import { describe, expect, it, vi } from 'vitest';
import { handleInteraction } from '../src/discord/client.js';
import { logger } from '../src/logger.js';

describe('Discord interaction error logging', () => {
  it('does not log secret-bearing command or fallback response errors', async () => {
    const secret = 'https://discord.com/api/webhooks/123/super-secret-token';
    const commandFailure = Object.assign(new Error(`command failed through ${secret}`), {
      code: 50_013,
      status: 403,
    });
    const responseFailure = Object.assign(new Error(`fallback failed through ${secret}`), {
      code: 10_015,
      status: 404,
    });
    const reply = vi.fn().mockRejectedValueOnce(commandFailure).mockRejectedValue(responseFailure);
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    await handleInteraction({
      id: 'interaction-id',
      commandName: 'pi',
      options: { getSubcommand: () => 'unknown-command' },
      replied: false,
      deferred: false,
      inGuild: () => false,
      reply,
      isButton: () => false,
      isModalSubmit: () => false,
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
    } as any);

    expect(errorLog).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: 'pi',
        subcommand: 'unknown-command',
        errorName: 'Error',
        discordCode: 50_013,
        httpStatus: 403,
      }),
      'Slash command failed',
    );
    expect(errorLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'interaction-id',
        errorName: 'Error',
        discordCode: 10_015,
        httpStatus: 404,
      }),
      'Interaction handler failed',
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(reply.mock.calls)).not.toContain(secret);
  });
});
