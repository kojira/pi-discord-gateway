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
  'STEER_BATCH_MAX_ATTACHMENT_BYTES',
  'STEER_BATCH_MAX_MESSAGES',
  'STEER_BATCH_MAX_PROMPT_CHARS',
  'STEER_DEBOUNCE_MAX_MS',
  'STEER_DEBOUNCE_MS',
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
  it('marks steer done only when consumed and does not replay it after a later run error', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-queue-steer-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.PI_CWD = '/global/project';
    process.env.STEER_DEBOUNCE_MS = '1';

    let finishInvocation!: (value: { ok: boolean; text: string; error?: string }) => void;
    invokeAgentMock.mockImplementation(
      () =>
        new Promise((resolveInvocation) => {
          finishInvocation = resolveInvocation;
        }),
    );
    let consumeSteer!: () => void | Promise<void>;
    steerActiveAgentMock.mockImplementation(async (_folder, _prompt, opts) => {
      consumeSteer = opts.onConsumed;
      return true;
    });
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

      await consumeSteer();
      const consumedDb = new Database(dbPath, { readonly: true });
      expect(
        (consumedDb.prepare('select status from message_queue where rowid = 2').get() as any)
          .status,
      ).toBe('done');
      consumedDb.close();

      finishInvocation({ ok: false, text: '', error: 'later failure' });
      await vi.waitFor(() =>
        expect(sendResponseMock).toHaveBeenCalledWith('dc:123', '⚠️ Agent error: later failure'),
      );

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

  it('debounces queued messages and steers them as one durable batch', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-queue-steer-batch-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.STEER_DEBOUNCE_MS = '20';

    let finishInvocation!: (value: { ok: boolean; text: string; error?: string }) => void;
    invokeAgentMock.mockImplementation(
      () =>
        new Promise((resolveInvocation) => {
          finishInvocation = resolveInvocation;
        }),
    );
    let consumeBatch!: () => void | Promise<void>;
    steerActiveAgentMock.mockImplementation(async (_folder, _prompt, opts) => {
      consumeBatch = opts.onConsumed;
      return true;
    });
    sendResponseMock.mockResolvedValue(true);
    setTypingMock.mockResolvedValue(undefined);

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:batch',
      name: 'batch test',
      folder: 'ch_batch',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'dc:batch',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'initial request',
      timestamp: new Date().toISOString(),
    });

    queue.startProcessingLoop();
    try {
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(1));
      db.enqueueMessage({
        channelJid: 'dc:batch',
        sender: 'u_1',
        senderName: 'Alice',
        content: 'first correction',
        timestamp: new Date().toISOString(),
        attachments: JSON.stringify([{ id: 'a1', name: 'first.png' }]),
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      db.enqueueMessage({
        channelJid: 'dc:batch',
        sender: 'u_2',
        senderName: 'Bob',
        content: 'second correction',
        timestamp: new Date().toISOString(),
        attachments: JSON.stringify([{ id: 'a2', name: 'second.png' }]),
      });

      await vi.waitFor(() => expect(steerActiveAgentMock).toHaveBeenCalledTimes(1));
      expect(steerActiveAgentMock).toHaveBeenCalledWith(
        'ch_batch',
        '[Discord user: Alice]\nfirst correction\n\n---\n\n[Discord user: Bob]\nsecond correction',
        expect.objectContaining({
          attachments: JSON.stringify([
            { id: 'a1', name: 'first.png' },
            { id: 'a2', name: 'second.png' },
          ]),
        }),
      );

      const processingDb = new Database(dbPath, { readonly: true });
      const processingRows = processingDb
        .prepare('select rowid, status from message_queue where rowid in (2, 3) order by rowid')
        .all() as Array<{ rowid: number; status: string }>;
      expect(processingRows).toEqual([
        { rowid: 2, status: 'processing' },
        { rowid: 3, status: 'processing' },
      ]);
      processingDb.close();

      await consumeBatch();
      const consumedDb = new Database(dbPath, { readonly: true });
      const consumedRows = consumedDb
        .prepare('select rowid, status from message_queue where rowid in (2, 3) order by rowid')
        .all() as Array<{ rowid: number; status: string }>;
      expect(consumedRows).toEqual([
        { rowid: 2, status: 'done' },
        { rowid: 3, status: 'done' },
      ]);
      consumedDb.close();
    } finally {
      finishInvocation?.({ ok: true, text: 'done' });
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });

  it('does not let a stale debounce cross active-run generations or resurrect stopped work', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-queue-steer-generation-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.STEER_DEBOUNCE_MS = '100';
    process.env.STEER_DEBOUNCE_MAX_MS = '200';

    let finishFirst!: (value: { ok: boolean; text: string; error?: string }) => void;
    invokeAgentMock
      .mockImplementationOnce(
        () =>
          new Promise((resolveInvocation) => {
            finishFirst = resolveInvocation;
          }),
      )
      .mockImplementationOnce(
        (_folder, _prompt, opts) =>
          new Promise((resolveInvocation) => {
            opts.signal.addEventListener(
              'abort',
              () => resolveInvocation({ ok: false, text: '', error: 'aborted' }),
              { once: true },
            );
          }),
      );
    sendResponseMock.mockResolvedValue(true);
    setTypingMock.mockResolvedValue(undefined);

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:generation',
      name: 'generation test',
      folder: 'ch_generation',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'dc:generation',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'first run',
      timestamp: new Date().toISOString(),
    });

    queue.startProcessingLoop();
    try {
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(1));
      db.enqueueMessage({
        channelJid: 'dc:generation',
        sender: 'u_1',
        senderName: 'Alice',
        content: 'next run',
        timestamp: new Date().toISOString(),
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      finishFirst({ ok: true, text: 'first done' });

      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(2));
      db.enqueueMessage({
        channelJid: 'dc:generation',
        sender: 'u_1',
        senderName: 'Alice',
        content: 'must be stopped',
        timestamp: new Date().toISOString(),
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      expect(queue.abortChannelTask('dc:generation')).toEqual({ aborted: true, cleared: 1 });
      await vi.waitFor(() => expect(queue.isChannelProcessing('dc:generation')).toBe(false));
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));

      expect(steerActiveAgentMock).not.toHaveBeenCalled();
      const inspect = new Database(dbPath, { readonly: true });
      try {
        expect(
          inspect
            .prepare('select rowid from message_queue where content = ?')
            .get('must be stopped'),
        ).toBeUndefined();
      } finally {
        inspect.close();
      }
    } finally {
      finishFirst?.({ ok: true, text: 'done' });
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });

  it('bounds steering batches by attachments, row count, and prompt characters', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-queue-steer-limits-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.STEER_DEBOUNCE_MS = '0';
    process.env.STEER_DEBOUNCE_MAX_MS = '50';
    process.env.STEER_BATCH_MAX_MESSAGES = '2';
    process.env.STEER_BATCH_MAX_PROMPT_CHARS = '100';
    process.env.STEER_BATCH_MAX_ATTACHMENT_BYTES = '10';

    let finishInvocation!: (value: { ok: boolean; text: string; error?: string }) => void;
    invokeAgentMock.mockImplementation(
      () =>
        new Promise((resolveInvocation) => {
          finishInvocation = resolveInvocation;
        }),
    );
    const consumeCallbacks: Array<() => void | Promise<void>> = [];
    steerActiveAgentMock.mockImplementation(async (_folder, _prompt, opts) => {
      consumeCallbacks.push(opts.onConsumed);
      return true;
    });
    sendResponseMock.mockResolvedValue(true);
    setTypingMock.mockResolvedValue(undefined);

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:limits',
      name: 'limit test',
      folder: 'ch_limits',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'dc:limits',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'initial',
      timestamp: new Date().toISOString(),
    });

    queue.startProcessingLoop();
    try {
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(1));
      const messages = [
        { content: 'a', attachments: JSON.stringify([{ name: 'a', size: 6 }]) },
        { content: 'b', attachments: JSON.stringify([{ name: 'b', size: 6 }]) },
        { content: 'c', attachments: null },
        { content: 'd', attachments: null },
        { content: 'x'.repeat(60), attachments: null },
      ];
      for (const message of messages) {
        db.enqueueMessage({
          channelJid: 'dc:limits',
          sender: 'u_1',
          senderName: 'Alice',
          content: message.content,
          timestamp: new Date().toISOString(),
          attachments: message.attachments,
        });
      }

      await vi.waitFor(() => expect(steerActiveAgentMock).toHaveBeenCalledTimes(4));
      const prompts = steerActiveAgentMock.mock.calls.map((call) => call[1]);
      expect(prompts).toEqual([
        '[Discord user: Alice]\na',
        '[Discord user: Alice]\nb\n\n---\n\n[Discord user: Alice]\nc',
        '[Discord user: Alice]\nd',
        `[Discord user: Alice]\n${'x'.repeat(60)}`,
      ]);
      expect(JSON.parse(steerActiveAgentMock.mock.calls[0][2].attachments)).toEqual([
        { name: 'a', size: 6 },
      ]);
      expect(JSON.parse(steerActiveAgentMock.mock.calls[1][2].attachments)).toEqual([
        { name: 'b', size: 6 },
      ]);

      for (const consume of consumeCallbacks) await consume();
      const inspect = new Database(dbPath, { readonly: true });
      try {
        expect(
          inspect
            .prepare("select count(*) as count from message_queue where status != 'done'")
            .get(),
        ).toEqual({ count: 1 });
      } finally {
        inspect.close();
      }
    } finally {
      finishInvocation?.({ ok: true, text: 'done' });
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });

  it('flushes a steering batch at the maximum debounce wait under sustained arrivals', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-queue-steer-max-wait-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.STEER_DEBOUNCE_MS = '20';
    process.env.STEER_DEBOUNCE_MAX_MS = '55';

    let finishInvocation!: (value: { ok: boolean; text: string; error?: string }) => void;
    invokeAgentMock.mockImplementation(
      () =>
        new Promise((resolveInvocation) => {
          finishInvocation = resolveInvocation;
        }),
    );
    let producing = true;
    steerActiveAgentMock.mockImplementation(async (_folder, _prompt, opts) => {
      await opts.onConsumed();
      return true;
    });
    sendResponseMock.mockResolvedValue(true);
    setTypingMock.mockResolvedValue(undefined);

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:max-wait',
      name: 'max wait test',
      folder: 'ch_max_wait',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'dc:max-wait',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'initial',
      timestamp: new Date().toISOString(),
    });

    queue.startProcessingLoop();
    try {
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(1));
      db.enqueueMessage({
        channelJid: 'dc:max-wait',
        sender: 'u_1',
        senderName: 'Alice',
        content: 'steer 0',
        timestamp: new Date().toISOString(),
      });
      const producer = (async () => {
        for (let index = 1; index <= 10; index += 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
          db.enqueueMessage({
            channelJid: 'dc:max-wait',
            sender: 'u_1',
            senderName: 'Alice',
            content: `steer ${index}`,
            timestamp: new Date().toISOString(),
          });
        }
        producing = false;
      })();

      await vi.waitFor(() => expect(steerActiveAgentMock).toHaveBeenCalled());
      expect(producing).toBe(true);
      await producer;
    } finally {
      finishInvocation?.({ ok: true, text: 'done' });
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });

  it('keeps an intermediate Discord delivery failure sticky after a later success', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-queue-delivery-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';

    invokeAgentMock.mockImplementation(async (_folder, _prompt, opts) => {
      try {
        await opts.onAssistantMessage('intermediate');
      } catch {
        // invokeAgent logs callback failures and continues delivering later turns.
      }
      await opts.onAssistantMessage('final');
      return { ok: true, text: 'final' };
    });
    sendResponseMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    setTypingMock.mockResolvedValue(undefined);

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:456',
      name: 'delivery test',
      folder: 'ch_456',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'dc:456',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'run task',
      timestamp: new Date().toISOString(),
    });

    queue.startProcessingLoop();
    try {
      await vi.waitFor(() =>
        expect(sendResponseMock).toHaveBeenCalledWith(
          'dc:456',
          '⚠️ One or more intermediate assistant messages could not be delivered.',
        ),
      );
      const inspectDb = new Database(dbPath, { readonly: true });
      expect(
        (inspectDb.prepare('select status from message_queue where rowid = 1').get() as any).status,
      ).toBe('failed');
      inspectDb.close();
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });
});
