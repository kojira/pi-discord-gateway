import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  getResidentSettingsStatus,
  hasResidentAgent,
  invokeAgent,
  refreshResidentSettings,
  shutdownResidentAgents,
  steerActiveAgent,
  type DesiredAgentSettings,
} from '../src/agent/invoke.js';
import * as db from '../src/db.js';
import { startProcessingLoop, stopProcessingLoop } from '../src/agent/queue.js';

vi.mock('../src/discord/client.js', () => ({
  sendResponse: vi.fn().mockResolvedValue(true),
  setTyping: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/discord/webhook-monitor.js', () => ({
  enqueueWebhookTrace: vi.fn(),
  enqueueWebhookTerminal: vi.fn(),
  flushWebhookTrace: vi.fn().mockResolvedValue(undefined),
}));

const original = { ...config };
const roots: string[] = [];
afterEach(async () => {
  await stopProcessingLoop({ timeoutMs: 50 });
  await shutdownResidentAgents();
  db.closeDb();
  Object.assign(config, original);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'piscord-settings-'));
  roots.push(root);
  const bin = join(root, 'pi.mjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const root = ${JSON.stringify(root)};
if (process.argv.includes('--list-models')) {
 console.log('provider model thinking\\ntest a yes\\ntest b yes\\ntest c yes'); process.exit(0);
}
const file = name => join(root,name);
const has = name => existsSync(file(name));
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const ack = (c,data) => send({type:'response',id:c.id,command:c.type,success:true,data});
let model = {provider:'test',id:'a'}, thinkingLevel='off', settingsRevision=0, active=false, count=0;
const state = () => ({model,thinkingLevel,settingsRevision,isStreaming:active,isCompacting:has('compact'),pendingMessageCount:0,capabilities:{guardedSteer:1,guardedSettings:1}});
const wait = name => new Promise(resolve => {
 const timer=setInterval(()=>{if(has(name)){clearInterval(timer);resolve();}},5);
});
const finish = (runId, text) => {
 send({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}});
 active=false; send({type:'agent_settled',runId});
};
const launchHeldChild = () => {
 const code = 'const fs=require("node:fs"); const timer=setInterval(()=>{if(fs.existsSync('+JSON.stringify(file('release-child'))+')) clearInterval(timer);},10);';
 const child=spawn(process.execPath,['-e',code]);
 writeFileSync(file('child-pid'),String(child.pid));
 child.on('exit',code=>{writeFileSync(file('child-exit'),String(code)); send({type:'agent_start',runId:'child-result'}); finish('child-result','child complete');});
};
async function handle(c) {
 appendFileSync(file('commands'),JSON.stringify(c)+'\\n');
 if(c.type==='get_state') { ack(c,state()); return; }
 if(c.type==='set_runtime_settings') {
  if(has('delay-settings')) { writeFileSync(file('settings-waiting'),'1'); await wait('release-settings'); }
  if(has('exit-settings')) { process.exit(9); }
  if(active || has('compact')) { ack(c,{applied:false,reason:'busy'}); return; }
  if(c.expectedRevision!==settingsRevision) { ack(c,{applied:false,reason:'revision_changed'}); return; }
  if(c.provider) model={provider:c.provider,id:c.modelId};
  if(c.thinkingLevel) thinkingLevel=c.thinkingLevel;
  settingsRevision++;
  ack(c,{applied:true,...state()}); return;
 }
 if(c.type==='prompt') {
  if(has('reject-prompt')) { unlinkSync(file('reject-prompt')); settingsRevision++; ack(c,{accepted:false,reason:'settings_changed'}); return; }
  if(active || has('compact')) { ack(c,{accepted:false,reason:'busy'}); return; }
  if(c.expectedSettingsRevision!==undefined && c.expectedSettingsRevision!==settingsRevision) { ack(c,{accepted:false,reason:'settings_changed'}); return; }
  active=true; const runId='run-'+(++count);
  appendFileSync(file('accepted'),JSON.stringify({message:c.message,model,thinkingLevel,pid:process.pid})+'\\n');
  // Admission is reserved before any effectful hook. A later failure cannot
  // truthfully return accepted:false, even before a user message is appended.
  appendFileSync(file('hook-effects'),JSON.stringify({message:c.message})+'\\n');
  if(has('hook-child')) { unlinkSync(file('hook-child')); launchHeldChild(); }
  for(const failure of ['preflight-error','late-revision','missing-ack','invalid-ack']) {
   if(!has(failure)) continue;
   unlinkSync(file(failure));
   if(failure==='missing-ack') { process.exit(9); }
   if(failure==='invalid-ack') { ack(c,{}); return; }
   if(failure==='late-revision') { settingsRevision++; thinkingLevel='low'; }
   active=false;
   send({type:'response',id:c.id,command:c.type,success:false,error:failure}); return;
  }
  ack(c,{accepted:true});
  send({type:'agent_start',runId}); send({type:'message_start',message:{role:'user',content:has('transform-input') ? 'transformed input' : c.message}});
  if(c.message==='child-held') launchHeldChild();
  if(c.message==='hold') await wait('release-parent');
  if(c.message==='child') {
   const child=spawn(process.execPath,['-e', 'setTimeout(()=>{},250)']);
   child.on('exit',code=>{writeFileSync(file('child-exit'),String(code)); send({type:'agent_start',runId:'child-result'}); finish('child-result','child complete');});
  }
  finish(runId,model.id+'/'+thinkingLevel); return;
 }
 ack(c,{});
}
let buffer='';
process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))!==-1){const c=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);void handle(c);}});
process.stdin.on('end',()=>process.exit(0));
`,
  );
  chmodSync(bin, 0o755);
  Object.assign(config, {
    piRpcPersistent: true,
    piBin: bin,
    piCwd: root,
    piModel: '',
    piThinking: '',
    piExtraFlags: '',
    sessionsDir: join(root, 'sessions'),
    dbPath: join(root, 'db'),
    pollInterval: 20,
  });
  let desired: DesiredAgentSettings = { model: 'test/a', thinking: 'off', cwd: root };
  const delivery = { onAssistantMessage: vi.fn(), onError: vi.fn() };
  const options = { resolveSettings: () => desired, connectionDelivery: delivery };
  return {
    root,
    delivery,
    options,
    set: (value: Partial<DesiredAgentSettings>) => {
      desired = { ...desired, ...value };
      refreshResidentSettings('channel');
    },
    touch: (name: string) => writeFileSync(join(root, name), '1'),
    remove: (name: string) => rmSync(join(root, name), { force: true }),
    commands: () =>
      existsSync(join(root, 'commands'))
        ? readFileSync(join(root, 'commands'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
    hookEffects: () =>
      existsSync(join(root, 'hook-effects'))
        ? readFileSync(join(root, 'hook-effects'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
    accepted: () =>
      existsSync(join(root, 'accepted'))
        ? readFileSync(join(root, 'accepted'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  };
}

it('reconciles idle model/thinking without replacing the retained process', async () => {
  const f = fixture();
  expect((await invokeAgent('channel', 'first', f.options)).text).toBe('a/off');
  f.set({ model: 'test/b', thinking: 'high' });
  await vi.waitFor(() =>
    expect(getResidentSettingsStatus('channel')).toContain('Applied: test/b / high'),
  );
  expect((await invokeAgent('channel', 'next', f.options)).text).toBe('b/high');
  expect(new Set(f.accepted().map((row) => row.pid)).size).toBe(1);
  expect(
    f
      .commands()
      .filter((c) => c.type === 'prompt')
      .every((c) => Number.isInteger(c.expectedSettingsRevision)),
  ).toBe(true);
  expect(f.commands().some((c) => ['abort', 'clear_queue'].includes(c.type))).toBe(false);
});

it('keeps changes and steering pending during an accepted parent request', async () => {
  const f = fixture();
  const first = invokeAgent('channel', 'hold', f.options);
  await vi.waitFor(() => expect(f.accepted()).toHaveLength(1));
  f.set({ model: 'test/b' });
  expect(await steerActiveAgent('channel', 'queued correction')).toBe(false);
  expect(f.commands().filter((c) => c.type === 'set_runtime_settings')).toHaveLength(0);
  f.touch('release-parent');
  expect((await first).text).toBe('a/off');
  expect((await invokeAgent('channel', 'queued correction', f.options)).text).toBe('b/off');
  expect(f.accepted().map((row) => row.message)).toEqual(['hold', 'queued correction']);
});

it('supersedes a delayed settings ACK before admitting new input', async () => {
  const f = fixture();
  await invokeAgent('channel', 'first', f.options);
  f.touch('delay-settings');
  f.set({ model: 'test/b' });
  await vi.waitFor(() => expect(existsSync(join(f.root, 'settings-waiting'))).toBe(true));
  f.set({ model: 'test/c', thinking: 'high' });
  const pending = invokeAgent('channel', 'next', f.options);
  f.touch('release-settings');
  expect((await pending).pending).toBe(true);
  expect(f.accepted()).toHaveLength(1);
  expect((await invokeAgent('channel', 'next', f.options)).text).toBe('c/high');
  expect(f.accepted().filter((row) => row.message === 'next')).toHaveLength(1);
});

it('preserves independent child work and delayed delivery during an idle parent update', async () => {
  const f = fixture();
  await invokeAgent('channel', 'child', f.options);
  f.set({ model: 'test/b' });
  expect((await invokeAgent('channel', 'next', f.options)).text).toBe('b/off');
  await vi.waitFor(() =>
    expect(f.delivery.onAssistantMessage).toHaveBeenCalledWith(
      'child complete',
      expect.any(AbortSignal),
    ),
  );
  expect(readFileSync(join(f.root, 'child-exit'), 'utf8')).toBe('0');
  expect(new Set(f.accepted().map((row) => row.pid)).size).toBe(1);
});

it.each([
  ['initial', 'preflight-error'],
  ['initial', 'late-revision'],
  ['retained', 'preflight-error'],
  ['retained', 'late-revision'],
])('retains child work after a %s prompt %s without replay', async (connection, failure) => {
  const f = fixture();
  const controller = new AbortController();
  try {
    if (connection === 'retained') await invokeAgent('channel', 'child-held', f.options);
    else f.touch('hook-child');
    f.touch(failure);
    const result = await invokeAgent('channel', 'effectful failure', {
      ...f.options,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, text: '', error: failure });
    expect(hasResidentAgent('channel')).toBe(true);
    expect(f.commands().some((c) => ['abort', 'clear_queue'].includes(c.type))).toBe(false);
    expect(existsSync(join(f.root, 'child-exit'))).toBe(false);
    expect(() =>
      process.kill(Number(readFileSync(join(f.root, 'child-pid'), 'utf8')), 0),
    ).not.toThrow();
    controller.abort(); // A completed failed request cannot stop its retained connection.
    expect((await invokeAgent('channel', 'control', f.options)).text).toBe('a/off');
    expect(new Set(f.accepted().map((row) => row.pid)).size).toBe(1);
    expect(
      f.commands().filter((c) => c.type === 'prompt' && c.message === 'effectful failure'),
    ).toHaveLength(1);
    expect(f.hookEffects().filter((row) => row.message === 'effectful failure')).toHaveLength(1);
    f.touch('release-child');
    await vi.waitFor(() =>
      expect(f.delivery.onAssistantMessage).toHaveBeenCalledWith(
        'child complete',
        expect.any(AbortSignal),
      ),
    );
    expect(readFileSync(join(f.root, 'child-exit'), 'utf8')).toBe('0');
    expect(
      f.delivery.onAssistantMessage.mock.calls.filter(([text]) => text === 'child complete'),
    ).toHaveLength(1);
    expect(f.commands().some((c) => ['abort', 'clear_queue'].includes(c.type))).toBe(false);
    expect(f.delivery.onError).not.toHaveBeenCalled();
  } finally {
    f.touch('release-child');
  }
});

it.each([false, true])(
  'logs nonpersistent input once with transformation=%s',
  async (transformed) => {
    const f = fixture();
    Object.assign(config, { piRpcPersistent: false });
    if (transformed) f.touch('transform-input');
    db.initDb();
    const reader = new Database(config.dbPath, { readonly: true });
    db.registerChannel({
      jid: 'dc:legacy-log',
      name: 'legacy-log',
      folder: 'channel',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: f.root,
    });
    db.enqueueMessage({
      channelJid: 'dc:legacy-log',
      sender: 'user',
      senderName: 'User',
      content: 'original Discord input',
      timestamp: new Date().toISOString(),
    });
    try {
      startProcessingLoop();
      await vi.waitFor(() =>
        expect(reader.prepare('select status from message_queue').get()).toEqual({
          status: 'done',
        }),
      );
      expect(reader.prepare("select content from message_log where role='user'").all()).toEqual([
        { content: 'original Discord input' },
      ]);
      expect(f.commands().filter((c) => c.type === 'prompt')).toHaveLength(1);
    } finally {
      await stopProcessingLoop({ timeoutMs: 100 });
      reader.close();
    }
  },
);

it('defers settings and input during compaction without aborting it', async () => {
  const f = fixture();
  await invokeAgent('channel', 'first', f.options);
  f.touch('compact');
  f.set({ model: 'test/b' });
  expect((await invokeAgent('channel', 'next', f.options)).pending).toBe(true);
  expect(f.accepted()).toHaveLength(1);
  expect(hasResidentAgent('channel')).toBe(true);
  f.remove('compact');
  expect((await invokeAgent('channel', 'next', f.options)).text).toBe('b/off');
  expect(f.commands().some((c) => c.type === 'abort')).toBe(false);
});

it.each(['cwd', 'executable', 'arguments', 'implicit default'])(
  'keeps %s changes explicitly pending without retiring unknown children',
  async (kind) => {
    const f = fixture();
    await invokeAgent('channel', 'first', f.options);
    if (kind === 'cwd') f.set({ cwd: join(f.root, 'other') });
    if (kind === 'executable') Object.assign(config, { piBin: join(f.root, 'other') });
    if (kind === 'arguments') Object.assign(config, { piExtraFlags: '--no-tools' });
    if (kind === 'implicit default') f.set({ model: undefined });
    expect((await invokeAgent('channel', 'next', f.options)).pending).toBe(true);
    expect(f.accepted()).toHaveLength(1);
    expect(hasResidentAgent('channel')).toBe(true);
    expect(f.commands().some((c) => c.type === 'abort')).toBe(false);
  },
);

it('does not admit input after cancellation during a delayed configuration transaction', async () => {
  const f = fixture();
  await invokeAgent('channel', 'first', f.options);
  f.touch('delay-settings');
  f.set({ model: 'test/b' });
  await vi.waitFor(() => expect(existsSync(join(f.root, 'settings-waiting'))).toBe(true));
  const controller = new AbortController();
  const next = invokeAgent('channel', 'not sent', { ...f.options, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  f.touch('release-settings');
  expect((await next).ok).toBe(false);
  expect(f.accepted()).toHaveLength(1);
});

it('does not let an exiting settings transaction unregister a later connection', async () => {
  const f = fixture();
  await invokeAgent('channel', 'first', f.options);
  f.touch('exit-settings');
  f.set({ model: 'test/b' });
  await vi.waitFor(() => expect(hasResidentAgent('channel')).toBe(false));
  f.remove('exit-settings');
  expect((await invokeAgent('channel', 'next', f.options)).text).toBe('b/off');
  expect(hasResidentAgent('channel')).toBe(true);
  expect(f.accepted().filter((row) => row.message === 'next')).toHaveLength(1);
});

it.each(['preflight-error', 'late-revision', 'missing-ack', 'invalid-ack'])(
  'never requeues or repeats an effectful hook after admitted %s',
  async (failure) => {
    const f = fixture();
    db.initDb();
    const reader = new Database(config.dbPath, { readonly: true });
    db.registerChannel({
      jid: 'dc:hook',
      name: 'hook',
      folder: 'channel',
      requiresTrigger: false,
      isMain: false,
      modelOverride: 'test/a',
      thinkingOverride: '',
      cwdOverride: f.root,
    });
    const enqueue = (content: string) =>
      db.enqueueMessage({
        channelJid: 'dc:hook',
        sender: 'user',
        senderName: 'User',
        content,
        timestamp: new Date().toISOString(),
      });
    try {
      f.touch(failure);
      enqueue('effectful request');
      startProcessingLoop();
      await vi.waitFor(() =>
        expect(reader.prepare('select status from message_queue where rowid=1').get()).toEqual({
          status: 'failed',
        }),
      );
      // A later ordinary input succeeds; the failed intent is never replayed,
      // even though its user message was not seen. Semantic failures retain Pi;
      // uncertain protocol/transport failures still use the disconnect path.
      enqueue('control');
      await vi.waitFor(() =>
        expect(reader.prepare('select status from message_queue where rowid=2').get()).toEqual({
          status: 'done',
        }),
      );
      expect(reader.prepare('select status from message_queue order by rowid').all()).toEqual([
        { status: 'failed' },
        { status: 'done' },
      ]);
      expect(
        f
          .commands()
          .filter((c) => c.type === 'prompt')
          .map((c) => c.message),
      ).toEqual(['[Discord user: User]\neffectful request', '[Discord user: User]\ncontrol']);
      expect(f.hookEffects()).toEqual([
        { message: '[Discord user: User]\neffectful request' },
        { message: '[Discord user: User]\ncontrol' },
      ]);
      if (failure === 'preflight-error' || failure === 'late-revision') {
        expect(new Set(f.accepted().map((row) => row.pid)).size).toBe(1);
        expect(f.commands().some((c) => ['abort', 'clear_queue'].includes(c.type))).toBe(false);
      }
      expect(
        reader.prepare("select content from message_log where role='user' order by rowid").all(),
      ).toEqual([{ content: 'control' }]);
    } finally {
      await stopProcessingLoop({ timeoutMs: 100 });
      reader.close();
    }
  },
);

it('preserves the real queue across settings busy and guarded prompt refusal, without replay', async () => {
  const f = fixture();
  db.initDb();
  const reader = new Database(config.dbPath, { readonly: true });
  db.registerChannel({
    jid: 'dc:settings',
    name: 'settings',
    folder: 'channel',
    requiresTrigger: false,
    isMain: false,
    modelOverride: 'test/a',
    thinkingOverride: '',
    cwdOverride: f.root,
  });
  const enqueue = (content: string) =>
    db.enqueueMessage({
      channelJid: 'dc:settings',
      sender: 'user',
      senderName: 'User',
      content,
      timestamp: new Date().toISOString(),
    });
  try {
    enqueue('first');
    startProcessingLoop();
    await vi.waitFor(() =>
      expect(reader.prepare('select status from message_queue where rowid=1').get()).toEqual({
        status: 'done',
      }),
    );
    f.touch('compact');
    db.setChannelModelOverride('dc:settings', 'test/b');
    enqueue('second');
    enqueue('third');
    await vi.waitFor(() =>
      expect(f.commands().some((c) => c.type === 'set_runtime_settings' && c.modelId === 'b')).toBe(
        true,
      ),
    );
    expect(f.accepted()).toHaveLength(1);
    expect(
      reader
        .prepare("select count(*) as n from message_queue where status in ('pending','processing')")
        .get(),
    ).toEqual({ n: 2 });
    f.touch('reject-prompt');
    f.remove('compact');
    await vi.waitFor(() =>
      expect(
        reader.prepare("select count(*) as n from message_queue where status='done'").get(),
      ).toEqual({ n: 3 }),
    );
    expect(f.accepted().map((row) => row.message)).toEqual([
      '[Discord user: User]\nfirst',
      '[Discord user: User]\nsecond',
      '[Discord user: User]\nthird',
    ]);
    expect(
      f
        .accepted()
        .slice(1)
        .every((row) => row.model.id === 'b'),
    ).toBe(true);
    expect(f.commands().filter((c) => c.type === 'prompt').length).toBeGreaterThan(
      f.accepted().length,
    );
    expect(
      reader.prepare("select content from message_log where role='user' order by rowid").all(),
    ).toEqual([{ content: 'first' }, { content: 'second' }, { content: 'third' }]);
    // Definite pre-hook refusals above cannot have executed the hook.
    expect(f.hookEffects()).toEqual(f.accepted().map(({ message }) => ({ message })));
    // A DB-only setter is reconciled even with no new user message.
    db.setChannelModelOverride('dc:settings', 'test/c');
    await vi.waitFor(() =>
      expect(getResidentSettingsStatus('channel')).toContain('Applied: test/c'),
    );
  } finally {
    await stopProcessingLoop({ timeoutMs: 100 });
    reader.close();
  }
});
