import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { webhookDeleteMock, webhookDestroyMock, WebhookClientMock } = vi.hoisted(() => {
  const remove = vi.fn().mockResolvedValue(undefined);
  const destroy = vi.fn();
  const Client = vi.fn(function (this: any) {
    this.delete = remove;
    this.destroy = destroy;
  });
  return { webhookDeleteMock: remove, webhookDestroyMock: destroy, WebhookClientMock: Client };
});

vi.mock('discord.js', async () => {
  const actual = await vi.importActual<typeof import('discord.js')>('discord.js');
  return { ...actual, WebhookClient: WebhookClientMock };
});

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'PIDG_CONFIG', 'PI_CWD', 'SESSIONS_DIR'];

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('webhook slash commands', () => {
  it('registers channel selection and clear subcommands', async () => {
    const { registerGlobalCommands } = await import('../src/discord/slash-commands.js');
    const set = vi.fn().mockResolvedValue(undefined);

    await registerGlobalCommands({ application: { commands: { set } } } as any);

    const command = set.mock.calls[0][0][0];
    const webhookCommand = command.options.find((option: any) => option.name === 'webhook');
    expect(webhookCommand.options[0]).toMatchObject({ name: 'channel', required: true });
    expect(command.options.some((option: any) => option.name === 'webhook-clear')).toBe(true);
  });

  it('creates, stores, reports, and clears a webhook for the current source channel', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.PI_CWD = tempDir;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { logger } = await import('../src/logger.js');
    const { ChannelType, PermissionFlagsBits } = await import('discord.js');
    const warn = vi.spyOn(logger, 'warn');
    const errorLog = vi.spyOn(logger, 'error');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'Server #source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    const createdSend = vi.fn().mockResolvedValue(undefined);
    const createdDelete = vi.fn().mockResolvedValue(undefined);
    const createWebhook = vi.fn().mockResolvedValue({
      id: 'created-webhook',
      token: 'created-token',
      send: createdSend,
      delete: createdDelete,
    });
    const destinationPermissions = { has: () => true };
    const destination = {
      id: 'monitor-channel',
      name: 'monitoring',
      guildId: 'guild-1',
      type: ChannelType.GuildText,
      createWebhook,
      permissionsFor: vi.fn().mockReturnValue(destinationPermissions),
    };
    const editReply = vi.fn().mockResolvedValue(undefined);
    const setInteraction = {
      commandName: 'pi',
      channelId: 'source',
      guild: { members: { me: { id: 'bot' } } },
      guildId: 'guild-1',
      user: { id: 'admin' },
      memberPermissions: {
        has: (permission: bigint) => permission === PermissionFlagsBits.ManageWebhooks,
      },
      inGuild: () => true,
      options: {
        getSubcommand: () => 'webhook',
        getChannel: () => destination,
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    try {
      await handleChatCommand(setInteraction as any);
      expect(createWebhook).toHaveBeenCalledOnce();
      expect(createdSend).toHaveBeenCalledWith({
        content: expect.stringContaining('Pi activity monitoring enabled'),
        allowedMentions: { parse: [] },
      });
      expect(db.getChannelWebhook('dc:source')).toEqual({
        channel_jid: 'dc:source',
        destination_channel_id: 'monitor-channel',
        destination_channel_name: 'monitoring',
        webhook_id: 'created-webhook',
        webhook_token: 'created-token',
      });
      expect(editReply).toHaveBeenCalledWith({
        content: 'Pi activity for this channel will be sent to <#monitor-channel>.',
      });

      const clearEditReply = vi.fn().mockResolvedValue(undefined);
      await handleChatCommand({
        ...setInteraction,
        options: { getSubcommand: () => 'webhook-clear' },
        editReply: clearEditReply,
      } as any);

      expect(db.getChannelWebhook('dc:source')).toBeUndefined();
      expect(WebhookClientMock).toHaveBeenCalledWith({
        id: 'created-webhook',
        token: 'created-token',
      });
      expect(webhookDeleteMock).toHaveBeenCalledWith('Pi activity monitoring disabled');
      expect(webhookDestroyMock).toHaveBeenCalled();
      expect(clearEditReply).toHaveBeenCalledWith({
        content: 'Pi activity monitoring is disabled and the Discord webhook was deleted.',
      });

      // A failed replacement cleanup retains the old credential, and clear
      // retries both that deletion and deletion of the active replacement.
      await handleChatCommand(setInteraction as any);
      createWebhook.mockResolvedValueOnce({
        id: 'replacement-webhook',
        token: 'replacement-token',
        send: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      });
      webhookDeleteMock.mockRejectedValueOnce(new Error('temporary Discord failure'));
      await handleChatCommand(setInteraction as any);
      expect(db.getChannelWebhook('dc:source')?.webhook_id).toBe('replacement-webhook');
      expect(db.getPendingWebhookCleanup('dc:source').map((item) => item.webhook_id)).toEqual([
        'created-webhook',
      ]);
      expect(editReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining('Cleanup of the previous Discord webhook is pending'),
      });
      expect(editReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining(
          '/pi webhook-clear to retry; note that it also disables the currently active monitoring webhook',
        ),
      });

      const retryEditReply = vi.fn().mockResolvedValue(undefined);
      await handleChatCommand({
        ...setInteraction,
        options: { getSubcommand: () => 'webhook-clear' },
        editReply: retryEditReply,
      } as any);
      expect(db.getChannelWebhook('dc:source')).toBeUndefined();
      expect(db.getPendingWebhookCleanup('dc:source')).toEqual([]);
      expect(retryEditReply).toHaveBeenCalledWith({
        content: 'Pi activity monitoring is disabled and the Discord webhook was deleted.',
      });

      await handleChatCommand(setInteraction as any);
      webhookDeleteMock.mockRejectedValueOnce(new Error('temporary Discord failure'));
      const failedClearReply = vi.fn().mockResolvedValue(undefined);
      await handleChatCommand({
        ...setInteraction,
        options: { getSubcommand: () => 'webhook-clear' },
        editReply: failedClearReply,
      } as any);
      expect(db.getChannelWebhook('dc:source')).toBeUndefined();
      expect(db.getPendingWebhookCleanup('dc:source')).toHaveLength(1);
      expect(() => db.unregisterChannel('dc:source')).toThrow(/pending cleanup/);
      expect(failedClearReply).toHaveBeenCalledWith({
        content: expect.stringContaining('run /pi webhook-clear again to retry'),
      });

      await handleChatCommand({
        ...setInteraction,
        options: { getSubcommand: () => 'webhook-clear' },
        editReply: retryEditReply,
      } as any);
      expect(db.getPendingWebhookCleanup('dc:source')).toEqual([]);

      const raceDelete = vi.fn().mockResolvedValue(undefined);
      createWebhook.mockResolvedValueOnce({
        id: 'racing-webhook',
        token: 'racing-token',
        send: vi.fn().mockImplementation(async () => {
          db.unregisterChannel('dc:source');
        }),
        delete: raceDelete,
      });
      await handleChatCommand(setInteraction as any);
      expect(db.getChannelWebhook('dc:source')).toBeUndefined();
      expect(db.getChannel('dc:source')).toBeDefined();
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(raceDelete).toHaveBeenCalledWith('Rolling back failed Pi monitoring setup');
      expect(editReply).toHaveBeenLastCalledWith({
        content: '⚠️ Webhook setup failed and the created webhook was removed. Try again.',
      });

      const failedRollbackDelete = vi
        .fn()
        .mockRejectedValue(new Error('Discord unavailable failed-rollback-token'));
      createWebhook.mockResolvedValueOnce({
        id: 'failed-rollback-webhook',
        token: 'failed-rollback-token',
        send: vi.fn().mockRejectedValue(new Error('validation failed failed-rollback-token')),
        delete: failedRollbackDelete,
      });
      await handleChatCommand(setInteraction as any);
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(db.getPendingWebhookCleanup('dc:source')).toEqual([
        {
          channel_jid: 'dc:source',
          destination_channel_id: 'monitor-channel',
          destination_channel_name: 'monitoring',
          webhook_id: 'failed-rollback-webhook',
          webhook_token: 'failed-rollback-token',
        },
      ]);
      expect(editReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining(
          'Webhook setup did not complete. Cleanup is pending; run /pi webhook-clear in this channel',
        ),
      });
      expect(JSON.stringify(editReply.mock.calls)).not.toContain('failed-rollback-token');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          jid: 'dc:source',
          destinationChannelId: 'monitor-channel',
          errorName: 'Error',
        }),
        'Failed to roll back Discord monitoring webhook; cleanup remains pending',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('failed-rollback-token');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('failed-rollback-token');
    } finally {
      db.closeDb();
    }
  });

  it('reconciles a stale pre-create lease by its unique Discord webhook name', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-recovery-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    const lease = db.beginChannelWebhookProvisioning(
      {
        channel_jid: 'dc:source',
        destination_channel_id: 'monitor',
        destination_channel_name: 'monitoring',
        webhook_name: 'monitor webhook',
      },
      0,
    );
    const interruptedDelete = vi.fn().mockResolvedValue(undefined);
    const unrelatedDelete = vi.fn();
    const editReply = vi.fn().mockResolvedValue(undefined);

    try {
      await handleChatCommand({
        commandName: 'pi',
        channelId: 'source',
        guildId: 'guild-1',
        guild: { members: { me: { id: 'bot' } } },
        user: { id: 'admin' },
        memberPermissions: { has: () => true },
        inGuild: () => true,
        options: { getSubcommand: () => 'webhook-clear' },
        client: {
          channels: {
            fetch: vi.fn().mockResolvedValue({
              fetchWebhooks: vi.fn().mockResolvedValue(
                new Map([
                  [
                    'interrupted',
                    { id: 'interrupted', name: lease.webhook_name, delete: interruptedDelete },
                  ],
                  ['unrelated', { id: 'unrelated', name: 'someone else', delete: unrelatedDelete }],
                ]),
              ),
            }),
          },
        },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply,
        reply: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        replied: false,
        deferred: true,
      } as any);

      expect(interruptedDelete).toHaveBeenCalledWith('Recovering interrupted Pi monitoring setup');
      expect(unrelatedDelete).not.toHaveBeenCalled();
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(editReply).toHaveBeenCalledWith({
        content:
          'Pi activity monitoring is disabled. Interrupted webhook setup was recovered and the Discord webhook was deleted.',
      });
    } finally {
      db.closeDb();
    }
  });

  it('rejects a destination where the caller lacks effective webhook permission', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-destination-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { ChannelType } = await import('discord.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    const createWebhook = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const permissionsFor = vi.fn().mockReturnValue({ has: () => false });
    const interaction = {
      commandName: 'pi',
      channelId: 'source',
      guildId: 'guild-1',
      guild: { members: { me: { id: 'bot' } } },
      user: { id: 'caller' },
      memberPermissions: { has: () => true },
      inGuild: () => true,
      options: {
        getSubcommand: () => 'webhook',
        getChannel: () => ({
          id: 'destination',
          name: 'private',
          guildId: 'guild-1',
          type: ChannelType.GuildText,
          createWebhook,
          permissionsFor,
        }),
      },
      reply,
      replied: false,
      deferred: false,
    };

    try {
      await handleChatCommand(interaction as any);

      expect(createWebhook).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'You need View Channel and Manage Webhooks in the monitoring destination.',
        }),
      );

      reply.mockClear();
      permissionsFor.mockImplementation((subject: unknown) => ({
        has: () => typeof subject === 'string',
      }));
      await handleChatCommand(interaction as any);
      expect(createWebhook).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'The bot needs View Channel and Manage Webhooks in the monitoring destination.',
        }),
      );
    } finally {
      db.closeDb();
    }
  });

  it('completes cleanup when Discord reports that the webhook is already deleted', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-gone-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { RESTJSONErrorCodes } = await import('discord.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.setChannelWebhook({
      channel_jid: 'dc:source',
      destination_channel_id: 'monitor',
      destination_channel_name: 'monitoring',
      webhook_id: 'already-deleted',
      webhook_token: 'old-token',
    });
    webhookDeleteMock.mockRejectedValueOnce({
      code: RESTJSONErrorCodes.UnknownWebhook,
      message: 'Unknown Webhook',
    });
    const editReply = vi.fn().mockResolvedValue(undefined);

    try {
      await handleChatCommand({
        commandName: 'pi',
        channelId: 'source',
        guildId: 'guild-1',
        memberPermissions: { has: () => true },
        inGuild: () => true,
        options: { getSubcommand: () => 'webhook-clear' },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply,
        reply: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        replied: false,
        deferred: true,
      } as any);

      expect(db.getPendingWebhookCleanup('dc:source')).toEqual([]);
      expect(editReply).toHaveBeenCalledWith({
        content: 'Pi activity monitoring is disabled and the Discord webhook was deleted.',
      });
      expect(db.unregisterChannel('dc:source')).toBe(true);
    } finally {
      db.closeDb();
    }
  });

  it('allows webhook-clear to finish retained cleanup from an unregistered source', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-unregistered-cleanup-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
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
    db.cancelChannelWebhookProvisioning(lease.lease_id);
    db.unregisterChannel('dc:source');
    db.recordChannelWebhookCreated(lease.lease_id, {
      channel_jid: 'dc:source',
      destination_channel_id: 'monitor',
      destination_channel_name: 'monitoring',
      webhook_id: 'late-webhook',
      webhook_token: 'late-token',
    });
    const editReply = vi.fn().mockResolvedValue(undefined);

    try {
      await handleChatCommand({
        commandName: 'pi',
        channelId: 'source',
        guildId: 'guild-1',
        memberPermissions: { has: () => true },
        inGuild: () => true,
        options: { getSubcommand: () => 'webhook-clear' },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply,
        reply: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        replied: false,
        deferred: true,
      } as any);

      expect(db.getChannel('dc:source')).toBeUndefined();
      expect(db.getPendingWebhookCleanup('dc:source')).toEqual([]);
      expect(webhookDeleteMock).toHaveBeenCalledWith('Pi activity monitoring disabled');
      expect(editReply).toHaveBeenCalledWith({
        content: 'Pi activity monitoring is disabled and the Discord webhook was deleted.',
      });
    } finally {
      db.closeDb();
    }
  });

  it('force-claims a fresh cross-process create and blocks late activation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-late-create-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const firstDb = await import('../src/db.js');
    const firstCommands = await import('../src/discord/slash-commands.js');
    const { logger: firstLogger } = await import('../src/logger.js');
    const firstWarn = vi.spyOn(firstLogger, 'warn');
    const firstError = vi.spyOn(firstLogger, 'error');
    const { ChannelType, RESTJSONErrorCodes } = await import('discord.js');
    firstDb.initDb();
    firstDb.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    let resolveCreate!: (webhook: any) => void;
    const createWebhook = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const destination = {
      id: 'monitor',
      name: 'monitoring',
      guildId: 'guild-1',
      type: ChannelType.GuildText,
      createWebhook,
      permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
    };
    const setEditReply = vi.fn().mockResolvedValue(undefined);
    const setPromise = firstCommands.handleChatCommand({
      commandName: 'pi',
      channelId: 'source',
      guildId: 'guild-1',
      guild: { members: { me: { id: 'bot' } } },
      user: { id: 'admin' },
      memberPermissions: { has: () => true },
      inGuild: () => true,
      options: { getSubcommand: () => 'webhook', getChannel: () => destination },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: setEditReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    } as any);
    for (let index = 0; index < 5 && createWebhook.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(createWebhook).toHaveBeenCalledOnce();

    // A second gateway process has an independent in-memory mutex while
    // sharing the durable SQLite lease. Clear must claim even this fresh lease.
    vi.resetModules();
    const secondDb = await import('../src/db.js');
    const secondCommands = await import('../src/discord/slash-commands.js');
    secondDb.initDb();
    const reconciliationReply = vi.fn().mockResolvedValue(undefined);
    const clearBase = {
      commandName: 'pi',
      channelId: 'source',
      guildId: 'guild-1',
      guild: { members: { me: { id: 'bot' } } },
      user: { id: 'admin', username: 'admin' },
      memberPermissions: { has: () => true },
      inGuild: () => true,
      options: { getSubcommand: () => 'webhook-clear' },
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue({
            fetchWebhooks: vi.fn().mockResolvedValue(new Map()),
          }),
        },
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: reconciliationReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    try {
      await secondCommands.handleChatCommand(clearBase as any);
      expect(secondDb.getChannelWebhookProvisioning('dc:source')).toBeDefined();
      expect(() => secondDb.unregisterChannel('dc:source')).toThrow(/active setup/);
      expect(reconciliationReply).toHaveBeenCalledWith({
        content: expect.stringContaining('cleanup status remains uncertain'),
      });

      const rollbackDelete = vi.fn().mockRejectedValue(new Error('Discord unavailable late-token'));
      resolveCreate({
        id: 'late-webhook',
        token: 'late-token',
        send: vi.fn().mockRejectedValue(new Error('late validation failed late-token')),
        delete: rollbackDelete,
      });
      await setPromise;
      expect(rollbackDelete).toHaveBeenCalledWith('Rolling back failed Pi monitoring setup');
      expect(setEditReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining(
          'Webhook setup did not complete. Cleanup is pending; run /pi webhook-clear in this channel',
        ),
      });
      expect(JSON.stringify(setEditReply.mock.calls)).not.toContain('late-token');
      expect(firstWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          jid: 'dc:source',
          destinationChannelId: 'monitor',
          errorName: 'Error',
        }),
        'Failed to roll back Discord monitoring webhook; cleanup remains pending',
      );
      expect(JSON.stringify(firstWarn.mock.calls)).not.toContain('late-token');
      expect(JSON.stringify(firstError.mock.calls)).not.toContain('late-token');
      expect(secondDb.getChannel('dc:source')).toBeDefined();
      expect(secondDb.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(secondDb.getPendingWebhookCleanup('dc:source')).toEqual([
        {
          channel_jid: 'dc:source',
          destination_channel_id: 'monitor',
          destination_channel_name: 'monitoring',
          webhook_id: 'late-webhook',
          webhook_token: 'late-token',
        },
      ]);

      expect(() => secondDb.unregisterChannel('dc:source')).toThrow(/pending cleanup/);

      webhookDeleteMock.mockRejectedValueOnce({
        code: RESTJSONErrorCodes.UnknownWebhook,
        message: 'Unknown Webhook',
      });
      const retryReply = vi.fn().mockResolvedValue(undefined);
      await secondCommands.handleChatCommand({ ...clearBase, editReply: retryReply } as any);
      expect(secondDb.getPendingWebhookCleanup('dc:source')).toEqual([]);
      expect(secondDb.getChannel('dc:source')).toBeDefined();
      expect(retryReply).toHaveBeenCalledWith({
        content: 'Pi activity monitoring is disabled and the Discord webhook was deleted.',
      });
      expect(secondDb.unregisterChannel('dc:source')).toBe(true);
    } finally {
      secondDb.closeDb();
      firstDb.closeDb();
      vi.useRealTimers();
    }
  });

  it('does not let a same-process hung create delay clear deactivation or response', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-hung-create-clear-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { enqueueWebhookTrace, webhookMonitorStats } =
      await import('../src/discord/webhook-monitor.js');
    const { ChannelType } = await import('discord.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.setChannelWebhook({
      channel_jid: 'dc:source',
      destination_channel_id: 'old-monitor',
      destination_channel_name: 'old monitoring',
      webhook_id: 'old-id',
      webhook_token: 'old-token',
    });
    enqueueWebhookTrace('dc:source', 'queued before clear');

    let resolveCreate!: (webhook: any) => void;
    const createWebhook = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const destination = {
      id: 'monitor',
      name: 'monitoring',
      guildId: 'guild-1',
      type: ChannelType.GuildText,
      createWebhook,
      permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
    };
    const common = {
      commandName: 'pi',
      channelId: 'source',
      guildId: 'guild-1',
      guild: { members: { me: { id: 'bot' } } },
      user: { id: 'admin' },
      memberPermissions: { has: () => true },
      inGuild: () => true,
      deferReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };
    const setReply = vi.fn().mockResolvedValue(undefined);
    const setPromise = handleChatCommand({
      ...common,
      options: { getSubcommand: () => 'webhook', getChannel: () => destination },
      editReply: setReply,
    } as any);
    await vi.waitFor(() => expect(createWebhook).toHaveBeenCalledOnce());

    const clearReply = vi.fn().mockResolvedValue(undefined);
    const clearPromise = handleChatCommand({
      ...common,
      options: { getSubcommand: () => 'webhook-clear' },
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue({
            fetchWebhooks: vi.fn().mockResolvedValue(new Map()),
          }),
        },
      },
      editReply: clearReply,
    } as any);

    try {
      await vi.waitFor(() => expect(clearReply).toHaveBeenCalledOnce());
      await clearPromise;
      expect(db.getChannelWebhook('dc:source')).toBeUndefined();
      expect(db.getChannelWebhookProvisioning('dc:source')).toMatchObject({ reconciling: 1 });
      expect(webhookMonitorStats('dc:source').states).toBe(0);
      expect(clearReply).toHaveBeenCalledWith({
        content: expect.stringContaining('Pi activity monitoring is disabled'),
      });

      // A second set reaches the durable lease immediately instead of waiting
      // behind the first process-local create promise.
      const secondSetReply = vi.fn().mockResolvedValue(undefined);
      await handleChatCommand({
        ...common,
        options: { getSubcommand: () => 'webhook', getChannel: () => destination },
        editReply: secondSetReply,
      } as any);
      expect(createWebhook).toHaveBeenCalledOnce();
      expect(secondSetReply).toHaveBeenCalledWith({
        content: expect.stringContaining('Webhook setup could not start'),
      });

      const lateDelete = vi.fn().mockResolvedValue(undefined);
      resolveCreate({
        id: 'late-id',
        token: 'late-token',
        send: vi.fn().mockResolvedValue(undefined),
        delete: lateDelete,
      });
      await setPromise;
      expect(lateDelete).toHaveBeenCalledWith('Rolling back failed Pi monitoring setup');
      expect(db.getChannelWebhook('dc:source')).toBeUndefined();
    } finally {
      db.closeDb();
    }
  });

  it('keeps a durable locator and avoids closed DB access when create resolves after shutdown', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-shutdown-create-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const commands = await import('../src/discord/slash-commands.js');
    const { ChannelType } = await import('discord.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    let resolveCreate!: (webhook: any) => void;
    const createWebhook = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const setPromise = commands.handleChatCommand({
      commandName: 'pi',
      channelId: 'source',
      guildId: 'guild-1',
      guild: { members: { me: { id: 'bot' } } },
      user: { id: 'admin' },
      memberPermissions: { has: () => true },
      inGuild: () => true,
      options: {
        getSubcommand: () => 'webhook',
        getChannel: () => ({
          id: 'monitor',
          name: 'monitoring',
          guildId: 'guild-1',
          type: ChannelType.GuildText,
          createWebhook,
          permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
        }),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    } as any);
    await vi.waitFor(() => expect(createWebhook).toHaveBeenCalledOnce());
    const locator = db.getChannelWebhookProvisioning('dc:source');
    expect(locator).toMatchObject({ state: 'creating', destination_channel_id: 'monitor' });

    await commands.stopWebhookLifecycle(0);
    db.closeDb();
    resolveCreate({ id: 'late-id', token: 'late-token', send, delete: remove });
    await expect(setPromise).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();

    // Reopening proves the late continuation did not access closed SQLite and
    // the unique-name locator remains available for /pi webhook-clear recovery.
    db.initDb();
    expect(db.getChannelWebhookProvisioning('dc:source')).toEqual(locator);
    db.closeDb();
  });

  it('retains an uncertain create locator when Discord may have committed before rejection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-uncertain-create-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { ChannelType } = await import('discord.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    const remoteWebhooks = new Map<string, any>();
    const remoteDelete = vi.fn().mockResolvedValue(undefined);
    const createWebhook = vi.fn().mockImplementation(async ({ name }: { name: string }) => {
      remoteWebhooks.set('committed', { id: 'committed', name, delete: remoteDelete });
      throw new Error('socket reset after request write');
    });
    const destination = {
      id: 'monitor',
      name: 'monitoring',
      guildId: 'guild-1',
      type: ChannelType.GuildText,
      createWebhook,
      permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
    };
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      commandName: 'pi',
      channelId: 'source',
      guildId: 'guild-1',
      guild: { members: { me: { id: 'bot' } } },
      user: { id: 'admin' },
      memberPermissions: { has: () => true },
      inGuild: () => true,
      options: { getSubcommand: () => 'webhook', getChannel: () => destination },
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue({
            fetchWebhooks: vi.fn().mockImplementation(async () => remoteWebhooks),
          }),
        },
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    try {
      await handleChatCommand(interaction as any);
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeDefined();
      expect(editReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining(
          'Cleanup is pending; run /pi webhook-clear in this channel',
        ),
      });

      vi.setSystemTime(
        new Date('2026-01-01T00:00:00Z').getTime() + db.WEBHOOK_PROVISIONING_LEASE_MS + 1,
      );
      editReply.mockClear();
      await handleChatCommand({
        ...interaction,
        options: { getSubcommand: () => 'webhook-clear' },
      } as any);

      expect(remoteDelete).toHaveBeenCalledWith('Recovering interrupted Pi monitoring setup');
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(editReply).toHaveBeenCalledWith({
        content:
          'Pi activity monitoring is disabled. Interrupted webhook setup was recovered and the Discord webhook was deleted.',
      });
    } finally {
      db.closeDb();
      vi.useRealTimers();
    }
  });

  it('keeps an empty-scan tombstone until a crashed creator webhook becomes visible', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-tombstone-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { enqueueWebhookTrace, webhookMonitorStats } =
      await import('../src/discord/webhook-monitor.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.setChannelWebhook({
      channel_jid: 'dc:source',
      destination_channel_id: 'old-monitor',
      destination_channel_name: 'old monitoring',
      webhook_id: 'old-active',
      webhook_token: 'old-token',
    });
    const lease = db.beginChannelWebhookProvisioning(
      {
        channel_jid: 'dc:source',
        destination_channel_id: 'monitor',
        destination_channel_name: 'monitoring',
        webhook_name: 'monitor webhook',
      },
      0,
    );
    const remoteWebhooks = new Map<string, any>();
    const remoteDelete = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      commandName: 'pi',
      channelId: 'source',
      guildId: 'guild-1',
      memberPermissions: { has: () => true },
      inGuild: () => true,
      options: { getSubcommand: () => 'webhook-clear' },
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue({
            fetchWebhooks: vi.fn().mockImplementation(async () => remoteWebhooks),
          }),
        },
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    try {
      await handleChatCommand(interaction as any);
      expect(db.getChannelWebhook('dc:source')).toBeUndefined();
      enqueueWebhookTrace('dc:source', 'must not route after clear');
      expect(webhookMonitorStats('dc:source').states).toBe(0);
      expect(db.getChannelWebhookProvisioning('dc:source')?.lease_id).toBe(lease.lease_id);
      expect(() => db.unregisterChannel('dc:source')).toThrow(/active setup/);
      expect(editReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining('recovery locator was retained'),
      });

      remoteWebhooks.set('late', {
        id: 'late',
        name: lease.webhook_name,
        delete: remoteDelete,
      });
      editReply.mockClear();
      await handleChatCommand(interaction as any);

      expect(remoteDelete).toHaveBeenCalledWith('Recovering interrupted Pi monitoring setup');
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(db.unregisterChannel('dc:source')).toBe(true);
    } finally {
      db.closeDb();
    }
  });

  it('classifies only conclusive Discord client responses as safe to cancel', async () => {
    const { isDefinitiveWebhookCreateRejection } = await import('../src/discord/slash-commands.js');
    const { DiscordAPIError } = await import('discord.js');
    const apiError = (status: number) =>
      new DiscordAPIError(
        { code: 50_013, message: 'request failed' },
        50_013,
        status,
        'POST',
        'https://discord.invalid/api/channels/monitor/webhooks',
        { files: [], body: {} },
      );

    expect(isDefinitiveWebhookCreateRejection(apiError(400))).toBe(true);
    expect(isDefinitiveWebhookCreateRejection(apiError(403))).toBe(true);
    expect(isDefinitiveWebhookCreateRejection(apiError(404))).toBe(true);
    expect(isDefinitiveWebhookCreateRejection(apiError(408))).toBe(false);
    expect(isDefinitiveWebhookCreateRejection(apiError(429))).toBe(false);
    expect(isDefinitiveWebhookCreateRejection(apiError(500))).toBe(false);
    expect(isDefinitiveWebhookCreateRejection(new Error('socket timeout'))).toBe(false);
  });

  it('releases the provisioning lease only for a definitive Discord client rejection', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-definitive-create-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { ChannelType, DiscordAPIError, RESTJSONErrorCodes } = await import('discord.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    const rejection = new DiscordAPIError(
      { code: RESTJSONErrorCodes.MissingPermissions, message: 'Missing Permissions' },
      RESTJSONErrorCodes.MissingPermissions,
      403,
      'POST',
      'https://discord.invalid/api/channels/monitor/webhooks',
      { files: [], body: {} },
    );
    const createWebhook = vi.fn().mockRejectedValue(rejection);
    const editReply = vi.fn().mockResolvedValue(undefined);

    try {
      await handleChatCommand({
        commandName: 'pi',
        channelId: 'source',
        guildId: 'guild-1',
        guild: { members: { me: { id: 'bot' } } },
        user: { id: 'admin' },
        memberPermissions: { has: () => true },
        inGuild: () => true,
        options: {
          getSubcommand: () => 'webhook',
          getChannel: () => ({
            id: 'monitor',
            name: 'monitoring',
            guildId: 'guild-1',
            type: ChannelType.GuildText,
            createWebhook,
            permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
          }),
        },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply,
        reply: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        replied: false,
        deferred: true,
      } as any);

      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(editReply).toHaveBeenLastCalledWith({
        content: expect.not.stringContaining('cleanup is pending'),
      });
      expect(db.unregisterChannel('dc:source')).toBe(true);
    } finally {
      db.closeDb();
    }
  });

  it('prevents cross-process activation while remote reconciliation deletion is in flight', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-reconcile-race-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const creatorDb = await import('../src/db.js');
    creatorDb.initDb();
    creatorDb.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    const lease = creatorDb.beginChannelWebhookProvisioning(
      {
        channel_jid: 'dc:source',
        destination_channel_id: 'monitor',
        destination_channel_name: 'monitoring',
        webhook_name: 'monitor webhook',
      },
      0,
    );

    vi.resetModules();
    const reconcilerDb = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    reconcilerDb.initDb();
    const createdConfig = {
      channel_jid: 'dc:source',
      destination_channel_id: 'monitor',
      destination_channel_name: 'monitoring',
      webhook_id: 'racing-created-webhook',
      webhook_token: 'racing-created-token',
    };
    const remoteDelete = vi.fn().mockImplementation(async () => {
      // This runs after the remote delete starts but before reconciliation's
      // completion transaction. The durable tombstone must reject activation.
      expect(creatorDb.recordChannelWebhookCreated(lease.lease_id, createdConfig)).toBe(false);
      expect(() => creatorDb.activateChannelWebhookProvisioning(lease.lease_id)).toThrow(
        /no longer active/,
      );
      expect(creatorDb.getChannelWebhook('dc:source')).toBeUndefined();
      expect(creatorDb.getChannelWebhookProvisioning('dc:source')).toMatchObject({
        state: 'created',
        reconciling: 1,
        webhook_id: createdConfig.webhook_id,
      });
      expect(creatorDb.getPendingWebhookCleanup('dc:source')).toEqual([]);
    });
    const editReply = vi.fn().mockResolvedValue(undefined);

    try {
      await handleChatCommand({
        commandName: 'pi',
        channelId: 'source',
        guildId: 'guild-1',
        memberPermissions: { has: () => true },
        inGuild: () => true,
        options: { getSubcommand: () => 'webhook-clear' },
        client: {
          channels: {
            fetch: vi.fn().mockResolvedValue({
              fetchWebhooks: vi.fn().mockResolvedValue(
                new Map([
                  [
                    createdConfig.webhook_id,
                    {
                      id: createdConfig.webhook_id,
                      name: lease.webhook_name,
                      delete: remoteDelete,
                    },
                  ],
                ]),
              ),
            }),
          },
        },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply,
        reply: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        replied: false,
        deferred: true,
      } as any);

      expect(remoteDelete).toHaveBeenCalledOnce();
      expect(reconcilerDb.getChannelWebhook('dc:source')).toBeUndefined();
      expect(reconcilerDb.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(reconcilerDb.getPendingWebhookCleanup('dc:source')).toEqual([]);
      expect(editReply).toHaveBeenCalledWith({
        content:
          'Pi activity monitoring is disabled. Interrupted webhook setup was recovered and the Discord webhook was deleted.',
      });
    } finally {
      reconcilerDb.closeDb();
      creatorDb.closeDb();
    }
  });

  it('recovers after a crash-window delete outcome using durably observed webhook IDs', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-delete-retry-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    const lease = db.beginChannelWebhookProvisioning(
      {
        channel_jid: 'dc:source',
        destination_channel_id: 'monitor',
        destination_channel_name: 'monitoring',
        webhook_name: 'monitor webhook',
      },
      0,
    );
    const remoteDelete = vi
      .fn()
      .mockRejectedValue(new Error('unknown delete outcome secret-value'));
    const fetchWebhooks = vi
      .fn()
      .mockResolvedValueOnce(
        new Map([
          [
            'observed-webhook',
            {
              id: 'observed-webhook',
              name: lease.webhook_name,
              delete: remoteDelete,
            },
          ],
        ]),
      )
      .mockResolvedValueOnce(new Map());
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      commandName: 'pi',
      channelId: 'source',
      guildId: 'guild-1',
      memberPermissions: { has: () => true },
      inGuild: () => true,
      options: { getSubcommand: () => 'webhook-clear' },
      client: {
        channels: { fetch: vi.fn().mockResolvedValue({ fetchWebhooks }) },
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    try {
      await handleChatCommand(interaction as any);
      expect(db.getChannelWebhookProvisioning('dc:source')).toMatchObject({
        reconciling: 1,
        reconciliation_webhook_ids: '["observed-webhook"]',
      });
      expect(editReply).toHaveBeenLastCalledWith({
        content: expect.stringContaining('cleanup remains pending'),
      });

      // Simulate a new process retry after the prior DELETE may have succeeded
      // remotely but crashed or rejected locally before DB completion.
      editReply.mockClear();
      await handleChatCommand(interaction as any);
      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(editReply).toHaveBeenCalledWith({
        content:
          'Pi activity monitoring is disabled. Interrupted webhook setup was recovered and the Discord webhook was deleted.',
      });
    } finally {
      db.closeDb();
    }
  });

  it('retains reconciliation state and safely reports destination inspection failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-inspection-errors-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { enqueueWebhookTrace, webhookMonitorStats } =
      await import('../src/discord/webhook-monitor.js');
    const { logger } = await import('../src/logger.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.setChannelWebhook({
      channel_jid: 'dc:source',
      destination_channel_id: 'old-monitor',
      destination_channel_name: 'old monitoring',
      webhook_id: 'old-active',
      webhook_token: 'old-token',
    });
    const lease = db.beginChannelWebhookProvisioning(
      {
        channel_jid: 'dc:source',
        destination_channel_id: 'monitor',
        destination_channel_name: 'monitoring',
        webhook_name: 'monitor webhook',
      },
      0,
    );
    const leaked = 'discord-error-secret-token';
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error(`channel fetch ${leaked}`))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        fetchWebhooks: vi.fn().mockRejectedValue(new Error(`webhook fetch ${leaked}`)),
      });
    const editReply = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(logger, 'warn');
    const interaction = {
      commandName: 'pi',
      channelId: 'source',
      guildId: 'guild-1',
      memberPermissions: { has: () => true },
      inGuild: () => true,
      options: { getSubcommand: () => 'webhook-clear' },
      client: { channels: { fetch } },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        editReply.mockClear();
        await handleChatCommand(interaction as any);
        expect(db.getChannelWebhook('dc:source')).toBeUndefined();
        enqueueWebhookTrace('dc:source', 'must not route after failed inspection');
        expect(webhookMonitorStats('dc:source').states).toBe(0);
        expect(editReply).toHaveBeenCalledWith({
          content: expect.stringContaining(
            'cleanup remains pending; verify the destination and permissions',
          ),
        });
        expect(db.getChannelWebhookProvisioning('dc:source')).toMatchObject({
          lease_id: lease.lease_id,
          reconciling: 1,
        });
      }
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(leaked);
      expect(JSON.stringify(editReply.mock.calls)).not.toContain(leaked);
    } finally {
      db.closeDb();
    }
  });

  it('recovers a tokenless create when deletion commits before its response is lost', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-tokenless-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const { ChannelType } = await import('discord.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    let remoteExists = true;
    let leaseId = '';
    const remoteDelete = vi.fn().mockImplementation(async () => {
      const provisioning = db.getChannelWebhookProvisioning('dc:source');
      expect(provisioning).toMatchObject({ reconciling: 1 });
      leaseId = provisioning!.lease_id;
      expect(db.getChannelWebhookReconciliationTargets(leaseId)).toEqual(['tokenless-id']);
      remoteExists = false;
      // Discord committed DELETE, but the response was lost. The durable ID
      // must let a restarted process interpret the next empty snapshot.
      throw new Error('socket closed after delete commit hidden-secret');
    });
    const createWebhook = vi.fn().mockResolvedValue({
      id: 'tokenless-id',
      token: null,
      delete: remoteDelete,
    });
    const destination = {
      id: 'monitor',
      name: 'monitoring',
      guildId: 'guild-1',
      type: ChannelType.GuildText,
      createWebhook,
      permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
    };
    const editReply = vi.fn().mockResolvedValue(undefined);
    const baseInteraction = {
      commandName: 'pi',
      channelId: 'source',
      guildId: 'guild-1',
      guild: { members: { me: { id: 'bot' } } },
      user: { id: 'admin' },
      memberPermissions: { has: () => true },
      inGuild: () => true,
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    try {
      await handleChatCommand({
        ...baseInteraction,
        options: { getSubcommand: () => 'webhook', getChannel: () => destination },
      } as any);
      expect(remoteDelete).toHaveBeenCalledWith('Webhook creation returned no usable token');
      expect(remoteExists).toBe(false);
      expect(db.getChannelWebhookProvisioning('dc:source')).toMatchObject({
        lease_id: leaseId,
        reconciling: 1,
        reconciliation_webhook_ids: '["tokenless-id"]',
      });
      expect(JSON.stringify(editReply.mock.calls)).not.toContain('hidden-secret');

      db.closeDb();
      db.initDb();
      editReply.mockClear();
      await handleChatCommand({
        ...baseInteraction,
        options: { getSubcommand: () => 'webhook-clear' },
        client: {
          channels: {
            fetch: vi.fn().mockResolvedValue({
              fetchWebhooks: vi.fn().mockResolvedValue(new Map()),
            }),
          },
        },
      } as any);

      expect(db.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(editReply).toHaveBeenCalledWith({
        content:
          'Pi activity monitoring is disabled. Interrupted webhook setup was recovered and the Discord webhook was deleted.',
      });
    } finally {
      db.closeDb();
    }
  });

  it('requires Manage Webhooks permission before creating anything', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-permission-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const db = await import('../src/db.js');
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    db.initDb();
    db.registerChannel({
      jid: 'dc:source',
      name: 'source',
      folder: 'ch_source',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    const reply = vi.fn().mockResolvedValue(undefined);

    try {
      await handleChatCommand({
        commandName: 'pi',
        channelId: 'source',
        guild: {},
        guildId: 'guild-1',
        memberPermissions: { has: () => false },
        inGuild: () => true,
        options: { getSubcommand: () => 'webhook' },
        reply,
        replied: false,
        deferred: false,
      } as any);

      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Manage Webhooks permission is required.' }),
      );
    } finally {
      db.closeDb();
    }
  });
});
