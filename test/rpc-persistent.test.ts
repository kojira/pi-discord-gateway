import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  hasResidentAgent,
  invokeAgent,
  shutdownResidentAgents,
  steerActiveAgent,
  stopResidentAgent,
} from '../src/agent/invoke.js';

const originalConfig = { ...config };
const originalTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
const roots: string[] = [];

afterEach(async () => {
  await shutdownResidentAgents();
  Object.assign(config, originalConfig);
  if (originalTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
  else process.env.PI_SUBAGENTS_TEMP_ROOT = originalTempRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(ignoreStop = false) {
  const root = mkdtempSync(join(tmpdir(), 'piscord-persistent-rpc-'));
  roots.push(root);
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  const bin = join(root, 'pi.mjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = ${JSON.stringify(root)};
const supervisorRoot = process.env.PI_SUBAGENTS_TEMP_ROOT || root;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const text = value => send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:value}],stopReason:'stop'}});
const settle = () => send({type:'agent_settled'});
const answer = command => {
 send({type:'agent_start'});
 send({type:'message_start',message:{role:'user',content:command.message === 'queued' ? 'transformed input' : command.message}});
 text(command.message + ':' + process.pid);
 if(command.message === 'summary') send({type:'work_contract',record:{status:'resolved',decision:{outcome:'waiting',summary:'waiting for children'}}});
 settle();
};
let buffer = '';
process.stdin.on('data', chunk => {
 buffer += chunk;
 let i;
 while ((i = buffer.indexOf('\\n')) !== -1) {
  const c = JSON.parse(buffer.slice(0,i)); buffer = buffer.slice(i+1);
  appendFileSync(join(root,'commands'), JSON.stringify(c) + '\\n');
  if(c.type === 'steer' && c.message === 'disconnect-steer') { process.exit(9); return; }
  send({type:'response',id:c.id,command:c.type,success:true,data:{sessionId:'owned-session',pendingMessageCount:existsSync(join(root,'pending')) ? 1 : 0}});
  if(c.type === 'steer') {
   send({type:'message_start',message:{role:'user',content:c.message}});
   text('steering consumed'); settle();
  }
  if(c.type !== 'prompt') continue;
  if(c.message === 'queued-steering') {
   text('previous autonomous result'); settle();
   const poll = setInterval(() => {
    if(!existsSync(join(root,'release-initial'))) return;
    clearInterval(poll);
    send({type:'agent_start'});
    send({type:'message_start',message:{role:'user',content:'transformed queued prompt'}});
   },10);
   continue;
  }
  if(c.message === 'hold') continue;
  if(c.message === 'crash') { setTimeout(() => process.exit(7), 50); continue; }
  if(c.message === 'queued') {
   text('previous autonomous result'); settle();
   setTimeout(() => answer(c), 150);
   continue;
  }
  answer(c);
  if(c.message === 'child') {
   const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("child done"),250)']);
   child.stdout.on('data', chunk => {
    send({type:'agent_start'}); text(chunk.toString());
    send({type:'work_contract',record:{status:'resolved',decision:{outcome:'completed',summary:'child summary'}}});
    settle();
    for (const [id, session] of [['ours','owned-session'],['other','other-session']]) {
     const dir = join(supervisorRoot,'supervisor-channels',id,'requests'); mkdirSync(dir,{recursive:true});
     writeFileSync(join(dir,id+'.json'),JSON.stringify({type:'subagent.supervisor.request',id,createdAt:Date.now(),reason:'need_decision',message:'late question',expectsReply:true,runId:id,agent:'worker',childIndex:0,orchestratorSessionId:session}));
    }
   });
  }
  if(c.message === 'error-flood') setTimeout(() => {
   for(let n=0;n<6;n++) {
    send({type:'work_contract',record:{status:'suspended',reason:'e'.repeat(1024*1024)}});
    settle();
   }
  },100);
  if(c.message === 'disconnect') setTimeout(() => process.exit(8), 150);
 }
});
${ignoreStop ? "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);" : "process.stdin.on('end',()=>process.exit(0));"}
`,
  );
  chmodSync(bin, 0o755);
  Object.assign(config, {
    piRpcPersistent: true,
    piBin: bin,
    piModel: '',
    piThinking: '',
    piExtraFlags: '',
    sessionsDir: join(root, 'sessions'),
  });
  return root;
}

function sinks() {
  return {
    onAssistantMessage: vi
      .fn<(text: string, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined),
    onSupervisorRequest: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
  };
}

describe('persistent RPC connection', () => {
  it('survives parent idle, delivers child output/supervisor on detached callbacks and reuses the same process', async () => {
    const root = fixture();
    const connectionDelivery = sinks();
    const requestDelivery = vi.fn();
    const controller = new AbortController();
    const first = await invokeAgent('channel', 'child', {
      cwd: root,
      signal: controller.signal,
      onAssistantMessage: requestDelivery,
      connectionDelivery,
    });
    expect(first.ok).toBe(true);
    expect(hasResidentAgent('channel')).toBe(true);
    controller.abort(); // completed request cannot close its former connection
    await vi.waitFor(
      () =>
        expect(connectionDelivery.onAssistantMessage).toHaveBeenCalledWith(
          'child summary',
          expect.any(AbortSignal),
        ),
      { timeout: 3000 },
    );
    expect(connectionDelivery.onAssistantMessage.mock.calls.map(([text]) => text)).toEqual([
      'child done',
      'child summary',
    ]);
    expect(requestDelivery).toHaveBeenCalledTimes(1);
    await vi.waitFor(
      () => expect(connectionDelivery.onSupervisorRequest).toHaveBeenCalledTimes(1),
      { timeout: 3000 },
    );
    expect(connectionDelivery.onSupervisorRequest.mock.calls[0]?.[0]).toMatchObject({ id: 'ours' });
    const next = await invokeAgent('channel', 'next', { cwd: root, onAssistantMessage: vi.fn() });
    expect(next.text.split(':')[1]).toBe(first.text.split(':')[1]);
    expect(readFileSync(join(root, 'commands'), 'utf8').match(/set_steering_mode/g)).toHaveLength(
      1,
    );
    expect(stopResidentAgent('channel')).toBe(true);
    await shutdownResidentAgents();
    expect(hasResidentAgent('channel')).toBe(false);
    const commands = readFileSync(join(root, 'commands'), 'utf8');
    expect(commands).toContain('clear_queue');
    expect(commands).toContain('abort');
    expect(connectionDelivery.onError).not.toHaveBeenCalled();
  });

  it('does not settle an unconsumed next request from a previous autonomous run', async () => {
    const root = fixture();
    const connectionDelivery = sinks();
    await invokeAgent('channel', 'first', { cwd: root, connectionDelivery });
    const requestDelivery = vi.fn();
    const next = await invokeAgent('channel', 'queued', {
      cwd: root,
      onAssistantMessage: requestDelivery,
    });
    expect(next.text).toMatch(/^queued:/);
    expect(requestDelivery).toHaveBeenCalledTimes(1);
    expect(connectionDelivery.onAssistantMessage).toHaveBeenCalledWith(
      'previous autonomous result',
      expect.any(AbortSignal),
    );
  });

  it('defers steering behind an unconsumed follow-up, then observes its consumption without stealing initial correlation', async () => {
    const root = fixture();
    await invokeAgent('channel', 'first', { cwd: root, connectionDelivery: sinks() });
    const next = invokeAgent('channel', 'queued-steering', { cwd: root });
    await vi.waitFor(() =>
      expect(readFileSync(join(root, 'commands'), 'utf8')).toContain('queued-steering'),
    );
    const onConsumed = vi.fn();
    expect(await steerActiveAgent('channel', 'consume steer', { onConsumed })).toBe(false);
    expect(readFileSync(join(root, 'commands'), 'utf8')).not.toContain('consume steer');
    writeFileSync(join(root, 'release-initial'), '1');
    await vi.waitFor(async () =>
      expect(await steerActiveAgent('channel', 'consume steer', { onConsumed })).toBe(true),
    );
    expect(await next).toEqual({ ok: true, text: 'steering consumed' });
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, 'commands'), 'utf8').match(/consume steer/g)).toHaveLength(1);
  });

  it('rejects a sent steer with a lost acknowledgement instead of reporting it definitely unsent', async () => {
    const root = fixture();
    const request = invokeAgent('channel', 'queued-steering', {
      cwd: root,
      connectionDelivery: sinks(),
    });
    writeFileSync(join(root, 'release-initial'), '1');
    let rejection: unknown;
    await vi.waitFor(async () => {
      try {
        expect(await steerActiveAgent('channel', 'disconnect-steer')).toBe(false);
      } catch (error) {
        rejection = error;
      }
      expect(String(rejection)).toContain('exited before responding');
    });
    expect((await request).ok).toBe(false);
    expect(readFileSync(join(root, 'commands'), 'utf8').match(/disconnect-steer/g)).toHaveLength(1);
  });

  it('bounds aggregate background errors behind a blocked delivery sink', async () => {
    const root = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const errors: string[] = [];
    const connectionDelivery = {
      ...sinks(),
      onError: async (error: string) => {
        errors.push(error);
        if (error.length > 1000) await blocked;
      },
    };
    try {
      expect(
        (await invokeAgent('channel', 'error-flood', { cwd: root, connectionDelivery })).ok,
      ).toBe(true);
      await vi.waitFor(
        () =>
          expect(errors).toContain('Pi RPC pending error delivery exceeded the 4 MiB safety limit'),
        { timeout: 3000 },
      );
      expect(hasResidentAgent('channel')).toBe(false);
      expect(errors.filter((error) => error.length > 1000)).toHaveLength(1);
    } finally {
      release();
    }
  });

  it('rejects changed launch settings without closing unknown background work, and reports idle crashes without replay', async () => {
    const root = fixture();
    const connectionDelivery = sinks();
    await invokeAgent('channel', 'disconnect', { cwd: root, connectionDelivery });
    const changed = await invokeAgent('channel', 'not sent', { cwd: root, model: 'changed' });
    expect(changed.ok).toBe(false);
    expect(changed.error).toContain('/stop');
    await vi.waitFor(() => expect(connectionDelivery.onError).toHaveBeenCalledTimes(1));
    expect(hasResidentAgent('channel')).toBe(false);
    expect(readFileSync(join(root, 'commands'), 'utf8')).not.toContain('not sent');
    const crashed = await invokeAgent('channel', 'crash', { cwd: root, connectionDelivery });
    expect(crashed.ok).toBe(false);
    expect(crashed.error).toContain('unexpectedly');
  });

  it('delivers explicit request summaries before resolving while keeping the connection alive', async () => {
    const root = fixture();
    const onAssistantMessage = vi.fn();
    const result = await invokeAgent('channel', 'summary', {
      cwd: root,
      onAssistantMessage,
      connectionDelivery: sinks(),
    });
    expect(result).toEqual({ ok: true, text: 'waiting for children', workOutcome: 'waiting' });
    expect(onAssistantMessage).toHaveBeenCalledTimes(2);
    expect(onAssistantMessage).toHaveBeenLastCalledWith('waiting for children');
    expect(hasResidentAgent('channel')).toBe(true);
  });

  it('rejects a nonempty Pi user queue before sending and can accept a later request without closing', async () => {
    const root = fixture();
    await invokeAgent('channel', 'first', { cwd: root, connectionDelivery: sinks() });
    writeFileSync(join(root, 'pending'), '1');
    const result = await invokeAgent('channel', 'not submitted', { cwd: root });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not sent');
    expect(readFileSync(join(root, 'commands'), 'utf8')).not.toContain('not submitted');
    expect(hasResidentAgent('channel')).toBe(true);
    rmSync(join(root, 'pending'));
    expect((await invokeAgent('channel', 'next', { cwd: root })).ok).toBe(true);
  });

  it('an active request abort fails that request and closes the resident connection', async () => {
    const root = fixture();
    const controller = new AbortController();
    const request = invokeAgent('channel', 'hold', {
      cwd: root,
      signal: controller.signal,
      connectionDelivery: sinks(),
    });
    await vi.waitFor(() => expect(readFileSync(join(root, 'commands'), 'utf8')).toContain('hold'));
    controller.abort();
    const result = await request;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unconfirmed');
    expect(hasResidentAgent('channel')).toBe(false);
  });

  it('shutdown escalates an EOF/TERM-resistant idle direct Pi without claiming descendant cancellation', async () => {
    const root = fixture(true);
    const first = await invokeAgent('channel', 'first', { cwd: root, connectionDelivery: sinks() });
    const pid = Number(first.text.split(':')[1]);
    await shutdownResidentAgents();
    expect(hasResidentAgent('channel')).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
