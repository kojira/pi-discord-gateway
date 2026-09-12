import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { type AttachmentMeta } from '../discord/attachments.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { type DownloadedFile, downloadAttachments } from '../session/media.js';
import {
  readSessionCreatedAt,
  resolveChannelSessionDir,
  resolveLatestChannelSessionFile,
} from '../session/path.js';
import type { AgentResult } from '../types.js';
import { resolvePiSpawn } from './pi-spawn.js';
import { startSupervisorWatcher, type SupervisorRequest } from './supervisor-channel.js';
import { formatAgentTraceEvent } from './trace.js';

export interface SessionTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface ChannelSessionStatus {
  sessionFile?: string;
  createdAt?: string;
  tokens?: SessionTokenUsage;
  contextUsage?: SessionContextUsage;
  statsSource: 'rpc' | 'jsonl' | 'none';
}

interface RpcResponse {
  type: 'response';
  id?: string;
  command?: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

interface PendingSteeringMessage {
  message: string;
  consumed: boolean;
  onConsumed?: () => void | Promise<void>;
}

export interface ConnectionDelivery {
  onAssistantMessage: (text: string, signal: AbortSignal) => void | Promise<void>;
  onSupervisorRequest?: (request: SupervisorRequest, signal: AbortSignal) => void | Promise<void>;
  onTraceEvent?: (text: string) => void;
  onError: (error: string, signal: AbortSignal) => void | Promise<void>;
}

interface InvokeOptions {
  model?: string;
  thinking?: string;
  cwd?: string;
  signal?: AbortSignal;
  attachments?: string | null;
  onAssistantMessage?: (text: string) => void | Promise<void>;
  onSupervisorRequest?: (request: SupervisorRequest) => void | Promise<void>;
  onTraceEvent?: (text: string) => void;
  connectionDelivery?: ConnectionDelivery;
}

interface ActiveRpcInvocation {
  identity?: string;
  request?: (prompt: string, opts?: InvokeOptions) => Promise<AgentResult>;
  stop?: () => Promise<void>;
  closing?: boolean;
  sendCommand: (command: Record<string, unknown>) => Promise<RpcResponse>;
  sendSteer: (message: string, onConsumed?: () => void | Promise<void>) => Promise<boolean>;
}

const activeRpcInvocations = new Map<string, ActiveRpcInvocation>();
export function hasResidentAgent(channelFolder: string): boolean {
  return Boolean(activeRpcInvocations.get(channelFolder)?.request);
}

export function stopResidentAgent(channelFolder: string): boolean {
  const connection = activeRpcInvocations.get(channelFolder);
  if (!connection?.stop) return false;
  void connection.stop();
  return true;
}

export async function shutdownResidentAgents(): Promise<void> {
  await Promise.all([...activeRpcInvocations.values()].map((connection) => connection.stop?.()));
}

const MAX_RPC_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PENDING_DELIVERY_BYTES = 4 * 1024 * 1024;

/** Queue a Discord message into an active Pi run using Pi's native steering queue. */
export async function steerActiveAgent(
  channelFolder: string,
  userText: string,
  opts?: {
    attachments?: string | null;
    signal?: AbortSignal;
    onConsumed?: () => void | Promise<void>;
  },
): Promise<boolean> {
  const invocation = activeRpcInvocations.get(channelFolder);
  if (!invocation) return false;

  const prompt = await buildPromptWithAttachments(channelFolder, userText, opts);
  if (activeRpcInvocations.get(channelFolder) !== invocation) return false;

  return invocation.sendSteer(prompt, opts?.onConsumed);
}

/**
 * Invoke Pi through its JSONL RPC mode.
 *
 * RPC is required here rather than print mode: it exposes every completed
 * assistant message and keeps stdin open for native steering while tools run.
 */
export async function invokeAgent(
  channelFolder: string,
  userText: string,
  opts?: InvokeOptions,
): Promise<AgentResult> {
  const sessionDir = resolveChannelSessionDir(channelFolder);
  mkdirSync(sessionDir, { recursive: true });
  const effectiveCwd = opts?.cwd || config.piCwd;
  let prompt = await buildPromptWithAttachments(channelFolder, userText, opts);

  if (opts?.signal?.aborted) {
    return { ok: false, text: '', error: 'Agent invocation aborted during shutdown' };
  }

  // `--session` expects a session file. A dedicated session directory plus
  // `--continue` reuses the newest session for this Discord channel.
  const args: string[] = ['--mode', 'rpc', '--session-dir', sessionDir, '--continue'];
  const model = opts?.model || config.piModel;
  if (model) args.push('--model', model);
  const thinking = opts?.thinking || config.piThinking;
  if (thinking) args.push('--thinking', thinking);
  if (config.piExtraFlags) args.push(...config.piExtraFlags.split(/\s+/).filter(Boolean));

  const persistent = config.piRpcPersistent;
  const identity = JSON.stringify([config.piBin, args, effectiveCwd]);
  const existing = activeRpcInvocations.get(channelFolder);
  if (existing?.request) {
    if (existing.closing || existing.identity !== identity) {
      return {
        ok: false,
        text: '',
        error:
          'Pi connection is stopping or its settings changed. Use /stop and wait before retrying.',
      };
    }
    return existing.request(prompt, opts);
  }

  if (persistent && !opts?.connectionDelivery) {
    return {
      ok: false,
      text: '',
      error: 'Persistent RPC requires connection-scoped delivery callbacks',
    };
  }

  const { bin: effectiveBin, args: effectiveArgs } = resolvePiSpawn(config.piBin, args);
  logger.debug(
    { bin: effectiveBin, args: effectiveArgs, channelFolder, cwd: effectiveCwd },
    'Spawning pi RPC',
  );

  return new Promise<AgentResult>((resolve) => {
    const proc = spawn(effectiveBin, effectiveArgs, {
      cwd: effectiveCwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const decoder = new StringDecoder('utf8');
    const pendingCommands = new Map<
      string,
      { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
    >();
    const pendingSteeringMessages: PendingSteeringMessage[] = [];
    const connectionController = new AbortController();
    const connectionDelivery = opts?.connectionDelivery;
    let supervisorWatcher =
      !persistent && opts?.onSupervisorRequest
        ? startSupervisorWatcher({ signal: opts.signal, onRequest: opts.onSupervisorRequest })
        : undefined;
    let requestResolve: ((result: AgentResult) => void) | undefined = resolve;
    let removeRequestAbort = () => {};
    let closeResolve!: () => void;
    const closed = new Promise<void>((done) => {
      closeResolve = done;
    });
    let stopPromise: Promise<void> | undefined;

    let stdoutBuffer = '';
    let stderr = '';
    let fatalRpcError = '';
    let pendingDeliveryBytes = 0;
    let commandSequence = 0;
    let lastAssistantText = '';
    let lastDeliveredText = '';
    let workOutcome: AgentResult['workOutcome'];
    let lastAssistantError = '';
    let lastAssistantFailed = false;
    let settled = false;
    let finished = false;
    let initialPromptObserved = false;
    let promptSubmitted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let legacySettleTimer: NodeJS.Timeout | undefined;
    // Only an observed legacy agent_end authorizes the legacy idle fallback.
    let legacyAgentEndPending = false;
    let deliveryChain = Promise.resolve();
    let consumptionChain = Promise.resolve();

    const sendCommand = (command: Record<string, unknown>): Promise<RpcResponse> => {
      if (!proc.stdin.writable || proc.stdin.destroyed) {
        return Promise.reject(new Error('Pi RPC stdin is closed'));
      }

      const id = `piscord-${++commandSequence}`;
      return new Promise<RpcResponse>((resolveCommand, rejectCommand) => {
        const timer = persistent
          ? setTimeout(() => {
              pendingCommands.delete(id);
              rejectCommand(new Error(`Pi RPC command timed out: ${String(command.type)}`));
            }, 30_000)
          : undefined;
        pendingCommands.set(id, {
          resolve: (response) => {
            clearTimeout(timer);
            resolveCommand(response);
          },
          reject: (error) => {
            clearTimeout(timer);
            rejectCommand(error);
          },
        });
        proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
          if (!error) return;
          clearTimeout(timer);
          pendingCommands.delete(id);
          rejectCommand(error);
        });
      });
    };

    const removePendingSteering = (request: PendingSteeringMessage) => {
      const index = pendingSteeringMessages.indexOf(request);
      if (index !== -1) pendingSteeringMessages.splice(index, 1);
    };

    const sendSteer = async (
      message: string,
      onConsumed?: () => void | Promise<void>,
    ): Promise<boolean> => {
      // Steering has priority over follow-ups in Pi. Do not let it become
      // the user event that identifies a still-unconsumed initial prompt.
      if (activeInvocation.closing || (persistent && (!requestResolve || !initialPromptObserved)))
        return false;
      const request: PendingSteeringMessage = { message, consumed: false, onConsumed };
      pendingSteeringMessages.push(request);

      try {
        const response = await sendCommand({ type: 'steer', message });
        if (!response.success) {
          removePendingSteering(request);
          throw new Error(response.error || 'Pi rejected the steering message');
        }

        // Consumption is authoritative even if settlement raced the response.
        if (request.consumed) return true;
        if (!persistent && activeRpcInvocations.get(channelFolder) !== activeInvocation) {
          removePendingSteering(request);
          return false;
        }
        return true;
      } catch (error) {
        removePendingSteering(request);
        // In persistent mode false means definitely unsent. A lost response
        // after writing is uncertain even if the connection has since closed.
        if (!persistent && activeRpcInvocations.get(channelFolder) !== activeInvocation)
          return false;
        throw error;
      }
    };
    const activeInvocation: ActiveRpcInvocation = { sendCommand, sendSteer };

    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      activeInvocation.closing = true;
      connectionController.abort();
      supervisorWatcher?.stop();
      if (proc.stdin.writable && !proc.stdin.destroyed) {
        proc.stdin.end('{"type":"clear_queue"}\n{"type":"abort"}\n');
      }
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = setTimeout(() => {
        proc.kill('SIGTERM');
        forceKillTimer = setTimeout(() => proc.kill('SIGKILL'), 1500);
      }, 500);
      stopPromise = new Promise<void>((done) => {
        const deadline = setTimeout(() => {
          logger.warn(
            { channelFolder },
            'Pi stop deadline reached; descendant/external job termination is unconfirmed',
          );
          done();
        }, 3000);
        void closed.then(() => {
          clearTimeout(deadline);
          done();
        });
      });
      return stopPromise;
    };

    const attachRequestAbort = () => {
      const signal = opts?.signal;
      if (!persistent || !signal) return;
      const abort = () => {
        void stop();
      };
      signal.addEventListener('abort', abort, { once: true });
      removeRequestAbort = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    };

    const resetOutput = () => {
      lastAssistantText = '';
      lastDeliveredText = '';
      workOutcome = undefined;
      lastAssistantError = '';
      lastAssistantFailed = false;
    };

    const submitPrompt = async (): Promise<RpcResponse | undefined> => {
      if (persistent) {
        const state = await sendCommand({ type: 'get_state' });
        const data = state.data as { sessionId?: string; pendingMessageCount?: number } | undefined;
        if (!state.success || typeof data?.pendingMessageCount !== 'number') {
          throw new Error('Pi did not return pendingMessageCount for request admission');
        }
        if (activeInvocation.closing) return undefined;
        if (!supervisorWatcher && connectionDelivery?.onSupervisorRequest) {
          if (!data.sessionId)
            throw new Error('Pi did not return a session ID for supervisor routing');
          supervisorWatcher = startSupervisorWatcher({
            signal: connectionController.signal,
            sessionId: data.sessionId,
            onRequest: (request) =>
              connectionDelivery.onSupervisorRequest!(request, connectionController.signal),
          });
        }
        if (data.pendingMessageCount !== 0) {
          const done = requestResolve;
          requestResolve = undefined;
          opts = undefined;
          removeRequestAbort();
          done?.({
            ok: false,
            text: '',
            error:
              'Pi already has pending user messages; request was not sent. Wait before retrying.',
          });
          return undefined;
        }
      }
      promptSubmitted = true;
      return sendCommand({ type: 'prompt', message: prompt, streamingBehavior: 'followUp' });
    };

    if (persistent) {
      activeInvocation.identity = identity;
      activeInvocation.stop = stop;
      activeInvocation.request = (nextPrompt, nextOpts) => {
        if (requestResolve || activeInvocation.closing) {
          return Promise.resolve({
            ok: false,
            text: '',
            error: 'Pi connection already has a request or is stopping',
          });
        }
        prompt = nextPrompt;
        opts = nextOpts;
        settled = false;
        initialPromptObserved = false;
        promptSubmitted = false;
        resetOutput();
        return new Promise<AgentResult>((done) => {
          requestResolve = done;
          attachRequestAbort();
          if (activeInvocation.closing) return;
          void submitPrompt()
            .then((response) => {
              if (response && !response.success)
                failRpcOutput(response.error || 'Pi rejected the prompt');
            })
            .catch((error: Error) => failRpcOutput(error.message));
        });
      };
      activeRpcInvocations.set(channelFolder, activeInvocation);
      attachRequestAbort();
    }

    const unregister = () => {
      if (activeRpcInvocations.get(channelFolder) === activeInvocation) {
        activeRpcInvocations.delete(channelFolder);
      }
    };

    const finish = (result: AgentResult) => {
      if (finished) return;
      finished = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (legacySettleTimer) clearTimeout(legacySettleTimer);
      unregister();
      supervisorWatcher?.stop();
      for (const pending of pendingCommands.values()) {
        pending.reject(new Error('Pi RPC process exited before responding'));
      }
      pendingCommands.clear();
      removeRequestAbort();
      connectionController.abort();
      closeResolve();
      requestResolve?.(result);
      requestResolve = undefined;
      opts = undefined;
    };

    const emitTrace = (trace: string | undefined) => {
      const callback = opts?.onTraceEvent || connectionDelivery?.onTraceEvent;
      if (!trace || !callback || activeInvocation.closing) return;
      try {
        callback(trace);
      } catch (error: any) {
        logger.warn({ channelFolder, err: error.message }, 'Failed to enqueue webhook trace');
      }
    };

    const failRpcOutput = (error: string) => {
      if (fatalRpcError || finished) return;
      fatalRpcError = error;
      stdoutBuffer = '';
      if (persistent) {
        void stop();
        return;
      }
      unregister();
      proc.stdin.end();
      proc.kill('SIGTERM');
      forceKillTimer = setTimeout(() => proc.kill('SIGKILL'), 1000);
    };

    const enqueueRpcDelivery = (
      text: string,
      deliver: (text: string) => void | Promise<void>,
      kind: 'assistant' | 'error' = 'assistant',
    ) => {
      if (activeInvocation.closing) return;
      const deliveryBytes = Buffer.byteLength(text);
      if (pendingDeliveryBytes + deliveryBytes > MAX_PENDING_DELIVERY_BYTES) {
        failRpcOutput(`Pi RPC pending ${kind} delivery exceeded the 4 MiB safety limit`);
        return;
      }
      if (kind === 'assistant') lastDeliveredText = text;
      pendingDeliveryBytes += deliveryBytes;
      deliveryChain = deliveryChain
        .then(() => deliver(text))
        .catch((error: Error) => {
          logger.error({ channelFolder, err: error.message }, 'Failed to deliver live RPC message');
        })
        .finally(() => {
          pendingDeliveryBytes -= deliveryBytes;
        });
    };

    const handleRpcMessage = (message: any) => {
      if (message?.type === 'response' && typeof message.id === 'string') {
        const pending = pendingCommands.get(message.id);
        if (pending) {
          pendingCommands.delete(message.id);
          pending.resolve(message as RpcResponse);
        }
        return;
      }

      emitTrace(formatAgentTraceEvent(message));

      if (message?.type === 'message_start' && message.message?.role === 'user') {
        const userText = extractUserText(message.message.content);
        // RPC events carry no command ID. Admission requires an empty user
        // queue; concurrent extension sendUserMessage is outside this contract.
        if (!initialPromptObserved && (persistent ? promptSubmitted : userText === prompt)) {
          initialPromptObserved = true;
          if (persistent) resetOutput();
          return;
        }

        const request = pendingSteeringMessages.find((candidate) => candidate.message === userText);
        if (request) {
          request.consumed = true;
          removePendingSteering(request);
          if (request.onConsumed) {
            consumptionChain = consumptionChain
              .then(() => request.onConsumed!())
              .catch((error: any) => {
                logger.error(
                  { channelFolder, err: error.message },
                  'Failed to record consumed steering message',
                );
              });
          }
        }
        return;
      }

      if (message?.type === 'message_end' && message.message?.role === 'assistant') {
        workOutcome = undefined;
        const text = extractAssistantText(message.message.content);
        lastAssistantFailed =
          message.message.stopReason === 'error' ||
          typeof message.message.errorMessage === 'string';
        lastAssistantError = lastAssistantFailed
          ? message.message.errorMessage || 'Pi assistant message ended with an error'
          : '';
        if (text) {
          lastAssistantText = text;
          const deliver =
            (!persistent || initialPromptObserved ? opts?.onAssistantMessage : undefined) ||
            (connectionDelivery
              ? (text: string) =>
                  connectionDelivery.onAssistantMessage(text, connectionController.signal)
              : undefined);
          if (deliver) enqueueRpcDelivery(text, deliver);
        }
        return;
      }

      if (message?.type === 'work_contract') {
        const record = message.record;
        if (record?.status === 'resolved' && typeof record.decision?.summary === 'string') {
          const outcome = record.decision.outcome;
          workOutcome = ['completed', 'cancelled', 'waiting', 'blocked'].includes(outcome)
            ? outcome
            : undefined;
          lastAssistantText = record.decision.summary;
          lastAssistantFailed = false;
          lastAssistantError = '';
        } else if (record?.status === 'suspended') {
          lastAssistantFailed = true;
          lastAssistantError = typeof record.reason === 'string' ? record.reason : 'Work suspended';
        }
        return;
      }

      if (message?.type === 'agent_settled') {
        settleInvocation();
        return;
      }

      // Pi versions before agent_settled support use agent_end as the terminal
      // event. Debounce it briefly because legacy auto-retry and auto-compaction
      // continuation events are emitted immediately after agent_end.
      if (message?.type === 'agent_end') {
        legacyAgentEndPending = !('willRetry' in message);
        if (legacyAgentEndPending) scheduleLegacySettlement();
        else cancelLegacySettlement();
        return;
      }

      if (
        message?.type === 'agent_start' ||
        message?.type === 'auto_retry_start' ||
        message?.type === 'compaction_start'
      ) {
        if (message.type === 'agent_start') {
          legacyAgentEndPending = false;
          if (persistent && !requestResolve) resetOutput();
        }
        cancelLegacySettlement();
        return;
      }

      if (message?.type === 'auto_retry_end' && message.success === false) {
        scheduleLegacySettlement();
        return;
      }

      if (message?.type === 'compaction_end' && message.willRetry === false) {
        scheduleLegacySettlement();
      }
    };

    const cancelLegacySettlement = () => {
      if (!legacySettleTimer) return;
      clearTimeout(legacySettleTimer);
      legacySettleTimer = undefined;
    };

    const scheduleLegacySettlement = () => {
      // willRetry:false on compaction_end means no overflow retry, not that
      // an in-loop tool continuation has ended. Modern Pi must emit agent_settled.
      if (!legacyAgentEndPending) return;
      cancelLegacySettlement();
      legacySettleTimer = setTimeout(() => {
        legacySettleTimer = undefined;
        settleInvocation();
      }, 100);
    };

    const currentResult = (): AgentResult => {
      if (fatalRpcError || lastAssistantFailed || !lastAssistantText) {
        return {
          ok: false,
          text: '',
          error:
            fatalRpcError ||
            lastAssistantError ||
            readLatestAgentErrorFromSession(channelFolder) ||
            'Pi completed without producing an assistant text message',
        };
      }
      return { ok: true, text: lastAssistantText, ...(workOutcome ? { workOutcome } : {}) };
    };

    const settleInvocation = () => {
      if (persistent) {
        if (activeInvocation.closing || (requestResolve && initialPromptObserved && settled))
          return;
        cancelLegacySettlement();
        const result = currentResult();
        const requestConsumed = Boolean(requestResolve && initialPromptObserved);
        if (result.ok && lastAssistantText !== lastDeliveredText) {
          const deliver =
            requestConsumed && opts?.onAssistantMessage
              ? opts.onAssistantMessage
              : connectionDelivery
                ? (text: string) =>
                    connectionDelivery.onAssistantMessage(text, connectionController.signal)
                : undefined;
          if (deliver) enqueueRpcDelivery(lastAssistantText, deliver);
        }
        if (activeInvocation.closing) return;
        if (requestConsumed) {
          settled = true;
          const done = requestResolve!;
          // Snapshot output and callback chains at the request boundary. Later
          // unsolicited events belong to the connection, not this request.
          opts = undefined;
          removeRequestAbort();
          requestResolve = undefined;
          void Promise.all([deliveryChain, consumptionChain]).then(() => done(result));
        } else if (connectionDelivery && !result.ok) {
          enqueueRpcDelivery(
            result.error || 'Pi failed',
            (error) => {
              if (!connectionController.signal.aborted)
                return connectionDelivery.onError(error, connectionController.signal);
            },
            'error',
          );
        }
        emitTrace('⏹️ parent idle (RPC retained; background work may remain)');
        return;
      }
      if (settled) return;
      cancelLegacySettlement();
      settled = true;
      emitTrace('⏹️ agent settled');
      unregister();
      proc.stdin.end();
      forceKillTimer = setTimeout(() => {
        if (process.platform === 'win32') proc.kill();
        else proc.kill('SIGTERM');
      }, 2000);
    };

    const consumeLine = (rawLine: string) => {
      if (Buffer.byteLength(rawLine) > MAX_RPC_EVENT_BYTES) {
        failRpcOutput('Pi RPC event exceeded the 4 MiB safety limit');
        return;
      }
      const line = rawLine.replace(/\r$/u, '');
      if (!line) return;
      try {
        handleRpcMessage(JSON.parse(line));
      } catch (error: any) {
        logger.warn(
          { channelFolder, err: error.message, line: line.slice(0, 300) },
          'Ignoring malformed Pi RPC output',
        );
      }
    };

    if (persistent)
      proc.stdin.on('error', (error) => {
        if (!activeInvocation.closing) failRpcOutput(error.message);
      });

    proc.stdout.on('data', (chunk: Buffer) => {
      if (fatalRpcError) return;
      stdoutBuffer += decoder.write(chunk);
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1 && !fatalRpcError) {
        consumeLine(stdoutBuffer.slice(0, newlineIndex));
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
      if (!fatalRpcError && Buffer.byteLength(stdoutBuffer) > MAX_RPC_EVENT_BYTES) {
        failRpcOutput('Pi RPC event exceeded the 4 MiB safety limit');
      }
    });
    proc.stdout.on('end', () => {
      if (fatalRpcError) return;
      stdoutBuffer += decoder.end();
      if (stdoutBuffer) consumeLine(stdoutBuffer);
      stdoutBuffer = '';
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      const available = Math.max(0, MAX_STDERR_BYTES - Buffer.byteLength(stderr));
      if (available === 0) return;
      stderr += chunk.subarray(0, available).toString('utf8');
    });

    if (!persistent && opts?.signal) {
      const onAbort = () => {
        unregister();
        if (proc.stdin.writable && !proc.stdin.destroyed) {
          // Pi's abort command continues already queued steering messages. Clear
          // them first so `/pi stop` retains its documented stop-all behavior.
          proc.stdin.write('{"type":"clear_queue"}\n{"type":"abort"}\n');
        }
        if (process.platform === 'win32') {
          proc.kill();
        } else {
          proc.kill('SIGTERM');
          forceKillTimer = setTimeout(() => proc.kill('SIGKILL'), 1500);
        }
      };
      const signal = opts.signal;
      signal.addEventListener('abort', onAbort, { once: true });
      proc.on('close', () => signal.removeEventListener('abort', onAbort));
    }

    proc.on('error', (error) => {
      logger.error({ err: error.message }, 'Failed to spawn pi RPC');
      finish({ ok: false, text: '', error: error.message });
    });

    proc.on('close', (code) => {
      if (finished) return;
      if (persistent) {
        const error =
          fatalRpcError ||
          (activeInvocation.closing
            ? 'Pi stop requested; descendant/external job termination is unconfirmed'
            : `Pi RPC connection exited unexpectedly (code ${code ?? 'unknown'}); background work may be interrupted`);
        if (!requestResolve && (!activeInvocation.closing || fatalRpcError) && connectionDelivery) {
          // A disconnect report is not cancelled by disposal of the dead connection.
          void Promise.resolve(
            connectionDelivery.onError(error, new AbortController().signal),
          ).catch((err: Error) =>
            logger.error({ channelFolder, err: err.message }, 'Failed to report RPC disconnect'),
          );
        }
        finish({ ok: false, text: '', error });
        return;
      }
      stderr = stderr.trim();
      void Promise.all([deliveryChain, consumptionChain]).then(() => {
        if (fatalRpcError) {
          finish({ ok: false, text: '', error: fatalRpcError });
          return;
        }
        if (!settled || code !== 0) {
          logger.warn(
            { code, stderr: stderr.slice(0, 500), channelFolder },
            'Pi RPC exited before settling',
          );
          finish({
            ok: false,
            text: '',
            error:
              lastAssistantError ||
              readLatestAgentErrorFromSession(channelFolder) ||
              stderr.slice(0, 600) ||
              `pi RPC exited with code ${code ?? 'unknown'} before agent_settled`,
          });
          return;
        }

        if (lastAssistantFailed) {
          finish({ ok: false, text: '', error: lastAssistantError });
          return;
        }

        if (!lastAssistantText) {
          finish({
            ok: false,
            text: '',
            error:
              lastAssistantError ||
              readLatestAgentErrorFromSession(channelFolder) ||
              stderr.slice(0, 600) ||
              'Pi completed without producing an assistant text message',
          });
          return;
        }
        finish({ ok: true, text: lastAssistantText, ...(workOutcome ? { workOutcome } : {}) });
      });
    });

    const initialize = async () => {
      if (activeInvocation.closing) throw new Error('Pi connection is stopping');
      return sendCommand({ type: 'set_steering_mode', mode: 'all' });
    };
    void initialize()
      .then((response) => {
        if (!response.success) {
          failRpcOutput(response.error || 'Pi rejected all-message steering mode');
          return undefined;
        }
        return submitPrompt();
      })
      .then((response) => {
        if (!response) return;
        if (!response.success) {
          failRpcOutput(response.error || 'Pi rejected the prompt');
          return;
        }
        if (!persistent && !settled && !finished && !fatalRpcError) {
          activeRpcInvocations.set(channelFolder, activeInvocation);
        }
      })
      .catch((error: any) => {
        failRpcOutput(error.message);
      });
  });
}

async function buildPromptWithAttachments(
  channelFolder: string,
  userText: string,
  opts?: { attachments?: string | null; signal?: AbortSignal },
): Promise<string> {
  let attachmentPrompt = '';
  if (opts?.attachments) {
    try {
      const metas: AttachmentMeta[] = JSON.parse(opts.attachments);
      const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const downloaded = await downloadAttachments(metas, channelFolder, messageId, opts.signal);
      attachmentPrompt = buildAttachmentPathPrompt(downloaded);
      if (downloaded.length > 0) {
        logger.info({ channelFolder, count: downloaded.length }, 'Downloaded files for pi');
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to process attachments');
    }
  }
  return attachmentPrompt ? `${userText}\n\n${attachmentPrompt}` : userText;
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block?.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block?.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function buildAttachmentPathPrompt(downloaded: DownloadedFile[]): string {
  if (downloaded.length === 0) return '';

  const lines = downloaded.map((file, index) => {
    const label = downloaded.length === 1 ? 'file' : `file ${index + 1}`;
    return [
      `- ${label}: ${file.originalName}`,
      `  path: ${file.filePath}`,
      `  type: ${file.contentType || 'application/octet-stream'}`,
      `  size: ${file.size} bytes`,
    ].join('\n');
  });

  return [
    '<attachments>',
    'The user attached local files. They are already downloaded on this machine.',
    'Do not assume their contents are loaded into context. Use tools to inspect or convert these paths when needed.',
    ...lines,
    '</attachments>',
  ].join('\n');
}

function readLatestAgentErrorFromSession(channelFolder: string): string | undefined {
  const sessionFile = resolveLatestChannelSessionFile(channelFolder);
  if (!sessionFile || !existsSync(sessionFile)) return undefined;

  let lines: string[];
  try {
    lines = readFileSync(sessionFile, 'utf-8').split(/\r?\n/u);
  } catch {
    return undefined;
  }

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line) continue;

    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          content?: unknown;
          stopReason?: string;
          errorMessage?: string;
        };
      };

