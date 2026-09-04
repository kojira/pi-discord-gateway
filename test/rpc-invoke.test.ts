import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  it('delivers intermediate assistant messages and accepts steering during the run', async () => {
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
    if (command.type === 'prompt') {
      send({ type: 'response', id: command.id, command: 'prompt', success: true });
      send({ type: 'agent_start' });
      send({ type: 'message_start', message: { role: 'user', content: command.message } });
      send({ type: 'message_end', message: { role: 'assistant', content: [
        { type: 'text', text: 'working update' },
        { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: {} }
      ] } });
    } else if (command.type === 'steer') {
      appendFileSync(${JSON.stringify(steerCapture)}, command.message);
      send({ type: 'response', id: command.id, command: 'steer', success: true });
      send({ type: 'message_start', message: { role: 'user', content: command.message } });
      setTimeout(finish, 10);
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
    let steerAccepted = false;
    let steerConsumed = false;
    const result = await invokeAgent('ch_test', 'initial prompt', {
      cwd: root,
      onTraceEvent: (text) => traces.push(text),
      onAssistantMessage: async (text) => {
        messages.push(text);
        if (text === 'working update') {
          steerAccepted = await steerActiveAgent(
            'ch_test',
            '[Discord user: Alice]\nchange course',
            { onConsumed: () => void (steerConsumed = true) },
          );
        }
      },
    });

    expect(result).toEqual({ ok: true, text: 'final answer' });
    expect(messages).toEqual(['working update', 'final answer']);
    expect(traces).toEqual([
      '▶️ agent started',
      '👤 user: initial prompt',
      '🤖 assistant: working update\n🛠️ bash {}',
      '👤 user: [Discord user: Alice]\nchange course',
      '🤖 assistant: final answer',
      '⏹️ agent settled',
    ]);
    expect(steerAccepted).toBe(true);
    expect(steerConsumed).toBe(true);
    expect(await steerActiveAgent('ch_test', 'too late')).toBe(false);
    expect(
      await import('node:fs').then(({ readFileSync }) => readFileSync(steerCapture, 'utf8')),
    ).toContain('change course');
  });

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

    const result = await invokeAgent('ch_old', 'hello', { cwd: root });
    expect(result).toEqual({ ok: true, text: 'old Pi final' });
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

  it('reports no active run for an unknown channel', async () => {
    expect(await steerActiveAgent('missing', 'hello')).toBe(false);
  });
});

function makeFakePi(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'piscord-rpc-'));
  tempDirs.push(root);
  const fakePi = join(root, 'fake-pi.mjs');
  writeFileSync(fakePi, `#!/usr/bin/env node\n${body}`);
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
