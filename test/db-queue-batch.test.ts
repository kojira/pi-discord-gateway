import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'PIDG_CONFIG', 'SESSIONS_DIR'];

afterEach(() => {
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('message queue batch transitions', () => {
  it('rolls back every row when a multi-row completion fails', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-db-batch-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();
    try {
      for (const content of ['first', 'second']) {
        db.enqueueMessage({
          channelJid: 'dc:batch',
          sender: 'u_1',
          senderName: 'Alice',
          content,
          timestamp: new Date().toISOString(),
        });
      }
      expect(db.claimMessages([1, 2])).toBe(true);

      const injector = new Database(dbPath);
      try {
        injector.exec(`
          create trigger fail_second_batch_completion
          before update of status on message_queue
          when old.rowid = 2 and new.status = 'done'
          begin
            select raise(abort, 'injected batch failure');
          end;
        `);
        expect(() => db.markMessagesDone([1, 2])).toThrow(/injected batch failure/);
      } finally {
        injector.close();
      }

      const inspect = new Database(dbPath, { readonly: true });
      try {
        expect(
          inspect.prepare('select rowid, status from message_queue order by rowid').all(),
        ).toEqual([
          { rowid: 1, status: 'processing' },
          { rowid: 2, status: 'processing' },
        ]);
      } finally {
        inspect.close();
      }
    } finally {
      db.closeDb();
    }
  });
});
