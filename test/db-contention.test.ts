import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  closeDb,
  enqueueMessage,
  getChannel,
  initDb,
  listPendingMessages,
  registerChannel,
} from '../src/db.js';
import { handleInteraction } from '../src/discord/client.js';

const dir = mkdtempSync(join(tmpdir(), 'piscord-busy-'));
const previousPath = config.dbPath;

beforeAll(() => {
  (config as { dbPath: string }).dbPath = join(dir, 'gateway.db');
  initDb();
});

afterAll(() => {
  closeDb();
  (config as { dbPath: string }).dbPath = previousPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('Discord ingress under a SQLite writer lock', () => {
  it.each([
    'status',
    'model',
    'reset-model',
    'thinking',
    'new',
    'stop',
    'webhook',
    'webhook-clear',
  ])('starts the common ACK before parsing or handling /pi %s', async (subcommand) => {
    const editReply = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const options = {
      getSubcommand: vi.fn().mockImplementation(() => {
        expect(deferReply).toHaveBeenCalledTimes(1);
        return subcommand;
      }),
      getString: () => 'high',
    };
    await handleInteraction({
      id: `isolated-${subcommand}`,
      commandName: 'pi',
      channelId: 'unregistered',
      guild: { id: 'isolated' },
      memberPermissions: { has: () => false },
      options,
      deferred: false,
      replied: false,
      inGuild: () => true,
      deferReply,
      editReply,
      isButton: () => false,
      isModalSubmit: () => false,
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
    } as any);
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
  });

  it('acknowledges /pi stop with an explicit failure under a writer lock', async () => {
    registerChannel({
      jid: 'dc:stop-test',
      name: 'stop-test',
      folder: 'stop-test',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    enqueueMessage({
      channelJid: 'dc:stop-test',
      sender: 'user',
      senderName: 'User',
      content: 'Keep pending when stop fails',
      timestamp: '2026-01-01T00:00:00Z',
    });
    const pending = listPendingMessages('dc:stop-test', 10);
    expect(pending).toHaveLength(1);
    const writer = new Database(config.dbPath);
    writer.exec('begin immediate');
    writer
      .prepare('insert into channels (jid, name, folder) values (?, ?, ?)')
      .run('dc:locked', 'locked', 'locked');
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      id: 'isolated-stop',
      commandName: 'pi',
      channelId: 'stop-test',
      options: { getSubcommand: () => 'stop' },
      guild: { id: 'isolated' },
      replied: false,
      deferred: false,
      inGuild: () => true,
      deferReply: vi.fn().mockImplementation(async () => {
        interaction.deferred = true;
      }),
      editReply,
      isButton: () => false,
      isModalSubmit: () => false,
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
    };
    try {
      const start = performance.now();
      await handleInteraction(interaction as any);
      expect(performance.now() - start).toBeLessThan(500);
      expect(interaction.deferReply).toHaveBeenCalledTimes(1);
      expect(editReply).toHaveBeenCalledTimes(1);
      expect(editReply.mock.calls[0]?.[0]?.content).toContain('Command failed');
      expect(listPendingMessages('dc:stop-test', 10)).toEqual(pending);
      expect(writer.inTransaction).toBe(true);
      expect(getChannel('dc:locked')).toBeUndefined();
    } finally {
      writer.exec('rollback');
      writer.close();
    }
  });

  it('fails explicitly instead of blocking all interaction ACKs for five seconds', () => {
    const channel = {
      jid: 'dc:busy',
      name: 'busy',
      folder: 'busy',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '' as const,
      cwdOverride: '',
    };
    const writer = new Database(config.dbPath);
    writer.exec('begin immediate');
    writer
      .prepare('insert into channels (jid, name, folder) values (?, ?, ?)')
      .run('dc:writer', 'writer', 'writer');
    try {
      const start = performance.now();
      expect(() => registerChannel(channel)).toThrow(/database is locked/i);
      expect(performance.now() - start).toBeLessThan(500);
      expect(getChannel(channel.jid)).toBeUndefined();
      expect(getChannel('dc:writer')).toBeUndefined();
      expect(writer.inTransaction).toBe(true);
      writer.exec('commit');
    } finally {
      if (writer.inTransaction) writer.exec('rollback');
      writer.close();
    }
    expect(getChannel('dc:writer')?.name).toBe('writer');
    expect(getChannel(channel.jid)).toBeUndefined();
    registerChannel(channel);
    expect(getChannel(channel.jid)).toEqual(channel);
  });
});
