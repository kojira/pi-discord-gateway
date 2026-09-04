/**
 * Message processing loop.
 *
 * Polls SQLite for pending messages, dispatches to pi agent, sends response
 * back to Discord. Enforces per-channel serial processing and global
 * concurrency limit.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  channelsWithPending,
  claimMessages,
  claimNextMessage,
  clearPendingMessages,
  listPendingMessages,
  markMessageDone,
  markMessageFailed,
  markMessagesDone,
  markMessagesFailed,
  pendingMessageSnapshot,
  recoverStuckMessages,
  requeueMessages,
  logMessage,
  getChannel,
} from '../db.js';
import { invokeAgent, steerActiveAgent } from './invoke.js';
import { promptSupervisorRequest, sendResponse, setTyping } from '../discord/client.js';
import { computeEffectiveChannelSettings } from './channel-settings.js';
import { enqueueWebhookTrace } from '../discord/webhook-monitor.js';
import type { QueuedMessage } from '../types.js';

/** Channels currently being processed (per-channel serial lock) */
const activeChannels = new Set<string>();
const activeTaskPromises = new Set<Promise<void>>();
const steeringTaskPromises = new Set<Promise<void>>();
const steeringTaskControllers = new Set<AbortController>();
const acceptedSteeringRows = new Map<string, Set<number>>();
const activeTaskControllers = new Map<number, AbortController>();
const activeChannelControllers = new Map<string, AbortController>();
const activeChannelGenerations = new Map<string, symbol>();

interface SteeringTask {
  generation: symbol;
  controller: AbortController;
  promise: Promise<void>;
}

const steeringTasksByChannel = new Map<string, SteeringTask>();

let running = false;
let pollTimer: NodeJS.Timeout | undefined;
let stopPromise: Promise<void> | null = null;

export function isChannelProcessing(jid: string): boolean {
  return activeChannels.has(jid);
}

export function abortChannelTask(jid: string): { aborted: boolean; cleared: number } {
  const controller = activeChannelControllers.get(jid);
  const aborted = Boolean(controller);
  if (controller) {
    controller.abort();
  }
  const cleared = clearPendingMessages(jid);
  return { aborted, cleared };
}

export function startProcessingLoop(): void {
  if (running) return;

  running = true;
  stopPromise = null;

  // Recover any messages stuck in 'processing' from a previous crash.
  const recovered = recoverStuckMessages();
  if (recovered > 0) {
    logger.info({ count: recovered }, 'Recovered stuck messages');
  }

  schedulePoll(0);
}

export function stopProcessingLoop(opts: { timeoutMs?: number } = {}): Promise<void> {
  if (stopPromise) {
    return stopPromise;
  }

  running = false;
  clearPollTimer();

  stopPromise = drainActiveTasks(opts.timeoutMs ?? config.shutdownTimeoutMs);
  return stopPromise;
}

function schedulePoll(delayMs = config.pollInterval): void {
  if (!running || pollTimer) return;

  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    poll();
  }, delayMs);
}

function clearPollTimer(): void {
  if (!pollTimer) return;
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

function poll(): void {
  if (!running) return;

  try {
    dispatch();
  } catch (err: any) {
    logger.error({ err: err.message }, 'Poll error');
  } finally {
    schedulePoll();
  }
}

function dispatch(): void {
  for (const jid of channelsWithPending()) {
    if (activeChannels.has(jid)) {
      dispatchSteeringMessage(jid);
      continue;
    }
    if (activeTaskPromises.size >= config.maxConcurrency) continue;

    const msg = claimNextMessage(jid);
    if (!msg) continue;

    const controller = new AbortController();
    const generation = Symbol(jid);
    activeChannels.add(jid);
    activeTaskControllers.set(msg.rowid, controller);
    activeChannelControllers.set(jid, controller);
    activeChannelGenerations.set(jid, generation);

    const taskPromise = processMessage(
      jid,
      msg.rowid,
      msg.sender_name,
      msg.content,
      controller.signal,
      msg.attachments,
    ).finally(async () => {
      const steeringTask = steeringTasksByChannel.get(jid);
      if (steeringTask?.generation === generation) {
        steeringTask.controller.abort();
        await steeringTask.promise;
      }

      if (activeChannelGenerations.get(jid) === generation) {
        activeChannels.delete(jid);
        activeChannelControllers.delete(jid);
        activeChannelGenerations.delete(jid);
      }
      activeTaskControllers.delete(msg.rowid);
      activeTaskPromises.delete(taskPromise);

      if (running) schedulePoll(0);
    });

    activeTaskPromises.add(taskPromise);
  }
}

function dispatchSteeringMessage(jid: string): void {
  if (steeringTasksByChannel.has(jid)) return;

  const channel = getChannel(jid);
  const generation = activeChannelGenerations.get(jid);
  const parentController = activeChannelControllers.get(jid);
  if (!channel || !generation || !parentController) return;

  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentController.signal.aborted) controller.abort();
  else parentController.signal.addEventListener('abort', abortFromParent, { once: true });

  steeringTaskControllers.add(controller);
  const taskPromise = processSteeringMessages(
    jid,
    channel.folder,
    generation,
    parentController.signal,
    controller.signal,
  )
    .catch((err: any) => {
      logger.error({ jid, err: err.message }, 'Steering batch task failed');
    })
    .finally(() => {
      parentController.signal.removeEventListener('abort', abortFromParent);
      if (steeringTasksByChannel.get(jid) === steeringTask) {
        steeringTasksByChannel.delete(jid);
      }
      steeringTaskControllers.delete(controller);
      steeringTaskPromises.delete(taskPromise);
      if (running) schedulePoll(0);
    });
  const steeringTask: SteeringTask = { generation, controller, promise: taskPromise };
  steeringTasksByChannel.set(jid, steeringTask);
  steeringTaskPromises.add(taskPromise);
}

