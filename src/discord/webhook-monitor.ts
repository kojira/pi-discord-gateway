import { RESTJSONErrorCodes, WebhookClient } from 'discord.js';
import { config } from '../config.js';
import { getChannelWebhook, type ChannelWebhookConfig } from '../db.js';
import { logger } from '../logger.js';

const FLUSH_INTERVAL_MS = 1000;
const MAX_LINES_PER_POST = 5;
const MAX_CONTENT_LENGTH = 1900;
const MAX_QUEUED_LINES = 100;
const MAX_QUEUED_CHARS = 64 * 1024;

interface WebhookDeliveryState {
  key: string;
  jid: string;
  webhook: ChannelWebhookConfig;
  client?: WebhookClient;
  lines: string[];
  queuedChars: number;
  droppedEvents: number;
  inFlightEvents: number;
  timer?: NodeJS.Timeout;
  drainPromise?: Promise<void>;
  retired: boolean;
}

const deliveryStates = new Map<string, WebhookDeliveryState>();
const configurationLocks = new Map<string, Promise<void>>();
let stopping = false;

/** Queue a bounded trace line for the webhook configured for this source channel. */
export function enqueueWebhookTrace(jid: string, line: string): void {
  if (stopping || !line.trim()) return;
  const webhook = getChannelWebhook(jid);
  if (!webhook) return;

  const state = getOrCreateState(webhook);
  const timestamp = new Date().toISOString().slice(11, 19);
  const entry = `${timestamp} ${line.trim()}`;
  if (
    state.lines.length >= MAX_QUEUED_LINES ||
    state.queuedChars + entry.length + 1 > MAX_QUEUED_CHARS
  ) {
    state.droppedEvents += 1;
    return;
  }

  state.lines.push(entry);
  state.queuedChars += entry.length + 1;
  if (state.lines.length >= MAX_LINES_PER_POST || state.queuedChars >= MAX_CONTENT_LENGTH) {
    void drainState(state);
  } else if (!state.timer) {
    state.timer = setTimeout(() => void drainState(state), FLUSH_INTERVAL_MS);
  }
}

/** Serialize webhook lifecycle mutations for one source channel. */
export async function withWebhookConfigLock<T>(
  jid: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = configurationLocks.get(jid) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  configurationLocks.set(jid, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (configurationLocks.get(jid) === tail) configurationLocks.delete(jid);
  }
}

/** Flush already queued output for one source channel and optional webhook epoch. */
export async function flushWebhookTrace(jid: string, webhookId?: string): Promise<void> {
  const states = matchingStates(jid, webhookId);
  await Promise.all(states.map((state) => drainState(state)));
}

/** Immediately drop queued output and destroy clients for a disabled route. */
export function discardWebhookTrace(jid: string, webhookId?: string): void {
  for (const state of matchingStates(jid, webhookId)) retireState(state);
}

/** Flush and dispose a replaced or removed webhook's delivery epoch. */
export async function retireWebhookTrace(
  jid: string,
  webhookId: string,
  timeoutMs = config.shutdownTimeoutMs,
): Promise<void> {
  const states = matchingStates(jid, webhookId);
  const draining = Promise.allSettled(states.map((state) => drainState(state)));
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs === 0) {
    timedOut = states.some((state) => state.lines.length > 0 || state.drainPromise);
  } else {
    await Promise.race([
      draining,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  if (timedOut) {
    const dropped = countUndelivered(states);
    logger.warn({ jid, webhookId, dropped }, 'Webhook retirement deadline reached');
  }
  for (const state of states) retireState(state);
}

/** Bound monitoring shutdown and stop accepting events once shutdown begins. */
export async function stopWebhookMonitor(timeoutMs = config.shutdownTimeoutMs): Promise<void> {
  stopping = true;
  const states = [...deliveryStates.values()];
  for (const state of states) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  const draining = Promise.allSettled(states.map((state) => drainState(state)));
  let timedOut = false;
  if (timeoutMs === 0) {
    timedOut = states.some((state) => state.lines.length > 0 || state.drainPromise);
  } else {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      draining,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  if (timedOut) {
    const dropped = countUndelivered(states);
    logger.warn({ dropped, timeoutMs }, 'Webhook monitoring shutdown deadline reached');
  }
  for (const state of states) retireState(state);
  deliveryStates.clear();
}

export async function deleteDiscordWebhook(
  webhook: ChannelWebhookConfig,
  reason: string,
): Promise<boolean> {
  const client = new WebhookClient({ id: webhook.webhook_id, token: webhook.webhook_token });
  try {
    await client.delete(reason);
    return true;
  } catch (error) {
    if (isDiscordUnknownWebhookError(error)) return true;
    logger.warn(
      {
        jid: webhook.channel_jid,
        destinationChannelId: webhook.destination_channel_id,
        ...safeDiscordErrorMetadata(error),
      },
      'Failed to delete Discord monitoring webhook',
    );
    return false;
  } finally {
    client.destroy();
  }
}

export function safeDiscordErrorMetadata(error: unknown): {
  errorName: string;
  discordCode?: number;
  httpStatus?: number;
} {
  if (typeof error !== 'object' || error === null) return { errorName: typeof error };
  const value = error as { code?: unknown; status?: unknown };
  return {
    errorName: error instanceof Error ? error.constructor.name.slice(0, 100) : 'unknown',
    ...(typeof value.code === 'number' ? { discordCode: value.code } : {}),
    ...(typeof value.status === 'number' ? { httpStatus: value.status } : {}),
  };
}

/** Discord reports an already-deleted webhook with this specific REST error. */
export function isDiscordUnknownWebhookError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === RESTJSONErrorCodes.UnknownWebhook
  );
}

async function drainState(state: WebhookDeliveryState): Promise<void> {
  if (state.drainPromise) return state.drainPromise;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }

  const run = async () => {
    while (!state.retired && (state.lines.length > 0 || state.droppedEvents > 0)) {
      const lines = state.lines.splice(0);
      state.queuedChars = 0;
      const dropped = state.droppedEvents;
      state.droppedEvents = 0;
      state.inFlightEvents = lines.length + dropped;
      if (dropped > 0) {
        lines.push(`⚠️ dropped ${dropped} activity events while the webhook was busy`);
      }
      const chunks = splitLines(lines, MAX_CONTENT_LENGTH);
      try {
        await deliver(state, chunks);
      } finally {
        state.inFlightEvents = 0;
      }
    }
  };

  state.drainPromise = run().finally(() => {
    state.drainPromise = undefined;
    if (!state.retired && state.lines.length > 0 && !state.timer) {
      state.timer = setTimeout(() => void drainState(state), FLUSH_INTERVAL_MS);
    }
  });
  return state.drainPromise;
}