      if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;

      if (entry.message.errorMessage) {
        return summarizeAgentError(entry.message.errorMessage);
      }

      if (entry.message.stopReason === 'error') {
        return 'pi stopped with an error but did not record an error message';
      }

      // The newest assistant message was not an error; older errors are not the
      // cause of the empty stdout for this invocation.
      return undefined;
    } catch {
      // Ignore incomplete or malformed trailing JSONL lines.
    }
  }

  return undefined;
}

function summarizeAgentError(errorMessage: string): string {
  const codexJson = errorMessage.match(/Codex error:\s*(\{.*\})/su)?.[1];
  if (codexJson) {
    try {
      const parsed = JSON.parse(codexJson) as {
        error?: { type?: string; code?: string; message?: string };
      };
      const error = parsed.error;
      if (error?.message) {
        const code = error.code || error.type;
        return code ? `${code}: ${error.message}` : error.message;
      }
    } catch {
      // Fall back to the original error message below.
    }
  }

  return errorMessage;
}

export async function getChannelSessionStatus(
  channelFolder: string,
  cwd = config.piCwd,
): Promise<ChannelSessionStatus> {
  const sessionFile = resolveLatestChannelSessionFile(channelFolder);
  if (!sessionFile) {
    return { statsSource: 'none' };
  }

  const createdAt = readSessionCreatedAt(sessionFile);

  try {
    const live = activeRpcInvocations.get(channelFolder);
    let stats: { tokens: SessionTokenUsage; contextUsage?: SessionContextUsage };
    if (live?.request) {
      const response = (await Promise.race([
        live.sendCommand({ type: 'get_session_stats' }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Session stats timed out')), 2500);
          timer.unref();
        }),
      ])) as RpcSessionStatsResponse;
      if (!response.success || !response.data?.tokens)
        throw new Error(response.error || 'No live session stats');
      const tokens = response.data.tokens;
      stats = {
        tokens: {
          input: toNumber(tokens.input),
          output: toNumber(tokens.output),
          cacheRead: toNumber(tokens.cacheRead),
          cacheWrite: toNumber(tokens.cacheWrite),
          total: toNumber(tokens.total),
        },
        contextUsage: response.data.contextUsage
          ? {
              tokens: toNullableNumber(response.data.contextUsage.tokens),
              contextWindow: toNullableNumber(response.data.contextUsage.contextWindow),
              percent: toNullableNumber(response.data.contextUsage.percent),
            }
          : undefined,
      };
    } else {
      stats = await getSessionStatsViaRpc(sessionFile, cwd);
    }
    return {
      sessionFile,
      createdAt,
      tokens: stats.tokens,
      contextUsage: stats.contextUsage,
      statsSource: 'rpc',
    };
  } catch (err: any) {
    logger.warn(
      { err: err.message, sessionFile },
      'Failed to query pi session stats via RPC; falling back to session JSONL',
    );

    return {
      sessionFile,
      createdAt,
      tokens: readSessionTokensFromJsonl(sessionFile),
      statsSource: 'jsonl',
    };
  }
}

