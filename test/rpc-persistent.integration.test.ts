import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { config } from '../src/config.js';
import {
  getChannelSessionStatus,
  invokeAgent,
  shutdownResidentAgents,
} from '../src/agent/invoke.js';

// Real installed Pi, read-only. No credentials, network provider, production
// settings, extensions, sessions or Gateway DB are used by this integration.
it.skipIf(process.platform === 'win32')(
  'real Pi keeps delayed custom child results and the next request on its original RPC process',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'piscord-real-persistent-'));
    const original = { ...config };
    const cli =
      process.env.PI_RPC_TEST_CLI ||
      join(
        dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),
        'cli.js',
      );
    const extension = join(root, 'fixture.ts');
    const wrapper = join(root, 'pi');
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec env -i PATH=${quote(process.env.PATH || '/usr/bin:/bin')} HOME=${quote(root)} PI_CODING_AGENT_DIR=${quote(join(root, 'agent'))} ${quote(process.execPath)} ${quote(cli)} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    writeFileSync(
      extension,
      `
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function(pi) {
 let calls = 0;
 let launched = false;
 const children = new Set();
 pi.registerProvider('fixture', {
  baseUrl: 'http://127.0.0.1:1/never-used', apiKey: 'not-a-secret', api: 'fixture-api',
  models: [{id:'local', name:'Local fixture', reasoning:false, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:200000, maxTokens:1000}],
  streamSimple(model, context) {
   const stream = createAssistantMessageEventStream();
   const n = ++calls;
   appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify({n,pid:process.pid,messages:context.messages})+'\\n');
   const text = n === 1 ? 'children started:' + process.pid : n === 2 ? 'children collected:' + process.pid : 'next request:' + process.pid;
   const message = {role:'assistant',content:[{type:'text',text}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
   queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message});stream.end();});
   return stream;
  }
 });
 pi.on('agent_start', () => {
  if(launched) return;
  launched = true;
  let completed = 0;
  for(const delay of [800,1200]) {
   const child = spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),'+delay+')'],{stdio:'ignore'});
   children.add(child);
   child.on('close', code => {
    children.delete(child);
    appendFileSync(${JSON.stringify(join(root, 'children.jsonl'))}, JSON.stringify({pid:child.pid,code})+'\\n');
    if(code === 0 && ++completed === 2) setTimeout(()=>pi.sendMessage({customType:'delayed-child-results',content:'Two children finished; delayed result delivery.',display:true},{triggerTurn:true,deliverAs:'followUp'}),300);
   });
  }
 });
 pi.on('session_shutdown',()=>{for(const child of children) child.kill();});
}
`,
    );
    Object.assign(config, {
      piRpcPersistent: true,
      piBin: wrapper,
      piModel: 'fixture/local',
      piThinking: '',
      piExtraFlags: `--no-extensions --no-skills --no-prompt-templates -e ${extension}`,
      sessionsDir: join(root, 'sessions'),
    });
    const late: string[] = [];
    let received!: () => void;
    const delivered = new Promise<void>((done) => {
      received = done;
    });
    try {
      const first = await invokeAgent('isolated', 'Start two children', {
        cwd: root,
        onAssistantMessage: () => {},
        connectionDelivery: {
          onAssistantMessage: (text) => {
            late.push(text);
            received();
          },
          onError: (error) => {
            throw new Error(error);
          },
        },
      });
      expect(first.ok, first.error).toBe(true);
      expect(first.text).toMatch(/^children started:/);
      expect(late).toEqual([]);
      const status = await getChannelSessionStatus('isolated', root);
      expect(status.statsSource).toBe('rpc');
      await Promise.race([
        delivered,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('No delayed parent response')), 8000).unref(),
        ),
      ]);
      const second = await invokeAgent('isolated', 'Next real user request', {
        cwd: root,
        onAssistantMessage: () => {},
      });
      expect(second.ok, second.error).toBe(true);
      const pid = Number(first.text.split(':')[1]);
      expect(late).toEqual([`children collected:${pid}`]);
      expect(second.text).toBe(`next request:${pid}`);
      const children = readFileSync(join(root, 'children.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(children).toHaveLength(2);
      expect(children.every(({ code }) => code === 0)).toBe(true);
      const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(calls).toHaveLength(3);
      expect(JSON.stringify(calls[1].messages)).toContain(
        'Two children finished; delayed result delivery.',
      );
      const rssKiB = Number(
        execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
      );
      const report = {
        realPiCli: cli,
        directPiPid: pid,
        idleAfterThreeCallsRssKiB: rssKiB,
        childExitCodes: children.map(({ code }) => code),
        providerCalls: calls.length,
      };
      console.log(JSON.stringify(report));
      if (process.env.PI_RPC_TEST_REPORT)
        writeFileSync(process.env.PI_RPC_TEST_REPORT, JSON.stringify(report, null, 2) + '\n');
      await shutdownResidentAgents();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await shutdownResidentAgents();
      Object.assign(config, original);
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
