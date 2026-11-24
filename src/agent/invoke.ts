import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { type AttachmentMeta } from '../discord/attachments.js';
import { config, currentPiBin, isResidentMode } from '../config.js';
import { logger } from '../logger.js';
import { type DownloadedFile, downloadAttachments } from '../session/media.js';
import {
  readSessionCreatedAt,
  resolveChannelSessionDir,
  resolveLatestChannelSessionFile,
} from '../session/path.js';
import type { AgentResult } from '../types.js';
import { resolvePiSpawn } from './pi-spawn.js';
import { formatAgentTraceEvent } from './trace.js';
import { RuntimeSettingsReconciler, type RuntimeSettings } from './runtime-settings.js';
import {
  isResidentAlive,
  readResidentRecord,
  removeResidentRecord,
  ResidentPiProcess,
  startResidentPi,
  writeResidentRecord,
  type ResidentPiRecord,
  type ResidentSnapshot,
} from './resident-pi.js';

/** Notification marker the agy ACP provider uses for agy text written before a tool call. */
const AGY_PROGRESS_MARKER = '[agy-progress] ';

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
  /** Queue rows carried by this steer; persisted so a later Gateway can complete them. */
  rowids?: number[];
}

export interface ConnectionDelivery {
  onAssistantMessage: (text: string, signal: AbortSignal) => void | Promise<void>;
  onTraceEvent?: (text: string) => void;
  onError: (error: string, signal: AbortSignal) => void | Promise<void>;
}

export interface DesiredAgentSettings {
  model?: string;
  thinking?: string;
  cwd?: string;
}

export interface InvokeOptions {
  /** Re-read persisted selection at admission, not before attachment/catalog awaits. */
  resolveSettings?: () => DesiredAgentSettings;
  model?: string;
  thinking?: string;
  cwd?: string;
  signal?: AbortSignal;
  attachments?: string | null;
  onAssistantMessage?: (text: string) => void | Promise<void>;
  /** Gateway-authored line for the channel; not part of the assistant transcript. */
  onNotice?: (text: string) => void | Promise<void>;
  onInputConsumed?: () => void;
  onTraceEvent?: (text: string) => void;
  connectionDelivery?: ConnectionDelivery;
  /** Queue state for this request, persisted with the resident Pi resume snapshot. */
  snapshotRequest?: () => unknown;
  /** Resolves once the queue has settled this request's row (resident Pi exit ACK). */
  rowSettled?: Promise<void>;
}

interface ActiveRpcInvocation {
  refreshSettings?: () => void;
  settingsStatus?: () => string;
  request?: (prompt: string, opts?: InvokeOptions) => Promise<AgentResult>;
  stop?: () => Promise<void>;
  closing?: boolean;
  trackSteering?: (processing: Promise<void>) => void;
  sendCommand: (command: Record<string, unknown>) => Promise<RpcResponse>;
  sendSteer: (
    message: string,
    onConsumed?: () => void | Promise<void>,
    rowids?: number[],
  ) => Promise<boolean>;
  /** Resident Pi only: hand the Pi to the next Gateway process. */
  detach?: (timeoutMs: number) => Promise<void>;
  reload?: () => void;
  /** `/pi reload` is ending this Pi; new input waits for the next Pi. */
  reloading?: boolean;
  piBin?: string;
}

const activeRpcInvocations = new Map<string, ActiveRpcInvocation>();
/** Set while the Gateway hands resident Pis over; no new Pi may start. */
let handingOver = false;

/** Accept new Pi starts again (Gateway processing loop start). */
export function acceptResidentRequests(): void {
  handingOver = false;
}

/** Polling also covers persisted changes made without a Discord slash command. */
export function refreshResidentSettings(channelFolder?: string): void {
  for (const [folder, connection] of activeRpcInvocations) {
    if (!channelFolder || folder === channelFolder) connection.refreshSettings?.();
  }
}

export function getResidentSettingsStatus(channelFolder: string): string {
  return (
    activeRpcInvocations.get(channelFolder)?.settingsStatus?.() ||
    'No retained runtime; saved settings apply on next request'
  );
}

function runtimeSettings(channelFolder: string, settings?: DesiredAgentSettings): RuntimeSettings {
  return {
    model: settings?.model || config.piModel || undefined,
    thinking: settings?.thinking || config.piThinking || undefined,
    // PI_BIN is not part of the identity: a new binary applies at the next Pi start.
    processIdentity: JSON.stringify([
      resolveChannelSessionDir(channelFolder),
      settings?.cwd || config.piCwd,
      config.piExtraFlags.split(/\s+/).filter(Boolean),
    ]),
  };
}
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

/**
 * Gateway shutdown with resident Pis: leave every Pi running and record where
 * this Gateway stopped so the next one continues. Active requests resolve as
 * `detached`; their queue rows stay `processing`.
 */
export async function detachResidentAgents(timeoutMs: number): Promise<void> {
  handingOver = true;
  await Promise.all(
    [...activeRpcInvocations.values()].map((connection) => connection.detach?.(timeoutMs)),
  );
}

