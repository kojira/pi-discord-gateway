import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

// Resident Pis run behind the real pi-host (src/agent/pi-host.ts via tsx) and a
// protocol fixture standing in for `pi --mode rpc`.

const mocks = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(true) }));
vi.mock('../src/discord/client.js', () => ({
  sendResponse: mocks.send,
  setTyping: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/discord/webhook-monitor.js', () => ({
  enqueueWebhookTrace: vi.fn(),
  enqueueWebhookTerminal: vi.fn(),
  flushWebhookTrace: vi.fn().mockResolvedValue(undefined),
}));

const previousEnv = { ...process.env };
const roots: string[] = [];
const hostPids = new Set<number>();

afterEach(() => {
  for (const pid of hostPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  hostPids.clear();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  vi.resetModules();
  mocks.send.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Pi RPC fixture: a prompt containing "slow" waits for <root>/release before replying. */
function writeFixturePi(root: string, name: string): string {
  const bin = join(root, name);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, rmSync } = require('node:fs');
const { basename, join } = require('node:path');
const root = ${JSON.stringify(root)};
const me = basename(process.argv[1]);
if (!process.argv.includes('rpc')) process.exit(0);
appendFileSync(join(root, 'starts'), me + ':' + process.pid + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let run = 0;
const reply = (message) => {
  const runId = 'run-' + ++run;
  send({ type: 'agent_start', runId });
  send({ type: 'message_start', message: { role: 'user', content: message } });
  const finish = () => {
    const text = 'reply(' + message.split('\\n').at(-1) + ') from ' + me;
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
    send({ type: 'agent_settled', runId });
  };
  if (!message.includes('slow')) return finish();
  const timer = setInterval(() => {
    if (!existsSync(join(root, 'release'))) return;
    clearInterval(timer);
    rmSync(join(root, 'release'));
    finish();
  }, 20);
};
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    appendFileSync(join(root, 'commands'), JSON.stringify(command) + '\\n');
    send({
      type: 'response',
      id: command.id,
      command: command.type,
      success: true,
      data: { accepted: true, sessionId: 'fixture', pendingMessageCount: 0, capabilities: { guardedSteer: 1 } },
    });
    if (command.type === 'prompt') reply(command.message);
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 50));
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function setupEnv(root: string, piBin: string, configFile?: string) {
  Object.assign(process.env, {
    PIDG_CONFIG: configFile ?? join(root, 'missing-config.env'),
    DB_PATH: join(root, 'gateway.db'),
    SESSIONS_DIR: join(root, 'sessions'),
    PI_RPC_PERSISTENT: 'true',
    PI_RESIDENT: 'true',
    PI_CWD: root,
    PI_MODEL: '',
    PI_THINKING: '',
    PI_EXTRA_FLAGS: '',
    POLL_INTERVAL_MS: '10',
    SHUTDOWN_TIMEOUT_MS: '5000',
  });
  if (configFile) delete process.env.PI_BIN;
  else process.env.PI_BIN = piBin;
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'piscord-resident-'));
  roots.push(root);
  return root;
}

