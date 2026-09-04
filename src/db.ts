import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { type RegisteredChannel, type QueuedMessage, type ThinkingLevel } from './types.js';

let db!: Database.Database;
let dbOpen = false;

export type ScheduledTaskType = 'once' | 'recurring';

export interface ChannelWebhookConfig {
  channel_jid: string;
  destination_channel_id: string;
  destination_channel_name: string;
  webhook_id: string;
  webhook_token: string;
}

export interface ChannelWebhookReplacement {
  previous?: ChannelWebhookConfig;
}

export interface ChannelWebhookClearStart {
  removed?: ChannelWebhookConfig;
  provisioning?: ChannelWebhookProvisioning;
}

export type ChannelWebhookProvisioningState = 'creating' | 'created';

export interface ChannelWebhookProvisioning {
  channel_jid: string;
  lease_id: string;
  destination_channel_id: string;
  destination_channel_name: string;
  webhook_name: string;
  state: ChannelWebhookProvisioningState;
  /** 0 proves no remote POST began; 1 means creation was issued or is uncertain. */
  request_issued: number;
  /** Durable tombstone: creator paths may persist credentials but cannot activate. */
  reconciling: number;
  reconciliation_webhook_ids: string;
  webhook_id: string | null;
  webhook_token: string | null;
  updated_at_ms: number;
}

export interface ChannelWebhookProvisioningInput {
  channel_jid: string;
  destination_channel_id: string;
  destination_channel_name: string;
  webhook_name: string;
}

export const WEBHOOK_PROVISIONING_LEASE_MS = 10 * 60 * 1000;

export interface ScheduledTaskRow {
  id: number;
  name: string;
  type: ScheduledTaskType;
  schedule: string;
  channel_jid: string;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  created_by: string;
}

