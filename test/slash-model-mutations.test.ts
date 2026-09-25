import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, getChannel, initDb, registerChannel } from '../src/db.js';
import { handleInteraction } from '../src/discord/client.js';
import { refreshModelCatalog } from '../src/agent/model-catalog.js';

const root = mkdtempSync(join(tmpdir(), 'piscord-model-mutation-'));
const previous = {
  dbPath: config.dbPath,
  piBin: config.piBin,
  piCwd: config.piCwd,
  piModel: config.piModel,
  piExtraFlags: config.piExtraFlags,
};
const modelTable = `provider model context max-out thinking images\ntest plain 128K 16K no no\ntest reason 128K 16K yes no\n`;

beforeAll(() => {
  const script = join(root, 'fake-pi.sh');
  writeFileSync(join(root, 'models.txt'), modelTable);
  writeFileSync(
    script,
    `#!/bin/sh\nsleep 0.1\nif [ -f '${root}/fail' ]; then exit 1; fi\ncat '${root}/models.txt'\n`,
  );
  chmodSync(script, 0o700);
  Object.assign(config, {
    dbPath: join(root, 'gateway.db'),
    piBin: script,
    piCwd: root,
    piModel: 'test/plain',
    piExtraFlags: '',
  });
  initDb();
});

afterAll(() => {
  closeDb();
  Object.assign(config, previous);
  rmSync(root, { recursive: true, force: true });
});

function command(sub: string, channelId: string, value = 'high') {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id: `isolated-${channelId}`,
    commandName: 'pi',
    channelId,
    guild: { id: 'isolated' },
    options: { getSubcommand: () => sub, getString: () => value },
    deferred: false,
    replied: false,
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
  return { interaction, editReply };
}

function channel(id: string, modelOverride: string, thinkingOverride: string) {
  const cwd = join(root, id);
  mkdirSync(cwd);
  registerChannel({
    jid: `dc:${id}`,
    name: id,
    folder: id,
    cwdOverride: cwd,
    requiresTrigger: false,
    isMain: false,
    modelOverride,
    thinkingOverride,
  });
  return cwd;
}

describe('model mutations after a shared early ACK', () => {
  it('waits asynchronously for cold model metadata before clamping thinking', async () => {
    channel('thinking', 'test/plain', '');
    const { interaction, editReply } = command('thinking', 'thinking');
    const pending = handleInteraction(interaction as any);
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(getChannel('dc:thinking')?.thinkingOverride).toBe('');
    await pending;
    expect(getChannel('dc:thinking')?.thinkingOverride).toBe('off');
    expect(editReply.mock.calls[0]?.[0]?.content).toContain('off');
  });

  it('verifies a cold default before reset and clamps the retained thinking override', async () => {
    channel('reset', 'test/reason', 'high');
    const { interaction } = command('reset-model', 'reset');
    const pending = handleInteraction(interaction as any);
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(getChannel('dc:reset')?.modelOverride).toBe('test/reason');
    await pending;
    expect(getChannel('dc:reset')?.modelOverride).toBe('');
    expect(getChannel('dc:reset')?.thinkingOverride).toBe('off');
  });

  it('rejects a model removed since the autocomplete catalog was warmed', async () => {
    const cwd = channel('removed', 'test/reason', '');
    await refreshModelCatalog({ forceRefresh: true, cwd });
    writeFileSync(join(root, 'models.txt'), modelTable.replace(/^test plain.*\n/m, ''));
    const { interaction, editReply } = command('model', 'removed', 'test/plain');
    await handleInteraction(interaction as any);
    expect(getChannel('dc:removed')?.modelOverride).toBe('test/reason');
    expect(editReply.mock.calls[0]?.[0]?.content).toContain('no longer available');
  });

  it('does not save a mutation when Pi model verification fails', async () => {
    channel('failed', 'test/plain', '');
    writeFileSync(join(root, 'fail'), '1');
    try {
      const { interaction, editReply } = command('thinking', 'failed');
      await handleInteraction(interaction as any);
      expect(getChannel('dc:failed')?.thinkingOverride).toBe('');
      expect(editReply.mock.calls[0]?.[0]?.content).toContain('Command failed');
    } finally {
      rmSync(join(root, 'fail'));
    }
  });
});
