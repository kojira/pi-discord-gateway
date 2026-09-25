import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

const pendingAcks = new WeakMap<ChatInputCommandInteraction, Promise<unknown>>();

/** Start the Discord ACK before any command-specific lookup or side effect. */
export function startChatCommandAck(interaction: ChatInputCommandInteraction): void {
  if (interaction.replied || pendingAcks.has(interaction)) return;
  const pending = interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );
  // The valid webhook setup/clear paths establish their durable lease before
  // awaiting the network ACK. Attach a handler now so an early rejection is
  // not reported as unhandled; awaitChatCommandAck still propagates it.
  void pending.catch(() => {});
  pendingAcks.set(interaction, pending);
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
