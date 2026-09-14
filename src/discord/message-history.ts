export interface FetchDiscordMessagesOptions {
  token: string;
  channelId: string;
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
  fetchImpl?: typeof fetch;
}

export interface DiscordHistoryMessage {
  id: string;
  channel_id?: string;
  guild_id?: string;
  timestamp: string;
  edited_timestamp?: string | null;
  webhook_id?: string;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  content?: string;
  attachments?: Array<{
    id?: string;
    filename?: string;
    url?: string;
    size?: number;
    content_type?: string;
  }>;
}

export async function fetchDiscordMessages({
  token,
  channelId,
  limit = 50,
  before,
  after,
  around,
  fetchImpl = fetch,
}: FetchDiscordMessagesOptions): Promise<DiscordHistoryMessage[]> {
  if (!token.trim()) throw new Error('DISCORD_BOT_TOKEN is not configured.');
  if (!channelId.trim()) throw new Error('Channel id is required.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Message fetch limit must be an integer from 1 to 100.');
  }

  const cursorCount = [before, after, around].filter(Boolean).length;
  if (cursorCount > 1) throw new Error('Specify at most one of --before, --after, or --around.');

  const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
  url.searchParams.set('limit', String(limit));
  if (before) url.searchParams.set('before', before);
  if (after) url.searchParams.set('after', after);
  if (around) url.searchParams.set('around', around);

  const response = await fetchImpl(url, {
    headers: { Authorization: `Bot ${token}` },
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = discordErrorMessage(body);
    throw new Error(
      `Discord message fetch failed (${response.status})${detail ? `: ${detail}` : ''}`,
    );
  }
  if (!Array.isArray(body))
    throw new Error('Discord message fetch returned an unexpected response.');
  return body as DiscordHistoryMessage[];
}

function discordErrorMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as { message?: unknown; code?: unknown };
  const message = typeof record.message === 'string' ? record.message : '';
  const code =
    typeof record.code === 'number' || typeof record.code === 'string' ? String(record.code) : '';
  return [message, code ? `code=${code}` : ''].filter(Boolean).join(' ');
}
