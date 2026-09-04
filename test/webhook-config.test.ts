import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
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
  it('durably leases provisioning before creation and preserves returned credentials', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-webhook-provisioning-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    const db = await import('../src/db.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    try {
      const lease = db.beginChannelWebhookProvisioning(
        {
          channel_jid: 'dc:source',
          destination_channel_id: 'monitor',
          destination_channel_name: 'monitoring',
          webhook_name: 'monitor webhook',
        },
        1_000,
      );
      expect(lease).toMatchObject({ state: 'creating', updated_at_ms: 1_000 });
      expect(lease.webhook_name).toContain(lease.lease_id.slice(0, 8));
      expect(() =>
        db.beginChannelWebhookProvisioning({
          channel_jid: 'dc:source',
          destination_channel_id: 'other',
          destination_channel_name: 'other',
          webhook_name: 'other webhook',
        }),
      ).toThrow(/already in progress/);
      expect(() => db.unregisterChannel('dc:source')).toThrow(/active setup/);
      expect(db.clearChannelWebhook('dc:source')).toBeUndefined();
      expect(
        db.isChannelWebhookProvisioningStale(lease, 1_000 + db.WEBHOOK_PROVISIONING_LEASE_MS),
      ).toBe(true);
      expect(() =>
        db.beginChannelWebhookProvisioning(
          {
            channel_jid: 'dc:source',
            destination_channel_id: 'other',
            destination_channel_name: 'other',
            webhook_name: 'other webhook',
          },
          1_000 + db.WEBHOOK_PROVISIONING_LEASE_MS,
        ),
      ).toThrow(/webhook-clear/);

      expect(db.markChannelWebhookCreateRequestIssued(lease.lease_id, 1_500)).toBe(true);
      const created = {
        channel_jid: 'dc:source',
        destination_channel_id: 'monitor',
        destination_channel_name: 'monitoring',
        webhook_id: 'created-id',
        webhook_token: 'created-token',
      };
      expect(db.recordChannelWebhookCreated(lease.lease_id, created, 2_000)).toBe(true);
      expect(db.getChannelWebhookProvisioning('dc:source')).toMatchObject({
        state: 'created',
        webhook_id: 'created-id',
        webhook_token: 'created-token',
      });
      db.closeDb();
      db.initDb();
      expect(db.getChannelWebhookProvisioning('dc:source')).toMatchObject({
        lease_id: lease.lease_id,
        state: 'created',
        webhook_id: 'created-id',
        webhook_token: 'created-token',
      });
      expect(db.activateChannelWebhookProvisioning(lease.lease_id)).toEqual({
        previous: undefined,
      });
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(db.getChannelWebhook('dc:source')).toEqual(created);
    } finally {
      db.closeDb();
    }
  });

  it('atomically disables routing and force-claims a fresh creator during clear', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-webhook-begin-clear-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    const db = await import('../src/db.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    const active = {
      channel_jid: 'dc:source',
      destination_channel_id: 'old-monitor',
      destination_channel_name: 'old monitoring',
      webhook_id: 'old-id',
      webhook_token: 'old-token',
    };
    db.setChannelWebhook(active);
    const lease = db.beginChannelWebhookProvisioning({
      channel_jid: 'dc:source',
      destination_channel_id: 'new-monitor',
      destination_channel_name: 'new monitoring',
      webhook_name: 'new webhook',
    });
    expect(db.markChannelWebhookCreateRequestIssued(lease.lease_id)).toBe(true);

    try {
      const started = db.beginChannelWebhookClear('dc:source');
      expect(started.removed).toEqual(active);
      expect(started.provisioning).toMatchObject({
        lease_id: lease.lease_id,
        state: 'creating',
        reconciling: 1,
      });
      expect(db.getChannelWebhook('dc:source')).toBeUndefined();
      expect(db.getPendingWebhookCleanup('dc:source')).toEqual([active]);

      const late = {
        channel_jid: 'dc:source',
        destination_channel_id: 'new-monitor',
        destination_channel_name: 'new monitoring',
        webhook_id: 'late-id',
        webhook_token: 'late-token',
      };
      expect(db.recordChannelWebhookCreated(lease.lease_id, late)).toBe(false);
      expect(() => db.activateChannelWebhookProvisioning(lease.lease_id)).toThrow(
        /no longer active/,
      );
      expect(db.getChannelWebhook('dc:source')).toBeUndefined();
      expect(db.getChannelWebhookProvisioning('dc:source')).toMatchObject({
        lease_id: lease.lease_id,
        state: 'created',
        reconciling: 1,
        webhook_id: 'late-id',
        webhook_token: 'late-token',
      });
    } finally {
      db.closeDb();
    }
  });

  it('moves already-created provisioning credentials to cleanup during clear', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-webhook-created-clear-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    const db = await import('../src/db.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    const lease = db.beginChannelWebhookProvisioning({
      channel_jid: 'dc:source',
      destination_channel_id: 'monitor',
      destination_channel_name: 'monitoring',
      webhook_name: 'webhook',
    });
    const created = {
      channel_jid: 'dc:source',
      destination_channel_id: 'monitor',
      destination_channel_name: 'monitoring',
      webhook_id: 'created-id',
      webhook_token: 'created-token',
    };
    db.markChannelWebhookCreateRequestIssued(lease.lease_id);
    db.recordChannelWebhookCreated(lease.lease_id, created);

    try {
      expect(db.beginChannelWebhookClear('dc:source').provisioning).toMatchObject({
        state: 'created',
        webhook_id: 'created-id',
      });
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(db.getPendingWebhookCleanup('dc:source')).toEqual([created]);
      expect(() => db.activateChannelWebhookProvisioning(lease.lease_id)).toThrow(
        /no longer active/,
      );
    } finally {
      db.closeDb();
    }
  });

  it('retains late or failed provisioning credentials for retry cleanup', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-webhook-late-provisioning-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    const db = await import('../src/db.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    try {
      const input = {
        channel_jid: 'dc:source',
        destination_channel_id: 'monitor',
        destination_channel_name: 'monitoring',
        webhook_name: 'monitor webhook',
      };
      const lateLease = db.beginChannelWebhookProvisioning(input);
      expect(db.markChannelWebhookCreateRequestIssued(lateLease.lease_id)).toBe(true);
      expect(db.cancelChannelWebhookProvisioning(lateLease.lease_id)).toBe(true);
      expect(db.unregisterChannel('dc:source')).toBe(true);
      const lateWebhook = {
        channel_jid: 'dc:source',
        destination_channel_id: 'monitor',
        destination_channel_name: 'monitoring',
        webhook_id: 'late-id',
        webhook_token: 'late-token',
      };
      expect(db.recordChannelWebhookCreated(lateLease.lease_id, lateWebhook)).toBe(false);
      expect(db.getChannel('dc:source')).toBeUndefined();
      expect(db.getPendingWebhookCleanup('dc:source')).toEqual([lateWebhook]);

      db.registerChannel({
        jid: 'dc:source',
        name: 'source',
        folder: 'source',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      const failedLease = db.beginChannelWebhookProvisioning(input);
      expect(db.markChannelWebhookCreateRequestIssued(failedLease.lease_id)).toBe(true);
      const failedWebhook = {
        ...lateWebhook,
        webhook_id: 'failed-id',
        webhook_token: 'failed-token',
      };
      expect(db.recordChannelWebhookCreated(failedLease.lease_id, failedWebhook)).toBe(true);
      db.queueChannelWebhookProvisioningCleanup(failedLease.lease_id, failedWebhook);
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(db.getPendingWebhookCleanup('dc:source')).toEqual([failedWebhook, lateWebhook]);
      expect(() => db.unregisterChannel('dc:source')).toThrow(/pending cleanup/);
    } finally {
      db.closeDb();
    }
  });

  it('conclusively clears a pre-request lease after restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-webhook-pre-request-restart-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    const db = await import('../src/db.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    const lease = db.beginChannelWebhookProvisioning({
      channel_jid: 'dc:source',
      destination_channel_id: 'monitor',
      destination_channel_name: 'monitoring',
      webhook_name: 'monitor webhook',
    });
    expect(lease.request_issued).toBe(0);

    try {
      db.closeDb();
      db.initDb();
      expect(db.getChannelWebhookProvisioning('dc:source')).toMatchObject({
        lease_id: lease.lease_id,
        request_issued: 0,
      });
      expect(db.beginChannelWebhookClear('dc:source').provisioning).toMatchObject({
        lease_id: lease.lease_id,
        request_issued: 0,
      });
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(db.unregisterChannel('dc:source')).toBe(true);
    } finally {
      db.closeDb();
    }
  });

  it('migrates legacy provisioning rows as request-issued and uncertain', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-webhook-request-migration-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    const legacy = new Database(dbPath);
    legacy.exec(`
      create table channel_webhook_provisioning (
        channel_jid text primary key,
        lease_id text not null unique,
        destination_channel_id text not null,
        destination_channel_name text not null,
        webhook_name text not null,
        state text not null,
        reconciling integer not null default 0,
        reconciliation_webhook_ids text not null default '[]',
        webhook_id text,
        webhook_token text,
        updated_at_ms integer not null
      );
      insert into channel_webhook_provisioning values (
        'dc:legacy', 'legacy-lease', 'monitor', 'monitoring', 'legacy webhook',
        'creating', 0, '[]', null, null, 1000
      );
    `);
    legacy.close();

    const db = await import('../src/db.js');
    try {
      db.initDb();
      expect(db.getChannelWebhookProvisioning('dc:legacy')).toMatchObject({
        lease_id: 'legacy-lease',
        request_issued: 1,
      });
      expect(db.beginChannelWebhookClear('dc:legacy').provisioning).toMatchObject({
        request_issued: 1,
        reconciling: 1,
      });
      expect(db.getChannelWebhookProvisioning('dc:legacy')).toBeDefined();
    } finally {
      db.closeDb();
    }
  });

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
      expect(db.setChannelWebhook(replacement)).toEqual({ previous: first });
      expect(db.getChannelWebhook(first.channel_jid)).toEqual(replacement);
      expect(db.getPendingWebhookCleanup(first.channel_jid)).toEqual([first]);
      expect(db.getChannelWebhook(second.channel_jid)).toEqual(second);

      expect(db.clearChannelWebhook(first.channel_jid)).toEqual(replacement);
      expect(db.getChannelWebhook(first.channel_jid)).toBeUndefined();
      expect(db.getPendingWebhookCleanup(first.channel_jid)).toEqual([first, replacement]);
      expect(db.clearChannelWebhook(first.channel_jid)).toBeUndefined();
      expect(db.getChannelWebhook(second.channel_jid)).toEqual(second);

      expect(() => db.unregisterChannel(second.channel_jid)).toThrow(/webhook-clear/);
      expect(db.getChannelWebhook(second.channel_jid)).toEqual(second);
      db.clearChannelWebhook(second.channel_jid);
      expect(() => db.unregisterChannel(second.channel_jid)).toThrow(/pending cleanup/);
      expect(db.completeWebhookCleanup(second.webhook_id)).toBe(true);
      expect(db.unregisterChannel(second.channel_jid)).toBe(true);

      expect(() => db.setChannelWebhook({ ...first, channel_jid: 'dc:missing' })).toThrow(
        /no longer registered/,
      );
    } finally {
      db.closeDb();
    }
  });
});