/** End this channel's resident Pi once it has no work; queued messages stay queued. */
export function reloadResidentAgent(channelFolder: string): boolean {
  const connection = activeRpcInvocations.get(channelFolder);
  if (!connection?.reload) return false;
  connection.reload();
  return true;
}

/** `/pi reload` is ending this channel's Pi; its queued messages wait for the next one. */
export function isResidentReloading(channelFolder: string): boolean {
  return Boolean(activeRpcInvocations.get(channelFolder)?.reloading);
}

/** Cheap poll-loop guard: true only while some `/pi reload` is in progress. */
export function hasReloadingResidents(): boolean {
  for (const connection of activeRpcInvocations.values()) if (connection.reloading) return true;
  return false;
}

/** PI_BIN of the running resident Pi, if any. */
export function getResidentPiBin(channelFolder: string): string | undefined {
  return activeRpcInvocations.get(channelFolder)?.piBin;
}

/** Resident Pi left by a previous Gateway process, if it is still running. */
export function readResumableResident(channelFolder: string): ResidentPiRecord | undefined {
  const record = readResidentRecord(channelFolder);
  if (!record) return undefined;
  if (isResidentAlive(record)) return record;
  removeResidentRecord(channelFolder);
  if (record.supervisorTempRoot)
    rmSync(record.supervisorTempRoot, { recursive: true, force: true });
  return undefined;
}

/**
 * Reattach to a resident Pi. With a request in the snapshot the returned
 * promise settles like the original invokeAgent call; otherwise it never does.
 */
export function resumeResidentAgent(
  channelFolder: string,
  record: ResidentPiRecord,
  opts: InvokeOptions & {
    connectionDelivery: ConnectionDelivery;
    steeringConsumed: (rowids: number[]) => void;
  },
): Promise<AgentResult> {
  return new Promise<AgentResult>((resolve) => {
    const proc = new ResidentPiProcess(channelFolder, record, record.snapshot?.lastSeq ?? 0);
    runRpcConnection({
      channelFolder,
      proc,
      persistent: true,
      piBin: record.piBin,
      launchedSettings: record.launchedSettings,
      supervisorTempRoot: record.supervisorTempRoot,
      prompt: '',
      opts: record.snapshot?.request ? opts : undefined,
      resolve,
      connectionDelivery: opts.connectionDelivery,
      resolveSettings: opts.resolveSettings,
      restore: { snapshot: record.snapshot, steeringConsumed: opts.steeringConsumed },
    });
  });
}

const RPC_COMMAND_TIMEOUT_MS = 2 * 60_000;
const RPC_COMPACTION_TIMEOUT_MS = 10 * 60_000;
const MAX_RPC_EVENT_BYTES = 4 * 1024 * 1024;
// Pi events such as tool results and agent_end can embed base64 images that the
// gateway never reads. Accept such raw lines up to this bound, then drop the
// inline image payloads before parsing so the 4 MiB limit still applies to the
// rest of the event.
const MAX_RPC_RAW_LINE_CHARS = 64 * 1024 * 1024;
const INLINE_BASE64_PAYLOAD = /"data":"[A-Za-z0-9+/=]{4096,}"/gu;

