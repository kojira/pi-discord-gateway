import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { config } from '../src/config.js';
import { hasResidentAgent, invokeAgent, shutdownResidentAgents } from '../src/agent/invoke.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn(),
}));

type Command = { type: string; id: string; message?: string };
const originalConfig = { ...config };
let root: string;
let proc: EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};
let commands: Command[];
let replyToState = true;
const send = (message: object) => proc.stdout.write(JSON.stringify(message) + '\n');
const reply = (command: Command, success = true) =>
  send({
    type: 'response',
    id: command.id,
    command: command.type,
    success,
    ...(success ? { data: { pendingMessageCount: 0 } } : { error: 'Compaction failed' }),
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'piscord-compaction-deadline-'));
  commands = [];
  replyToState = true;
  proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  proc.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const command: Command = JSON.parse(line);
      commands.push(command);
      if (command.type === 'set_steering_mode' || (command.type === 'get_state' && replyToState))
        reply(command);
    }
  });
  proc.stdin.on('finish', () => proc.emit('close', 0));
  vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  Object.assign(config, {
    piRpcPersistent: true,
    piBin: 'pi-fixture',
    piModel: '',
    piThinking: '',
    piExtraFlags: '',
    sessionsDir: root,
  });
});

afterEach(async () => {
  await shutdownResidentAgents();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  Object.assign(config, originalConfig);
  rmSync(root, { recursive: true, force: true });
});

async function start(signal?: AbortSignal) {
  const result = invokeAgent('channel', 'check', {
    cwd: root,
    signal,
    connectionDelivery: { onAssistantMessage: vi.fn(), onError: vi.fn() },
  });
  await vi.advanceTimersByTimeAsync(0);
  const prompt = commands.findLast((c) => c.type === 'prompt');
  expect(prompt).toBeDefined();
  return { result, prompt: prompt! };
}

function complete(prompt: Command) {
  reply(prompt);
  send({ type: 'message_start', message: { role: 'user', content: 'check' } });
  send({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }], stopReason: 'stop' },
  });
  send({ type: 'agent_settled' });
}

describe('RPC prompt preflight compaction deadlines', () => {
  it('accepts compaction lasting beyond two minutes without replay', async () => {
    const { result, prompt } = await start();
    send({ type: 'compaction_start', reason: 'threshold' });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(proc.stdin.writableEnded).toBe(false);
    send({ type: 'compaction_end', willRetry: false });
    complete(prompt);
    expect(await result).toEqual({ ok: true, text: 'ready' });
    expect(commands.filter((c) => c.type === 'prompt')).toHaveLength(1);
    expect(hasResidentAgent('channel')).toBe(true);
  });

  it('allows ordinary admission longer than 30 seconds', async () => {
    const { result, prompt } = await start();
    await vi.advanceTimersByTimeAsync(90_000);
    complete(prompt);
    expect((await result).ok).toBe(true);
  });

  it('bounds ordinary prompt acknowledgement at two minutes', async () => {
    const { result } = await start();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(proc.stdin.writableEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).error).toBe('Pi RPC command timed out: prompt');
  });

  it('bounds stalled compaction even with repeated starts and retry cycles', async () => {
    const { result } = await start();
    send({ type: 'compaction_start' });
    await vi.advanceTimersByTimeAsync(300_000);
    send({ type: 'compaction_start' });
    send({ type: 'compaction_end', willRetry: true });
    send({ type: 'compaction_start' });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(proc.stdin.writableEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).error).toBe('Pi RPC command timed out: prompt');
  });

  it.each([false, true])(
    'restores the short deadline after compaction ends (aborted=%s)',
    async (aborted) => {
      const { result } = await start();
      send({ type: 'compaction_start' });
      await vi.advanceTimersByTimeAsync(87_000);
      send({ type: 'compaction_end', aborted, willRetry: false });
      await vi.advanceTimersByTimeAsync(20_000);
      send({ type: 'compaction_end', aborted, willRetry: false });
      await vi.advanceTimersByTimeAsync(100_000);
      expect((await result).error).toBe('Pi RPC command timed out: prompt');
    },
  );

  it('propagates failed preflight instead of waiting out the long deadline', async () => {
    const { result, prompt } = await start();
    send({ type: 'compaction_start' });
    await vi.advanceTimersByTimeAsync(87_000);
    send({ type: 'compaction_end', errorMessage: 'Compaction failed', willRetry: false });
    reply(prompt, false);
    await vi.advanceTimersByTimeAsync(0);
    expect((await result).error).toBe('Compaction failed');
  });

  it('allows cancellation during long preflight and clears its deadline', async () => {
    const controller = new AbortController();
    const { result } = await start(controller.signal);
    send({ type: 'compaction_start' });
    await vi.advanceTimersByTimeAsync(87_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect((await result).ok).toBe(false);
    expect(commands.some((c) => c.type === 'abort')).toBe(true);
    expect(hasResidentAgent('channel')).toBe(false);
  });

  it('handles admission during existing background compaction on a retained connection', async () => {
    const first = await start();
    complete(first.prompt);
    expect((await first.result).ok).toBe(true);
    send({ type: 'compaction_start' });
    const second = await start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(proc.stdin.writableEnded).toBe(false);
    send({ type: 'compaction_end', willRetry: false });
    complete(second.prompt);
    expect((await second.result).ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('anchors the cap to delayed compaction start and does not exceed it on end', async () => {
    const { result } = await start();
    await vi.advanceTimersByTimeAsync(110_000);
    send({ type: 'compaction_start' });
    await vi.advanceTimersByTimeAsync(599_000);
    expect(proc.stdin.writableEnded).toBe(false);
    send({ type: 'compaction_end', willRetry: false });
    await vi.advanceTimersByTimeAsync(999);
    expect(proc.stdin.writableEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).error).toBe('Pi RPC command timed out: prompt');
  });

  it('does not extend a state query deadline during background compaction', async () => {
    const first = await start();
    complete(first.prompt);
    await first.result;
    send({ type: 'compaction_start' });
    replyToState = false;
    const next = invokeAgent('channel', 'next', { cwd: root });
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await next).error).toBe('Pi RPC command timed out: get_state');
    expect(commands.filter((c) => c.type === 'prompt')).toHaveLength(1);
  });
});
