import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeAgentMock, steerActiveAgentMock, sendResponseMock, setTypingMock } = vi.hoisted(
  () => ({
    invokeAgentMock: vi.fn(),
    steerActiveAgentMock: vi.fn(),
    sendResponseMock: vi.fn(),
    setTypingMock: vi.fn(),
  }),
);

vi.mock('../src/agent/invoke.js', () => ({
  invokeAgent: invokeAgentMock,
  steerActiveAgent: steerActiveAgentMock,
}));

vi.mock('../src/discord/client.js', () => ({
  promptSupervisorRequest: vi.fn(),
  sendResponse: sendResponseMock,
  setTyping: setTypingMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'MAX_CONCURRENCY',
  'PI_CWD',
  'POLL_INTERVAL_MS',
  'SESSIONS_DIR',
];

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('active-run steering', () => {
  it('routes a later channel message to Pi steer instead of starting another invocation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-queue-steer-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.PI_CWD = '/global/project';

    let finishInvocation!: (value: { ok: true; text: string }) => void;
    invokeAgentMock.mockImplementation(
      () =>
        new Promise((resolveInvocation) => {
          finishInvocation = resolveInvocation;
        }),
    );
    steerActiveAgentMock.mockResolvedValue(true);
    sendResponseMock.mockResolvedValue(true);
    setTypingMock.mockResolvedValue(undefined);

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:123',
      name: 'queue test',
      folder: 'ch_123',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'dc:123',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'initial request',
      timestamp: new Date().toISOString(),
    });

    queue.startProcessingLoop();
    try {
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(1));
      db.enqueueMessage({
        channelJid: 'dc:123',
        sender: 'u_1',
        senderName: 'Alice',
        content: 'change direction',
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => expect(steerActiveAgentMock).toHaveBeenCalledTimes(1));
      expect(steerActiveAgentMock).toHaveBeenCalledWith(
        'ch_123',
        '[Discord user: Alice]\nchange direction',
        expect.objectContaining({ attachments: null }),
      );
      expect(invokeAgentMock).toHaveBeenCalledTimes(1);

      const inspectDb = new Database(dbPath, { readonly: true });
      expect(
        (inspectDb.prepare('select status from message_queue where rowid = 2').get() as any).status,
      ).toBe('processing');
      inspectDb.close();

      finishInvocation({ ok: true, text: 'done' });
      await vi.waitFor(() => expect(sendResponseMock).toHaveBeenCalledWith('dc:123', 'done'));

      const completedDb = new Database(dbPath, { readonly: true });
      expect(
        (completedDb.prepare('select status from message_queue where rowid = 2').get() as any)
          .status,
      ).toBe('done');
      completedDb.close();
    } finally {
      finishInvocation?.({ ok: true, text: 'done' });
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });
});
