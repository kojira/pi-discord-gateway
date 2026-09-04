import { afterEach, describe, expect, it, vi } from 'vitest';

const { getChannelWebhookMock, sendMock, deleteMock, destroyMock, WebhookClientMock } = vi.hoisted(
  () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn();
    const Client = vi.fn(function (this: any, credentials: unknown) {
      this.credentials = credentials;
      this.send = send;
      this.delete = remove;
      this.destroy = destroy;
    });
    return {
      getChannelWebhookMock: vi.fn(),
      sendMock: send,
      deleteMock: remove,
      destroyMock: destroy,
      WebhookClientMock: Client,
    };
  },
);

vi.mock('../src/db.js', () => ({
  getChannelWebhook: getChannelWebhookMock,
}));

vi.mock('discord.js', () => ({
  WebhookClient: WebhookClientMock,
}));

import {
  deleteDiscordWebhook,
  enqueueWebhookTrace,
  flushWebhookTrace,
  stopWebhookMonitor,
} from '../src/discord/webhook-monitor.js';

const webhook = {
  channel_jid: 'dc:source',
  destination_channel_id: 'monitor',
  destination_channel_name: 'monitoring',
  webhook_id: 'webhook-id',
  webhook_token: 'webhook-secret',
};

afterEach(async () => {
  await stopWebhookMonitor();
  vi.clearAllMocks();
});

describe('webhook activity delivery', () => {
  it('batches per-channel traces, suppresses mentions, and never includes the token in content', async () => {
    getChannelWebhookMock.mockReturnValue(webhook);

    enqueueWebhookTrace('dc:source', '👤 user: hello @everyone');
    enqueueWebhookTrace('dc:source', '🛠️ tool read {"path":"/tmp/a"}');
    await flushWebhookTrace('dc:source');

    expect(WebhookClientMock).toHaveBeenCalledWith({
      id: 'webhook-id',
      token: 'webhook-secret',
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      content: expect.stringContaining('👤 user: hello @everyone'),
      allowedMentions: { parse: [] },
    });
    expect(sendMock.mock.calls[0][0].content).toContain('🛠️ tool read');
    expect(sendMock.mock.calls[0][0].content).not.toContain('webhook-secret');
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the source channel has no webhook mapping', async () => {
    getChannelWebhookMock.mockReturnValue(undefined);

    enqueueWebhookTrace('dc:source', '▶️ agent started');
    await flushWebhookTrace('dc:source');

    expect(WebhookClientMock).not.toHaveBeenCalled();
  });

  it('deletes a managed webhook without logging or returning its credentials', async () => {
    await expect(deleteDiscordWebhook(webhook, 'disabled')).resolves.toBe(true);

    expect(deleteMock).toHaveBeenCalledWith('disabled');
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});
