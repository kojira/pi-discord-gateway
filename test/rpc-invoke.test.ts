import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { invokeAgent, steerActiveAgent } from '../src/agent/invoke.js';

const tempDirs: string[] = [];
const originalConfig = {
  piBin: config.piBin,
  piModel: config.piModel,
  piThinking: config.piThinking,
  piExtraFlags: config.piExtraFlags,
  sessionsDir: config.sessionsDir,
};

afterEach(() => {
  const mutable = config as unknown as Record<string, unknown>;
  Object.assign(mutable, originalConfig);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Pi RPC invocation', () => {
  it('sets persistent all-message steering mode before sending the initial prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piscord-rpc-mode-'));
    tempDirs.push(root);
    const commandCapture = join(root, 'commands.txt');
    const fakePi = join(root, 'fake-pi.mjs');

    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let buffer = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    appendFileSync(${JSON.stringify(commandCapture)}, JSON.stringify(command) + '\\n');
    if (command.type === 'set_steering_mode') {
      send({ type: 'response', id: command.id, command: command.type, success: command.mode === 'all' });
    } else if (command.type === 'prompt') {
      send({ type: 'response', id: command.id, command: command.type, success: true });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } });
      send({ type: 'agent_settled' });
    }
  }
});
`,
    );
    chmodSync(fakePi, 0o755);

    const mutable = config as unknown as Record<string, unknown>;
    Object.assign(mutable, {
      piBin: fakePi,
      piModel: '',
      piThinking: '',
      piExtraFlags: '',
      sessionsDir: join(root, 'sessions'),
    });

    expect(await invokeAgent('ch_mode', 'initial prompt', { cwd: root })).toEqual({
      ok: true,
      text: 'done',
    });
    const commands = (await import('node:fs'))
      .readFileSync(commandCapture, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(commands.map(({ type }) => type)).toEqual(['set_steering_mode', 'prompt']);
    expect(commands[0]).toMatchObject({ type: 'set_steering_mode', mode: 'all' });
    expect(commands[1]).toMatchObject({
      type: 'prompt',
      message: 'initial prompt',
      streamingBehavior: 'followUp',
    });
  });

  it('does not prompt when Pi rejects all-message steering mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piscord-rpc-mode-reject-'));
    tempDirs.push(root);
    const commandCapture = join(root, 'commands.txt');
    const fakePi = join(root, 'fake-pi.mjs');

    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let buffer = '';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    appendFileSync(${JSON.stringify(commandCapture)}, command.type + '\\n');
    if (command.type === 'set_steering_mode') {
      send({ type: 'response', id: command.id, command: command.type, success: false, error: 'unsupported mode' });
    } else if (command.type === 'prompt') {
      send({ type: 'response', id: command.id, command: command.type, success: true });
    }
  }
});
`,
    );
    chmodSync(fakePi, 0o755);

    const mutable = config as unknown as Record<string, unknown>;
    Object.assign(mutable, {
      piBin: fakePi,
      piModel: '',
      piThinking: '',
      piExtraFlags: '',
      sessionsDir: join(root, 'sessions'),
    });

    expect(await invokeAgent('ch_mode_reject', 'must not be sent', { cwd: root })).toEqual({
      ok: false,
      text: '',
      error: 'unsupported mode',
    });
    expect((await import('node:fs')).readFileSync(commandCapture, 'utf8').trim()).toBe(
      'set_steering_mode',
    );
  });

  it('delivers separated steers from one long turn before one following assistant turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piscord-rpc-'));
    tempDirs.push(root);
    const steerCapture = join(root, 'steer.txt');
    const fakePi = join(root, 'fake-pi.mjs');

    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let buffer = '';
