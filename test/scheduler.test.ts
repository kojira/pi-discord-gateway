import { describe, expect, it, vi } from 'vitest';

const originalDbPath = process.env.DB_PATH;

describe('computeNextRun', () => {
  it('returns a future date for a cron expression', async () => {
    vi.resetModules();
    const { computeNextRun } = await import('../src/agent/scheduler.js');

    const nextRun = computeNextRun('* * * * *', 'recurring');

    expect(nextRun).not.toBeNull();
    expect(new Date(nextRun ?? '').getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for a past ISO one-time schedule', async () => {
    vi.resetModules();
    const { computeNextRun } = await import('../src/agent/scheduler.js');

    const nextRun = computeNextRun(new Date(Date.now() - 60_000).toISOString(), 'once');

    expect(nextRun).toBeNull();
  });

  it('returns the original future ISO one-time schedule', async () => {
    vi.resetModules();
    const { computeNextRun } = await import('../src/agent/scheduler.js');
    const futureIso = new Date(Date.now() + 60_000).toISOString();

    const nextRun = computeNextRun(futureIso, 'once');

    expect(nextRun).toBe(futureIso);
  });
});

describe('scheduled task db helpers', () => {
  it('does not overlap identical scheduled messages while one is still running', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();

    const db = await import('../src/db.js');
    db.initDb();

    try {
      db.registerChannel({
        jid: 'dc:heartbeat',
        name: 'heartbeat',
        folder: 'ch_heartbeat',
        requiresTrigger: false,
        isMain: false,
        cwdOverride: '',
      });
      const taskId = db.addScheduledTask({
        name: 'Heartbeat',
        type: 'recurring',
        schedule: '* * * * *',
        channelJid: 'dc:heartbeat',
        prompt: 'report progress',
        createdBy: 'tester',
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const message = {
        channelJid: 'dc:heartbeat',
        sender: 'scheduler',
        senderName: 'Scheduler',
        content: 'report progress',
        timestamp: new Date().toISOString(),
      };

      db.enqueueScheduledTask(taskId, message, message.timestamp, new Date().toISOString());
      expect(db.claimNextMessage('dc:heartbeat')).toBeTruthy();

      db.enqueueScheduledTask(taskId, message, message.timestamp, new Date().toISOString());
      expect(db.pendingMessageSnapshot('dc:heartbeat').count).toBe(0);
    } finally {
      db.closeDb();
      vi.resetModules();

      if (originalDbPath === undefined) {
        delete process.env.DB_PATH;
      } else {
        process.env.DB_PATH = originalDbPath;
      }
    }
  });

  it('adds, lists, and removes scheduled tasks in an in-memory database', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();

    const db = await import('../src/db.js');
    db.initDb();

    try {
      const id = db.addScheduledTask({
        name: 'Daily summary',
        type: 'recurring',
        schedule: '* * * * *',
        channelJid: 'dc:123',
        prompt: 'post summary',
        createdBy: 'tester',
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      });

      expect(id).toBeGreaterThan(0);

      const tasks = db.listScheduledTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        id,
        name: 'Daily summary',
        type: 'recurring',
        schedule: '* * * * *',
        channel_jid: 'dc:123',
        prompt: 'post summary',
        enabled: 1,
        created_by: 'tester',
      });
      expect(tasks[0].next_run_at).toBeTruthy();

      expect(db.removeScheduledTask(id)).toBe(true);
      expect(db.listScheduledTasks()).toHaveLength(0);
    } finally {
      db.closeDb();
      vi.resetModules();

      if (originalDbPath === undefined) {
        delete process.env.DB_PATH;
      } else {
        process.env.DB_PATH = originalDbPath;
      }
    }
  });
});