/** Remove large inline base64 payloads (image data) from an oversized Pi RPC line. */
export function stripInlineRpcPayloads(rawLine: string): string {
  return rawLine.replace(INLINE_BASE64_PAYLOAD, '"data":""');
}
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
    processingComplete?: Promise<void>;
    rowids?: number[];
  },
): Promise<boolean> {
  const invocation = activeRpcInvocations.get(channelFolder);
  if (!invocation) return false;

  const steering = (async () => {
    const prompt = await buildPromptWithAttachments(channelFolder, userText, opts);
    if (activeRpcInvocations.get(channelFolder) !== invocation) return false;
    return invocation.sendSteer(prompt, opts?.onConsumed, opts?.rowids);
  })();
  // Include attachment preparation and the caller's row-state commit, not just
  // the transport ACK. The queue resolves processingComplete in its finally.
  invocation.trackSteering?.(
    opts?.processingComplete ??
      steering.then(
        () => {},
        () => {},
      ),
  );
  return steering;
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
  const prompt = await buildPromptWithAttachments(channelFolder, userText, opts);
  const selected = opts?.resolveSettings?.() || opts;
  const effectiveCwd = selected?.cwd || config.piCwd;
  const launchedSettings = runtimeSettings(channelFolder, selected);

  if (opts?.signal?.aborted) {
    return { ok: false, text: '', error: 'Agent invocation aborted during shutdown' };
  }

  // `--session` expects a session file. A dedicated session directory plus
  // `--continue` reuses the newest session for this Discord channel.
  const args: string[] = ['--mode', 'rpc', '--session-dir', sessionDir, '--continue'];
  const model = launchedSettings.model;
  if (model) args.push('--model', model);
  const thinking = launchedSettings.thinking;
  if (thinking) args.push('--thinking', thinking);
  if (config.piExtraFlags) args.push(...config.piExtraFlags.split(/\s+/).filter(Boolean));

  const persistent = config.piRpcPersistent;
  if (persistent && handingOver) {
    return { ok: false, text: '', pending: true, error: 'Gateway is restarting; input not sent' };
  }
  const existing = activeRpcInvocations.get(channelFolder);
  if (existing?.request) {
    if (existing.closing || existing.reloading) {
      return {
        ok: false,
        text: '',
        pending: true,
        error: 'Pi connection is stopping; input not sent',
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

  const piBin = currentPiBin();
  const { bin: effectiveBin, args: effectiveArgs } = resolvePiSpawn(piBin, args);
  logger.debug(
    { bin: effectiveBin, args: effectiveArgs, channelFolder, cwd: effectiveCwd },
    'Spawning pi RPC',
  );

  return new Promise<AgentResult>((resolve) => {
    const supervisorTempRoot = mkdtempSync(join(tmpdir(), 'piscord-subagents-'));
    const env = { ...process.env, PI_SUBAGENTS_TEMP_ROOT: supervisorTempRoot };
    const proc: PiRpcProcess = isResidentMode()
      ? startResidentPi({
          channelFolder,
          bin: effectiveBin,
          args: effectiveArgs,
          cwd: effectiveCwd,
          env,
          piBin,
          launchedSettings,
          supervisorTempRoot,
        })
      : spawn(effectiveBin, effectiveArgs, {
          cwd: effectiveCwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
    runRpcConnection({
      channelFolder,
      proc,
      persistent,
      piBin,
      launchedSettings,
      supervisorTempRoot,
      prompt,
      opts,
      resolve,
      connectionDelivery: opts?.connectionDelivery,
      resolveSettings: opts?.resolveSettings,
    });
  });
}

/** What invoke.ts uses of a Pi RPC process: a stdio child or a resident Pi socket. */
interface PiRpcProcess {
  stdin: {
    writable: boolean;
    destroyed: boolean;
    write(data: string, callback?: (error?: Error | null) => void): boolean;
    end(data?: string): void;
    on(event: 'error', listener: (error: Error) => void): unknown;
  };
  stdout: { on(event: string, listener: (...args: any[]) => void): unknown };
  stderr: { on(event: string, listener: (...args: any[]) => void): unknown };
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

interface RpcConnectionSetup {
  channelFolder: string;
  proc: PiRpcProcess;
  persistent: boolean;
  piBin: string;
  launchedSettings: RuntimeSettings;
  supervisorTempRoot: string;
  prompt: string;
  opts?: InvokeOptions;
  resolve: (result: AgentResult) => void;
  connectionDelivery?: ConnectionDelivery;
  resolveSettings?: () => DesiredAgentSettings;
  /** Reattach to a resident Pi left by a previous Gateway process. */
  restore?: { snapshot?: ResidentSnapshot; steeringConsumed: (rowids: number[]) => void };
}

function runRpcConnection(setup: RpcConnectionSetup): void {
  const { channelFolder, proc, persistent, launchedSettings, supervisorTempRoot, resolve } = setup;
  let { prompt, opts } = setup;
  {
    const decoder = new StringDecoder('utf8');
    const pendingCommands = new Map<
      string,
      {
        resolve: (response: RpcResponse) => void;
        reject: (error: Error) => void;
        setCompacting: (active: boolean) => void;
      }
    >();
    let compacting = false;
    const pendingSteeringMessages: PendingSteeringMessage[] = [];
    const connectionController = new AbortController();
    const connectionDelivery = setup.connectionDelivery;
    const resident = proc instanceof ResidentPiProcess ? proc : undefined;
    let requestResolve: ((result: AgentResult) => void) | undefined = resolve;
    let detaching = false;
    let reloadRequested = false;
    let checkpointTimer: NodeJS.Timeout | undefined;
    let deliveriesInFlight = 0;
    // Prompt command whose response the previous Gateway did not see (resume only).
    let orphanPromptId: string | undefined;
    let promptCommandId: string | undefined;
    let consumptionsInFlight = 0;
    // Queue row of the latest request; a resident Pi's exit is acknowledged after it settles.
    let requestRowSettled = opts?.rowSettled;
    let removeRequestAbort = () => {};
    let closeResolve!: () => void;
    const closed = new Promise<void>((done) => {
      closeResolve = done;
    });
    let stopPromise: Promise<void> | undefined;

    // Partial line pieces since the last newline, joined only when the line completes
    // so a large event is not re-copied and re-scanned on every chunk.
    let pendingParts: string[] = [];
    let pendingLength = 0;
    let stderr = '';
    let fatalRpcError = '';
    let pendingDeliveryBytes = 0;
    let commandSequence = 0;
    let lastAssistantText = '';
    let lastDeliveredText = '';
    // Pi may make several text-only continuation turns while one work checkpoint stays active.
    // Preserve every turn in Pi's transcript/context, but expose at most one intermediate
    // assistant message per user/native-input boundary. Explicit work-control output remains
    // separately deliverable through the work_contract event.
    let intermediateTextDelivered = false;
    // Latest agy progress text posted to the channel. The agy provider repeats it as the
    // finish_work summary when nothing new remains, and that summary is not posted again.
    let lastAgyProgressText = '';
    let workOutcome: AgentResult['workOutcome'];
    let lastAssistantError = '';
    // Error text of the latest assistant turn only, used as the cause of a later suspension.
    let lastProviderError = '';
    let lastAssistantFailed = false;
    // Pi parks the parent after a successful async launch; the native completion
    // notice resumes it later. A parked run is waiting, not a missing reply.
    let parked = false;
    let settled = false;
    let currentRunId: string | undefined;
    let requestRunId: string | undefined;
    let steeringClosed = false;
    const steeringProcessing = new Set<Promise<void>>();
    let finished = false;
    let initialPromptObserved = false;
    let promptSubmitted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let legacySettleTimer: NodeJS.Timeout | undefined;
    // Only an observed legacy agent_end authorizes the legacy idle fallback.
    let legacyAgentEndPending = false;
    let deliveryChain = Promise.resolve();
    let consumptionChain = Promise.resolve();
    let settingsNotice: string | undefined;

    const sendCommand = (command: Record<string, unknown>): Promise<RpcResponse> => {
      if (!proc.stdin.writable || proc.stdin.destroyed) {
        return Promise.reject(new Error('Pi RPC stdin is closed'));
      }

      const id = `piscord-${++commandSequence}`;
      return new Promise<RpcResponse>((resolveCommand, rejectCommand) => {
        let timer: NodeJS.Timeout | undefined;
        let compactionDeadline: number | undefined;
        let commandCompacting = false;
        const armTimeout = (delayMs: number) => {
          clearTimeout(timer);
          timer = setTimeout(
            () => {
              pendingCommands.delete(id);
              rejectCommand(new Error(`Pi RPC command timed out: ${String(command.type)}`));
            },
            Math.max(0, delayMs),
          );
        };
        const setCompacting = (active: boolean) => {
          if (!persistent || command.type !== 'prompt' || active === commandCompacting) return;
          commandCompacting = active;
          // Prompt acceptance follows preflight, which can include summarization.
          // Establish the long deadline once: duplicate events/retries cannot renew it.
          compactionDeadline ??= Date.now() + RPC_COMPACTION_TIMEOUT_MS;
          const remaining = compactionDeadline - Date.now();
          armTimeout(active ? remaining : Math.min(RPC_COMMAND_TIMEOUT_MS, remaining));
        };
        if (persistent) armTimeout(RPC_COMMAND_TIMEOUT_MS);
        setCompacting(compacting);
        if (command.type === 'prompt') promptCommandId = id;
        pendingCommands.set(id, {
          setCompacting,
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
      rowids?: number[],
    ): Promise<boolean> => {
      // Steering has priority over follow-ups in Pi. Do not let it become
      // the user event that identifies a still-unconsumed initial prompt.
      if (
        activeInvocation.closing ||
        detaching ||
        // `/pi reload`: later messages wait for the next Pi instead of joining this one.
        reloadRequested ||
        (persistent &&
          (!requestResolve || !initialPromptObserved || steeringClosed || !requestRunId))
      )
        return false;
      const request: PendingSteeringMessage = { message, consumed: false, onConsumed, rowids };
      pendingSteeringMessages.push(request);

      try {
        const response = await sendCommand({
          type: 'steer',
          message,
          ...(persistent ? { expectedRunId: requestRunId } : {}),
        });
        if (!response.success) {
          removePendingSteering(request);
          throw new Error(response.error || 'Pi rejected the steering message');
        }

        if (persistent) {
          const data = response.data as { accepted?: boolean; reason?: string } | undefined;
          if (
            data?.accepted === false &&
            data.reason === 'run_not_accepting' &&
            !request.consumed
          ) {
            removePendingSteering(request);
            return false;
          }
          if (data?.accepted !== true)
            throw new Error('Pi returned an invalid guarded steering acknowledgement');
          noticeUnappliedSettings();
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
    const activeInvocation: ActiveRpcInvocation = { sendCommand, sendSteer, piBin: setup.piBin };
    // Retain only the settings source, never completed request callbacks/signals.
    let desiredOptions: DesiredAgentSettings = {
      model: opts?.model,
      thinking: opts?.thinking,
      cwd: opts?.cwd,
    };
    let resolveDesiredSettings = setup.resolveSettings;
    const readDesired = () =>
      runtimeSettings(channelFolder, resolveDesiredSettings?.() || desiredOptions);
    const settings = new RuntimeSettingsReconciler(
      launchedSettings,
      readDesired,
      sendCommand,
      () =>
        !activeInvocation.closing && activeRpcInvocations.get(channelFolder) === activeInvocation,
    );

    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      activeInvocation.closing = true;
      connectionController.abort();
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
      intermediateTextDelivered = false;
      lastAgyProgressText = '';
      workOutcome = undefined;
      lastAssistantError = '';
      lastProviderError = '';
      lastAssistantFailed = false;
      parked = false;
    };

    /** Tell the user once per distinct reason, only alongside input Pi accepted. */
    const noticeUnappliedSettings = () => {
      const notice = settings.unappliedNotice();
      if (!notice) settingsNotice = undefined;
      else if (notice !== settingsNotice && opts?.onNotice) {
        enqueueRpcDelivery(notice, opts.onNotice, 'error');
        settingsNotice = notice;
      }
    };

    const deferUnsentRequest = (reason: string) => {
      const done = requestResolve;
      requestResolve = undefined;
      opts = undefined;
      removeRequestAbort();
      done?.({ ok: false, text: '', pending: true, error: reason });
    };

    const submitPrompt = async (): Promise<RpcResponse | undefined> => {
      let settingsRevision: number | undefined;
      if (persistent) {
        // Unapplied settings never hold input back: it runs on the applied selection.
        const admission = await settings.reconcile();
        if (activeInvocation.closing || finished || detaching) return undefined;
        const state = await sendCommand({ type: 'get_state' });
        const data = state.data as
          | {
              sessionId?: string;
              pendingMessageCount?: number;
              settingsRevision?: number;
              capabilities?: { guardedSteer?: number };
            }
          | undefined;
        if (!state.success || typeof data?.pendingMessageCount !== 'number') {
          throw new Error('Pi did not return pendingMessageCount for request admission');
        }
        if (activeInvocation.closing || detaching) return undefined;
        if (data.capabilities?.guardedSteer !== 1 || data.pendingMessageCount !== 0) {
          const done = requestResolve;
          requestResolve = undefined;
          opts = undefined;
          removeRequestAbort();
          done?.({
            ok: false,
            text: '',
            error:
              data.capabilities?.guardedSteer !== 1
                ? 'Pi must be updated to support guarded steering; request was not sent.'
                : 'Pi already has pending user messages; request was not sent. Wait before retrying.',
          });
          return undefined;
        }
        settingsRevision = admission.ready ? admission.revision : data.settingsRevision;
      }
      if (persistent && (activeInvocation.closing || finished || detaching)) return undefined;
      // A selection saved from here on is reconciled in the background and
      // takes effect at Pi's next turn boundary.
      promptSubmitted = true;
      const response = await sendCommand({
        type: 'prompt',
        message: prompt,
        streamingBehavior: 'followUp',
        ...(settingsRevision === undefined ? {} : { expectedSettingsRevision: settingsRevision }),
      });
      if (
        persistent &&
        response.success === false &&
        response.command === 'prompt' &&
        typeof response.error === 'string' &&
        !initialPromptObserved
      ) {
        // A semantic preflight failure can follow effectful hooks. It fails this
        // request without replay, not the connection or independent child work.
        // Malformed/uncertain transport responses still take failRpcOutput.
        const done = requestResolve;
        requestResolve = undefined;
        promptSubmitted = false;
        steeringClosed = true;
        opts = undefined;
        removeRequestAbort();
        done?.({ ok: false, text: '', error: response.error || 'Pi rejected the prompt' });
        return undefined;
      }
      if (settingsRevision !== undefined && response.success) {
        const data = response.data as { accepted?: boolean; reason?: string } | undefined;
        if (
          data?.accepted === false &&
          ['busy', 'settings_changed'].includes(data.reason || '') &&
          !initialPromptObserved
        ) {
          promptSubmitted = false;
          deferUnsentRequest(`Pi ${data.reason}; input not accepted, retrying automatically`);
          return undefined;
        }
        if (data?.accepted !== true)
          throw new Error('Invalid guarded prompt acknowledgement; delivery uncertain');
      }
      if (persistent && response.success) noticeUnappliedSettings();
      return response;
    };

    if (persistent) {
      activeInvocation.trackSteering = (processing) => {
        if (!requestResolve || steeringClosed) return;
        steeringProcessing.add(processing);
        void processing.finally(() => steeringProcessing.delete(processing)).catch(() => {});
      };
      activeInvocation.settingsStatus = () => settings.describe();
      activeInvocation.refreshSettings = () => {
        if (!activeInvocation.closing) settings.refresh();
      };
      activeInvocation.stop = stop;
      activeInvocation.request = (nextPrompt, nextOpts) => {
        if (detaching || activeInvocation.reloading) {
          return Promise.resolve({
            ok: false,
            text: '',
            pending: true,
            error: 'Pi connection is handing over; input not sent',
          });
        }
        if (requestResolve || activeInvocation.closing) {
          return Promise.resolve({
            ok: false,
            text: '',
            error: 'Pi connection already has a request or is stopping',
          });
        }
        prompt = nextPrompt;
        opts = nextOpts;
        requestRowSettled = nextOpts?.rowSettled;
        desiredOptions = {
          model: nextOpts?.model,
          thinking: nextOpts?.thinking,
          cwd: nextOpts?.cwd,
        };
        resolveDesiredSettings = nextOpts?.resolveSettings;
        settled = false;
        steeringClosed = false;
        requestRunId = undefined;
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
      activeInvocation.reload = () => {
        reloadRequested = true;
        maybeReload();
        scheduleCheckpoint();
      };
      activeInvocation.detach = detach;
      activeRpcInvocations.set(channelFolder, activeInvocation);
      attachRequestAbort();
    }

    // ── Resident Pi hand-over (docs/design/resident-pi.md) ──

    /** Everything needed to continue this connection in another Gateway process. */
    function captureSnapshot(): ResidentSnapshot {
      return {
        lastSeq: resident!.lastSeq,
        connection: {
          commandSequence,
          compacting,
          lastAssistantText,
          lastDeliveredText,
          intermediateTextDelivered,
          lastAgyProgressText,
          workOutcome,
          lastAssistantError,
          lastProviderError,
          lastAssistantFailed,
          parked,
          settled,
          currentRunId,
          requestRunId,
          steeringClosed,
          initialPromptObserved,
          promptSubmitted,
          legacyAgentEndPending,
          settingsNotice,
          reloadRequested,
          orphanPromptId:
            promptCommandId && pendingCommands.has(promptCommandId)
              ? promptCommandId
              : orphanPromptId,
        },
        ...(requestResolve && promptSubmitted
          ? { request: { queue: opts?.snapshotRequest?.() ?? null } }
          : {}),
        steering: pendingSteeringMessages
          .filter((request) => request.rowids?.length)
          .map((request) => ({ message: request.message, rowids: request.rowids! })),
      };
    }

    function writeCheckpoint(): void {
      if (!resident || finished) return;
      const record = readResidentRecord(channelFolder);
      if (!record || record.hostPid !== resident.hostPid) return;
      const snapshot = captureSnapshot();
      writeResidentRecord(channelFolder, { ...record, snapshot });
      resident.ack(snapshot.lastSeq);
    }

    /** Persist only at points where every delivery for processed lines is done. */
    function scheduleCheckpoint(): void {
      if (!resident || detaching || finished || checkpointTimer) return;
      checkpointTimer = setTimeout(() => {
        checkpointTimer = undefined;
        if (detaching || finished) return;
        if (deliveriesInFlight > 0 || consumptionsInFlight > 0) scheduleCheckpoint();
        else writeCheckpoint();
      }, 200);
      checkpointTimer.unref();
    }

    function restoreSnapshot(restore: NonNullable<RpcConnectionSetup['restore']>): void {
      const state = (restore.snapshot?.connection ?? {}) as Record<string, any>;
      commandSequence = state.commandSequence ?? 0;
      compacting = state.compacting ?? false;
      lastAssistantText = state.lastAssistantText ?? '';
      lastDeliveredText = state.lastDeliveredText ?? '';
      intermediateTextDelivered = state.intermediateTextDelivered ?? false;
      lastAgyProgressText = state.lastAgyProgressText ?? '';
      workOutcome = state.workOutcome;
      lastAssistantError = state.lastAssistantError ?? '';
      lastProviderError = state.lastProviderError ?? '';
      lastAssistantFailed = state.lastAssistantFailed ?? false;
      parked = state.parked ?? false;
      settled = state.settled ?? false;
      currentRunId = state.currentRunId;
      requestRunId = state.requestRunId;
      steeringClosed = state.steeringClosed ?? false;
      initialPromptObserved = state.initialPromptObserved ?? false;
      promptSubmitted = state.promptSubmitted ?? false;
      legacyAgentEndPending = state.legacyAgentEndPending ?? false;
      settingsNotice = state.settingsNotice;
      reloadRequested = state.reloadRequested ?? false;
      orphanPromptId = state.orphanPromptId;
      if (!restore.snapshot?.request) {
        requestResolve = undefined;
        opts = undefined;
      }
      for (const steer of restore.snapshot?.steering ?? []) {
        pendingSteeringMessages.push({
          message: steer.message,
          consumed: false,
          rowids: steer.rowids,
          onConsumed: () => restore.steeringConsumed(steer.rowids),
        });
      }
      logger.info(
        {
          channelFolder,
          hostPid: resident?.hostPid,
          lastSeq: resident?.lastSeq,
          request: Boolean(restore.snapshot?.request),
        },
        'Reattached resident Pi',
      );
      maybeReload();
    }

    /** `/pi reload`: end Pi's input once no request or parked async work remains. */
    function maybeReload(): void {
      if (!reloadRequested || requestResolve || parked) return;
      if (activeInvocation.closing || detaching || finished || activeInvocation.reloading) return;
      activeInvocation.reloading = true;
      logger.info({ channelFolder }, 'Ending resident Pi for reload');
      proc.stdin.end();
    }

    /** Gateway shutdown: leave Pi running and hand its state to the next Gateway. */
    async function detach(timeoutMs: number): Promise<void> {
      if (!resident || finished || detaching) return;
      detaching = true;
      const deadline = Date.now() + timeoutMs;
      while (
        Date.now() < deadline &&
        !finished &&
        (steeringProcessing.size > 0 || pendingCommands.size > 0)
      ) {
        await new Promise((done) => setTimeout(done, 20));
      }
      if (finished) return;
      resident.pause();
      if (requestResolve && !promptSubmitted) {
        // Definitely unsent: the row returns to pending as before.
        deferUnsentRequest('Gateway is restarting; input not sent');
      }
      await Promise.all([deliveryChain, consumptionChain]);
      if (finished) return;
      if (checkpointTimer) clearTimeout(checkpointTimer);
      checkpointTimer = undefined;
      writeCheckpoint();
      finished = true;
      if (legacySettleTimer) clearTimeout(legacySettleTimer);
      unregister();
      resident.detach();
      for (const pending of pendingCommands.values()) {
        pending.reject(new Error('Gateway is restarting'));
      }
      pendingCommands.clear();
      removeRequestAbort();
      connectionController.abort();
      closeResolve();
      const done = requestResolve;
      requestResolve = undefined;
      opts = undefined;
      done?.({ ok: false, text: '', detached: true });
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
      if (checkpointTimer) clearTimeout(checkpointTimer);
      unregister();
      if (resident?.piExited) {
        // Keep the host (and its record) reattachable until this exit is fully handled.
        void Promise.all([deliveryChain, consumptionChain, requestRowSettled]).then(() => {
          removeResidentRecord(channelFolder, resident.hostPid);
          resident.ackExit();
        });
      } else if (resident) removeResidentRecord(channelFolder, resident.hostPid);
      rmSync(supervisorTempRoot, { recursive: true, force: true });
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
      if (fatalRpcError || finished || detaching) return;
      fatalRpcError = error;
      pendingParts = [];
      pendingLength = 0;
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
      deliveriesInFlight++;
      deliveryChain = deliveryChain
        .then(() => deliver(text))
        .catch((error: Error) => {
          logger.error({ channelFolder, err: error.message }, 'Failed to deliver live RPC message');
        })
        .finally(() => {
          pendingDeliveryBytes -= deliveryBytes;
          deliveriesInFlight--;
        });
    };

    const assistantDelivery = () =>
      (!persistent || initialPromptObserved ? opts?.onAssistantMessage : undefined) ||
      (connectionDelivery
        ? (text: string) => connectionDelivery.onAssistantMessage(text, connectionController.signal)
        : undefined);

    const handleRpcMessage = (message: any) => {
      if (message?.type === 'response' && typeof message.id === 'string') {
        const pending = pendingCommands.get(message.id);
        if (pending) {
          pendingCommands.delete(message.id);
          pending.resolve(message as RpcResponse);
        } else if (message.id === orphanPromptId) {
          orphanPromptId = undefined;
          const data = message.data as { accepted?: boolean } | undefined;
          if (!initialPromptObserved && (!message.success || data?.accepted === false)) {
            // The prompt the previous Gateway sent was not accepted: nothing ran.
            promptSubmitted = false;
            deferUnsentRequest(message.error || 'Pi did not accept the input; retrying');
          }
        }
        return;
      }

      if (message?.type === 'compaction_start' || message?.type === 'compaction_end') {
        compacting = message.type === 'compaction_start';
        for (const pending of pendingCommands.values()) pending.setCompacting(compacting);
      }

      emitTrace(formatAgentTraceEvent(message));

      if (
        message?.type === 'extension_ui_request' &&
        message.method === 'notify' &&
        typeof message.message === 'string' &&
        message.message.startsWith(AGY_PROGRESS_MARKER)
      ) {
        const text = message.message.slice(AGY_PROGRESS_MARKER.length).trim();
        const deliver = assistantDelivery();
        if (text && deliver) {
          lastAgyProgressText = text;
          enqueueRpcDelivery(text, deliver);
        }
        return;
      }

      const markSteeringConsumed = (userText: string) => {
        const request = pendingSteeringMessages.find((candidate) => candidate.message === userText);
        if (!request) return false;
        request.consumed = true;
        removePendingSteering(request);
        if (request.onConsumed) {
          consumptionsInFlight++;
          consumptionChain = consumptionChain
            .then(() => request.onConsumed!())
            .catch((error: any) => {
              logger.error(
                { channelFolder, err: error.message },
                'Failed to record consumed steering message',
              );
            })
            .finally(() => {
              consumptionsInFlight--;
            });
        }
        return true;
      };

      if (message?.type === 'message_start' && message.message?.role === 'user') {
        const userText = extractUserText(message.message.content);
        // RPC events carry no command ID. Admission requires an empty user
        // queue; concurrent extension sendUserMessage is outside this contract.
        if (!initialPromptObserved && (persistent ? promptSubmitted : userText === prompt)) {
          initialPromptObserved = true;
          opts?.onInputConsumed?.();
          requestRunId = currentRunId;
          if (persistent) resetOutput();
          return;
        }

        // A queued user message is a new public-response boundary even when Pi consumes
        // it inside the same physical agent run.
        intermediateTextDelivered = false;
        markSteeringConsumed(userText);
        return;
      }

      if (message?.type === 'steering_consumed' && typeof message.message === 'string') {
        markSteeringConsumed(message.message);
        return;
      }

      if (message?.type === 'message_start' && message.message?.role === 'assistant') {
        parked = false;
        return;
      }

      if (
        message?.type === 'tool_execution_end' &&
        message.isError !== true &&
        message.result?.terminate === true &&
        message.result?.park === true
      ) {
        parked = true;
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
        lastProviderError = lastAssistantError;
        if (text && (!persistent || !intermediateTextDelivered)) {
          lastAssistantText = text;
          intermediateTextDelivered = true;
          const deliver = assistantDelivery();
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
          lastProviderError = '';
        } else if (record?.status === 'awaiting_input' && typeof record.question === 'string') {
          workOutcome = undefined;
          lastAssistantText = record.question;
          lastAssistantFailed = false;
          lastAssistantError = '';
          lastProviderError = '';
        } else if (record?.status === 'suspended') {
          const reason = typeof record.reason === 'string' ? record.reason : 'Work suspended';
          // A suspension right after a failed provider turn is only the consequence;
          // keep the underlying provider error visible instead of the generic reason.
          const cause = lastProviderError;
          lastAssistantFailed = true;
          lastAssistantError = cause && cause !== reason ? `${cause} (${reason})` : reason;
        }
        if (
          (record?.status === 'resolved' && typeof record.decision?.summary === 'string') ||
          (record?.status === 'awaiting_input' && typeof record.question === 'string')
        ) {
          const deliver = assistantDelivery();
          if (deliver && lastAssistantText.trim() !== lastAgyProgressText) {
            enqueueRpcDelivery(lastAssistantText, deliver);
          }
          lastAgyProgressText = '';
        }
        return;
      }

      if (message?.type === 'agent_settled') {
        // An older native run can settle while the next prompt is in preflight.
        if (
          persistent &&
          requestResolve &&
          (!initialPromptObserved || (requestRunId && message.runId !== requestRunId))
        )
          return;
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
          currentRunId = typeof message.runId === 'string' ? message.runId : undefined;
          legacyAgentEndPending = false;
          // Native completion and a fresh prompt start a new physical run. Automatic
          // text-only continuation turns do not emit agent_start and stay suppressed.
          intermediateTextDelivered = false;
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
      if (!fatalRpcError && !lastAssistantFailed && !lastAssistantText && parked) {
        return { ok: true, text: '', parked: true };
      }
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
          steeringClosed = true;
          const done = requestResolve!;
          // Snapshot output and callback chains at the request boundary. Later
          // unsolicited events belong to the connection, not this request.
          opts = undefined;
          removeRequestAbort();
          requestResolve = undefined;
          const processing = [...steeringProcessing];
          void Promise.allSettled(processing)
            .then(() => Promise.all([deliveryChain, consumptionChain]))
            .then(() => done(result));
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
        maybeReload();
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

    const consumeLine = (inputLine: string) => {
      let rawLine = inputLine;
      if (Buffer.byteLength(rawLine) > MAX_RPC_EVENT_BYTES) {
        rawLine = stripInlineRpcPayloads(rawLine);
        if (Buffer.byteLength(rawLine) > MAX_RPC_EVENT_BYTES) {
          failRpcOutput('Pi RPC event exceeded the 4 MiB safety limit');
          return;
        }
      }
      const line = rawLine.replace(/\r$/u, '');
      if (!line) return;
      try {
        handleRpcMessage(JSON.parse(line));
        scheduleCheckpoint();
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
      let text = decoder.write(chunk);
      let newlineIndex = text.indexOf('\n');
      while (newlineIndex !== -1 && !fatalRpcError) {
        pendingParts.push(text.slice(0, newlineIndex));
        const line = pendingParts.join('');
        pendingParts = [];
        pendingLength = 0;
        consumeLine(line);
        text = text.slice(newlineIndex + 1);
        newlineIndex = text.indexOf('\n');
      }
      if (fatalRpcError || !text) return;
      pendingParts.push(text);
      // UTF-16 length is a lower bound on the UTF-8 byte count; the precise
      // 4 MiB byte check runs on each complete line in consumeLine.
      pendingLength += text.length;
      if (pendingLength > MAX_RPC_RAW_LINE_CHARS) {
        failRpcOutput('Pi RPC event exceeded the 4 MiB safety limit');
      }
    });
    proc.stdout.on('end', () => {
      if (fatalRpcError) return;
      pendingParts.push(decoder.end());
      const rest = pendingParts.join('');
      pendingParts = [];
      pendingLength = 0;
      if (rest) consumeLine(rest);
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
        const reloaded = activeInvocation.reloading && resident?.piExited && !fatalRpcError;
        const error =
          fatalRpcError ||
          (activeInvocation.closing
            ? 'Pi stop requested; descendant/external job termination is unconfirmed'
            : reloaded
              ? 'Pi ended for reload'
              : resident && !resident.piExited
                ? 'Lost the connection to the resident Pi; background work may be interrupted'
                : `Pi RPC connection exited unexpectedly (code ${code ?? 'unknown'}); background work may be interrupted`);
        if (!reloaded && !activeInvocation.closing) {
          logger.warn(
            { code, stderr: stderr.trim().slice(0, 500), channelFolder },
            'Pi RPC connection closed',
          );
        }
        if (
          !requestResolve &&
          !reloaded &&
          (!activeInvocation.closing || fatalRpcError) &&
          connectionDelivery
        ) {
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
    if (setup.restore) {
      restoreSnapshot(setup.restore);
      return;
    }
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
  }
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
  const { bin: rpcBin, args: rpcArgs } = resolvePiSpawn(currentPiBin(), args);

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