let finished = false;
const steering = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const finish = () => {
  if (finished) return;
  finished = true;
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], stopReason: 'stop' } });
  send({ type: 'agent_end', messages: [], willRetry: false });
  send({ type: 'agent_settled' });
};
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === 'set_steering_mode') {
      send({ type: 'response', id: command.id, command: command.type, success: command.mode === 'all' });
    } else if (command.type === 'prompt') {
      send({ type: 'response', id: command.id, command: 'prompt', success: true });
      setTimeout(() => {
        send({ type: 'agent_start' });
        send({ type: 'message_start', message: { role: 'user', content: command.message } });
        send({ type: 'message_end', message: { role: 'assistant', content: [
          { type: 'text', text: 'working update' },
          { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: {} }
        ] } });
      }, 20);
    } else if (command.type === 'steer') {
      appendFileSync(${JSON.stringify(steerCapture)}, command.message + '\\n');
      steering.push(command.message);
      send({ type: 'response', id: command.id, command: 'steer', success: true });
      if (steering.length === 2) {
        setTimeout(() => {
          for (const message of steering) send({ type: 'message_start', message: { role: 'user', content: message } });
          finish();
        }, 10);
      }
    } else if (command.type === 'abort') {
      send({ type: 'response', id: command.id, command: 'abort', success: true });
      finish();
    }
  }
});
setTimeout(finish, 2000);
`,
    );
    chmodSync(fakePi, 0o755);

    const mutable = config as unknown as Record<string, unknown>;
    Object.assign(mutable, {
      piBin: fakePi,
      piModel: '',
      piThinking: '',
      piExtraFlags: '',
      sessionsDir: join(root, 'sessions'),
    });

    const messages: string[] = [];
    const traces: string[] = [];
    const steerAccepted: boolean[] = [];
    let steerConsumed = 0;
    const result = await invokeAgent('ch_test', 'initial prompt', {
      cwd: root,
      onTraceEvent: (text) => traces.push(text),
      onAssistantMessage: async (text) => {
        messages.push(text);
        if (text === 'working update') {
          steerAccepted.push(
            await steerActiveAgent('ch_test', '[Discord user: Alice]\nchange course', {
              onConsumed: () => void (steerConsumed += 1),
            }),
          );
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
          steerAccepted.push(
            await steerActiveAgent(
              'ch_test',
              '[Discord user: Alice]\nand keep the original files',
              {
                onConsumed: () => void (steerConsumed += 1),
              },
            ),
          );
        }
      },
    });

    expect(result).toEqual({ ok: true, text: 'final answer' });
    expect(messages).toEqual(['working update', 'final answer']);
    expect(traces).toEqual([
      '▶️ agent started',
      '👤 user: initial prompt',
      '🤖 assistant: working update',
      '👤 user: [Discord user: Alice]\nchange course',
      '👤 user: [Discord user: Alice]\nand keep the original files',
      '🤖 assistant: final answer',
      '⏹️ agent settled',
    ]);
    expect(steerAccepted).toEqual([true, true]);
    expect(steerConsumed).toBe(2);
    expect(await steerActiveAgent('ch_test', 'too late')).toBe(false);
    expect(
      await import('node:fs').then(({ readFileSync }) => readFileSync(steerCapture, 'utf8')),
    ).toBe(
      '[Discord user: Alice]\nchange course\n[Discord user: Alice]\nand keep the original files\n',
    );
  });

  it('treats steering_consumed events as authoritative consumption', async () => {
    const root = makeFakePi(`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  while (buffer.includes('\\n')) {
    const line = buffer.slice(0, buffer.indexOf('\\n'));
    buffer = buffer.slice(buffer.indexOf('\\n') + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === 'set_steering_mode') {
      send({ type: 'response', id: command.id, command: 'set_steering_mode', success: true });
      continue;
    }
    if (command.type === 'prompt') {
      send({ type: 'response', id: command.id, command: 'prompt', success: true });
      setTimeout(() => {
        send({ type: 'message_start', message: { role: 'user', content: command.message } });
        send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] } });
      }, 10);
      continue;
    }
    if (command.type === 'steer') {
      send({ type: 'response', id: command.id, command: 'steer', success: true });
      setTimeout(() => {
        send({ type: 'steering_consumed', message: command.message, target: 'recipient', recipientId: 'child-1' });
        send({ type: 'agent_end', messages: [] });
      }, 10);
    }
  }
});
`);

    let consumed = 0;
    let ready!: () => void;
    const readyMessage = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const request = invokeAgent('ch_test', 'initial prompt', {
      cwd: root,
      onAssistantMessage: async (text) => {
        if (text === 'ready') ready();
      },
    });

    await readyMessage;
    expect(
      await steerActiveAgent('ch_test', '[Discord user: Alice]\ninterrupt child', {
        onConsumed: () => void (consumed += 1),
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(consumed).toBe(1));
    await expect(request).resolves.toMatchObject({ ok: true, text: 'ready' });
  });

  it('forwards bounded subagent tool output through the trace callback', async () => {
    const root = makeFakePi(`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (!buffer.includes('\\n')) return;
  const command = JSON.parse(buffer.slice(0, buffer.indexOf('\\n')));
  send({ type: 'response', id: command.id, command: 'prompt', success: true });
  send({ type: 'tool_execution_start', toolCallId: 'sub-1', toolName: 'subagent', args: { action: 'status', id: 'run-1' } });
  send({ type: 'tool_execution_end', toolCallId: 'sub-1', toolName: 'subagent', result: { content: [{ type: 'text', text: 'Reviewer complete: no blockers' }] }, isError: false });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } });
  send({ type: 'agent_settled' });
});
`);

    const traces: string[] = [];
    const result = await invokeAgent('ch_subagent_trace', 'review it', {
      cwd: root,
      onTraceEvent: (text) => traces.push(text),
    });

    expect(result).toEqual({ ok: true, text: 'done' });
    expect(traces).toContain('🛠️ tool subagent: {"action":"status","id":"run-1"}');
    expect(traces).toContain('🔧 tool-end subagent ok: Reviewer complete: no blockers');
  });

  it.each([
    {
      record: {
        status: 'resolved',
        decision: { outcome: 'completed', summary: 'verified; not deployed' },
      },
      expected: { ok: true, text: 'verified; not deployed', workOutcome: 'completed' },
    },
    {
      record: { status: 'suspended', reason: 'explicit finish missing' },
      expected: { ok: false, text: '', error: 'explicit finish missing' },
    },
  ])(
    'uses the work contract result instead of an earlier progress reply: $record.status',
    async ({ record, expected }) => {
      const root = makeFakePi(`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.on('data', (chunk) => {
  const command = JSON.parse(chunk.toString('utf8').trim());
  send({ type: 'response', id: command.id, command: 'prompt', success: true });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }], stopReason: 'toolUse' } });
  send({ type: 'work_contract', record: ${JSON.stringify(record)} });
  send({ type: 'agent_settled' });
});
`);
      expect(await invokeAgent('ch_contract', 'verify', { cwd: root })).toEqual(expected);
    },
  );

  it('supports pre-agent_settled Pi versions that terminate with agent_end', async () => {
    const root = makeFakePi(`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (!buffer.includes('\\n')) return;
  const command = JSON.parse(buffer.slice(0, buffer.indexOf('\\n')));
  send({ type: 'response', id: command.id, command: 'prompt', success: true });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'old Pi final' }], stopReason: 'stop' } });
  send({ type: 'agent_end', messages: [] });
});
`);

    const traces: string[] = [];
    const result = await invokeAgent('ch_old', 'hello', {
      cwd: root,
      onTraceEvent: (text) => traces.push(text),
    });
    expect(result).toEqual({ ok: true, text: 'old Pi final' });
    expect(traces).toContain('⏹️ agent settled');
  });

  it('does not settle an active tool loop when threshold compaction ends without overflow retry', async () => {
    const root = makeFakePi(`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