export function initDb(): void {
  if (dbOpen) return;

  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  dbOpen = true;
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    create table if not exists channels (
      jid              text primary key,
      name             text not null,
      folder           text not null unique,
      requires_trigger integer not null default 1,
      is_main          integer not null default 0,
      model_override   text not null default '',
      thinking_override text not null default '',
      cwd_override     text not null default '',
      created_at       text not null default (datetime('now'))
    );

    create table if not exists message_queue (
      rowid         integer primary key autoincrement,
      channel_jid   text not null,
      sender        text not null,
      sender_name   text not null,
      content       text not null,
      timestamp     text not null,
      status        text not null default 'pending',
      created_at    text not null default (datetime('now')),
      processed_at  text
    );

    create index if not exists idx_queue_status on message_queue(status, channel_jid);

    create table if not exists channel_webhooks (
      channel_jid              text primary key,
      destination_channel_id   text not null,
      destination_channel_name text not null,
      webhook_id               text not null,
      webhook_token            text not null,
      created_at                text not null default (datetime('now')),
      updated_at                text not null default (datetime('now'))
    );

    create table if not exists channel_webhook_cleanup (
      webhook_id               text primary key,
      channel_jid              text not null,
      destination_channel_id   text not null,
      destination_channel_name text not null,
      webhook_token            text not null,
      created_at                text not null default (datetime('now'))
    );

    create index if not exists idx_webhook_cleanup_channel
      on channel_webhook_cleanup(channel_jid);

    create table if not exists channel_webhook_provisioning (
      channel_jid              text primary key,
      lease_id                 text not null unique,
      destination_channel_id   text not null,
      destination_channel_name text not null,
      webhook_name             text not null,
      state                    text not null check(state in ('creating', 'created')),
      request_issued           integer not null default 0 check(request_issued in (0, 1)),
      reconciling              integer not null default 0 check(reconciling in (0, 1)),
      reconciliation_webhook_ids text not null default '[]',
      webhook_id               text,
      webhook_token            text,
      updated_at_ms            integer not null,
      check(
        (state = 'creating' and webhook_id is null and webhook_token is null) or
        (state = 'created' and request_issued = 1 and webhook_id is not null and webhook_token is not null)
      )
    );

    create table if not exists message_log (
      rowid         integer primary key autoincrement,
      channel_jid   text not null,
      role          text not null,
      content       text not null,
      timestamp     text not null default (datetime('now'))
    );

    create table if not exists scheduled_tasks (
      id           integer primary key autoincrement,
      name         text not null,
      type         text not null check(type in ('once', 'recurring')),
      schedule     text not null,
      channel_jid  text not null,
      prompt       text not null,
      enabled      integer not null default 1,
      last_run_at  text,
      next_run_at  text,
      created_at   text not null default (datetime('now')),
      created_by   text not null default ''
    );

    create index if not exists idx_scheduled_tasks_due on scheduled_tasks(enabled, next_run_at);
  `);

  ensureTableColumn('channels', 'model_override', "text not null default ''");
  ensureTableColumn('channels', 'thinking_override', "text not null default ''");
  ensureTableColumn('channels', 'cwd_override', "text not null default ''");
  ensureTableColumn('message_queue', 'attachments', 'text');
  // Legacy rows may already represent an in-flight/uncertain POST, so migrate
  // them conservatively. New leases always insert request_issued = 0 explicitly.
  ensureTableColumn('channel_webhook_provisioning', 'request_issued', 'integer not null default 1');
  ensureTableColumn('channel_webhook_provisioning', 'reconciling', 'integer not null default 0');
  ensureTableColumn(
    'channel_webhook_provisioning',
    'reconciliation_webhook_ids',
    "text not null default '[]'",
  );
  hardenDatabaseFiles();

  logger.info({ path: config.dbPath }, 'Database initialized');
}

function ensureTableColumn(table: string, column: string, ddl: string): void {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`alter table ${table} add column ${column} ${ddl}`);
  logger.info({ table, column }, 'Database migrated: added column');
}

function normalizeTimestamp(timestamp: string | null): string | null {
  if (timestamp === null) {
    return null;
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

// ── Channel registration ──

export function registerChannel(ch: RegisteredChannel): void {
  db.prepare(
    `
    insert into channels (jid, name, folder, requires_trigger, is_main, model_override, thinking_override, cwd_override)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(jid) do update set
      name = excluded.name,
      folder = excluded.folder,
      requires_trigger = excluded.requires_trigger,
      is_main = excluded.is_main,
      cwd_override = case
        when excluded.cwd_override != '' then excluded.cwd_override
        else channels.cwd_override
      end
  `,
  ).run(
    ch.jid,
    ch.name,
    ch.folder,
    ch.requiresTrigger ? 1 : 0,
    ch.isMain ? 1 : 0,
    ch.modelOverride || '',
    ch.thinkingOverride || '',
    ch.cwdOverride.trim(),
  );
  logger.info({ jid: ch.jid, name: ch.name }, 'Channel registered');
}

export function unregisterChannel(jid: string): boolean {
  return db.transaction(() => {
    if (
      getChannelWebhook(jid) ||
      getChannelWebhookProvisioning(jid) ||
      getPendingWebhookCleanup(jid).length > 0
    ) {
      throw new Error(
        `Channel ${jid} has a managed monitoring webhook, active setup, or pending cleanup. Run /pi webhook-clear in that channel before unregistering it.`,
      );
    }
    return db.prepare('delete from channels where jid = ?').run(jid).changes > 0;
  })();
}

export function getChannel(jid: string): RegisteredChannel | undefined {
  const row = db.prepare('select * from channels where jid = ?').get(jid) as any;
  return row ? rowToChannel(row) : undefined;
}

export function getAllChannels(): RegisteredChannel[] {
  const rows = db.prepare('select * from channels order by created_at').all() as any[];
  return rows.map(rowToChannel);
}

export function createDmChannel(
  jid: string,
  userId: string,
  displayName: string,
): RegisteredChannel {
  return {
    jid,
    name: `DM:${displayName}`,
    folder: `dm_${userId}`,
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  };
}

export function setChannelModelOverride(jid: string, modelOverride: string): boolean {
  const result = db
    .prepare('update channels set model_override = ? where jid = ?')
    .run(modelOverride.trim(), jid);
  return result.changes > 0;
}

export function clearChannelModelOverride(jid: string): boolean {
  const result = db.prepare("update channels set model_override = '' where jid = ?").run(jid);
  return result.changes > 0;
}

export function setChannelThinkingOverride(jid: string, thinkingOverride: ThinkingLevel): boolean {
  const result = db
    .prepare('update channels set thinking_override = ? where jid = ?')
    .run(thinkingOverride, jid);
  return result.changes > 0;
}

export function clearChannelThinkingOverride(jid: string): boolean {
  const result = db.prepare("update channels set thinking_override = '' where jid = ?").run(jid);
  return result.changes > 0;
}

export function getChannelWebhookProvisioning(
  channelJid: string,
): ChannelWebhookProvisioning | undefined {
  return db
    .prepare(
      `select channel_jid, lease_id, destination_channel_id, destination_channel_name,
              webhook_name, state, request_issued, reconciling, reconciliation_webhook_ids,
              webhook_id, webhook_token, updated_at_ms
       from channel_webhook_provisioning where channel_jid = ?`,
    )
    .get(channelJid) as ChannelWebhookProvisioning | undefined;
}

/**
 * Acquire the durable, cross-process setup lease before calling Discord.
 * A creating lease is intentionally never stolen: after an uncertain request,
 * /pi webhook-clear retains its unique Discord name until it positively deletes
 * the remote webhook or Discord definitively rejects creation.
 */
export function beginChannelWebhookProvisioning(
  input: ChannelWebhookProvisioningInput,
  now = Date.now(),
): ChannelWebhookProvisioning {
  const leaseId = randomUUID();
  const webhookName = `${input.webhook_name.slice(0, 69)} · ${leaseId.slice(0, 8)}`;
  const result = db.transaction(() => {
    if (!getChannel(input.channel_jid)) {
      throw new Error(`Source channel ${input.channel_jid} is no longer registered.`);
    }
    const existing = getChannelWebhookProvisioning(input.channel_jid);
    if (existing) {
      const suffix = isChannelWebhookProvisioningStale(existing, now)
        ? ' Run /pi webhook-clear to recover the interrupted setup.'
        : ' Wait for it to finish.';
      throw new Error(`A monitoring webhook setup is already in progress.${suffix}`);
    }

    db.prepare(
      `insert into channel_webhook_provisioning (
         channel_jid, lease_id, destination_channel_id, destination_channel_name,
         webhook_name, state, request_issued, reconciling, reconciliation_webhook_ids,
         webhook_id, webhook_token, updated_at_ms
       ) values (?, ?, ?, ?, ?, 'creating', 0, 0, '[]', null, null, ?)`,
    ).run(
      input.channel_jid,
      leaseId,
      input.destination_channel_id,
      input.destination_channel_name,
      webhookName,
      now,
    );
    return getChannelWebhookProvisioning(input.channel_jid)!;
  })();
  hardenDatabaseFiles();
  return result;
}

/**
 * Durably cross the remote-side-effect boundary immediately before POST.
 * Failure means clear/reconciliation already claimed or removed this exact lease.
 */
export function markChannelWebhookCreateRequestIssued(leaseId: string, now = Date.now()): boolean {
  const marked =
    db
      .prepare(
        `update channel_webhook_provisioning
         set request_issued = 1, updated_at_ms = ?
         where lease_id = ? and state = 'creating'
           and request_issued = 0 and reconciling = 0`,
      )
      .run(now, leaseId).changes > 0;
  if (marked) hardenDatabaseFiles();
  return marked;
}

/** Record returned credentials before any validation send or activation work. */
export function recordChannelWebhookCreated(
  leaseId: string,
  webhook: ChannelWebhookConfig,
  now = Date.now(),
): boolean {
  const recorded = db.transaction(() => {
    const result = db
      .prepare(
        `update channel_webhook_provisioning
         set state = 'created', webhook_id = ?, webhook_token = ?, updated_at_ms = ?
         where lease_id = ? and channel_jid = ? and state = 'creating'
           and request_issued = 1 and reconciling = 0`,
      )
      .run(webhook.webhook_id, webhook.webhook_token, now, leaseId, webhook.channel_jid);
    if (result.changes > 0) return true;

    // Reconciliation may have claimed this lease while Discord creation was
    // in flight. Persist the credentials on the tombstone, but report false so
    // the creator cannot validate or activate it. A retry can then delete by
    // credential even if the name-based remote deletion already completed.
    const retained = db
      .prepare(
        `update channel_webhook_provisioning
         set state = 'created', webhook_id = ?, webhook_token = ?, updated_at_ms = ?
         where lease_id = ? and channel_jid = ? and state = 'creating'
           and request_issued = 1 and reconciling = 1`,
      )
      .run(webhook.webhook_id, webhook.webhook_token, now, leaseId, webhook.channel_jid);
    if (retained.changes > 0) return false;

    // The reconciliation transaction already completed or the lease was
    // otherwise removed. Retain returned credentials independently.
    insertPendingWebhookCleanup(webhook);
    return false;
  })();
  hardenDatabaseFiles();
  return recorded;
}

/** Atomically activate the created webhook and retain any replaced credential. */
export function activateChannelWebhookProvisioning(leaseId: string): ChannelWebhookReplacement {
  const result = db.transaction((): ChannelWebhookReplacement & { sourceMissing?: boolean } => {
    const provisioning = db
      .prepare(
        `select channel_jid, lease_id, destination_channel_id, destination_channel_name,
                webhook_name, state, request_issued, reconciling, reconciliation_webhook_ids,
                webhook_id, webhook_token, updated_at_ms
         from channel_webhook_provisioning where lease_id = ?`,
      )
      .get(leaseId) as ChannelWebhookProvisioning | undefined;
    if (!provisioning || provisioning.state !== 'created' || provisioning.reconciling !== 0) {
      throw new Error('Monitoring webhook setup lease is no longer active.');
    }
    const webhook = provisioningWebhookConfig(provisioning);
    if (!getChannel(webhook.channel_jid)) {
      insertPendingWebhookCleanup(webhook);
      db.prepare('delete from channel_webhook_provisioning where lease_id = ?').run(leaseId);
      return { sourceMissing: true };
    }

    const previous = getChannelWebhook(webhook.channel_jid);
    upsertChannelWebhook(webhook);
    if (previous && previous.webhook_id !== webhook.webhook_id) {
      insertPendingWebhookCleanup(previous);
    }
    db.prepare('delete from channel_webhook_provisioning where lease_id = ?').run(leaseId);
    return { previous };
  })();
  hardenDatabaseFiles();
  if (result.sourceMissing) {
    throw new Error('Source channel is no longer registered; webhook cleanup is pending.');
  }
  return result;
}

/** Move a post-create failed setup to the durable retry-cleanup queue. */
export function queueChannelWebhookProvisioningCleanup(
  leaseId: string,
  fallback: ChannelWebhookConfig,
): void {
  db.transaction(() => {
    const provisioning = db
      .prepare(
        `select channel_jid, lease_id, destination_channel_id, destination_channel_name,
                webhook_name, state, request_issued, reconciling, reconciliation_webhook_ids,
                webhook_id, webhook_token, updated_at_ms
         from channel_webhook_provisioning where lease_id = ?`,
      )
      .get(leaseId) as ChannelWebhookProvisioning | undefined;
    insertPendingWebhookCleanup(
      provisioning?.state === 'created' ? provisioningWebhookConfig(provisioning) : fallback,
    );
    db.prepare('delete from channel_webhook_provisioning where lease_id = ?').run(leaseId);
  })();
  hardenDatabaseFiles();
}

/** Complete rollback only after Discord confirms that the created webhook is gone. */
export function completeChannelWebhookProvisioningRollback(
  leaseId: string,
  webhookId: string,
): void {
  db.transaction(() => {
    db.prepare(
      `delete from channel_webhook_provisioning
       where lease_id = ? and (webhook_id = ? or webhook_id is null)`,
    ).run(leaseId, webhookId);
    db.prepare('delete from channel_webhook_cleanup where webhook_id = ?').run(webhookId);
  })();
}

/** Cancel a pre-request lease only when no Discord create side effect can exist. */
export function cancelChannelWebhookProvisioning(leaseId: string): boolean {
  return (
    db
      .prepare(
        `delete from channel_webhook_provisioning
         where lease_id = ? and state = 'creating' and request_issued = 0 and reconciling = 0`,
      )
      .run(leaseId).changes > 0
  );
}

/**
 * Complete a definitive Discord create rejection for this exact lease.
 * A clear may already have marked the lease reconciling; that is still safe to
 * remove only while no remote webhook ID has been durably observed. SQLite
 * serializes this delete with reconciliation target recording.
 */
export function completeDefinitiveChannelWebhookCreateRejection(leaseId: string): boolean {
  return (
    db
      .prepare(
        `delete from channel_webhook_provisioning
         where lease_id = ? and state = 'creating' and request_issued = 1
           and reconciliation_webhook_ids = '[]'`,
      )
      .run(leaseId).changes > 0
  );
}

export function isChannelWebhookProvisioningStale(
  provisioning: ChannelWebhookProvisioning,
  now = Date.now(),
): boolean {
  return (
    provisioning.state === 'creating' &&
    (provisioning.reconciling === 1 ||
      provisioning.updated_at_ms <= now - WEBHOOK_PROVISIONING_LEASE_MS)
  );
}

/**
 * Turn a stale creating lease into a durable reconciliation tombstone before
 * any remote inspection. Once claimed, a late creator can only queue cleanup.
 */
export function claimChannelWebhookProvisioningReconciliation(
  leaseId: string,
  now = Date.now(),
  force = false,
): ChannelWebhookProvisioning | undefined {
  return db.transaction(() => {
    const current = selectWebhookProvisioningByLease(leaseId);
    if (!current) return undefined;
    if (current.state === 'created') return current;
    if (!force && !isChannelWebhookProvisioningStale(current, now)) return current;
    if (current.request_issued === 0) {
      // No remote side effect can exist, so recovery is conclusive and local.
      db.prepare('delete from channel_webhook_provisioning where lease_id = ?').run(leaseId);
      return undefined;
    }

    db.prepare(
      `update channel_webhook_provisioning
       set reconciling = 1
       where lease_id = ? and state = 'creating' and request_issued = 1`,
    ).run(leaseId);
    return selectWebhookProvisioningByLease(leaseId);
  })();
}

/** Record positively observed remote IDs before attempting their deletion. */
export function recordChannelWebhookReconciliationTargets(
  leaseId: string,
  webhookIds: readonly string[],
): string[] {
  const recorded = db.transaction(() => {
    const provisioning = selectWebhookProvisioningByLease(leaseId);
    if (!provisioning || provisioning.reconciling !== 1) return [];
    const ids = [
      ...new Set([...parseReconciliationWebhookIds(provisioning), ...webhookIds.filter(Boolean)]),
    ];
    db.prepare(
      `update channel_webhook_provisioning
       set reconciliation_webhook_ids = ?
       where lease_id = ? and reconciling = 1`,
    ).run(JSON.stringify(ids), leaseId);
    return ids;
  })();
  hardenDatabaseFiles();
  return recorded;
}

export function getChannelWebhookReconciliationTargets(leaseId: string): string[] {
  const provisioning = selectWebhookProvisioningByLease(leaseId);
  return provisioning ? parseReconciliationWebhookIds(provisioning) : [];
}

/**
 * Finish a positive remote reconciliation in one transaction. This also
 * removes credentials concurrently queued by a late creator and defensively
 * removes a matching active mapping, so deleted webhooks can never stay active.
 */
export function completeChannelWebhookProvisioningReconciliation(
  leaseId: string,
  webhookIds: readonly string[],
): boolean {
  if (webhookIds.length === 0) return false;
  const ids = [...new Set(webhookIds)];
  const placeholders = ids.map(() => '?').join(', ');
  const completed = db.transaction(() => {
    const provisioning = selectWebhookProvisioningByLease(leaseId);
    if (!provisioning || provisioning.reconciling !== 1) return false;

    db.prepare(
      `delete from channel_webhook_cleanup
       where channel_jid = ? and webhook_id in (${placeholders})`,
    ).run(provisioning.channel_jid, ...ids);
    db.prepare(
      `delete from channel_webhooks
       where channel_jid = ? and webhook_id in (${placeholders})`,
    ).run(provisioning.channel_jid, ...ids);
    db.prepare(
      'delete from channel_webhook_provisioning where lease_id = ? and reconciling = 1',
    ).run(leaseId);
    return true;
  })();
  hardenDatabaseFiles();
  return completed;
}

export function getChannelWebhook(channelJid: string): ChannelWebhookConfig | undefined {
  return db
    .prepare(
      `select channel_jid, destination_channel_id, destination_channel_name, webhook_id, webhook_token
       from channel_webhooks where channel_jid = ?`,
    )
    .get(channelJid) as ChannelWebhookConfig | undefined;
}

export function setChannelWebhook(webhook: ChannelWebhookConfig): ChannelWebhookReplacement {
  const result = db.transaction(() => {
    if (!getChannel(webhook.channel_jid)) {
      throw new Error(`Source channel ${webhook.channel_jid} is no longer registered.`);
    }
    if (getChannelWebhookProvisioning(webhook.channel_jid)) {
      throw new Error('Monitoring webhook setup is still in progress.');
    }

    const previous = getChannelWebhook(webhook.channel_jid);
    upsertChannelWebhook(webhook);
    if (previous && previous.webhook_id !== webhook.webhook_id) {
      insertPendingWebhookCleanup(previous);
    }
    return { previous };
  })();
  hardenDatabaseFiles();
  return result;
}

/**
 * Atomically disable trace routing while retaining credentials until remote
 * deletion succeeds. This intentionally works while provisioning is active.
 */
export function clearChannelWebhook(channelJid: string): ChannelWebhookConfig | undefined {
  const existing = db.transaction(() => {
    const current = getChannelWebhook(channelJid);
    if (!current) return undefined;
    insertPendingWebhookCleanup(current);
    db.prepare('delete from channel_webhooks where channel_jid = ?').run(channelJid);
    return current;
  })();
  hardenDatabaseFiles();
  return existing;
}

/**
 * First, synchronous step of /pi webhook-clear. It disables routing and claims
 * every in-progress setup before any process-local lock or remote await, so a
 * delayed creator can persist cleanup credentials but can never activate.
 */
export function beginChannelWebhookClear(channelJid: string): ChannelWebhookClearStart {
  const result = db.transaction((): ChannelWebhookClearStart => {
    const removed = getChannelWebhook(channelJid);
    if (removed) {
      insertPendingWebhookCleanup(removed);
      db.prepare('delete from channel_webhooks where channel_jid = ?').run(channelJid);
    }

    const provisioning = getChannelWebhookProvisioning(channelJid);
    if (!provisioning) return { removed };

    if (provisioning.state === 'creating' && provisioning.request_issued === 0) {
      // The creator has not crossed the POST boundary. Removing the exact
      // lease makes clear immediately final without inventing remote cleanup.
      db.prepare('delete from channel_webhook_provisioning where lease_id = ?').run(
        provisioning.lease_id,
      );
      return { removed, provisioning };
    }

    if (provisioning.state === 'created') {
      insertPendingWebhookCleanup(provisioningWebhookConfig(provisioning));
      db.prepare('delete from channel_webhook_provisioning where lease_id = ?').run(
        provisioning.lease_id,
      );
      return { removed, provisioning };
    }

    db.prepare(
      `update channel_webhook_provisioning
       set reconciling = 1
       where lease_id = ? and state = 'creating' and request_issued = 1`,
    ).run(provisioning.lease_id);
    return {
      removed,
      provisioning: selectWebhookProvisioningByLease(provisioning.lease_id),
    };
  })();
  hardenDatabaseFiles();
  return result;
}

export function getPendingWebhookCleanup(channelJid: string): ChannelWebhookConfig[] {
  return db
    .prepare(
      `select channel_jid, destination_channel_id, destination_channel_name, webhook_id, webhook_token
       from channel_webhook_cleanup where channel_jid = ? order by created_at, webhook_id`,
    )
    .all(channelJid) as ChannelWebhookConfig[];
}

export function completeWebhookCleanup(webhookId: string): boolean {
  return (
    db.prepare('delete from channel_webhook_cleanup where webhook_id = ?').run(webhookId).changes >
    0
  );
}

function selectWebhookProvisioningByLease(leaseId: string): ChannelWebhookProvisioning | undefined {
  return db
    .prepare(
      `select channel_jid, lease_id, destination_channel_id, destination_channel_name,
              webhook_name, state, request_issued, reconciling, reconciliation_webhook_ids,
              webhook_id, webhook_token, updated_at_ms
       from channel_webhook_provisioning where lease_id = ?`,
    )
    .get(leaseId) as ChannelWebhookProvisioning | undefined;
}

function parseReconciliationWebhookIds(provisioning: ChannelWebhookProvisioning): string[] {
  try {
    const parsed = JSON.parse(provisioning.reconciliation_webhook_ids) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function provisioningWebhookConfig(provisioning: ChannelWebhookProvisioning): ChannelWebhookConfig {
  if (!provisioning.webhook_id || !provisioning.webhook_token) {
    throw new Error('Provisioning record does not contain webhook credentials.');
  }
  return {
    channel_jid: provisioning.channel_jid,
    destination_channel_id: provisioning.destination_channel_id,
    destination_channel_name: provisioning.destination_channel_name,
    webhook_id: provisioning.webhook_id,
    webhook_token: provisioning.webhook_token,
  };
}

function upsertChannelWebhook(webhook: ChannelWebhookConfig): void {
  db.prepare(
    `insert into channel_webhooks (
       channel_jid, destination_channel_id, destination_channel_name, webhook_id, webhook_token
     ) values (?, ?, ?, ?, ?)
     on conflict(channel_jid) do update set
       destination_channel_id = excluded.destination_channel_id,
       destination_channel_name = excluded.destination_channel_name,
       webhook_id = excluded.webhook_id,
       webhook_token = excluded.webhook_token,
       updated_at = datetime('now')`,
  ).run(
    webhook.channel_jid,
    webhook.destination_channel_id,
    webhook.destination_channel_name,
    webhook.webhook_id,
    webhook.webhook_token,
  );
}

function insertPendingWebhookCleanup(webhook: ChannelWebhookConfig): void {
  db.prepare(
    `insert into channel_webhook_cleanup (
       webhook_id, channel_jid, destination_channel_id, destination_channel_name, webhook_token
     ) values (?, ?, ?, ?, ?)
     on conflict(webhook_id) do update set
       channel_jid = excluded.channel_jid,
       destination_channel_id = excluded.destination_channel_id,
       destination_channel_name = excluded.destination_channel_name,
       webhook_token = excluded.webhook_token`,
  ).run(
    webhook.webhook_id,
    webhook.channel_jid,
    webhook.destination_channel_id,
    webhook.destination_channel_name,
    webhook.webhook_token,
  );
}

function hardenDatabaseFiles(): void {
  if (process.platform === 'win32') return;
  for (const path of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

function rowToChannel(row: any): RegisteredChannel {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    requiresTrigger: row.requires_trigger === 1,
    isMain: row.is_main === 1,
    modelOverride: row.model_override || '',
    thinkingOverride: (row.thinking_override || '') as ThinkingLevel | '',
    cwdOverride: row.cwd_override || '',
  };
}

// ── Message queue ──

export function enqueueMessage(msg: {
  channelJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  attachments?: string | null;
}): void {
  db.prepare(
    `
    insert into message_queue (channel_jid, sender, sender_name, content, timestamp, attachments)
    values (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    msg.channelJid,
    msg.sender,
    msg.senderName,
    msg.content,
    msg.timestamp,
    msg.attachments ?? null,
  );
}

