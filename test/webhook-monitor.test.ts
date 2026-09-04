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

vi.mock('discord.js', async () => {
  const actual = await vi.importActual<typeof import('discord.js')>('discord.js');
  return { ...actual, WebhookClient: WebhookClientMock };
});

const webhook = {
  channel_jid: 'dc:source',
  destination_channel_id: 'monitor',
  destination_channel_name: 'monitoring',
  webhook_id: 'webhook-id',
  webhook_token: 'webhook-secret',
};

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  sendMock.mockResolvedValue(undefined);
});

describe('webhook activity delivery', () => {
  it('batches per-channel traces, suppresses mentions, and never includes the token in content', async () => {
    const monitor = await import('../src/discord/webhook-monitor.js');
    getChannelWebhookMock.mockReturnValue(webhook);

    monitor.enqueueWebhookTrace('dc:source', '👤 user: hello @everyone');
    monitor.enqueueWebhookTrace('dc:source', '🛠️ tool read');
    await monitor.flushWebhookTrace('dc:source');

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
  });

  it('keeps one bounded queue and reports dropped activity while delivery is blocked', async () => {
    const monitor = await import('../src/discord/webhook-monitor.js');
    getChannelWebhookMock.mockReturnValue(webhook);
    let releaseSend!: () => void;
    sendMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
    );

    for (let index = 0; index < 5; index += 1) {
      monitor.enqueueWebhookTrace('dc:source', `initial-${index}`);
    }
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 1000; index += 1) {
      monitor.enqueueWebhookTrace('dc:source', `queued-${index}-${'x'.repeat(1000)}`);
    }

    const stats = monitor.webhookMonitorStats('dc:source');
    expect(stats.states).toBe(1);
    expect(stats.queuedLines).toBeLessThanOrEqual(100);
    expect(stats.queuedChars).toBeLessThanOrEqual(64 * 1024);
    expect(stats.droppedEvents).toBeGreaterThan(0);

    releaseSend();
    await monitor.flushWebhookTrace('dc:source');
    expect(
      sendMock.mock.calls.some(([payload]) =>
        payload.content.includes(`dropped ${stats.droppedEvents}`),
      ),
    ).toBe(true);
    expect(WebhookClientMock).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent set/set and set/clear lifecycle operations per source', async () => {
    const monitor = await import('../src/discord/webhook-monitor.js');
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstSet = monitor.withWebhookConfigLock('dc:source', async () => {
      order.push('set-1-start');
      await firstGate;
      order.push('set-1-end');
    });
    const secondSet = monitor.withWebhookConfigLock('dc:source', async () => {
      order.push('set-2');
    });
    const clear = monitor.withWebhookConfigLock('dc:source', async () => {
      order.push('clear');
    });

    await vi.waitFor(() => expect(order).toEqual(['set-1-start']));
    releaseFirst();
    await Promise.all([firstSet, secondSet, clear]);
    expect(order).toEqual(['set-1-start', 'set-1-end', 'set-2', 'clear']);
  });

  it('immediately discards queued old-epoch activity after clear', async () => {
    const monitor = await import('../src/discord/webhook-monitor.js');
    let mapping: typeof webhook | undefined = webhook;
    getChannelWebhookMock.mockImplementation(() => mapping);
    monitor.enqueueWebhookTrace('dc:source', 'before clear');

    mapping = undefined;
    monitor.discardWebhookTrace('dc:source');
    monitor.enqueueWebhookTrace('dc:source', 'during clear');
    await monitor.flushWebhookTrace('dc:source');

    expect(sendMock).not.toHaveBeenCalled();
    expect(monitor.webhookMonitorStats('dc:source').states).toBe(0);
  });

  it('revalidates the durable mapping before a stale process sends', async () => {
    const monitor = await import('../src/discord/webhook-monitor.js');
    let mapping: typeof webhook | undefined = webhook;
    getChannelWebhookMock.mockImplementation(() => mapping);
    monitor.enqueueWebhookTrace('dc:source', 'queued in another process');

    mapping = undefined;
    await monitor.flushWebhookTrace('dc:source');

    expect(sendMock).not.toHaveBeenCalled();
    expect(WebhookClientMock).not.toHaveBeenCalled();
    expect(monitor.webhookMonitorStats('dc:source').states).toBe(0);
  });

  it('bounds retirement of a blocked webhook epoch', async () => {
    const monitor = await import('../src/discord/webhook-monitor.js');
    getChannelWebhookMock.mockReturnValue(webhook);
    sendMock.mockImplementation(() => new Promise<void>(() => undefined));
    for (let index = 0; index < 5; index += 1) {
      monitor.enqueueWebhookTrace('dc:source', `blocked-${index}`);
    }
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));

    const started = Date.now();
    await monitor.retireWebhookTrace('dc:source', webhook.webhook_id, 20);
    expect(Date.now() - started).toBeLessThan(500);
    expect(destroyMock).toHaveBeenCalled();
    expect(monitor.webhookMonitorStats('dc:source').states).toBe(0);
  });

  it('logs delivery failures without exposing library error messages or tokens', async () => {
    const monitor = await import('../src/discord/webhook-monitor.js');
    const { logger } = await import('../src/logger.js');
    const warn = vi.spyOn(logger, 'warn');
    getChannelWebhookMock.mockReturnValue(webhook);
    sendMock.mockRejectedValueOnce(new Error('request failed with webhook-secret'));

    monitor.enqueueWebhookTrace('dc:source', 'safe event');
    await monitor.flushWebhookTrace('dc:source');

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jid: 'dc:source',
        destinationChannelId: 'monitor',
        errorName: 'Error',
      }),
      'Failed to deliver Pi trace to monitoring webhook',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('webhook-secret');
  });

  it('does nothing when the source channel has no webhook mapping', async () => {
    const monitor = await import('../src/discord/webhook-monitor.js');
    getChannelWebhookMock.mockReturnValue(undefined);

    monitor.enqueueWebhookTrace('dc:source', '▶️ agent started');
    await monitor.flushWebhookTrace('dc:source');

    expect(WebhookClientMock).not.toHaveBeenCalled();
  });

  it('deletes a managed webhook without returning its credentials', async () => {
    const monitor = await import('../src/discord/webhook-monitor.js');
    await expect(monitor.deleteDiscordWebhook(webhook, 'disabled')).resolves.toBe(true);

    expect(deleteMock).toHaveBeenCalledWith('disabled');
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('treats only Discord Unknown Webhook as idempotent delete success', async () => {
    const { RESTJSONErrorCodes } = await import('discord.js');
    const monitor = await import('../src/discord/webhook-monitor.js');

    deleteMock.mockRejectedValueOnce({
      code: RESTJSONErrorCodes.UnknownWebhook,
      message: 'Unknown Webhook',
    });
    await expect(monitor.deleteDiscordWebhook(webhook, 'already gone')).resolves.toBe(true);

    deleteMock.mockRejectedValueOnce({ code: 50_013, message: 'Missing Permissions' });
    await expect(monitor.deleteDiscordWebhook(webhook, 'not authorized')).resolves.toBe(false);
  });

  it('bounds shutdown, destroys clients, and rejects later trace events', async () => {
    const monitor = await import('../src/discord/webhook-monitor.js');
    getChannelWebhookMock.mockReturnValue(webhook);
    sendMock.mockImplementation(() => new Promise<void>(() => undefined));

    for (let index = 0; index < 5; index += 1) {
      monitor.enqueueWebhookTrace('dc:source', `blocked-${index}`);
    }
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));

    const started = Date.now();
    await monitor.stopWebhookMonitor(20);
    expect(Date.now() - started).toBeLessThan(500);
    expect(destroyMock).toHaveBeenCalled();

    monitor.enqueueWebhookTrace('dc:source', 'too late');
    expect(monitor.webhookMonitorStats('dc:source').states).toBe(0);
  });
});
