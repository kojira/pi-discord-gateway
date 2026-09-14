import { describe, expect, it, vi } from 'vitest';
import { fetchDiscordMessages } from '../src/discord/message-history.js';

describe('fetchDiscordMessages', () => {
  it('fetches channel messages with bot auth and cursor parameters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: 'm1', timestamp: '2026-09-14T04:29:24Z', content: 'hello' }],
    });

    const messages = await fetchDiscordMessages({
      token: 'secret-token',
      channelId: '123',
      limit: 25,
      before: '456',
      fetchImpl,
    });

    expect(messages).toEqual([{ id: 'm1', timestamp: '2026-09-14T04:29:24Z', content: 'hello' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'https://discord.com/api/v10/channels/123/messages?limit=25&before=456',
    );
    expect(init).toEqual({ headers: { Authorization: 'Bot secret-token' } });
  });

  it('rejects ambiguous cursors', async () => {
    await expect(
      fetchDiscordMessages({ token: 't', channelId: '123', before: '1', after: '2' }),
    ).rejects.toThrow('Specify at most one');
  });

  it('reports Discord errors without exposing the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Missing Access', code: 50001 }),
    });

    await expect(
      fetchDiscordMessages({ token: 'secret-token', channelId: '123', fetchImpl }),
    ).rejects.toThrow('Discord message fetch failed (403): Missing Access code=50001');
  });
});
