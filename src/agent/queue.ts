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
  claimNextMessage,
  clearPendingMessages,
  markMessageDone,
  markMessageFailed,
  recoverStuckMessages,
  requeueMessage,
  logMessage,
  getChannel,
} from '../db.js';
import { invokeAgent, steerActiveAgent } from './invoke.js';
import { promptSupervisorRequest, sendResponse, setTyping } from '../discord/client.js';
import { computeEffectiveChannelSettings } from './channel-settings.js';

/** Channels currently being processed (per-channel serial lock) */
const activeChannels = new Set<string>();
const activeTaskPromises = new Set<Promise<void>>();
const steeringTaskPromises = new Set<Promise<void>>();
const steeringTaskControllers = new Set<AbortController>();
const steeringChannels = new Set<string>();
const acceptedSteeringRows = new Map<string, Set<number>>();
const activeTaskControllers = new Map<number, AbortController>();
const activeChannelControllers = new Map<string, AbortController>();

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
    activeChannels.add(jid);
    activeTaskControllers.set(msg.rowid, controller);
    activeChannelControllers.set(jid, controller);

    const taskPromise = processMessage(
      jid,
      msg.rowid,
      msg.sender_name,
      msg.content,
      controller.signal,
      msg.attachments,
    ).finally(() => {
      activeChannels.delete(jid);
      activeTaskControllers.delete(msg.rowid);
      activeChannelControllers.delete(jid);
      activeTaskPromises.delete(taskPromise);

      if (running) schedulePoll(0);
    });

    activeTaskPromises.add(taskPromise);
  }
}

function dispatchSteeringMessage(jid: string): void {
  if (steeringChannels.has(jid)) return;

  const channel = getChannel(jid);
  const msg = claimNextMessage(jid);
  if (!channel || !msg) return;

  const controller = new AbortController();
  const parentSignal = activeChannelControllers.get(jid)?.signal;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  steeringChannels.add(jid);
  steeringTaskControllers.add(controller);
  const taskPromise = processSteeringMessage(
    jid,
    channel.folder,
    msg.rowid,
    msg.sender_name,
    msg.content,
    msg.attachments,
    controller.signal,
  ).finally(() => {
    parentSignal?.removeEventListener('abort', abortFromParent);
    steeringChannels.delete(jid);
    steeringTaskControllers.delete(controller);
    steeringTaskPromises.delete(taskPromise);
    if (running) schedulePoll(0);
  });
  steeringTaskPromises.add(taskPromise);
}

async function processSteeringMessage(
  jid: string,
  channelFolder: string,
  rowid: number,
  senderName: string,
  content: string,
  attachments: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const prompt = `[Discord user: ${senderName}]\n${content}`;

  try {
    let consumed = false;
    const accepted = await steerActiveAgent(channelFolder, prompt, {
      attachments,
      signal,
      onConsumed: () => {
        consumed = true;
        markMessageDone(rowid);
        acceptedSteeringRows.get(jid)?.delete(rowid);
        logger.info({ jid, rowid }, 'Steering message consumed by Pi');
      },
    });
    if (!accepted) {
      // The active run may still be starting or may have just settled. Let the
      // normal queue path process this message on the next poll unless the user
      // or gateway explicitly aborted the owning channel task.
      if (signal?.aborted) markMessageFailed(rowid);
      else requeueMessage(rowid);
      return;
    }

    logMessage(jid, 'user', content);
    if (!consumed) {
      const rows = acceptedSteeringRows.get(jid) || new Set<number>();
      rows.add(rowid);
      acceptedSteeringRows.set(jid, rows);
    }
    logger.info({ jid, rowid, senderName, len: content.length }, 'Message steered into active run');
  } catch (err: any) {
    if (!activeChannels.has(jid)) {
      if (signal?.aborted) markMessageFailed(rowid);
      else requeueMessage(rowid);
      return;
    }
    markMessageFailed(rowid);
    logger.warn({ jid, rowid, err: err.message }, 'Failed to steer message into active run');
    await sendResponse(jid, `⚠️ Steer failed: ${err.message?.slice(0, 250)}`);
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
  const rows = acceptedSteeringRows.get(jid) || new Set<number>();
  acceptedSteeringRows.delete(jid);
  for (const rowid of rows) {
    if (status === 'done') markMessageDone(rowid);
    else if (status === 'failed') markMessageFailed(rowid);
    else requeueMessage(rowid);
  }
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