function readLines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function trackHost(folder: string, sessionsDir: string): number {
  const record = JSON.parse(readFileSync(join(sessionsDir, folder, 'pi-host.json'), 'utf8'));
  hostPids.add(record.hostPid);
  return record.hostPid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One Gateway process lifetime: fresh modules over the same DB and sessions. */
async function bootGateway() {
  vi.resetModules();
  const db = await import('../src/db.js');
  const queue = await import('../src/agent/queue.js');
  const invoke = await import('../src/agent/invoke.js');
  db.initDb();
  return { db, queue, invoke };
}

const channel = {
  jid: 'dc:resident',
  name: 'resident',
  folder: 'resident',
  requiresTrigger: false,
  isMain: false,
  modelOverride: '',
  thinkingOverride: '' as const,
  cwdOverride: '',
};

it('Gateway restart mid-turn: Pi keeps running and the reply is delivered once after reattach', async () => {
  const root = newRoot();
  const piBin = writeFixturePi(root, 'pi-fixture');
  setupEnv(root, piBin);
  const sessionsDir = join(root, 'sessions');

  // Gateway #1 starts the turn.
  const first = await bootGateway();
  first.db.registerChannel(channel);
  first.db.enqueueMessage({
    channelJid: channel.jid,
    sender: 'user',
    senderName: 'User',
    content: 'slow job',
    timestamp: new Date().toISOString(),
  });
  first.queue.startProcessingLoop();
  await vi.waitFor(
    () => expect(readLines(join(root, 'commands')).some((l) => l.includes('slow job'))).toBe(true),
    { timeout: 10_000 },
  );
  const hostPid = trackHost(channel.folder, sessionsDir);
  const piPid = Number(readLines(join(root, 'starts'))[0].split(':')[1]);

  // Gateway #1 shuts down (launchd stop / deploy). Pi must stay up, row stays processing.
  await first.queue.stopProcessingLoop({ timeoutMs: 5000 });
  first.db.closeDb();
  expect(alive(hostPid)).toBe(true);
  expect(alive(piPid)).toBe(true);
  const reader = new Database(join(root, 'gateway.db'), { readonly: true });
  try {
    expect(reader.prepare('select status from message_queue').get()).toEqual({
      status: 'processing',
    });
    expect(mocks.send).not.toHaveBeenCalled();

    // Pi finishes while no Gateway is attached.
    writeFileSync(join(root, 'release'), '1');
    await vi.waitFor(() => expect(existsSync(join(root, 'release'))).toBe(false), {
      timeout: 5000,
    });

    // Gateway #2 reattaches and completes the same row.
    const second = await bootGateway();
    second.queue.startProcessingLoop();
    await vi.waitFor(
      () =>
        expect(reader.prepare('select status from message_queue').get()).toEqual({
          status: 'done',
        }),
      { timeout: 10_000 },
    );
    expect(mocks.send.mock.calls.map(([jid, text]) => [jid, text])).toEqual([
      [channel.jid, 'reply(slow job) from pi-fixture'],
    ]);
    expect(readLines(join(root, 'starts'))).toHaveLength(1); // same Pi, not restarted
    expect(second.invoke.hasResidentAgent(channel.folder)).toBe(true);

    // The reattached Pi serves the next message too.
    second.db.enqueueMessage({
      channelJid: channel.jid,
      sender: 'user',
      senderName: 'User',
      content: 'next',
      timestamp: new Date().toISOString(),
    });
    await vi.waitFor(() =>
      expect(mocks.send).toHaveBeenLastCalledWith(
        channel.jid,
        'reply(next) from pi-fixture',
        expect.any(AbortSignal),
      ),
    );
    expect(readLines(join(root, 'starts'))).toHaveLength(1);

    // /pi stop reaches the Pi through the socket; host and socket go away.
    expect(second.queue.abortChannelTask(channel.jid).aborted).toBe(true);
    await vi.waitFor(() => expect(alive(hostPid)).toBe(false), { timeout: 5000 });
    expect(existsSync(join(sessionsDir, channel.folder, 'pi-host.json'))).toBe(false);
    await second.queue.stopProcessingLoop({ timeoutMs: 1000 });
    second.db.closeDb();
  } finally {
    reader.close();
  }
}, 30_000);

it('reads PI_BIN at every Pi start; /pi reload ends the Pi after its current work and the next one uses the configured PI_BIN', async () => {
  const root = newRoot();
  const binA = writeFixturePi(root, 'pi-a');
  const binB = writeFixturePi(root, 'pi-b');
  const configFile = join(root, 'config.env');
  writeFileSync(configFile, `PI_BIN=${binA}\n`);
  setupEnv(root, binA, configFile);
  const { db, queue, invoke } = await bootGateway();
  const { formatPiVersion } = await import('../src/discord/slash-commands.js');
  db.registerChannel(channel);
  queue.startProcessingLoop();
  const enqueue = (content: string) =>
    db.enqueueMessage({
      channelJid: channel.jid,
      sender: 'user',
      senderName: 'User',
      content,
      timestamp: new Date().toISOString(),
    });
  try {
    enqueue('slow one');
    await vi.waitFor(() =>
      expect(readLines(join(root, 'commands')).some((l) => l.includes('slow one'))).toBe(true),
    );
    const hostA = trackHost(channel.folder, join(root, 'sessions'));
    expect(invoke.getResidentPiBin(channel.folder)).toBe(binA);
    expect(formatPiVersion(channel.folder)).toBe('pi-a (configured)');

    // A deploy switches PI_BIN in the config file without restarting the Gateway.
    writeFileSync(configFile, `PI_BIN=${binB}\n`);
    expect(invoke.getResidentPiBin(channel.folder)).toBe(binA); // running Pi keeps its binary
    expect(formatPiVersion(channel.folder)).toBe('pi-a → configured pi-b (/pi reload to update)');

    // /pi reload during work: nothing is interrupted, a queued message stays queued.
    expect(invoke.reloadResidentAgent(channel.folder)).toBe(true);
    enqueue('queued during reload');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(hostA)).toBe(true);
    writeFileSync(join(root, 'release'), '1');

    await vi.waitFor(
      () =>
        expect(mocks.send.mock.calls.map(([, text]) => text)).toEqual([
          'reply(slow one) from pi-a',
          'reply(queued during reload) from pi-b',
        ]),
      { timeout: 10_000 },
    );
    expect(alive(hostA)).toBe(false);
    const commands = readLines(join(root, 'commands')).map((line) => JSON.parse(line).type);
    expect(commands).not.toContain('abort');
    expect(commands).not.toContain('clear_queue');
    expect(readLines(join(root, 'starts')).map((line) => line.split(':')[0])).toEqual([
      'pi-a',
      'pi-b',
    ]);
    trackHost(channel.folder, join(root, 'sessions'));
    expect(formatPiVersion(channel.folder)).toBe('pi-b (configured)');
  } finally {
    queue.abortChannelTask(channel.jid);
    await invoke.shutdownResidentAgents();
    await queue.stopProcessingLoop({ timeoutMs: 1000 });
    db.closeDb();
  }
}, 30_000);

it('labels deploy artifacts by component and commit for /pi status', async () => {
  const { buildLabelFromPath } = await import('../src/version.js');
  expect(
    buildLabelFromPath(
      '/x/pi-stack-deploy/wrappers/pi-pi-71236a4c0116-3f8e5b9e41952bbc-a5656d23bba6',
      'pi',
    ),
  ).toBe('pi-71236a4c0116');
  expect(
    buildLabelFromPath(
      '/x/artifacts/gateway-5850968fda65-1f0f4b8cc8901694/dist/cli/index.js',
      'gateway',
    ),
  ).toBe('gateway-5850968fda65');
  expect(buildLabelFromPath('/usr/local/bin/pi', 'pi')).toBe('pi');
});
