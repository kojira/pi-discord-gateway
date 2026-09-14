import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchDiscordMessagesMock, sendFilesToDiscordMock, startGatewayMock } = vi.hoisted(() => ({
  fetchDiscordMessagesMock: vi.fn(),
  sendFilesToDiscordMock: vi.fn(),
  startGatewayMock: vi.fn(),
}));

vi.mock('../src/discord/send.js', () => ({
  sendFilesToDiscord: sendFilesToDiscordMock,
}));

vi.mock('../src/discord/message-history.js', () => ({
  fetchDiscordMessages: fetchDiscordMessagesMock,
}));

vi.mock('../src/index.js', () => ({
  startGateway: startGatewayMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'DISCORD_BOT_TOKEN',
  'HOME',
  'PI_CWD',
  'PIDG_CONFIG',
  'SESSIONS_DIR',
];

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('formatHelpText', () => {
  it('mentions the primary distribution commands, send usage, and cwd registration option', async () => {
    vi.resetModules();
    const { formatHelpText } = await import('../src/cli/index.js');
    const help = formatHelpText();

    expect(help).toContain('piscord setup');
    expect(help).toContain('piscord start');
    expect(help).toContain('piscord status');
    expect(help).toContain('piscord register');
    expect(help).toContain('piscord daemon install');
    expect(help).toContain('piscord send --channel <jid> [--text <message>] [--file <path> ...]');
    expect(help).toContain('piscord messages fetch --channel <id|jid>');
    expect(help).toContain('--cwd <path>');
  });
});

describe('start command', () => {
  it('does not report ESM-only pi-ai as a missing peer dependency', async () => {
    process.env.PIDG_CONFIG = resolve('package.json');
    startGatewayMock.mockResolvedValue(undefined);

    vi.resetModules();
    const { main } = await import('../src/cli/index.js');

    await expect(main(['start'])).resolves.toBe(0);
    expect(startGatewayMock).toHaveBeenCalledOnce();
  });
});

describe('send command', () => {
  it('allows text-only sends and normalizes the channel id', async () => {
    sendFilesToDiscordMock.mockResolvedValue({ sentFiles: 0 });

    vi.resetModules();
    const { main } = await import('../src/cli/index.js');
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    await expect(main(['send', '--channel', '123', '--text', 'hello'])).resolves.toBe(0);
    expect(sendFilesToDiscordMock).toHaveBeenCalledWith({
      channelJid: 'dc:123',
      text: 'hello',
      files: [],
    });
    expect(logged.join('\n')).toContain('Sent message to dc:123');
  });

  it('rejects send requests with neither text nor files', async () => {
    vi.resetModules();
    const { main } = await import('../src/cli/index.js');

    await expect(main(['send', '--channel', '123'])).rejects.toThrow(
      'At least one of --text or --file is required.',
    );
    expect(sendFilesToDiscordMock).not.toHaveBeenCalled();
  });
});

describe('messages fetch command', () => {
  it('fetches another channel history through the Piscord CLI', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    fetchDiscordMessagesMock.mockResolvedValue([
      {
        id: 'm1',
        timestamp: '2026-09-14T04:29:24.282000+00:00',
        author: { username: 'monitor' },
        content: 'hello',
      },
    ]);
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    vi.resetModules();
    const { main } = await import('../src/cli/index.js');

    await expect(
      main(['messages', 'fetch', '--channel', 'dc:1545841603438968962', '--limit', '10']),
    ).resolves.toBe(0);
    expect(fetchDiscordMessagesMock).toHaveBeenCalledWith({
      token: 'test-token',
      channelId: '1545841603438968962',
      limit: 10,
      before: undefined,
      after: undefined,
      around: undefined,
    });
    expect(logged).toEqual([
      JSON.stringify({
        id: 'm1',
        timestamp: '2026-09-14T04:29:24.282000+00:00',
        author: { username: 'monitor' },
        content: 'hello',
      }),
    ]);
  });

  it('supports table output and raw channel ids', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    fetchDiscordMessagesMock.mockResolvedValue([
      { id: 'm1', timestamp: '2026-09-14T04:29:24Z', webhook_id: 'w1', content: 'hello world' },
    ]);
    const table = vi.spyOn(console, 'table').mockImplementation(() => undefined);

    vi.resetModules();
    const { main } = await import('../src/cli/index.js');

    await expect(
      main(['messages', 'fetch', '--channel', '1545841603438968962', '--format', 'table']),
    ).resolves.toBe(0);
    expect(fetchDiscordMessagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '1545841603438968962', limit: 50 }),
    );
    expect(table).toHaveBeenCalledWith([
      {
        id: 'm1',
        timestamp: '2026-09-14T04:29:24Z',
        author: '',
        webhook_id: 'w1',
        len: 11,
        content: 'hello world',
      },
    ]);
  });
});

describe('register command cwd support', () => {
  it('refuses to unregister a channel until its managed webhook is cleared', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-cli-webhook-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = resolve(tempDir, 'gateway.db');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    const { main } = await import('../src/cli/index.js');
    await main(['register', '123', 'source']);
    const db = await import('../src/db.js');
    db.initDb();
    db.setChannelWebhook({
      channel_jid: 'dc:123',
      destination_channel_id: 'monitor',
      destination_channel_name: 'monitoring',
      webhook_id: 'webhook',
      webhook_token: 'secret',
    });
    db.closeDb();

    await expect(main(['unregister', '123'])).rejects.toThrow(/webhook-clear/);
    db.initDb();
    try {
      expect(db.getChannel('dc:123')).toBeDefined();
      expect(db.getChannelWebhook('dc:123')).toBeDefined();
    } finally {
      db.closeDb();
    }
  });

  it('stores a per-channel cwd override and shows it in channel listings', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-cli-'));
    tempDirs.push(tempDir);

    process.env.DB_PATH = resolve(tempDir, 'gateway.db');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.PI_CWD = '/global/project';

    vi.resetModules();
    const { main } = await import('../src/cli/index.js');
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    await expect(
      main(['register', '123', 'my-server #general', '--cwd', '/workspace/project']),
    ).resolves.toBe(0);
    expect(logged.join('\n')).toContain('Working directory: /workspace/project (channel override)');

    const db = await import('../src/db.js');
    db.initDb();
    try {
      expect(db.getChannel('dc:123')).toMatchObject({
        jid: 'dc:123',
        cwdOverride: '/workspace/project',
      });
    } finally {
      db.closeDb();
    }

    logged.length = 0;
    await expect(main(['channels'])).resolves.toBe(0);
    expect(logged.join('\n')).toContain('cwd=/workspace/project (channel)');
  });
});
