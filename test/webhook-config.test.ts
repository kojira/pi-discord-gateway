import { mkdtempSync, rmSync, statSync } from 'node:fs';
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

describe('per-channel webhook configuration', () => {
  it('creates, replaces, and clears one independent webhook per source channel', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-webhook-config-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    const db = await import('../src/db.js');
    db.initDb();
    try {
      for (const [jid, folder] of [
        ['dc:source-1', 'source_1'],
        ['dc:source-2', 'source_2'],
      ]) {
        db.registerChannel({
          jid,
          name: jid,
          folder,
          requiresTrigger: false,
          isMain: false,
          modelOverride: '',
          thinkingOverride: '',
          cwdOverride: '',
        });
      }

      const first = {
        channel_jid: 'dc:source-1',
        destination_channel_id: 'monitor-1',
        destination_channel_name: 'monitoring',
        webhook_id: 'webhook-1',
        webhook_token: 'secret-1',
      };
      const second = {
        channel_jid: 'dc:source-2',
        destination_channel_id: 'monitor-2',
        destination_channel_name: 'operations',
        webhook_id: 'webhook-2',
        webhook_token: 'secret-2',
      };

      db.setChannelWebhook(first);
      db.setChannelWebhook(second);
      if (process.platform !== 'win32') {
        expect(statSync(process.env.DB_PATH!).mode & 0o777).toBe(0o600);
      }
      expect(db.getChannelWebhook(first.channel_jid)).toEqual(first);
      expect(db.getChannelWebhook(second.channel_jid)).toEqual(second);

      const replacement = {
        ...first,
        destination_channel_id: 'monitor-3',
        destination_channel_name: 'private-monitoring',
        webhook_id: 'webhook-3',
        webhook_token: 'secret-3',
      };
      db.setChannelWebhook(replacement);
      expect(db.getChannelWebhook(first.channel_jid)).toEqual(replacement);
      expect(db.getChannelWebhook(second.channel_jid)).toEqual(second);

      expect(db.clearChannelWebhook(first.channel_jid)).toEqual(replacement);
      expect(db.getChannelWebhook(first.channel_jid)).toBeUndefined();
      expect(db.clearChannelWebhook(first.channel_jid)).toBeUndefined();
      expect(db.getChannelWebhook(second.channel_jid)).toEqual(second);

      expect(db.unregisterChannel(second.channel_jid)).toBe(true);
      expect(db.getChannelWebhook(second.channel_jid)).toBeUndefined();
    } finally {
      db.closeDb();
    }
  });
});