export function claimNextMessage(channelJid: string): QueuedMessage | undefined {
  const row = db
    .prepare(
      `
    with next_message as (
      select rowid
      from message_queue
      where status = 'pending' and channel_jid = ?
      order by rowid asc
      limit 1
    )
    update message_queue
    set status = 'processing'
    where rowid = (select rowid from next_message)
      and status = 'pending'
    returning rowid, channel_jid, sender, sender_name, content, timestamp, status, attachments
  `,
    )
    .get(channelJid) as QueuedMessage | undefined;

  return row;
}

export function markMessageDone(rowid: number): void {
  markMessagesDone([rowid]);
}

export function markMessagesDone(rowids: readonly number[]): void {
  updateMessageStatuses(rowids, 'done');
}

export function markMessageFailed(rowid: number): void {
  markMessagesFailed([rowid]);
}

export function markMessagesFailed(rowids: readonly number[]): void {
  updateMessageStatuses(rowids, 'failed');
}

export function requeueMessage(rowid: number): void {
  requeueMessages([rowid]);
}

export function requeueMessages(rowids: readonly number[]): void {
  updateMessageStatuses(rowids, 'pending');
}

function updateMessageStatuses(
  rowids: readonly number[],
  status: 'pending' | 'done' | 'failed',
): void {
  if (rowids.length === 0) return;
  const placeholders = rowids.map(() => '?').join(', ');
  const processedAt = status === 'pending' ? 'null' : "datetime('now')";
  db.prepare(
    `update message_queue set status = ?, processed_at = ${processedAt} where rowid in (${placeholders})`,
  ).run(status, ...rowids);
}