interface PreparedSteeringBatch {
  messages: QueuedMessage[];
  prompt: string;
  attachments: string | null;
}

async function processSteeringMessages(
  jid: string,
  channelFolder: string,
  generation: symbol,
  parentSignal: AbortSignal,
  signal: AbortSignal,
): Promise<void> {
  const ready = await waitForSteeringDebounce(jid, generation, signal);
  if (!ready || !isCurrentGeneration(jid, generation)) return;

  const candidates = listPendingMessages(jid, config.steerBatchMaxMessages);
  const prepared = prepareSteeringBatch(candidates);
  if (!prepared) return;
  if (prepared.messages.length === 0) {
    const oversized = candidates[0];
    if (oversized && isCurrentGeneration(jid, generation)) {
      markMessagesFailed([oversized.rowid]);
      logger.warn({ jid, rowid: oversized.rowid }, 'Steering message exceeds batch limits');
      await sendResponse(jid, '⚠️ Steer message exceeds the configured batch limits.');
    }
    return;
  }

  const rowids = prepared.messages.map((message) => message.rowid);
  if (!isCurrentGeneration(jid, generation) || signal.aborted || !claimMessages(rowids)) return;

  try {
    let consumed = false;
    const accepted = await steerActiveAgent(channelFolder, prepared.prompt, {
      attachments: prepared.attachments,
      signal,
      onConsumed: () => {
        markMessagesDone(rowids);
        consumed = true;
        const acceptedRows = acceptedSteeringRows.get(jid);
        for (const rowid of rowids) acceptedRows?.delete(rowid);
        logger.info({ jid, rowids, count: rowids.length }, 'Steering batch consumed by Pi');
      },
    });
    if (!accepted) {
      settleInactiveSteeringBatch(jid, generation, rowids, parentSignal);
      return;
    }

    if (!consumed && (!isCurrentGeneration(jid, generation) || signal.aborted)) {
      settleInactiveSteeringBatch(jid, generation, rowids, parentSignal);
      return;
    }

    for (const message of prepared.messages) logMessage(jid, 'user', message.content);
    if (!consumed) {
      const rows = acceptedSteeringRows.get(jid) || new Set<number>();
      for (const rowid of rowids) rows.add(rowid);
      acceptedSteeringRows.set(jid, rows);
    }
    logger.info(
      { jid, rowids, count: prepared.messages.length, len: prepared.prompt.length },
      'Messages steered into active run as one batch',
    );
  } catch (err: any) {
    if (signal.aborted || !isCurrentGeneration(jid, generation)) {
      settleInactiveSteeringBatch(jid, generation, rowids, parentSignal);
      return;
    }
    markMessagesFailed(rowids);
    logger.warn({ jid, rowids, err: err.message }, 'Failed to steer message batch into active run');
    await sendResponse(jid, `⚠️ Steer failed: ${err.message?.slice(0, 250)}`);
  }
}

function settleInactiveSteeringBatch(
  jid: string,
  generation: symbol,
  rowids: readonly number[],
  parentSignal: AbortSignal,
): void {
  if (parentSignal.aborted || !isCurrentGeneration(jid, generation)) {
    markMessagesFailed(rowids);
  } else {
    requeueMessages(rowids);
  }
}

