import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type InteractionReplyOptions,
  type TextChannel,
} from 'discord.js';
import {
  getChannelSessionStatus,
  type ChannelSessionStatus,
  type SessionContextUsage,
  type SessionTokenUsage,
} from '../agent/invoke.js';
import { config } from '../config.js';
import {
  clearChannelModelOverride,
  clearChannelWebhook,
  clearPendingMessages,
  createDmChannel,
  getChannel,
  getChannelWebhook,
  registerChannel,
  setChannelModelOverride,
  setChannelThinkingOverride,
  setChannelWebhook,
} from '../db.js';
import { logger } from '../logger.js';
import {
  autocompleteModels,
  hasCachedModelCatalog,
  isModelCatalogStale,
  isThinkingLevel,
  listAvailableModels,
  listSelectableModels,
  resolveModelReference,
  resolveThinkingForModel,
  toModelChoiceName,
} from '../agent/model-catalog.js';
import {
  buildThinkingAdjustmentMessage,
  computeEffectiveChannelSettings,
  getDesiredThinkingLevel,
  type EffectiveChannelSettings,
} from '../agent/channel-settings.js';
import { abortChannelTask, isChannelProcessing } from '../agent/queue.js';
import { rotateChannelSessionDir } from '../session/path.js';
import type { RegisteredChannel } from '../types.js';
import { deleteDiscordWebhook, flushWebhookTrace } from './webhook-monitor.js';

const PI_COMMAND = new SlashCommandBuilder()
  .setName('pi')
  .setDescription('Inspect or change pi model settings for this channel')
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Show the current model and thinking configuration for this channel'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('model')
      .setDescription('Set the default model for this channel')
      .addStringOption((option) =>
        option
          .setName('model')
          .setDescription("Choose one of pi's currently available models")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('reset-model').setDescription("Reset this channel to the gateway's default model"),
  )
  .addSubcommand((sub) =>
    sub
      .setName('thinking')
      .setDescription('Set the default thinking level for this channel')
      .addStringOption((option) =>
        option
          .setName('level')
          .setDescription('Thinking level')
          .setRequired(true)
          .addChoices(
            { name: 'off', value: 'off' },
            { name: 'minimal', value: 'minimal' },
            { name: 'low', value: 'low' },
            { name: 'medium', value: 'medium' },
            { name: 'high', value: 'high' },
            { name: 'xhigh', value: 'xhigh' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('new').setDescription('Start a fresh pi session for this channel'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('stop')
      .setDescription('Abort the current task and clear the queue for this channel'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('webhook')
      .setDescription('Send this channel’s Pi activity to a monitoring webhook channel')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Discord channel that will receive the Pi activity trace')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('webhook-clear')
      .setDescription('Stop sending this channel’s Pi activity to its monitoring webhook'),
  );

export async function registerGlobalCommands(client: Client<true>): Promise<void> {
  await client.application.commands.set([PI_COMMAND.toJSON()]);
  logger.info('Registered global slash commands');
}

const catalogRefreshesInFlight = new Set<string>();

/** Refresh a cwd's model catalog off the interaction path, at most once at a time. */
function scheduleCatalogRefresh(cwd: string): void {
  if (catalogRefreshesInFlight.has(cwd)) return;
  catalogRefreshesInFlight.add(cwd);
  setImmediate(() => {
    try {
      listAvailableModels({ forceRefresh: true, cwd });
    } catch (err: any) {
      logger.warn({ cwd, err: err.message }, 'Failed to warm model catalog');
    } finally {
      catalogRefreshesInFlight.delete(cwd);
    }
  });
}

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== 'pi') return;
  if (interaction.options.getSubcommand() !== 'model') return;
  if (interaction.options.getFocused(true).name !== 'model') return;

  const channel = getChannel(`dc:${interaction.channelId}`);
  if (!channel) {
    await interaction.respond([]);
    return;
  }

  const cwd = channel.cwdOverride || config.piCwd;
  if (!hasCachedModelCatalog(cwd)) {
    await interaction.respond([]);
    scheduleCatalogRefresh(cwd);
    return;
  }

  const focused = interaction.options.getFocused();
  const models = await autocompleteModels(focused, 25, { allowStale: true, cwd });
  const matches = models.map((model) => ({
    name: toModelChoiceName(model),
    value: model.ref,
  }));

  await interaction.respond(matches);

  // Serve stale results within Discord's deadline, but refresh expired
  // catalogs in the background so autocomplete-only users still pick up
  // pi upgrades and provider changes.
  if (isModelCatalogStale(cwd)) {
    scheduleCatalogRefresh(cwd);
  }
}

export async function handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName !== 'pi') return;

  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'status':
        await handleStatus(interaction);
        return;
      case 'model':
        await handleModelSet(interaction);
        return;
      case 'reset-model':
        await handleModelReset(interaction);
        return;
      case 'thinking':
        await handleThinkingSet(interaction);
        return;
      case 'new':
        await handleNew(interaction);
        return;
      case 'stop':
        await handleStop(interaction);
        return;
      case 'webhook':
        await handleWebhookSet(interaction);
        return;
      case 'webhook-clear':
        await handleWebhookClear(interaction);
        return;
      default:
        await interaction.reply(reply(`Unknown subcommand: ${subcommand}`, interaction));
    }
  } catch (err: any) {
    logger.error(
      { err: err.message, command: interaction.commandName, subcommand },
      'Slash command failed',
    );
    const payload = reply(`⚠️ ${err.message}`, interaction);
    if (interaction.replied) {
      await interaction.followUp(payload);
    } else if (interaction.deferred) {
      await interaction.editReply({ content: payload.content });
    } else {
      await interaction.reply(payload);
    }
  }
}

