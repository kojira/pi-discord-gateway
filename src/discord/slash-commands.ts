import {
  ChannelType,
  DiscordAPIError,
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
  activateChannelWebhookProvisioning,
  beginChannelWebhookClear,
  beginChannelWebhookProvisioning,
  cancelChannelWebhookProvisioning,
  claimChannelWebhookProvisioningReconciliation,
  clearChannelModelOverride,
  clearPendingMessages,
  completeChannelWebhookProvisioningReconciliation,
  completeChannelWebhookProvisioningRollback,
  completeWebhookCleanup,
  createDmChannel,
  getChannel,
  getChannelWebhook,
  getChannelWebhookProvisioning,
  getChannelWebhookReconciliationTargets,
  getPendingWebhookCleanup,
  isChannelWebhookProvisioningStale,
  queueChannelWebhookProvisioningCleanup,
  recordChannelWebhookCreated,
  recordChannelWebhookReconciliationTargets,
  registerChannel,
  setChannelModelOverride,
  setChannelThinkingOverride,
  type ChannelWebhookConfig,
  type ChannelWebhookProvisioning,
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
import {
  deleteDiscordWebhook,
  discardWebhookTrace,
  isDiscordUnknownWebhookError,
  retireWebhookTrace,
  safeDiscordErrorMetadata,
} from './webhook-monitor.js';

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

class WebhookCommandError extends Error {}

const activeWebhookLifecycles = new Set<Promise<void>>();
let acceptingWebhookLifecycles = true;
let webhookDbMutationsAllowed = true;

/**
 * Stop accepting webhook mutations and wait only up to the shutdown budget.
 * A timed-out handler leaves its pre-await durable provisioning/cleanup record
 * for recovery and is forbidden from touching SQLite when it resumes.
 */
export async function stopWebhookLifecycle(timeoutMs = config.shutdownTimeoutMs): Promise<void> {
  acceptingWebhookLifecycles = false;
  const settling = Promise.allSettled([...activeWebhookLifecycles]);
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  if (activeWebhookLifecycles.size > 0) {
    if (timeoutMs <= 0) {
      timedOut = true;
    } else {
      await Promise.race([
        settling,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
  }

  // The gateway may close SQLite immediately after this function returns.
  webhookDbMutationsAllowed = false;
  if (timedOut) {
    logger.warn(
      { active: activeWebhookLifecycles.size, timeoutMs },
      'Webhook lifecycle shutdown deadline reached; durable cleanup state retained',
    );
  }
}

function canMutateWebhookDb(): boolean {
  return webhookDbMutationsAllowed;
}

function webhookCommandError(message: string): WebhookCommandError {
  return new WebhookCommandError(message);
}

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
  const isWebhookCommand = subcommand === 'webhook' || subcommand === 'webhook-clear';
  if (!isWebhookCommand) {
    await executeChatCommand(interaction, subcommand, false);
    return;
  }
  if (!acceptingWebhookLifecycles) return;

  const operation = executeChatCommand(interaction, subcommand, true);
  activeWebhookLifecycles.add(operation);
  try {
    await operation;
  } finally {
    activeWebhookLifecycles.delete(operation);
  }
}

async function executeChatCommand(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
  isWebhookCommand: boolean,
): Promise<void> {
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
  } catch (error) {
    // A timed-out lifecycle continuation must not use the closed Discord client
    // for command replies. All cleanup state needed by the next process was
    // persisted before the Discord await that timed out.
    if (isWebhookCommand && !canMutateWebhookDb()) return;
    if (isWebhookCommand) {
      logger.error(
        {
          command: interaction.commandName,
          subcommand,
          ...safeDiscordErrorMetadata(error),
        },
        'Webhook slash command failed',
      );
    } else {
      logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          command: interaction.commandName,
          subcommand,
        },
        'Slash command failed',
      );
    }
    const publicMessage = isWebhookCommand
      ? error instanceof WebhookCommandError
        ? error.message
        : 'Webhook command failed safely. Run /pi webhook-clear to inspect or retry cleanup.'
      : error instanceof Error
        ? error.message
        : String(error);
    const payload = reply(`⚠️ ${publicMessage}`, interaction);
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

  const destinationChannel = destination as TextChannel;
  const callerPermissions = destinationChannel.permissionsFor(interaction.user.id);
  if (
    !callerPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !callerPermissions.has(PermissionFlagsBits.ManageWebhooks)
  ) {
    await interaction.reply(
      reply(
        'You need View Channel and Manage Webhooks in the monitoring destination.',
        interaction,
      ),
    );
    return;
  }
  const botMember = interaction.guild?.members.me;
  const botPermissions = botMember ? destinationChannel.permissionsFor(botMember) : undefined;
  if (
    !botPermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !botPermissions.has(PermissionFlagsBits.ManageWebhooks)
  ) {
    await interaction.reply(
      reply(
        'The bot needs View Channel and Manage Webhooks in the monitoring destination.',
        interaction,
      ),
    );
    return;
  }

  // Acquire the cross-process lease before the first await on the valid setup
  // path. A concurrent clear can now tombstone this lease even while Discord's
  // interaction acknowledgement is blocked.
  let provisioning: ChannelWebhookProvisioning;
  try {
    provisioning = beginChannelWebhookProvisioning({
      channel_jid: channel.jid,
      destination_channel_id: destination.id,
      destination_channel_name: destination.name,
      webhook_name: buildWebhookName(channel.name),
    });
  } catch (error) {
    logger.warn(
      { jid: channel.jid, ...safeDiscordErrorMetadata(error) },
      'Monitoring webhook provisioning could not start',
    );
    throw webhookCommandError(
      'Webhook setup could not start. Another setup or cleanup may be active; run /pi webhook-clear to inspect it.',
    );
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch {
    // No Discord create request has been issued, so this lease is safe to
    // cancel. cancelChannelWebhookProvisioning refuses reconciled tombstones.
    if (canMutateWebhookDb()) cancelChannelWebhookProvisioning(provisioning.lease_id);
    throw webhookCommandError('Discord did not acknowledge webhook setup. Try again.');
  }
  if (!canMutateWebhookDb()) return;

  const currentProvisioning = getChannelWebhookProvisioning(channel.jid);
  if (
    currentProvisioning?.lease_id !== provisioning.lease_id ||
    currentProvisioning.state !== 'creating' ||
    currentProvisioning.reconciling !== 0
  ) {
    throw webhookCommandError(
      'Webhook setup was canceled before creation. Monitoring remains disabled.',
    );
  }

  const oldWebhookDeleted = await (async (): Promise<boolean | undefined> => {
    let webhook: Awaited<ReturnType<TextChannel['createWebhook']>>;
    try {
      webhook = await destinationChannel.createWebhook({
        name: provisioning.webhook_name,
        reason: `Pi activity monitoring configured by Discord user ${interaction.user.id}`,
      });
    } catch (error) {
      if (!canMutateWebhookDb()) return undefined;
      const definitive = isDefinitiveWebhookCreateRejection(error);
      if (definitive) {
        // A concrete Discord 4xx response (other than timeout/rate limiting)
        // proves that this POST did not create a remote webhook.
        cancelChannelWebhookProvisioning(provisioning.lease_id);
      }
      logger.warn(
        {
          jid: channel.jid,
          destinationChannelId: destination.id,
          ...safeDiscordErrorMetadata(error),
        },
        definitive
          ? 'Discord rejected monitoring webhook creation'
          : 'Webhook creation outcome is uncertain; cleanup remains pending',
      );
      throw definitive
        ? webhookCommandError(
            'Discord rejected webhook creation. Check destination permissions and try again.',
          )
        : cleanupPendingError();
    }

    if (!canMutateWebhookDb()) return undefined;
    if (!webhook.token) {
      // The remote webhook ID is the only durable recovery handle available
      // without a token. Claim reconciliation and persist the ID before DELETE
      // so a crash after Discord accepts deletion is recoverable from an empty
      // destination snapshot on the next /pi webhook-clear.
      const claimed = claimChannelWebhookProvisioningReconciliation(
        provisioning.lease_id,
        Date.now(),
        true,
      );
      const targets = claimed?.reconciling
        ? recordChannelWebhookReconciliationTargets(provisioning.lease_id, [webhook.id])
        : [];
      if (targets.length === 0) {
        logger.warn(
          { jid: channel.jid, destinationChannelId: destination.id },
          'Could not persist tokenless webhook cleanup target',
        );
        throw cleanupPendingError();
      }

      const deleted = await deleteWebhookObject(
        webhook,
        'Webhook creation returned no usable token',
        channel.jid,
        destination.id,
      );
      if (!canMutateWebhookDb()) return undefined;
      if (deleted) {
        completeChannelWebhookProvisioningReconciliation(provisioning.lease_id, targets);
      }
      throw webhookCommandError(
        deleted
          ? 'Discord created a webhook without a usable token, so it was deleted.'
          : 'Discord created a webhook without a usable token. Webhook cleanup is pending; run /pi webhook-clear in this channel to retry.',
      );
    }

    const createdConfig: ChannelWebhookConfig = {
      channel_jid: channel.jid,
      destination_channel_id: destination.id,
      destination_channel_name: destination.name,
      webhook_id: webhook.id,
      webhook_token: webhook.token,
    };
    let previous: ChannelWebhookConfig | undefined;
    try {
      if (!recordChannelWebhookCreated(provisioning.lease_id, createdConfig)) {
        throw new Error('Monitoring webhook setup lease expired before activation.');
      }

      await webhook.send({
        content: `✅ Pi activity monitoring enabled for **${escapeDiscordMarkdown(channel.name)}**.`,
        allowedMentions: { parse: [] },
      });
      if (!canMutateWebhookDb()) return undefined;
      ({ previous } = activateChannelWebhookProvisioning(provisioning.lease_id));
    } catch (error) {
      if (!canMutateWebhookDb()) return undefined;
      logger.warn(
        {
          jid: channel.jid,
          destinationChannelId: destination.id,
          ...safeDiscordErrorMetadata(error),
        },
        'Monitoring webhook validation or activation failed',
      );
      const deleted = await deleteWebhookObject(
        webhook,
        'Rolling back failed Pi monitoring setup',
        channel.jid,
        destination.id,
      );
      if (!canMutateWebhookDb()) return undefined;
      if (deleted) {
        completeChannelWebhookProvisioningRollback(provisioning.lease_id, createdConfig.webhook_id);
      } else {
        // This stores the returned token even if activation failed or the
        // source vanished, allowing /pi webhook-clear to retry deletion.
        queueChannelWebhookProvisioningCleanup(provisioning.lease_id, createdConfig);
      }
      throw deleted
        ? webhookCommandError(
            'Webhook setup failed and the created webhook was removed. Try again.',
          )
        : cleanupPendingError();
    }

    // Activation is complete at this point. Cleanup failures for the previous
    // epoch must not roll back or delete the newly active webhook.
    if (!previous || previous.webhook_id === webhook.id) return true;
    await retireWebhookTrace(channel.jid, previous.webhook_id);
    if (!canMutateWebhookDb()) return undefined;
    const deleted = await deleteDiscordWebhook(previous, 'Pi monitoring destination replaced');
    if (!canMutateWebhookDb()) return undefined;
    if (deleted) completeWebhookCleanup(previous.webhook_id);
    return deleted;
  })();

  if (oldWebhookDeleted === undefined || !canMutateWebhookDb()) return;
  logger.info(
    { jid: channel.jid, destinationChannelId: destination.id },
    'Channel monitoring webhook configured',
  );
  await interaction.editReply({
    content: `Pi activity for this channel will be sent to <#${destination.id}>.${
      oldWebhookDeleted
        ? ''
        : '\n⚠️ Cleanup of the previous Discord webhook is pending. Run /pi webhook-clear to retry; note that it also disables the currently active monitoring webhook.'
    }`,
  });
}

async function handleWebhookClear(interaction: ChatInputCommandInteraction): Promise<void> {
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

  const channelJid = `dc:${interaction.channelId}`;
  const channel = getChannel(channelJid);
  const hasWebhookLifecycle =
    Boolean(getChannelWebhook(channelJid)) ||
    Boolean(getChannelWebhookProvisioning(channelJid)) ||
    getPendingWebhookCleanup(channelJid).length > 0;
  if (!channel && !hasWebhookLifecycle) {
    await interaction.reply(reply(notRegisteredMessage(), interaction));
    return;
  }

  // This durable transition deliberately happens before defer/network awaits
  // and outside the process-local setup lock. It disables routing immediately
  // and prevents even a fresh or hung creator from activating later.
  const clearStart = beginChannelWebhookClear(channelJid);
  discardWebhookTrace(channelJid);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!canMutateWebhookDb()) return;
  const pendingBefore = getPendingWebhookCleanup(channelJid);

  // Credential cleanup is independent of name-based provisioning recovery.
  // A failed/empty provisioning scan must never reactivate the old epoch.
  for (const webhook of pendingBefore) {
    const deleted = await deleteDiscordWebhook(webhook, 'Pi activity monitoring disabled');
    if (!canMutateWebhookDb()) return;
    if (deleted) completeWebhookCleanup(webhook.webhook_id);
  }

  const reconciliation = await reconcileWebhookProvisioning(interaction, channelJid);
  if (!canMutateWebhookDb() || reconciliation === 'stopped') return;
  const remaining = getPendingWebhookCleanup(channelJid);
  const hasLifecycle = Boolean(getChannelWebhookProvisioning(channelJid));
  const result =
    !clearStart.removed &&
    pendingBefore.length === 0 &&
    !clearStart.provisioning &&
    reconciliation === 'none' &&
    !hasLifecycle
      ? undefined
      : {
          removed: clearStart.removed,
          remaining,
          reconciliation,
          hasLifecycle,
        };
  if (!result) {
    await interaction.editReply({
      content: 'No monitoring webhook is configured for this channel.',
    });
    return;
  }

  const provisioningPending =
    result.reconciliation === 'uncertain' ||
    result.reconciliation === 'retry' ||
    result.hasLifecycle;
  if (result.reconciliation === 'uncertain') {
    logger.warn({ jid: channelJid }, 'Webhook creation is still uncertain; locator retained');
  }
  logger.info(
    {
      jid: channelJid,
      pendingCleanup: result.remaining.length,
      provisioningPending,
    },
    'Channel monitoring webhook cleared',
  );

  const pendingParts: string[] = [];
  if (result.remaining.length > 0) {
    pendingParts.push(
      `${result.remaining.length} webhook cleanup ${
        result.remaining.length === 1 ? 'attempt remains' : 'attempts remain'
      }`,
    );
  }
  if (provisioningPending) {
    pendingParts.push(
      result.reconciliation === 'uncertain'
        ? 'the interrupted setup cleanup status remains uncertain because Discord did not list the webhook yet; the recovery locator was retained'
        : 'interrupted setup cleanup remains pending; verify the destination and permissions',
    );
  }

  await interaction.editReply({
    content:
      pendingParts.length > 0
        ? `Pi activity monitoring is disabled. ⚠️ ${pendingParts.join(
            '; ',
          )}. Inspect the destination if needed, then run /pi webhook-clear again to retry.`
        : result.reconciliation === 'recovered'
          ? 'Pi activity monitoring is disabled. Interrupted webhook setup was recovered and the Discord webhook was deleted.'
          : 'Pi activity monitoring is disabled and the Discord webhook was deleted.',
  });
}

type ProvisioningReconciliation =
  'none' | 'queued' | 'recovered' | 'uncertain' | 'retry' | 'stopped';

async function reconcileWebhookProvisioning(
  interaction: ChatInputCommandInteraction,
  channelJid: string,
): Promise<ProvisioningReconciliation> {
  let provisioning = getChannelWebhookProvisioning(channelJid);
  if (!provisioning) return 'none';

  if (provisioning.state === 'created') {
    queueChannelWebhookProvisioningCleanup(provisioning.lease_id, provisioningConfig(provisioning));
    return 'queued';
  }
  if (!isChannelWebhookProvisioningStale(provisioning)) {
    throw webhookCommandError(
      'Monitoring webhook setup is still in progress. Wait, then try again.',
    );
  }

  // Claim the stale lease before the first remote await. This durable tombstone
  // prevents a creator in another process from activating while reconciliation
  // inspects or deletes the remote webhook.
  provisioning = claimChannelWebhookProvisioningReconciliation(provisioning.lease_id);
  if (!provisioning) return 'none';
  if (provisioning.state === 'created') {
    queueChannelWebhookProvisioningCleanup(provisioning.lease_id, provisioningConfig(provisioning));
    return 'queued';
  }
  if (provisioning.reconciling !== 1) {
    throw webhookCommandError(
      'Monitoring webhook setup is still in progress. Wait, then try again.',
    );
  }

  let destination: Awaited<ReturnType<typeof interaction.client.channels.fetch>>;
  try {
    destination = await interaction.client.channels.fetch(provisioning.destination_channel_id);
  } catch (error) {
    if (!canMutateWebhookDb()) return 'stopped';
    logWebhookReconciliationFailure(provisioning, error, 'destination_fetch_failed');
    return 'retry';
  }
  if (!canMutateWebhookDb()) return 'stopped';
  if (!destination || !('fetchWebhooks' in destination)) {
    logger.warn(
      {
        jid: provisioning.channel_jid,
        destinationChannelId: provisioning.destination_channel_id,
        reason: destination ? 'unsupported_destination' : 'missing_destination',
      },
      'Could not inspect interrupted monitoring webhook; cleanup remains pending',
    );
    return 'retry';
  }

  let webhooks: Awaited<ReturnType<typeof destination.fetchWebhooks>>;
  try {
    webhooks = await destination.fetchWebhooks();
  } catch (error) {
    if (!canMutateWebhookDb()) return 'stopped';
    logWebhookReconciliationFailure(provisioning, error, 'webhook_fetch_failed');
    return 'retry';
  }
  if (!canMutateWebhookDb()) return 'stopped';
  const priorTargets = getChannelWebhookReconciliationTargets(provisioning.lease_id);
  const priorTargetSet = new Set(priorTargets);
  const matches = [...webhooks.values()].filter(
    (webhook) =>
      webhook.name === provisioning.webhook_name ||
      (typeof webhook.id === 'string' && priorTargetSet.has(webhook.id)),
  );
  if (matches.length === 0) {
    if (priorTargets.length > 0) {
      // A prior attempt durably observed these IDs before issuing DELETE. Their
      // absence now is positive retry evidence that they are gone.
      completeChannelWebhookProvisioningReconciliation(provisioning.lease_id, priorTargets);
      return 'recovered';
    }
    // Absence from the first snapshot cannot prove that an uncertain POST will
    // not appear later. Keep the reconciling tombstone indefinitely.
    return 'uncertain';
  }

  const matchIds = matches.flatMap((webhook) =>
    typeof webhook.id === 'string' ? [webhook.id] : [],
  );
  if (matchIds.length !== matches.length) {
    logger.warn(
      {
        jid: provisioning.channel_jid,
        destinationChannelId: provisioning.destination_channel_id,
        reason: 'webhook_id_missing',
      },
      'Could not finish interrupted monitoring webhook cleanup',
    );
    return 'retry';
  }
  const reconciliationTargets = recordChannelWebhookReconciliationTargets(
    provisioning.lease_id,
    matchIds,
  );
  if (reconciliationTargets.length === 0) return 'retry';

  for (const webhook of matches) {
    const deleted = await deleteWebhookObject(
      webhook,
      'Recovering interrupted Pi monitoring setup',
      provisioning.channel_jid,
      provisioning.destination_channel_id,
    );
    if (!canMutateWebhookDb()) return 'stopped';
    if (!deleted) return 'retry';
  }

  completeChannelWebhookProvisioningReconciliation(provisioning.lease_id, reconciliationTargets);
  return 'recovered';
}

function logWebhookReconciliationFailure(
  provisioning: ChannelWebhookProvisioning,
  error: unknown,
  reason: string,
): void {
  logger.warn(
    {
      jid: provisioning.channel_jid,
      destinationChannelId: provisioning.destination_channel_id,
      reason,
      ...safeDiscordErrorMetadata(error),
    },
    'Could not inspect interrupted monitoring webhook; cleanup remains pending',
  );
}

async function deleteWebhookObject(
  webhook: { delete(reason?: string): Promise<unknown> },
  reason: string,
  channelJid: string,
  destinationChannelId: string,
): Promise<boolean> {
  try {
    await webhook.delete(reason);
    return true;
  } catch (error) {
    if (isDiscordUnknownWebhookError(error)) return true;
    logger.warn(
      {
        jid: channelJid,
        destinationChannelId,
        ...safeDiscordErrorMetadata(error),
      },
      'Failed to roll back Discord monitoring webhook; cleanup remains pending',
    );
    return false;
  }
}

export function isDefinitiveWebhookCreateRejection(error: unknown): boolean {
  if (!(error instanceof DiscordAPIError)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

function cleanupPendingError(): WebhookCommandError {
  return webhookCommandError(
    'Webhook setup did not complete. Cleanup is pending; run /pi webhook-clear in this channel to retry.',
  );
}

function provisioningConfig(provisioning: ChannelWebhookProvisioning): ChannelWebhookConfig {
  if (!provisioning.webhook_id || !provisioning.webhook_token) {
    throw webhookCommandError('Interrupted webhook setup has no stored credentials.');
  }
  return {
    channel_jid: provisioning.channel_jid,
    destination_channel_id: provisioning.destination_channel_id,
    destination_channel_name: provisioning.destination_channel_name,
    webhook_id: provisioning.webhook_id,
    webhook_token: provisioning.webhook_token,
  };
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
