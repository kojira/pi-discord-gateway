import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as db from '../src/db.js';
import { startProcessingLoop, stopProcessingLoop } from '../src/agent/queue.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  send: vi.fn(async () => true),
  rowBarrier: undefined as Promise<void> | undefined,
}));
vi.mock('../src/agent/invoke.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/invoke.js')>();
  return {
    ...actual,
    steerActiveAgent: async (...args: Parameters<typeof actual.steerActiveAgent>) => {
      const result = await actual.steerActiveAgent(...args);
      await mocks.rowBarrier;
      return result;
    },
  };
});
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/discord/client.js', () => ({
  sendResponse: mocks.send,
  setTyping: vi.fn(async () => {}),
}));
vi.mock('../src/discord/webhook-monitor.js', () => ({
  enqueueWebhookTrace: vi.fn(),
  enqueueWebhookTerminal: vi.fn(),
  flushWebhookTrace: vi.fn(async () => {}),
}));

const original = { ...config };
let root: string;
let reader: Database.Database;
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  const stopped = stopProcessingLoop({ timeoutMs: 0 });
  await vi.advanceTimersByTimeAsync(5000);
  await stopped;
  reader?.close();
  db.closeDb();
  Object.assign(config, original);
  mocks.rowBarrier = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

type Command = { id: string; type: string; message?: string; expectedRunId?: string };
function fixture(capability = true) {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'piscord-guarded-queue-'));
  Object.assign(config, {
    dbPath: join(root, 'db'),
    sessionsDir: join(root, 'sessions'),
    piCwd: root,
    piBin: 'fixture',
    piModel: '',
    piThinking: '',
    piExtraFlags: '',
    piRpcPersistent: true,
    pollInterval: 10,
    maxConcurrency: 1,
  });
  db.initDb();
  reader = new Database(config.dbPath, { readonly: true });
  db.registerChannel({
    jid: 'synthetic',
    folder: 'synthetic',
    name: 'Fixture',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  const proc = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: Command[] = [];
  const emit = (value: object) => stdout.write(JSON.stringify(value) + '\n');
  const ack = (c: Command, data?: object) =>
    emit({ type: 'response', id: c.id, command: c.type, success: true, data });
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split('\n')) {
        const c: Command = JSON.parse(line);
        commands.push(c);
        if (c.type === 'get_state')
          ack(c, {
            pendingMessageCount: 0,
            capabilities: capability ? { guardedSteer: 1 } : undefined,
          });
        else if (c.type !== 'steer') ack(c);
      }
      callback();
    },
  });
  stdin.on('finish', () => proc.emit('close', 0));
  mocks.spawn.mockReturnValue(
    Object.assign(proc, {
      stdin,
      stdout,
      stderr,
      kill: () => {
        proc.emit('close', 0);
        return true;
      },
    }),
  );
  const enqueue = (content: string) =>
    db.enqueueMessage({
      channelJid: 'synthetic',
      sender: 'user',
      senderName: 'User',
      content,
      timestamp: '2020-01-01T00:00:00Z',
    });
  const rows = () =>
    reader.prepare('select content, status from message_queue order by rowid').all();
  const start = (prompt: string, runId: string) => {
    emit({ type: 'agent_start', runId });
    emit({ type: 'message_start', message: { role: 'user', content: prompt } });
  };
  const decision = (summary: string) =>
    emit({
      type: 'work_contract',
      record: { status: 'resolved', decision: { outcome: 'completed', summary } },
    });
  return { commands, emit, ack, enqueue, rows, start, decision };
}