async function handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  if (isChannelProcessing(channel.jid)) {
    await interaction.reply(
      reply(
        'This channel is currently processing a message. Wait for it to finish, then run /new again.',
        interaction,
      ),
    );
    return;
  }

  const cleared = clearPendingMessages(channel.jid);
  const archivedSession = rotateChannelSessionDir(channel.folder);

  logger.info(
    { jid: channel.jid, cleared, archived: Boolean(archivedSession) },
    'Channel session reset',
  );

  const notes = ['Started a fresh session for this channel.'];
  if (cleared > 0) {
    notes.push(`Cleared ${cleared} queued ${cleared === 1 ? 'message' : 'messages'}.`);
  }
  if (archivedSession) {
    notes.push('Archived the previous session on disk.');
  }

  await interaction.reply(reply(notes.join('\n'), interaction));
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const jid = `dc:${interaction.channelId}`;
  const result = abortChannelTask(jid);

  if (!result.aborted && result.cleared === 0) {
    await interaction.reply(
      reply('No active task or queued messages in this channel.', interaction),
    );
    return;
  }

  const notes: string[] = [];
  if (result.aborted) {
    notes.push('Aborted the current task.');
  }
  if (result.cleared > 0) {
    notes.push(
      `Cleared ${result.cleared} queued ${result.cleared === 1 ? 'message' : 'messages'}.`,
    );
  }

  await interaction.reply(reply(notes.join(' '), interaction));
}