export function clearPendingMessages(channelJid: string): number {
  const result = db
    .prepare("delete from message_queue where channel_jid = ? and status = 'pending'")
    .run(channelJid);
  return result.changes;
}

export function recoverStuckMessages(): number {
  const result = db
    .prepare("update message_queue set status = 'pending' where status = 'processing'")
    .run();
  return result.changes;
}

export function pendingMessageSnapshot(channelJid: string): {
  count: number;
  latestRowid: number;
} {
  return db
    .prepare(
      `select count(*) as count, coalesce(max(rowid), 0) as latestRowid
       from message_queue where status = 'pending' and channel_jid = ?`,
    )
    .get(channelJid) as { count: number; latestRowid: number };
}

export function listPendingMessages(channelJid: string, limit: number): QueuedMessage[] {
  return db
    .prepare(
      `select rowid, channel_jid, sender, sender_name, content, timestamp, status, attachments
       from message_queue
       where status = 'pending' and channel_jid = ?
       order by rowid asc
       limit ?`,
    )
    .all(channelJid, limit) as QueuedMessage[];
}

export function claimMessages(rowids: readonly number[]): boolean {
  if (rowids.length === 0) return false;
  const placeholders = rowids.map(() => '?').join(', ');
  return db.transaction(() => {
    const pending = db
      .prepare(
        `select count(*) as count from message_queue
         where status = 'pending' and rowid in (${placeholders})`,
      )
      .get(...rowids) as { count: number };
    if (pending.count !== rowids.length) return false;
    const result = db
      .prepare(
        `update message_queue set status = 'processing'
         where status = 'pending' and rowid in (${placeholders})`,
      )
      .run(...rowids);
    return result.changes === rowids.length;
  })();
}