it.each(['ack-first', 'settled-first'] as const)(
  'commits a definite decline before finalization and dispatches it after delivery (%s)',
  async (order) => {
    const f = fixture();
    f.enqueue('initial');
    startProcessingLoop();
    await vi.advanceTimersByTimeAsync(0);
    const initial = f.commands.find((c) => c.type === 'prompt')!;
    f.start(initial.message!, 'run-one');
    f.enqueue('late');
    await vi.advanceTimersByTimeAsync(10);
    const steer = f.commands.find((c) => c.type === 'steer')!;
    expect(steer).toBeDefined();
    let release!: () => void;
    mocks.send.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
          releases.push(release);
        }),
    );
    f.decision('first result');
    if (order === 'ack-first') f.ack(steer, { accepted: false, reason: 'run_not_accepting' });
    f.emit({ type: 'agent_settled', runId: 'run-one' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.rows()[0]).toEqual({ content: 'initial', status: 'processing' });
    if (order === 'settled-first') f.ack(steer, { accepted: false, reason: 'run_not_accepting' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.rows()).toEqual([
      { content: 'initial', status: 'processing' },
      { content: 'late', status: 'pending' },
    ]);
    expect(f.commands.filter((c) => c.type === 'prompt')).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(10);
    const next = f.commands.filter((c) => c.type === 'prompt')[1];
    expect(next.message).toContain('late');
    f.start(next.message!, 'run-two');
    f.decision('second result');
    f.emit({ type: 'agent_settled', runId: 'run-two' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.rows()).toEqual([
      { content: 'initial', status: 'done' },
      { content: 'late', status: 'done' },
    ]);
    expect(mocks.send.mock.calls.map((call) => call[1])).toEqual(['first result', 'second result']);
    expect(steer.expectedRunId).toBe('run-one');
  },
);

it.each(['accepted', 'uncertain'] as const)(
  'waits for late %s row processing and never replays sent input',
  async (outcome) => {
    const f = fixture();
    f.enqueue('initial');
    startProcessingLoop();
    await vi.advanceTimersByTimeAsync(0);
    f.start(f.commands.find((c) => c.type === 'prompt')!.message!, 'run-one');
    f.enqueue('sent');
    await vi.advanceTimersByTimeAsync(10);
    const steer = f.commands.find((c) => c.type === 'steer')!;
    f.decision('same');
    f.decision('same');
    f.emit({ type: 'agent_settled', runId: 'run-one' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.rows()[0]).toEqual({ content: 'initial', status: 'processing' });
    if (outcome === 'accepted') {
      f.emit({ type: 'steering_consumed', message: steer.message });
      f.ack(steer, { accepted: true });
    } else
      f.emit({
        type: 'response',
        id: steer.id,
        command: 'steer',
        success: false,
        error: 'uncertain',
        errorCode: 'STEER_DELIVERY_UNCERTAIN',
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.rows()).toEqual([
      { content: 'initial', status: 'done' },
      { content: 'sent', status: outcome === 'accepted' ? 'done' : 'failed' },
    ]);
    expect(f.commands.filter((c) => c.type === 'prompt')).toHaveLength(1);
    expect(mocks.send.mock.calls.map((call) => call[1]).slice(0, 2)).toEqual(['same', 'same']);
  },
);

it('holds request finalization until the caller commits the steering row, not merely its ACK', async () => {
  const f = fixture();
  f.enqueue('initial');
  startProcessingLoop();
  await vi.advanceTimersByTimeAsync(0);
  f.start(f.commands.find((c) => c.type === 'prompt')!.message!, 'run-one');
  let commit!: () => void;
  mocks.rowBarrier = new Promise<void>((resolve) => {
    commit = resolve;
    releases.push(resolve);
  });
  f.enqueue('late');
  await vi.advanceTimersByTimeAsync(10);
  f.ack(
    f.commands.find((c) => c.type === 'steer')!,
    { accepted: false, reason: 'run_not_accepting' },
  );
  f.decision('first');
  f.emit({ type: 'agent_settled', runId: 'run-one' });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.rows()).toEqual([
    { content: 'initial', status: 'processing' },
    { content: 'late', status: 'processing' },
  ]);
  commit();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.rows()).toEqual([
    { content: 'initial', status: 'done' },
    { content: 'late', status: 'pending' },
  ]);
});

it('rejects old Pi capability before sending any user input', async () => {
  const f = fixture(false);
  f.enqueue('initial');
  startProcessingLoop();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.commands.some((c) => c.type === 'prompt' || c.type === 'steer')).toBe(false);
  expect(f.rows()).toEqual([{ content: 'initial', status: 'failed' }]);
  expect(mocks.send.mock.calls[0][1]).toContain('must be updated');
});

it.each(['timeout', 'disconnect'] as const)(
  'never replays steering after an uncertain %s',
  async (failure) => {
    const f = fixture();
    f.enqueue('initial');
    startProcessingLoop();
    await vi.advanceTimersByTimeAsync(0);
    f.start(f.commands.find((c) => c.type === 'prompt')!.message!, 'run-one');
    f.enqueue('sent');
    await vi.advanceTimersByTimeAsync(10);
    f.decision('first');
    f.emit({ type: 'agent_settled', runId: 'run-one' });
    if (failure === 'disconnect') mocks.spawn.mock.results.at(-1)!.value.emit('close', 9);
    await vi.advanceTimersByTimeAsync(failure === 'timeout' ? 120000 : 0);
    expect(f.rows()[1]).toEqual({ content: 'sent', status: 'failed' });
    expect(f.commands.filter((c) => c.type === 'prompt')).toHaveLength(1);
    expect(f.commands.filter((c) => c.type === 'steer')).toHaveLength(1);
  },
);

it('keeps ACK-first accepted input processing until its actual user-message consumption', async () => {
  const f = fixture();
  f.enqueue('initial');
  startProcessingLoop();
  await vi.advanceTimersByTimeAsync(0);
  f.start(f.commands.find((c) => c.type === 'prompt')!.message!, 'run-one');
  f.enqueue('accepted');
  await vi.advanceTimersByTimeAsync(10);
  const steer = f.commands.find((c) => c.type === 'steer')!;
  f.ack(steer, { accepted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.rows()[1]).toEqual({ content: 'accepted', status: 'processing' });
  f.decision('first');
  f.emit({ type: 'message_start', message: { role: 'user', content: steer.message } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.rows()[1]).toEqual({ content: 'accepted', status: 'done' });
  f.decision('second');
  f.emit({ type: 'agent_settled', runId: 'run-one' });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.rows()).toEqual([
    { content: 'initial', status: 'done' },
    { content: 'accepted', status: 'done' },
  ]);
  expect(mocks.send.mock.calls.map((call) => call[1])).toEqual(['first', 'second']);
  expect(f.commands.filter((c) => c.type === 'steer')).toHaveLength(1);
});