async function handleWebhookSet(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply(
      reply('Monitoring webhooks can only be configured in a server.', interaction),
    );
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageWebhooks)) {
    await interaction.reply(reply('Manage Webhooks permission is required.', interaction));
    return;
  }

  const destination = interaction.options.getChannel('channel', true);
  const destinationGuildId =
    'guildId' in destination && typeof destination.guildId === 'string'
      ? destination.guildId
      : 'guild_id' in destination && typeof destination.guild_id === 'string'
        ? destination.guild_id
        : undefined;
  if (
    destinationGuildId !== interaction.guildId ||
    (destination.type !== ChannelType.GuildText &&
      destination.type !== ChannelType.GuildAnnouncement) ||
    !('createWebhook' in destination)
  ) {
    await interaction.reply(
      reply('Choose a text or announcement channel in this server.', interaction),
    );
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const existing = getChannelWebhook(channel.jid);
  const webhookName = buildWebhookName(channel.name);
  const webhook = await (destination as TextChannel).createWebhook({
    name: webhookName,
    reason: `Pi activity monitoring configured by Discord user ${interaction.user.id}`,
  });

  if (!webhook.token) {
    await webhook.delete('Webhook creation returned no usable token').catch(() => undefined);
    throw new Error('Discord created a webhook without a usable token.');
  }

  try {
    await webhook.send({
      content: `✅ Pi activity monitoring enabled for **${escapeDiscordMarkdown(channel.name)}**.`,
      allowedMentions: { parse: [] },
    });
    await flushWebhookTrace(channel.jid);
    setChannelWebhook({
      channel_jid: channel.jid,
      destination_channel_id: destination.id,
      destination_channel_name: destination.name,
      webhook_id: webhook.id,
      webhook_token: webhook.token,
    });
  } catch (error) {
    await webhook.delete('Rolling back failed Pi monitoring setup').catch(() => undefined);
    throw error;
  }

  let oldWebhookDeleted = true;
  if (existing && existing.webhook_id !== webhook.id) {
    oldWebhookDeleted = await deleteDiscordWebhook(existing, 'Pi monitoring destination replaced');
  }

  logger.info(
    { jid: channel.jid, destinationChannelId: destination.id },
    'Channel monitoring webhook configured',
  );
  await interaction.editReply({
    content: `Pi activity for this channel will be sent to <#${destination.id}>.${
      oldWebhookDeleted ? '' : '\n⚠️ The previous Discord webhook could not be deleted.'
    }`,
  });
}

async function handleWebhookClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }
  if (!interaction.inGuild()) {
    await interaction.reply(
      reply('Monitoring webhooks can only be configured in a server.', interaction),
    );
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageWebhooks)) {
    await interaction.reply(reply('Manage Webhooks permission is required.', interaction));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const existing = getChannelWebhook(channel.jid);
  if (!existing) {
    await interaction.editReply({
      content: 'No monitoring webhook is configured for this channel.',
    });
    return;
  }

  await flushWebhookTrace(channel.jid);
  clearChannelWebhook(channel.jid);
  const deleted = await deleteDiscordWebhook(existing, 'Pi activity monitoring disabled');
  logger.info(
    { jid: channel.jid, destinationChannelId: existing.destination_channel_id },
    'Channel monitoring webhook cleared',
  );
  await interaction.editReply({
    content: deleted
      ? 'Pi activity monitoring is disabled and the Discord webhook was deleted.'
      : 'Pi activity monitoring is disabled. ⚠️ Discord did not allow the old webhook to be deleted.',
  });
}

function buildWebhookName(sourceName: string): string {
  const compact = sourceName.replace(/[\r\n]/gu, ' ').trim() || 'channel';
  return `ぴーこ monitor · ${compact}`.slice(0, 80);
}

function escapeDiscordMarkdown(text: string): string {
  const markdownCharacters = new Set('\\`*_{}[]()<>#+-.!|');
  return [...text]
    .map((character) => (markdownCharacters.has(character) ? `\\${character}` : character))
    .join('');
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  await interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );

  const effective = computeEffectiveChannelSettings(channel);
  const sessionStatus = await getChannelSessionStatus(channel.folder, effective.effectiveCwd);
  await interaction.editReply({
    content: buildStatusMessage(channel.jid, effective, sessionStatus),
  });
}

