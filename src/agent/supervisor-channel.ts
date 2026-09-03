import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { logger } from '../logger.js';

const REQUESTS_DIR = 'requests';
const REPLIES_DIR = 'replies';
const POLL_MS = 1000;
const LOOKBACK_MS = 5000;

export type SupervisorReason = 'need_decision' | 'interview_request' | 'progress_update';

export interface SupervisorRequest {
  type: 'subagent.supervisor.request';
  id: string;
  createdAt: number;
  expiresAt?: number;
  reason: SupervisorReason;
  message: string;
  expectsReply: boolean;
  runId: string;
  agent: string;
  childIndex: number;
  childTarget?: string;
  channelDir: string;
  requestFile: string;
  replyFile: string;
}

export interface SupervisorWatcher {
  stop(): void;
}

export function startSupervisorWatcher(input: {
  signal?: AbortSignal;
  onRequest: (request: SupervisorRequest) => void | Promise<void>;
}): SupervisorWatcher {
  const startedAt = Date.now();
  const seen = new Set<string>();
  let stopped = false;
  let polling = false;

  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      for (const request of listPendingSupervisorRequests()) {
        if (seen.has(request.id)) continue;
        seen.add(request.id);
        if (request.createdAt + LOOKBACK_MS < startedAt) continue;
        await input.onRequest(request);
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Supervisor watcher poll failed');
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => void poll(), POLL_MS);
  setImmediate(() => void poll());

  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  input.signal?.addEventListener('abort', stop, { once: true });

  return { stop };
}

export async function writeSupervisorReply(
  request: Pick<SupervisorRequest, 'id' | 'replyFile'>,
  message: string,
): Promise<void> {
  const reply = {
    type: 'subagent.supervisor.reply',
    requestId: request.id,
    createdAt: Date.now(),
    message,
  };
  await writeFile(request.replyFile, `${JSON.stringify(reply, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function listPendingSupervisorRequests(): SupervisorRequest[] {
  const requests: SupervisorRequest[] = [];
  for (const root of candidateSupervisorRoots()) {
    let channels;
    try {
      channels = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const channel of channels) {
      if (!channel.isDirectory()) continue;
      const channelDir = join(root, channel.name);
      const requestsDir = join(channelDir, REQUESTS_DIR);
      let entries;
      try {
        entries = readdirSync(requestsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const requestFile = join(requestsDir, entry.name);
        const parsed = readSupervisorRequest(requestFile, channelDir);
        if (parsed && parsed.expectsReply && !replyExists(parsed)) {
          requests.push(parsed);
        }
      }
    }
  }
  return requests.sort((a, b) => a.createdAt - b.createdAt);
}

function candidateSupervisorRoots(): string[] {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (configured) return [join(resolve(configured), 'supervisor-channels')];

  let entries;
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('pi-subagents-'))
    .map((entry) => join(tmpdir(), entry.name, 'supervisor-channels'));
}

function readSupervisorRequest(
  requestFile: string,
  channelDir: string,
): SupervisorRequest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(requestFile, 'utf8')) as Partial<SupervisorRequest>;
    if (parsed.type !== 'subagent.supervisor.request') return undefined;
    if (!parsed.id || typeof parsed.id !== 'string') return undefined;
    if (!parsed.message || typeof parsed.message !== 'string') return undefined;
    if (!parsed.runId || typeof parsed.runId !== 'string') return undefined;
    if (!parsed.agent || typeof parsed.agent !== 'string') return undefined;
    if (typeof parsed.childIndex !== 'number') return undefined;
    if (!['need_decision', 'interview_request', 'progress_update'].includes(parsed.reason ?? '')) {
      return undefined;
    }
    const replyFile = join(channelDir, REPLIES_DIR, `${safeSegment(parsed.id)}.json`);
    return {
      type: 'subagent.supervisor.request',
      id: parsed.id,
      createdAt: Number(parsed.createdAt) || Date.now(),
      ...(typeof parsed.expiresAt === 'number' ? { expiresAt: parsed.expiresAt } : {}),
      reason: parsed.reason as SupervisorReason,
      message: parsed.message,
      expectsReply: parsed.expectsReply !== false,
      runId: parsed.runId,
      agent: parsed.agent,
      childIndex: parsed.childIndex,
      ...(typeof parsed.childTarget === 'string' ? { childTarget: parsed.childTarget } : {}),
      channelDir,
      requestFile,
      replyFile,
    };
  } catch {
    return undefined;
  }
}

function replyExists(request: SupervisorRequest): boolean {
  try {
    readFileSync(request.replyFile);
    return true;
  } catch {
    return false;
  }
}

function safeSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}
