import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/logger.js';
import {
  respondToAutocomplete,
  startChatCommandAck,
  awaitChatCommandAck,
} from '../src/discord/interaction-ack.js';

afterEach(() => vi.restoreAllMocks());

describe('interaction acknowledgement timing', () => {
  it('starts the chat ACK immediately and records the REST completion', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      id: 'chat-id',
      createdTimestamp: Date.now() - 50,
      replied: false,
      inGuild: () => true,
      deferReply,
    } as any;

    startChatCommandAck(interaction);
    expect(deferReply).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat-id', ageAtAckStartMs: expect.any(Number) }),
      'Discord chat ACK started',
    );
    await awaitChatCommandAck(interaction);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat-id', ackNetworkMs: expect.any(Number) }),
      'Discord chat ACK completed',
    );
  });

  it('records a failed autocomplete ACK without logging the REST error or choices', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const secret = 'sensitive-interaction-token';
    const respond = vi.fn().mockRejectedValue(new Error(secret));
    const interaction = {
      id: 'autocomplete-id',
      createdTimestamp: Date.now() - 40,
      respond,
    } as any;

    await expect(
      respondToAutocomplete(interaction, [{ name: 'choice', value: 'choice' }]),
    ).rejects.toThrow(secret);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'autocomplete-id', ackNetworkMs: expect.any(Number) }),
      'Discord autocomplete ACK failed',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('choice');
  });
});