async function handleModelSet(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  await interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );

  const selectedRef = interaction.options.getString('model', true);
  const cwd = channel.cwdOverride || config.piCwd;
  const models = await listSelectableModels({ forceRefresh: true, cwd });
  const selectedModel = resolveModelReference(selectedRef, models);
  if (!selectedModel) {
    await interaction.editReply({ content: `Model is no longer available: ${selectedRef}` });
    return;
  }

  setChannelModelOverride(channel.jid, selectedModel.ref);

  // Re-read channel to use the persisted override in status/effective computation.
  const updated = getChannel(channel.jid)!;
  const desiredThinking = getDesiredThinkingLevel(updated);
  const thinkingResolution = resolveThinkingForModel(selectedModel, desiredThinking);

  // Only persist the clamped value if the channel already had an explicit thinking override.
  if (updated.thinkingOverride) {
    setChannelThinkingOverride(updated.jid, thinkingResolution.effective);
  }

  const notes = [`Model set to ${selectedModel.ref} for this channel.`];
  if (thinkingResolution.adjusted) {
    notes.push(
      buildThinkingAdjustmentMessage(
        thinkingResolution.requested,
        thinkingResolution.effective,
        selectedModel,
      ),
    );
  }

  await interaction.editReply({ content: notes.join('\n') });
}

async function handleModelReset(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  await interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );

  clearChannelModelOverride(channel.jid);

  const updated = getChannel(channel.jid)!;
  const effective = computeEffectiveChannelSettings(updated, { forceRefresh: true });
  const notes = ['Model reset for this channel.'];

  if (updated.thinkingOverride && effective.thinkingAdjusted) {
    setChannelThinkingOverride(updated.jid, effective.effectiveThinking);
  }

  if (effective.thinkingAdjusted) {
    const currentThinking = effective.hasManagedThinking
      ? effective.effectiveThinking
      : '(pi runtime default)';
    notes.push(
      `Current effective thinking is ${currentThinking}. ${effective.thinkingAdjustmentMessage}`,
    );
  }

  await interaction.editReply({ content: notes.join('\n') });
}

async function handleThinkingSet(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = ensureManagedChannel(interaction);
  if (!channel) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  const rawLevel = interaction.options.getString('level', true);
  if (!isThinkingLevel(rawLevel)) {
    await interaction.reply(reply(`Invalid thinking level: ${rawLevel}`, interaction));
    return;
  }

  await interaction.deferReply(
    interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : undefined,
  );

  const effective = computeEffectiveChannelSettings(channel, { forceRefresh: true });
  const resolution = resolveThinkingForModel(effective.modelInfo, rawLevel);

  setChannelThinkingOverride(channel.jid, resolution.effective);

  const notes = [`Thinking level set to ${resolution.effective} for this channel.`];
  if (resolution.adjusted) {
    notes.push(
      buildThinkingAdjustmentMessage(
        resolution.requested,
        resolution.effective,
        effective.modelInfo,
      ),
    );
  }

  await interaction.editReply({ content: notes.join('\n') });
}

function ensureManagedChannel(
  interaction: ChatInputCommandInteraction,
): RegisteredChannel | undefined {
  const jid = `dc:${interaction.channelId}`;
  const channel = getChannel(jid);
  if (channel) return channel;

  // Allow slash commands to bootstrap DM channels, same as normal DM messages.
  if (!interaction.guild && config.autoRegisterDMs) {
    const reg = createDmChannel(jid, interaction.user.id, interaction.user.username);
    registerChannel(reg);
    return getChannel(jid) ?? reg;
  }

  return undefined;
}

function notRegisteredMessage(): string {
  return 'This channel is not registered yet. Send a regular message in this channel first — the gateway will auto-register it (if channel policy is `open` or `open-trigger`).';
}