// Pi RPC treats stdin EOF as shutdown and aborts its active model request.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  const command = JSON.parse(chunk.toString('utf8').trim());
  send({ type: 'response', id: command.id, command: 'prompt', success: true });
  send({ type: 'agent_start' });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'working before compaction' }], stopReason: 'toolUse' } });
  send({ type: 'compaction_start', reason: 'threshold' });
  send({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false });
  setTimeout(() => {
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'continued after compaction' }], stopReason: 'stop' } });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  }, 300);
});
`);
    expect(await invokeAgent('ch_in_loop_compaction', 'work', { cwd: root })).toEqual({
      ok: true,
      text: 'continued after compaction',
    });
  });

  it('settles a legacy invocation after post-run compaction finishes', async () => {
    const root = makeFakePi(`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.on('data', (chunk) => {
  const command = JSON.parse(chunk.toString('utf8').trim());
  send({ type: 'response', id: command.id, command: 'prompt', success: true });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'legacy completed' }], stopReason: 'stop' } });
  send({ type: 'agent_end', messages: [] });
  send({ type: 'compaction_start', reason: 'threshold' });
  setTimeout(() => send({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false }), 150);
});
`);
    expect(await invokeAgent('ch_legacy_compaction', 'work', { cwd: root })).toEqual({
      ok: true,
      text: 'legacy completed',
    });
  });

  it('keeps a legacy invocation alive across automatic retry events', async () => {
    const root = makeFakePi(`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (!buffer.includes('\\n')) return;
  const command = JSON.parse(buffer.slice(0, buffer.indexOf('\\n')));
  send({ type: 'response', id: command.id, command: 'prompt', success: true });
  send({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'temporary overload' } });
  send({ type: 'agent_end', messages: [] });
  send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 20 });
  setTimeout(() => {
    send({ type: 'agent_start' });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'retry succeeded' }], stopReason: 'stop' } });
    send({ type: 'auto_retry_end', success: true, attempt: 1 });
    send({ type: 'agent_end', messages: [] });
  }, 150);
});
`);

    const result = await invokeAgent('ch_retry', 'hello', { cwd: root });
    expect(result).toEqual({ ok: true, text: 'retry succeeded' });
  });

  it('rejects a steer accepted after its invocation has already settled', async () => {
    const root = makeFakePi(`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    if (command.type === 'prompt') {
      send({ type: 'response', id: command.id, command: 'prompt', success: true });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }], stopReason: 'stop' } });
      // A real Pi settles even if no steer is sent. Keep this fake from
      // hanging forever when delivery scheduling is delayed under CI load.
      setTimeout(() => send({ type: 'agent_settled' }), 100);
    } else if (command.type === 'steer') {
      send({ type: 'agent_settled' });
      send({ type: 'response', id: command.id, command: 'steer', success: true });
    }
  }
});
`);

    let accepted = true;
    const result = await invokeAgent('ch_race', 'hello', {
      cwd: root,
      onAssistantMessage: async () => {
        accepted = await steerActiveAgent('ch_race', 'too late');
      },
    });
    expect(accepted).toBe(false);
    expect(result).toEqual({ ok: true, text: 'ready' });
  });

  it('treats assistant error state as authoritative even when partial text exists', async () => {
    const root = makeFakePi(`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (!buffer.includes('\\n')) return;
  const command = JSON.parse(buffer.slice(0, buffer.indexOf('\\n')));
  send({ type: 'response', id: command.id, command: 'prompt', success: true });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'error', errorMessage: 'provider failed' } });
  send({ type: 'agent_end', messages: [], willRetry: false });
  send({ type: 'agent_settled' });
});
`);

    const result = await invokeAgent('ch_error', 'hello', { cwd: root });
    expect(result).toEqual({ ok: false, text: '', error: 'provider failed' });
  });

  it('rejects an oversized newline-free RPC event without retaining unbounded output', async () => {
    const root = makeFakePi(`
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (!buffer.includes('\\n')) return;
  process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1));
  setInterval(() => {}, 1000);
});
`);

    const result = await invokeAgent('ch_oversized', 'hello', { cwd: root });
    expect(result).toEqual({
      ok: false,
      text: '',
      error: 'Pi RPC event exceeded the 4 MiB safety limit',
    });
  });

  it('rejects an unbounded backlog of pending assistant deliveries', async () => {
    const root = makeFakePi(`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (!buffer.includes('\\n')) return;
  const text = 'x'.repeat(1024 * 1024);
  for (let index = 0; index < 6; index += 1) {
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  }
  setInterval(() => {}, 1000);
});
`);

    const result = await invokeAgent('ch_delivery_limit', 'hello', {
      cwd: root,
      // Keep each delivery pending long enough for the RPC reader to observe
      // the bounded backlog before normal parsing work drains it.
      onAssistantMessage: () => new Promise((resolve) => setTimeout(resolve, 500)),
    });
    expect(result).toEqual({
      ok: false,
      text: '',
      error: 'Pi RPC pending assistant delivery exceeded the 4 MiB safety limit',
    });
  });

  it('retains only a bounded stderr prefix from a noisy RPC process', async () => {
    const root = makeFakePi(`
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (!buffer.includes('\\n')) return;
  process.stderr.write('diagnostic-start:' + 'x'.repeat(2 * 1024 * 1024));
  process.exit(1);
});
`);

    const result = await invokeAgent('ch_stderr', 'hello', { cwd: root });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^diagnostic-start:/);
    expect(result.error!.length).toBeLessThanOrEqual(600);
  });

  it('kills and reaps a Pi child that rejects the initial prompt but ignores EOF', async () => {
    const root = makeFakePi(`
