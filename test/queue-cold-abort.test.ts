import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { refreshMock, invokeMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  invokeMock: vi.fn(),
}));
vi.mock('../src/agent/model-catalog.js', () => ({
  hasCachedModelCatalog: () => false,
  refreshModelCatalog: refreshMock,
}));
vi.mock('../src/agent/invoke.js', () => ({
  hasResidentAgent: () => false,
  stopResidentAgent: () => false,
  shutdownResidentAgents: vi.fn().mockResolvedValue(undefined),
  invokeAgent: invokeMock,
}));
vi.mock('../src/discord/client.js', () => ({
  setTyping: vi.fn().mockResolvedValue(undefined),
  sendResponse: vi.fn().mockResolvedValue(true),
}));

const root = mkdtempSync(join(tmpdir(), 'piscord-cold-abort-'));
const previous = {
  DB_PATH: process.env.DB_PATH,
  PI_CWD: process.env.PI_CWD,
  SESSIONS_DIR: process.env.SESSIONS_DIR,
  POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS,
};
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('stop during cold model discovery', () => {
  it('releases the channel without waiting for the shared Pi lookup to finish', async () => {
    process.env.DB_PATH = ':memory:';
    process.env.PI_CWD = root;
    process.env.SESSIONS_DIR = join(root, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    refreshMock.mockImplementation(() => new Promise(() => undefined));

    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:cold',
      name: 'cold',
      folder: 'cold',
      requiresTrigger: false,
      isMain: false,
      modelOverride: 'test/plain',
      thinkingOverride: 'high',
      cwdOverride: root,
    });
    db.enqueueMessage({
      channelJid: 'dc:cold',
      sender: 'user',
      senderName: 'User',
      content: 'first',
      timestamp: new Date().toISOString(),
    });
    try {
      queue.startProcessingLoop();
      await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledOnce());
      expect(queue.isChannelProcessing('dc:cold')).toBe(true);
      expect(queue.abortChannelTask('dc:cold').aborted).toBe(true);
      await vi.waitFor(() => expect(queue.isChannelProcessing('dc:cold')).toBe(false));
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 100 });
      db.closeDb();
    }
  });
});