function buildStatusMessage(
  channelJid: string,
  effective: EffectiveChannelSettings,
  sessionStatus: ChannelSessionStatus,
): string {
  const webhook = getChannelWebhook(channelJid);
  const rows: Array<[string, string]> = [
    ['Model', formatModelValue(effective)],
    ['Thinking', formatThinkingValue(effective)],
    ['Working dir', formatWorkingDirValue(effective)],
    [
      'Webhook',
      webhook
        ? `#${webhook.destination_channel_name} (${webhook.destination_channel_id})`
        : 'disabled',
    ],
  ];

  if (effective.thinkingAdjusted) {
    rows.push(['Fallback', formatThinkingFallback(effective)]);
  }

  rows.push(
    ['Reasoning', effective.modelInfo ? (effective.modelInfo.reasoning ? 'yes' : 'no') : 'unknown'],
    [
      'Session',
      sessionStatus.createdAt ? formatSessionCreatedAt(sessionStatus.createdAt) : 'not started',
    ],
    ['Tokens', formatTokenUsage(sessionStatus.tokens, sessionStatus.statsSource)],
    ['Context', formatContextUsage(sessionStatus.contextUsage)],
  );

  return `\`\`\`text\n${formatTwoColumnRows(rows)}\n\`\`\``;
}

function formatModelValue(effective: EffectiveChannelSettings): string {
  if (effective.modelSource === 'pi runtime default') {
    return 'pi runtime default';
  }

  return `${effective.displayModel} (${formatSettingSource(effective.modelSource)})`;
}

function formatThinkingValue(effective: EffectiveChannelSettings): string {
  if (!effective.hasManagedThinking || effective.thinkingSource === 'pi runtime default') {
    return 'pi runtime default';
  }

  return `${effective.effectiveThinking} (${formatSettingSource(effective.thinkingSource)})`;
}

function formatThinkingFallback(effective: EffectiveChannelSettings): string {
  if (
    effective.modelInfo &&
    !effective.modelInfo.reasoning &&
    effective.requestedThinking !== 'off'
  ) {
    return `${effective.requestedThinking} -> off (no reasoning)`;
  }

  if (effective.requestedThinking === 'xhigh' && effective.effectiveThinking === 'high') {
    return 'xhigh -> high (unsupported)';
  }

  return `${effective.requestedThinking} -> ${effective.effectiveThinking}`;
}

function formatWorkingDirValue(effective: EffectiveChannelSettings): string {
  return `${effective.effectiveCwd} (${effective.cwdSource === 'override' ? 'channel' : 'gateway'})`;
}

function formatSettingSource(source: EffectiveChannelSettings['modelSource']): string {
  switch (source) {
    case 'override':
      return 'channel';
    case 'default':
      return 'gateway';
    case 'pi runtime default':
      return 'pi';
  }
}

function formatSessionCreatedAt(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function formatTokenUsage(
  tokens: SessionTokenUsage | undefined,
  statsSource: ChannelSessionStatus['statsSource'],
): string {
  if (!tokens) {
    return statsSource === 'none' ? '0 total' : '?';
  }

  const cache = tokens.cacheRead + tokens.cacheWrite;
  const details = [`${formatNumber(tokens.input)} in`, `${formatNumber(tokens.output)} out`];
  if (cache > 0) {
    details.push(`${formatNumber(cache)} cache`);
  }

  const showDetails = tokens.input > 0 || tokens.output > 0 || cache > 0;
  return `${formatNumber(tokens.total)} total${showDetails ? ` (${details.join(' / ')})` : ''}`;
}

function formatContextUsage(contextUsage: SessionContextUsage | undefined): string {
  if (!contextUsage) {
    return '?';
  }

  const tokens = contextUsage.tokens == null ? '?' : formatNumber(contextUsage.tokens);
  const window =
    contextUsage.contextWindow == null ? '?' : formatNumber(contextUsage.contextWindow);
  const percent = contextUsage.percent == null ? '?' : `${formatPercent(contextUsage.percent)}%`;
  return `${tokens} / ${window} (${percent})`;
}

function formatTwoColumnRows(rows: Array<[string, string]>): string {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}

function reply(content: string, interaction: ChatInputCommandInteraction): InteractionReplyOptions {
  if (interaction.inGuild()) {
    return { content, flags: MessageFlags.Ephemeral };
  }
  return { content };
}
