import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { logger } from '../logger.js';

const pendingAcks = new WeakMap<ChatInputCommandInteraction, Promise<unknown>>();

/** Start the Discord ACK before any command-specific lookup or side effect. */
export function startChatCommandAck(interaction: ChatInputCommandInteraction): void {
  if (interaction.replied || pendingAcks.has(interaction)) return;
  const startedAt = Date.now();
  const pending = interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );
  pendingAcks.set(interaction, pending);
  // Observe completion without waiting for the network before command handling.
  // Do not log option values, tokens, or raw REST errors.
  logger.info(
    { id: interaction.id, ageAtAckStartMs: ageOf(interaction, startedAt) },
    'Discord chat ACK started',
  );
  void pending.then(
    () =>
      logger.info(
        { id: interaction.id, ackNetworkMs: Date.now() - startedAt },
        'Discord chat ACK completed',
      ),
    () =>
      logger.warn(
        { id: interaction.id, ackNetworkMs: Date.now() - startedAt },
        'Discord chat ACK failed',
      ),
  );
}

/** Autocomplete ACK must send choices instead of deferring. */
export async function respondToAutocomplete(
  interaction: AutocompleteInteraction,
  choices: Parameters<AutocompleteInteraction['respond']>[0],
): Promise<void> {
  const startedAt = Date.now();
  const pending = interaction.respond(choices);
  logger.info(
    { id: interaction.id, ageAtAckStartMs: ageOf(interaction, startedAt) },
    'Discord autocomplete ACK started',
  );
  try {
    await pending;
    logger.info(
      { id: interaction.id, ackNetworkMs: Date.now() - startedAt },
      'Discord autocomplete ACK completed',
    );
  } catch (error) {
    logger.warn(
      { id: interaction.id, ackNetworkMs: Date.now() - startedAt },
      'Discord autocomplete ACK failed',
    );
    throw error;
  }
}

function ageOf(interaction: { createdTimestamp: number }, now: number): number | null {
  return Number.isFinite(interaction.createdTimestamp)
    ? Math.max(0, now - interaction.createdTimestamp)
    : null;
}

export async function awaitChatCommandAck(interaction: ChatInputCommandInteraction): Promise<void> {
  await pendingAcks.get(interaction);
}

/** All command replies edit the initially deferred, ephemeral-in-guild response. */
export async function replyToChatCommand(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await awaitChatCommandAck(interaction);
  await interaction.editReply({ content });
}