process.on('SIGTERM', () => {});
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (!buffer.includes('\\n')) return;
  const command = JSON.parse(buffer.slice(0, buffer.indexOf('\\n')));
  send({ type: 'response', id: command.id, command: 'prompt', success: false, error: 'prompt denied' });
  setInterval(() => {}, 1000);
});
`);

    const result = await Promise.race([
      invokeAgent('ch_prompt_rejected', 'hello', { cwd: root }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('prompt-rejecting Pi was not reaped')), 3000),
      ),
    ]);
    expect(result).toEqual({ ok: false, text: '', error: 'prompt denied' });
  });

  it('force-kills a Pi child that ignores SIGTERM after shutdown abort', async () => {
    const root = makeFakePi(`
process.on('SIGTERM', () => {});
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  if (!buffer.includes('\\n')) return;
  const command = JSON.parse(buffer.slice(0, buffer.indexOf('\\n')));
  send({ type: 'response', id: command.id, command: 'prompt', success: true });
  send({ type: 'agent_start' });
  setInterval(() => {}, 1000);
});
`);
    const controller = new AbortController();
    const invocation = invokeAgent('ch_kill', 'hello', { cwd: root, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    const result = await Promise.race([
      invocation,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SIGTERM-ignoring Pi did not settle')), 3000),
      ),
    ]);
    expect(result.ok).toBe(false);
  });

  it('reports no active run for an unknown channel', async () => {
    expect(await steerActiveAgent('missing', 'hello')).toBe(false);
  });
});

function makeFakePi(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'piscord-rpc-'));
  tempDirs.push(root);
  const fakePi = join(root, 'fake-pi.mjs');
  const steeringModeShim = `
