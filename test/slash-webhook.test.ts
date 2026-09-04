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
