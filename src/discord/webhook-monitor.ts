import { WebhookClient } from 'discord.js';
import { getChannelWebhook, type ChannelWebhookConfig } from '../db.js';
import { logger } from '../logger.js';

const FLUSH_INTERVAL_MS = 1000;
const MAX_LINES_PER_POST = 5;
const MAX_CONTENT_LENGTH = 1900;

interface PendingWebhookBatch {
  jid: string;
  webhook: ChannelWebhookConfig;
  lines: string[];
  timer?: NodeJS.Timeout;
}

const pendingBatches = new Map<string, PendingWebhookBatch>();
const activeSends = new Map<Promise<void>, string>();
const deliveryChains = new Map<string, Promise<void>>();

/** Queue a bounded trace line for the webhook configured for this source channel. */
export function enqueueWebhookTrace(jid: string, line: string): void {
  const webhook = getChannelWebhook(jid);
  if (!webhook || !line.trim()) return;

  const key = batchKey(webhook);
  let batch = pendingBatches.get(key);
  if (!batch) {
    batch = { jid, webhook, lines: [] };
    pendingBatches.set(key, batch);
  }

  const timestamp = new Date().toISOString().slice(11, 19);
  batch.lines.push(`${timestamp} ${line.trim()}`);

  if (
    batch.lines.length >= MAX_LINES_PER_POST ||
    batch.lines.reduce((total, entry) => total + entry.length + 1, 0) >= MAX_CONTENT_LENGTH
  ) {
    void flushBatch(key);
    return;
  }

  if (!batch.timer) {
    batch.timer = setTimeout(() => void flushBatch(key), FLUSH_INTERVAL_MS);
  }
}

/** Flush trace output for one source channel before replacing or removing its webhook. */
export async function flushWebhookTrace(jid: string): Promise<void> {
  const keys = [...pendingBatches].filter(([, batch]) => batch.jid === jid).map(([key]) => key);
  await Promise.all(keys.map((key) => flushBatch(key)));
  await Promise.all(
    [...activeSends].filter(([, sourceJid]) => sourceJid === jid).map(([send]) => send),
  );
}

/** Flush every configured channel during graceful shutdown. */
export async function stopWebhookMonitor(): Promise<void> {
  await Promise.all([...pendingBatches.keys()].map((key) => flushBatch(key)));
  await Promise.all([...activeSends.keys()]);
  deliveryChains.clear();
}

export async function deleteDiscordWebhook(
  webhook: ChannelWebhookConfig,
  reason: string,
): Promise<boolean> {
  const client = new WebhookClient({ id: webhook.webhook_id, token: webhook.webhook_token });
  try {
    await client.delete(reason);
    return true;
  } catch (err: any) {
    logger.warn(
      {
        jid: webhook.channel_jid,
        destinationChannelId: webhook.destination_channel_id,
        err: err.message,
      },
      'Failed to delete Discord monitoring webhook',
    );
    return false;
  } finally {
    client.destroy();
  }
}

async function flushBatch(key: string): Promise<void> {
  const batch = pendingBatches.get(key);
  if (!batch) return;
  pendingBatches.delete(key);
  if (batch.timer) clearTimeout(batch.timer);

  const chunks = splitLines(batch.lines, MAX_CONTENT_LENGTH);
  const previous = deliveryChains.get(key) ?? Promise.resolve();
  const delivery = previous
    .catch(() => undefined)
    .then(() => deliver(batch.webhook, batch.jid, chunks));
  deliveryChains.set(key, delivery);
  activeSends.set(delivery, batch.jid);
  await delivery.finally(() => {
    activeSends.delete(delivery);
    if (deliveryChains.get(key) === delivery) deliveryChains.delete(key);
  });
}

async function deliver(
  webhook: ChannelWebhookConfig,
  jid: string,
  chunks: readonly string[],
): Promise<void> {
  const client = new WebhookClient({ id: webhook.webhook_id, token: webhook.webhook_token });
  try {
    for (const content of chunks) {
      await client.send({ content, allowedMentions: { parse: [] } });
    }
  } catch (err: any) {
    logger.warn(
      { jid, destinationChannelId: webhook.destination_channel_id, err: err.message },
      'Failed to deliver Pi trace to monitoring webhook',
    );
  } finally {
    client.destroy();
  }
}

function batchKey(webhook: ChannelWebhookConfig): string {
  return `${webhook.channel_jid}:${webhook.webhook_id}`;
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
