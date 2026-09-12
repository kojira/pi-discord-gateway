import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue({ ok: true, text: 'first reply' }),
  send: vi.fn().mockResolvedValue(true),
  supervisor: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockReturnValue(true),
}));
vi.mock('../src/agent/invoke.js', () => ({
  invokeAgent: mocks.invoke,
  steerActiveAgent: vi.fn(),
  hasResidentAgent: () => true,
  stopResidentAgent: mocks.stop,
  shutdownResidentAgents: mocks.shutdown,
}));
vi.mock('../src/discord/client.js', () => ({
  sendResponse: mocks.send,
  promptSupervisorRequest: mocks.supervisor,
  setTyping: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/discord/webhook-monitor.js', () => ({
  enqueueWebhookTrace: vi.fn(),
  enqueueWebhookTerminal: vi.fn(),
  flushWebhookTrace: vi.fn().mockResolvedValue(undefined),
}));

it('delivers independently after a queue row finishes and shuts down idle resident connections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'piscord-queue-persistent-'));
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    DB_PATH: join(root, 'db'),
    SESSIONS_DIR: join(root, 'sessions'),
    PI_RPC_PERSISTENT: 'true',
    POLL_INTERVAL_MS: '1',
  });
  vi.resetModules();
  const db = await import('../src/db.js');
  const queue = await import('../src/agent/queue.js');
  db.initDb();
  const reader = new Database(join(root, 'db'), { readonly: true });
  try {
    db.registerChannel({
      jid: 'dc:test',
      name: 'test',
      folder: 'test',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'dc:test',
      sender: 'user',
      senderName: 'User',
      content: 'first',
      timestamp: new Date().toISOString(),
    });
    queue.startProcessingLoop();
    await vi.waitFor(() =>
      expect(reader.prepare('select status from message_queue').get()).toEqual({ status: 'done' }),
    );
    const delivery = mocks.invoke.mock.calls[0][2].connectionDelivery;
    const connectionSignal = new AbortController().signal;
    await delivery.onAssistantMessage('delayed child reply', connectionSignal);
    await delivery.onSupervisorRequest({ id: 'late supervisor' }, connectionSignal);
    expect(mocks.send).toHaveBeenLastCalledWith(
      'dc:test',
      'delayed child reply',
      expect.any(AbortSignal),
    );
    expect(mocks.send.mock.calls.at(-1)?.[2].aborted).toBe(false);
    expect(mocks.supervisor).toHaveBeenCalledWith(
      'dc:test',
      { id: 'late supervisor' },
      expect.any(AbortSignal),
    );
    expect(reader.prepare('select status from message_queue').get()).toEqual({ status: 'done' });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(queue.isChannelProcessing('dc:test')).toBe(true); // /new cannot rotate a live session
    expect(queue.abortChannelTask('dc:test').aborted).toBe(true);
    expect(mocks.stop).toHaveBeenCalledWith('test');
    await queue.stopProcessingLoop();
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
    const sent = mocks.send.mock.calls.length;
    await delivery.onAssistantMessage('after teardown', connectionSignal);
    expect(mocks.send).toHaveBeenCalledTimes(sent);
  } finally {
    await queue.stopProcessingLoop();
    reader.close();
    db.closeDb();
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    vi.resetModules();
    rmSync(root, { recursive: true, force: true });
  }
});
