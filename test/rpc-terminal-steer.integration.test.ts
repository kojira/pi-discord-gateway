import { createServer, type Socket } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { invokeAgent, shutdownResidentAgents, steerActiveAgent } from '../src/agent/invoke.js';

// Opt-in modern Pi RPC, isolated from credentials and operational extensions.
// The provider is deterministic; the socket is a barrier, not a model endpoint.
it.skipIf(!process.env.PI_TERMINAL_TEST_CLI)(
  'does not strand late input while Pi is idle but its settlement event is delayed',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'piscord-terminal-steer-'));
    const original = { ...config };
    let barrier!: Socket;
    let reached!: () => void;
    const idle = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const server = createServer((socket) => {
      barrier = socket;
      socket.once('data', () => reached());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No barrier address');
    const extension = join(root, 'fixture.ts');
    writeFileSync(
      extension,
      `
import { connect } from 'node:net';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function(pi) {
 let calls = 0;
 let first = true;
 pi.registerProvider('fixture', {
  baseUrl: 'http://127.0.0.1:1/unused', apiKey: 'synthetic', api: 'fixture-api',
  models: [{id:'local', name:'Fixture', reasoning:false, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:200000, maxTokens:1000}],
  streamSimple(model) {
   const stream = createAssistantMessageEventStream();
   const n = ++calls;
   const message = {role:'assistant',content:[{type:'toolCall',id:'finish-'+n,name:'finish_work',arguments:{outcome:'completed',reason:'Fixture complete',summary:'response-'+n}}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()};
   queueMicrotask(()=>{stream.push({type:'done',reason:'toolUse',message});stream.end();});
   return stream;
  }
 });
 pi.on('agent_settled', async () => {
  if (!first) return;
  first = false;
  await new Promise(resolve => {
   const socket = connect(${address.port}, '127.0.0.1', () => socket.write('idle'));
   socket.once('data', () => {socket.end(); resolve();});
  });
 });
}
`,
    );
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const wrapper = join(root, 'pi');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec env -i PATH=${quote(process.env.PATH || '/usr/bin:/bin')} HOME=${quote(root)} PI_OFFLINE=1 PI_CODING_AGENT_DIR=${quote(join(root, 'agent'))} ${quote(process.execPath)} ${quote(process.env.PI_TERMINAL_TEST_CLI!)} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    Object.assign(config, {
      piRpcPersistent: true,
      piBin: wrapper,
      piModel: 'fixture/local',
      piThinking: '',
      piExtraFlags: `--no-extensions --no-skills --no-prompt-templates -e ${extension}`,
      sessionsDir: join(root, 'sessions'),
    });
    const responses: string[] = [];
    const onConsumed = vi.fn();
    const options = {
      cwd: root,
      onAssistantMessage: (text: string) => {
        responses.push(text);
      },
      connectionDelivery: {
        onAssistantMessage: (text: string) => {
          responses.push(text);
        },
        onError: vi.fn(),
      },
    };
    try {
      const first = invokeAgent('synthetic', 'initial', options);
      await idle;
      const accepted = await steerActiveAgent('synthetic', 'late input', { onConsumed });
      barrier.write('release');
      expect(await first).toMatchObject({ ok: true, text: 'response-1' });
      // A definitely-unsent late input can be submitted by the ordinary queue.
      // Accepted input must already have been consumed before that queue advances.
      const next = await invokeAgent('synthetic', accepted ? 'next input' : 'late input', options);
      expect(next.ok, next.error).toBe(true);
      expect(onConsumed).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(responses).toEqual(['response-1', 'response-2']);
    } finally {
      barrier?.destroy();
      await shutdownResidentAgents();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      Object.assign(config, original);
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