const originalStdinOn = process.stdin.on.bind(process.stdin);
process.stdin.on = (event, listener) => {
  if (event !== 'data') return originalStdinOn(event, listener);
  let setupBuffer = '';
  return originalStdinOn('data', (chunk) => {
    setupBuffer += chunk.toString('utf8');
    let setupIndex;
    while ((setupIndex = setupBuffer.indexOf('\\n')) !== -1) {
      const setupLine = setupBuffer.slice(0, setupIndex);
      setupBuffer = setupBuffer.slice(setupIndex + 1);
      if (!setupLine) continue;
      const setupCommand = JSON.parse(setupLine);
      if (setupCommand.type === 'set_steering_mode') {
        process.stdout.write(JSON.stringify({ type: 'response', id: setupCommand.id, command: setupCommand.type, success: setupCommand.mode === 'all' }) + '\\n');
      } else {
        listener(Buffer.from(setupLine + '\\n'));
      }
    }
  });
};
`;
  writeFileSync(fakePi, `#!/usr/bin/env node\n${steeringModeShim}\n${body}`);
  chmodSync(fakePi, 0o755);

  const mutable = config as unknown as Record<string, unknown>;
  Object.assign(mutable, {
    piBin: fakePi,
    piModel: '',
    piThinking: '',
    piExtraFlags: '',
    sessionsDir: join(root, 'sessions'),
  });
  return root;
}
