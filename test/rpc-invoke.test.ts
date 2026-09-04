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
      send({ type: 'message_end', message: { role: 'assistant', content: [
        { type: 'text', text: 'working update' },
        { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: {} }
      ] } });
    } else if (command.type === 'steer') {
      appendFileSync(${JSON.stringify(steerCapture)}, command.message);
      send({ type: 'response', id: command.id, command: 'steer', success: true });
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
    let steerAccepted = false;
    const result = await invokeAgent('ch_test', 'initial prompt', {
      cwd: root,
      onAssistantMessage: async (text) => {
        messages.push(text);
        if (text === 'working update') {
          steerAccepted = await steerActiveAgent('ch_test', '[Discord user: Alice]\nchange course');
        }
      },
    });

    expect(result).toEqual({ ok: true, text: 'final answer' });
    expect(messages).toEqual(['working update', 'final answer']);
    expect(steerAccepted).toBe(true);
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