/** Get channels that have pending messages */
export function channelsWithPending(): string[] {
  const rows = db
    .prepare(
      `
    select channel_jid
    from message_queue
    where status = 'pending'
    group by channel_jid
    order by min(rowid) asc
  `,
    )
    .all() as any[];
  return rows.map((r) => r.channel_jid);
}

// ── Scheduled tasks ──

export function addScheduledTask(task: {
  name: string;
  type: ScheduledTaskType;
  schedule: string;
  channelJid: string;
  prompt: string;
  createdBy?: string;
  nextRunAt: string;
}): number {
  const result = db
    .prepare(
      `
    insert into scheduled_tasks (name, type, schedule, channel_jid, prompt, created_by, next_run_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      task.name,
      task.type,
      task.schedule,
      task.channelJid,
      task.prompt,
      task.createdBy ?? '',
      normalizeTimestamp(task.nextRunAt),
    );

  return Number(result.lastInsertRowid);
}

export function removeScheduledTask(id: number): boolean {
  const result = db.prepare('delete from scheduled_tasks where id = ?').run(id);
  return result.changes > 0;
}

export function enableScheduledTask(id: number): boolean {
  const result = db.prepare('update scheduled_tasks set enabled = 1 where id = ?').run(id);
  return result.changes > 0;
}

export function disableScheduledTask(id: number): boolean {
  const result = db.prepare('update scheduled_tasks set enabled = 0 where id = ?').run(id);
  return result.changes > 0;
}

export function listScheduledTasks(): ScheduledTaskRow[] {
  return db
    .prepare(
      `
    select id, name, type, schedule, channel_jid, prompt, enabled, last_run_at, next_run_at, created_at, created_by
    from scheduled_tasks
    order by id asc
  `,
    )
    .all() as ScheduledTaskRow[];
}

export function getDueScheduledTasks(): ScheduledTaskRow[] {
  return db
    .prepare(
      `
    select id, name, type, schedule, channel_jid, prompt, enabled, last_run_at, next_run_at, created_at, created_by
    from scheduled_tasks
    where enabled = 1
      and next_run_at is not null
      and next_run_at <= datetime('now')
    order by next_run_at asc, id asc
  `,
    )
    .all() as ScheduledTaskRow[];
}

export function updateTaskAfterRun(id: number, lastRunAt: string, nextRunAt: string | null): void {
  db.prepare(
    `
    update scheduled_tasks
    set last_run_at = ?,
        next_run_at = ?,
        enabled = case when ? is null then 0 else enabled end
    where id = ?
  `,
  ).run(normalizeTimestamp(lastRunAt), normalizeTimestamp(nextRunAt), nextRunAt, id);
}

export function enqueueScheduledTask(
  taskId: number,
  msg: {
    channelJid: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
  },
  lastRunAt: string,
  nextRunAt: string | null,
): void {
  db.transaction(() => {
    enqueueMessage(msg);
    updateTaskAfterRun(taskId, lastRunAt, nextRunAt);
  })();
}

// ── Message log ──

export function logMessage(channelJid: string, role: string, content: string): void {
  db.prepare('insert into message_log (channel_jid, role, content) values (?, ?, ?)').run(
    channelJid,
    role,
    content,
  );
}

export function closeDb(): void {
  if (!dbOpen) return;
  db.close();
  dbOpen = false;
}