async function waitForSteeringDebounce(
  jid: string,
  generation: symbol,
  signal: AbortSignal,
): Promise<boolean> {
  let observed = pendingMessageSnapshot(jid);
  if (observed.count === 0) return false;
  const deadline = Date.now() + config.steerDebounceMaxMs;

  while (config.steerDebounceMs > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    if (!(await waitForDelay(Math.min(config.steerDebounceMs, remainingMs), signal))) return false;
    if (!isCurrentGeneration(jid, generation)) return false;

    const current = pendingMessageSnapshot(jid);
    if (current.count === 0) return false;
    if (current.latestRowid === observed.latestRowid) break;
    observed = current;
  }

  return !signal.aborted && isCurrentGeneration(jid, generation);
}

function isCurrentGeneration(jid: string, generation: symbol): boolean {
  return activeChannelGenerations.get(jid) === generation;
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (completed: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function prepareSteeringBatch(candidates: QueuedMessage[]): PreparedSteeringBatch | undefined {
  if (candidates.length === 0) return undefined;

  const messages: QueuedMessage[] = [];
  const segments: string[] = [];
  const attachments: unknown[] = [];
  let promptChars = 0;
  let attachmentBytes = 0;

  for (const message of candidates) {
    const segment = `[Discord user: ${message.sender_name}]\n${message.content}`;
    const parsedAttachments = parseSteeringAttachments(message);
    const nextPromptLength =
      promptChars + segment.length + (segments.length > 0 ? '\n\n---\n\n'.length : 0);
    const nextAttachmentBytes = attachmentBytes + parsedAttachments.bytes;
    if (
      nextPromptLength > config.steerBatchMaxPromptChars ||
      nextAttachmentBytes > config.steerBatchMaxAttachmentBytes
    ) {
      break;
    }
    messages.push(message);
    segments.push(segment);
    attachments.push(...parsedAttachments.values);
    promptChars = nextPromptLength;
    attachmentBytes = nextAttachmentBytes;
  }

  return {
    messages,
    prompt: segments.join('\n\n---\n\n'),
    attachments: attachments.length > 0 ? JSON.stringify(attachments) : null,
  };
}

function parseSteeringAttachments(message: QueuedMessage): { values: unknown[]; bytes: number } {
  if (!message.attachments) return { values: [], bytes: 0 };
  try {
    const attachments: unknown = JSON.parse(message.attachments);
    if (!Array.isArray(attachments)) return { values: [], bytes: 0 };
    return {
      values: attachments,
      bytes: attachments.reduce(
        (total, attachment) =>
          total +
          (typeof attachment === 'object' &&
          attachment !== null &&
          'size' in attachment &&
          typeof attachment.size === 'number' &&
          Number.isFinite(attachment.size) &&
          attachment.size > 0
            ? attachment.size
            : 0),
        0,
      ),
    };
  } catch (err: any) {
    logger.warn({ rowid: message.rowid, err: err.message }, 'Ignoring malformed steer attachments');
    return { values: [], bytes: 0 };
  }
}

async function drainActiveTasks(timeoutMs: number): Promise<void> {
  if (activeTaskPromises.size === 0 && steeringTaskPromises.size === 0) {
    return;
  }

  const initialDrain = Promise.allSettled([...activeTaskPromises, ...steeringTaskPromises]);
  const drainedGracefully = await waitForPromise(initialDrain, timeoutMs);
  if (drainedGracefully) {
    return;
  }

  logger.warn(
    { timeoutMs, activeTasks: activeTaskPromises.size },
    'Shutdown timeout reached; aborting in-flight message processing',
  );

  for (const controller of activeTaskControllers.values()) controller.abort();
  for (const controller of steeringTaskControllers) controller.abort();

  if (activeTaskPromises.size > 0 || steeringTaskPromises.size > 0) {
    await Promise.race([
      Promise.allSettled([...activeTaskPromises, ...steeringTaskPromises]),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

async function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) {
    return false;
  }

  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  return activeTaskPromises.size === 0 && steeringTaskPromises.size === 0;
}

async function processMessage(
  jid: string,
  rowid: number,
  senderName: string,
  content: string,
  signal: AbortSignal,
  attachments?: string | null,
): Promise<void> {
  const channel = getChannel(jid);
  if (!channel) {
    logger.warn({ jid }, 'Channel disappeared during processing');
    markMessageFailed(rowid);
    return;
  }

  logger.info({ jid, senderName, len: content.length }, 'Processing message');

  const typingLoop = createTypingLoop(jid);

  try {
    const prompt = `[Discord user: ${senderName}]\n${content}`;

    logMessage(jid, 'user', content);

    const effective = computeEffectiveChannelSettings(channel);

    let lastAttemptedText = '';
    let lastDeliverySucceeded = false;
    let hadLiveDeliveryFailure = false;
    const result = await invokeAgent(channel.folder, prompt, {
      model: effective.rawModelRef || undefined,
      thinking: effective.hasManagedThinking ? effective.effectiveThinking : undefined,
      cwd: effective.effectiveCwd,
      signal,
      attachments,
      onAssistantMessage: async (text) => {
        lastAttemptedText = text;
        lastDeliverySucceeded = await sendResponse(jid, text);
        if (!lastDeliverySucceeded) {
          hadLiveDeliveryFailure = true;
          throw new Error('Could not deliver live assistant message to Discord');
        }
        logMessage(jid, 'assistant', text);
      },
      onSupervisorRequest: (request) => promptSupervisorRequest(jid, request),
      onTraceEvent: (text) => enqueueWebhookTrace(jid, text),
    });

    if (signal.aborted) {
      markMessageFailed(rowid);
      finalizeSteeringRows(jid, 'failed');
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

    if (result.ok) {
      // Any rows left here were accepted but never observed as user messages.
      // Requeue them rather than claiming they were processed.
      finalizeSteeringRows(jid, 'pending');

      // Every RPC assistant message is delivered at message_end. Send a fallback
      // only when the callback was never attempted; retrying a partially sent
      // multi-chunk message would duplicate its earlier Discord chunks.
      if (lastAttemptedText === result.text && !lastDeliverySucceeded) {
        markMessageFailed(rowid);
        logger.warn({ jid }, 'Final assistant message was only partially delivered to Discord');
        return;
      }
      if (lastAttemptedText !== result.text) {
        const sent = await sendResponse(jid, result.text);
        if (!sent) {
          markMessageFailed(rowid);
          logger.warn({ jid }, 'Agent response generated but could not be delivered to Discord');
          return;
        }
        logMessage(jid, 'assistant', result.text);
      }

      if (hadLiveDeliveryFailure) {
        markMessageFailed(rowid);
        await sendResponse(
          jid,
          '⚠️ One or more intermediate assistant messages could not be delivered.',
        );
        logger.warn({ jid }, 'Agent completed with missing live Discord messages');
        return;
      }

      markMessageDone(rowid);
      logger.info({ jid, responseLen: result.text.length }, 'Message processed');
      return;
    }

    finalizeSteeringRows(jid, 'pending');
    const errMsg = `⚠️ Agent error: ${result.error?.slice(0, 300) || 'unknown error'}`;
    await sendResponse(jid, errMsg);
    markMessageFailed(rowid);
    logger.warn({ jid, error: result.error }, 'Agent returned error');
  } catch (err: any) {
    if (signal.aborted) {
      finalizeSteeringRows(jid, 'failed');
      markMessageFailed(rowid);
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

    logger.error({ jid, err: err.message }, 'processMessage failed');
    finalizeSteeringRows(jid, signal.aborted ? 'failed' : 'pending');
    markMessageFailed(rowid);
    try {
      await sendResponse(jid, `⚠️ Internal error: ${err.message?.slice(0, 200)}`);
    } catch {
      // Nothing else to do here.
    }
  } finally {
    await typingLoop.stop();
  }
}

function finalizeSteeringRows(jid: string, status: 'done' | 'failed' | 'pending'): void {
  const rowids = [...(acceptedSteeringRows.get(jid) || [])];
  if (status === 'done') markMessagesDone(rowids);
  else if (status === 'failed') markMessagesFailed(rowids);
  else requeueMessages(rowids);
  acceptedSteeringRows.delete(jid);
}

function createTypingLoop(jid: string): { stop: () => Promise<void> } {
  let typingAlive = true;
  let cancelTypingDelay = () => {};

  const loop = (async () => {
    while (typingAlive) {
      await setTyping(jid);
      if (!typingAlive) break;

      const delay = cancellableSleep(8000);
      cancelTypingDelay = delay.cancel;
      await delay.promise;
      cancelTypingDelay = () => {};
    }
  })();

  return {
    stop: async () => {
      typingAlive = false;
      cancelTypingDelay();
      await loop;
    },
  };
}

function cancellableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  let resolvePromise: () => void = () => {};

  const promise = new Promise<void>((resolve) => {
    resolvePromise = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    timer = setTimeout(resolvePromise, ms);
  });

  return {
    promise,
    cancel: resolvePromise,
  };
}
