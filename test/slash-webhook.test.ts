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
    const { ChannelType, PermissionFlagsBits } = await import('discord.js');
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
        content: expect.stringContaining('previous Discord webhook could not be deleted'),
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
        content: expect.stringContaining('active setup'),
      });

      const failedRollbackDelete = vi.fn().mockRejectedValue(new Error('Discord unavailable'));
      createWebhook.mockResolvedValueOnce({
        id: 'failed-rollback-webhook',
        token: 'failed-rollback-token',
        send: vi.fn().mockRejectedValue(new Error('validation failed')),
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
        content: expect.stringContaining('validation failed'),
      });
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
                  ['interrupted', { name: lease.webhook_name, delete: interruptedDelete }],
                  ['unrelated', { name: 'someone else', delete: unrelatedDelete }],
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
        content: 'No monitoring webhook is configured for this channel.',
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

  it('lets an unregistered source retry cleanup left by a late webhook creator', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const tempDir = mkdtempSync(join(tmpdir(), 'piscord-slash-webhook-late-create-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = join(tempDir, 'gateway.db');
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');

    const firstDb = await import('../src/db.js');
    const firstCommands = await import('../src/discord/slash-commands.js');
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
    // sharing the durable SQLite lease.
    vi.setSystemTime(
      new Date('2026-01-01T00:00:00Z').getTime() + firstDb.WEBHOOK_PROVISIONING_LEASE_MS + 1,
    );
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
      expect(secondDb.getChannelWebhookProvisioning('dc:source')).toBeUndefined();
      expect(secondDb.unregisterChannel('dc:source')).toBe(true);

      const rollbackDelete = vi.fn().mockRejectedValue(new Error('Discord unavailable'));
      resolveCreate({
        id: 'late-webhook',
        token: 'late-token',
        send: vi.fn(),
        delete: rollbackDelete,
      });
      await setPromise;
      expect(rollbackDelete).toHaveBeenCalledWith('Rolling back failed Pi monitoring setup');
      expect(secondDb.getChannel('dc:source')).toBeUndefined();
      expect(secondDb.getPendingWebhookCleanup('dc:source')).toEqual([
        {
          channel_jid: 'dc:source',
          destination_channel_id: 'monitor',
          destination_channel_name: 'monitoring',
          webhook_id: 'late-webhook',
          webhook_token: 'late-token',
        },
      ]);

      const blockedReply = vi.fn().mockResolvedValue(undefined);
      await secondCommands.handleChatCommand({
        ...clearBase,
        options: { getSubcommand: () => 'status' },
        reply: blockedReply,
        deferred: false,
      } as any);
      await secondCommands.handleChatCommand({
        ...clearBase,
        options: { getSubcommand: () => 'webhook', getChannel: () => destination },
        reply: blockedReply,
        deferred: false,
      } as any);
      expect(blockedReply).toHaveBeenCalledTimes(2);
      expect(blockedReply).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ content: expect.stringContaining('not registered') }),
      );
      expect(blockedReply).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ content: expect.stringContaining('not registered') }),
      );
      expect(createWebhook).toHaveBeenCalledOnce();

      webhookDeleteMock.mockRejectedValueOnce({
        code: RESTJSONErrorCodes.UnknownWebhook,
        message: 'Unknown Webhook',
      });
      const retryReply = vi.fn().mockResolvedValue(undefined);
      await secondCommands.handleChatCommand({ ...clearBase, editReply: retryReply } as any);
      expect(secondDb.getPendingWebhookCleanup('dc:source')).toEqual([]);
      expect(secondDb.getChannel('dc:source')).toBeUndefined();
      expect(retryReply).toHaveBeenCalledWith({
        content: 'Pi activity monitoring is disabled and the Discord webhook was deleted.',
      });
    } finally {
      secondDb.closeDb();
      firstDb.closeDb();
      vi.useRealTimers();
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