async function deliver(state: WebhookDeliveryState, chunks: readonly string[]): Promise<void> {
  try {
    for (const content of chunks) {
      if (state.retired || !isCurrentWebhookEpoch(state)) {
        retireState(state);
        return;
      }
      state.client ??= new WebhookClient({
        id: state.webhook.webhook_id,
        token: state.webhook.webhook_token,
      });
      await state.client.send({ content, allowedMentions: { parse: [] } });
    }
  } catch (error) {
    logger.warn(
      {
        jid: state.jid,
        destinationChannelId: state.webhook.destination_channel_id,
        ...safeDiscordErrorMetadata(error),
      },
      'Failed to deliver Pi trace to monitoring webhook',
    );
  }
}

function isCurrentWebhookEpoch(state: WebhookDeliveryState): boolean {
  return getChannelWebhook(state.jid)?.webhook_id === state.webhook.webhook_id;
}

function getOrCreateState(webhook: ChannelWebhookConfig): WebhookDeliveryState {
  const key = batchKey(webhook);
  let state = deliveryStates.get(key);
  if (!state) {
    state = {
      key,
      jid: webhook.channel_jid,
      webhook,
      lines: [],
      queuedChars: 0,
      droppedEvents: 0,
      inFlightEvents: 0,
      retired: false,
    };
    deliveryStates.set(key, state);
  }
  return state;
}

function matchingStates(jid: string, webhookId?: string): WebhookDeliveryState[] {
  return [...deliveryStates.values()].filter(
    (state) => state.jid === jid && (!webhookId || state.webhook.webhook_id === webhookId),
  );
}

function retireState(state: WebhookDeliveryState): void {
  state.retired = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  state.lines = [];
  state.queuedChars = 0;
  state.droppedEvents = 0;
  state.inFlightEvents = 0;
  state.client?.destroy();
  deliveryStates.delete(state.key);
}

function countUndelivered(states: readonly WebhookDeliveryState[]): number {
  return states.reduce(
    (total, state) => total + state.lines.length + state.droppedEvents + state.inFlightEvents,
    0,
  );
}

function batchKey(webhook: ChannelWebhookConfig): string {
  return `${webhook.channel_jid}:${webhook.webhook_id}`;
}

export function webhookMonitorStats(jid: string): {
  states: number;
  queuedLines: number;
  queuedChars: number;
  droppedEvents: number;
} {
  const states = matchingStates(jid);
  return {
    states: states.length,
    queuedLines: states.reduce((total, state) => total + state.lines.length, 0),
    queuedChars: states.reduce((total, state) => total + state.queuedChars, 0),
    droppedEvents: states.reduce((total, state) => total + state.droppedEvents, 0),
  };
}

export function splitWebhookLines(
  lines: readonly string[],
  maxLength = MAX_CONTENT_LENGTH,
): string[] {
  return splitLines(lines, maxLength);
}

function splitLines(lines: readonly string[], maxLength: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    let remaining = line;
    while (remaining.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }

    const combined = current ? `${current}\n${remaining}` : remaining;
    if (combined.length > maxLength) {
      chunks.push(current);
      current = remaining;
    } else {
      current = combined;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