interface RpcSessionStatsResponse {
  type: 'response';
  command: 'get_session_stats';
  success: boolean;
  data?: {
    tokens?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
    contextUsage?: {
      tokens?: number | null;
      contextWindow?: number | null;
      percent?: number | null;
    };
  };
  error?: string;
}

async function getSessionStatsViaRpc(
  sessionFile: string,
  cwd: string,
): Promise<{ tokens: SessionTokenUsage; contextUsage?: SessionContextUsage }> {
  const args = ['--mode', 'rpc', '--session', sessionFile];
  const { bin: rpcBin, args: rpcArgs } = resolvePiSpawn(config.piBin, args);

  return new Promise((resolve, reject) => {
    const proc = spawn(rpcBin, rpcArgs, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    let response: RpcSessionStatsResponse | undefined;
    let finished = false;

    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (err) {
        reject(err);
        return;
      }

      if (!response?.success || !response.data?.tokens) {
        reject(new Error(response?.error || 'pi did not return session stats'));
        return;
      }

      resolve({
        tokens: {
          input: toNumber(response.data.tokens.input),
          output: toNumber(response.data.tokens.output),
          cacheRead: toNumber(response.data.tokens.cacheRead),
          cacheWrite: toNumber(response.data.tokens.cacheWrite),
          total: toNumber(response.data.tokens.total),
        },
        contextUsage: response.data.contextUsage
          ? {
              tokens: toNullableNumber(response.data.contextUsage.tokens),
              contextWindow: toNullableNumber(response.data.contextUsage.contextWindow),
              percent: toNullableNumber(response.data.contextUsage.percent),
            }
          : undefined,
      });
    };

    const terminate = () => {
      if (process.platform === 'win32') {
        proc.kill();
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 1000).unref();
      }
    };

    const failOutput = (message: string) => {
      if (finished) return;
      terminate();
      finish(new Error(message));
    };

    const timeout = setTimeout(() => {
      terminate();
      finish(new Error('Timed out waiting for pi session stats'));
    }, 2500);

    proc.stdout.on('data', (chunk: Buffer) => {
      if (finished) return;
      stdout += chunk.toString('utf-8');
      if (Buffer.byteLength(stdout) > MAX_RPC_EVENT_BYTES) {
        failOutput('Pi session stats RPC event exceeded the 4 MiB safety limit');
        return;
      }

      let newlineIndex = stdout.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdout.slice(0, newlineIndex).replace(/\r$/, '').trim();
        stdout = stdout.slice(newlineIndex + 1);

        if (line) {
          try {
            const message = JSON.parse(line) as RpcSessionStatsResponse | { type?: string };
            if (
              message.type === 'response' &&
              (message as RpcSessionStatsResponse).command === 'get_session_stats'
            ) {
              response = message as RpcSessionStatsResponse;
            }
          } catch {
            // Ignore non-JSON output from stdout.
          }
        }

        newlineIndex = stdout.indexOf('\n');
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const available = Math.max(0, MAX_STDERR_BYTES - Buffer.byteLength(stderr));
      if (available > 0) stderr += chunk.subarray(0, available).toString('utf8');
    });
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      const trailingLine = stdout.trim();
      if (trailingLine) {
        try {
          const message = JSON.parse(trailingLine) as RpcSessionStatsResponse | { type?: string };
          if (
            message.type === 'response' &&
            (message as RpcSessionStatsResponse).command === 'get_session_stats'
          ) {
            response = message as RpcSessionStatsResponse;
          }
        } catch {
          // Ignore malformed trailing output on shutdown.
        }
      }

      if (code !== 0) {
        finish(new Error(stderr.trim() || `pi exited with code ${code}`));
        return;
      }

      finish();
    });

    proc.stdin.end('{"type":"get_session_stats"}\n');
  });
}

function readSessionTokensFromJsonl(sessionFile: string): SessionTokenUsage {
  const totals: SessionTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const lines = readFileSync(sessionFile, 'utf-8').split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as {
        type?: string;
        message?: {
          role?: string;
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            totalTokens?: number;
          };
        };
      };

      if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !entry.message.usage) {
        continue;
      }

      const input = toNumber(entry.message.usage.input);
      const output = toNumber(entry.message.usage.output);
      const cacheRead = toNumber(entry.message.usage.cacheRead);
      const cacheWrite = toNumber(entry.message.usage.cacheWrite);

      totals.input += input;
      totals.output += output;
      totals.cacheRead += cacheRead;
      totals.cacheWrite += cacheWrite;
      totals.total +=
        toNumber(entry.message.usage.totalTokens) || input + output + cacheRead + cacheWrite;
    } catch {
      // Ignore incomplete or malformed trailing JSONL lines.
    }
  }

  return totals;
}

function toNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toNullableNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
