/**
 * Discord channel adapter.
 *
 * Architecture borrowed from NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Handles all Discord I/O: receiving messages, sending responses, typing indicators.
 * Contains zero business logic — that lives in the pi agent.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type TextChannel,
} from 'discord.js';
import { type RegisteredChannel } from '../types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  createDmChannel,
  getChannel,
  registerChannel as dbRegisterChannel,
  enqueueMessage,
} from '../db.js';
import {
  buildAttachmentOnlyPrompt,
  selectAttachmentsWithinLimits,
  type AttachmentMeta,
} from './attachments.js';
import { handleAutocomplete, handleChatCommand, registerGlobalCommands } from './slash-commands.js';
import { writeSupervisorReply, type SupervisorRequest } from '../agent/supervisor-channel.js';

let client: Client | null = null;
let triggerPattern: RegExp;
let botId: string;

export async function startDiscord(): Promise<void> {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Required for DM message events in discord.js.
    partials: [Partials.Channel],
  });

  client.on(Events.MessageCreate, handleMessage);
  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.Error, (err) => logger.error({ err: err.message }, 'Discord client error'));

  return new Promise<void>((resolve, reject) => {
    const onReady = async (ready: Client<true>) => {
      cleanup();
      botId = ready.user.id;
      triggerPattern = new RegExp(`^@${escapeRegExp(config.triggerName)}\\b`, 'i');
      logger.info({ tag: ready.user.tag, id: botId }, 'Discord bot connected');

      try {
        await registerGlobalCommands(ready);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to register global slash commands');
      }

      resolve();
    };

    const onStartupError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      client?.off(Events.ClientReady, onReady);
      client?.off(Events.Error, onStartupError);
    };

    client!.once(Events.ClientReady, onReady);
    client!.once(Events.Error, onStartupError);
    client!.login(config.discordToken).catch(onStartupError);
  });
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isButton() && interaction.customId.startsWith(SUPERVISOR_BUTTON_PREFIX)) {
      await handleSupervisorButton(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(SUPERVISOR_MODAL_PREFIX)) {
      await handleSupervisorModal(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleChatCommand(interaction);
    }
  } catch (err: any) {
    logger.error({ err: err.message, id: interaction.id }, 'Interaction handler failed');
  }
}

async function handleMessage(message: Message): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  const isDM = !message.guild;
  const channelId = message.channelId;
  const jid = `dc:${channelId}`;

  // ── Build content ──
  let content = message.content;
  const senderName =
    message.member?.displayName || message.author.displayName || message.author.username;
  const sender = message.author.id;
  const timestamp = message.createdAt.toISOString();

  // Translate @bot mentions → trigger format
  if (client?.user) {
    const isMentioned =
      message.mentions.users.has(botId) ||
      content.includes(`<@${botId}>`) ||
      content.includes(`<@!${botId}>`);

    if (isMentioned) {
      content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
      if (!triggerPattern.test(content)) {
        content = `@${config.triggerName} ${content}`;
      }
    }
  }

  // Attachments → extract metadata for downstream download
  let acceptedAttachments: AttachmentMeta[] = [];
  let attachmentsJson: string | null = null;
  if (message.attachments.size > 0) {
    const metas: AttachmentMeta[] = [...message.attachments.values()].map((att) => ({
      url: att.url,
      name: att.name || 'file',
      contentType: att.contentType || '',
      size: att.size || 0,
    }));

    const selection = selectAttachmentsWithinLimits(metas, {
      maxFileBytes: config.maxAttachmentBytes,
      maxTotalBytes: config.maxTotalAttachmentBytes,
    });

    acceptedAttachments = selection.accepted;
    if (selection.rejected.length > 0) {
      logger.info(
        {
          jid,
          skipped: selection.rejected.map(({ attachment, reason, limitBytes }) => ({
            name: attachment.name,
            size: attachment.size,
            reason,
            limitBytes,
          })),
        },
        'Skipped oversized Discord attachments before enqueue',
      );
    }

    if (acceptedAttachments.length > 0) {
      attachmentsJson = JSON.stringify(acceptedAttachments);
    }
  }

  // Reply context
  if (message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      const refAuthor = ref.member?.displayName || ref.author.displayName || ref.author.username;
      content = `[Reply to ${refAuthor}] ${content}`;
    } catch {
      // deleted message
    }
  }

  // ── Channel registration check ──
  let channel = getChannel(jid);

  // Auto-register DMs
  if (!channel && isDM && config.autoRegisterDMs) {
    const reg = createDmChannel(jid, sender, senderName);
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, senderName }, 'Auto-registered DM channel');
  }

  // Auto-register guild channels based on policy
  if (!channel && !isDM && config.channelPolicy !== 'allowlist') {
    if (config.excludedChannels.has(channelId)) {
      return;
    }

    const guildName = message.guild?.name || 'Unknown';
    const channelName = (message.channel as TextChannel).name || 'unknown';
    const name = `${guildName} #${channelName}`;
    const reg: RegisteredChannel = {
      jid,
      name,
      folder: `ch_${channelId}`,
      requiresTrigger: config.channelPolicy === 'open-trigger',
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    };
    dbRegisterChannel(reg);
    channel = reg;
    logger.info({ jid, name, policy: config.channelPolicy }, 'Auto-registered guild channel');
  }

  if (!channel) {
    logger.debug({ jid }, 'Message from unregistered channel, ignoring');
    return;
  }

  // ── Trigger check ──
  if (channel.requiresTrigger && !triggerPattern.test(content)) {
    logger.debug({ jid }, 'Message does not match trigger, ignoring');
    return;
  }

  // Strip trigger prefix from content sent to agent
  content = content.replace(triggerPattern, '').trim();
  if (!content && acceptedAttachments.length > 0) {
    content = buildAttachmentOnlyPrompt(acceptedAttachments.length);
  }
  if (!content) return;

  // ── Enqueue ──
  enqueueMessage({
    channelJid: jid,
    sender,
    senderName,
    content,
    timestamp,
    attachments: attachmentsJson,
  });
  logger.info({ jid, sender: senderName, len: content.length }, 'Message enqueued');
}

// ── Supervisor UI ──

const SUPERVISOR_BUTTON_PREFIX = 'supervisor:';
const SUPERVISOR_MODAL_PREFIX = 'supervisor-modal:';
const SUPERVISOR_DEFAULT_BEST_EFFORT =
  'Proceed best-effort. Do not wait for supervisor again in this run. If evidence is missing, report it explicitly as residual risk in your final output.';
const SUPERVISOR_CANCEL_REPLY =
  'Cancel this child task. Return a final blocked/cancelled result to the parent and do not continue this child task.';

const pendingSupervisorRequests = new Map<string, SupervisorRequest>();
const alwaysSupervisorReplies = new Map<string, string>();

export async function promptSupervisorRequest(
  jid: string,
  request: SupervisorRequest,
  signal?: AbortSignal,
): Promise<void> {
  const alwaysReply = alwaysSupervisorReplies.get(supervisorAlwaysKey(request));
  if (alwaysReply) {
    await replyToSupervisorRequest(request.id, alwaysReply);
    logger.info(
      { jid, requestId: request.id, runId: request.runId },
      'Applied supervisor always reply',
    );
    return;
  }

  pendingSupervisorRequests.set(request.id, request);
  if (!client) return;

  const channelId = jid.replace(/^dc:/, '');
  const channel = await abortableDiscordRequest(client.channels.fetch(channelId), signal);
  if (!channel || !('send' in channel)) {
    logger.warn({ jid, requestId: request.id }, 'Cannot send supervisor prompt to Discord channel');
    return;
  }

  const expires = request.expiresAt
    ? `\nExpires: <t:${Math.floor(request.expiresAt / 1000)}:R>`
    : '';
  const body = [
    '⚠️ **Subagent needs supervisor input**',
    '',
    `Agent: \`${request.agent}\`  Child: \`${request.childIndex}\``,
    `Reason: \`${request.reason}\``,
    `Run: \`${request.runId}\`${expires}`,
    '',
    truncateForDiscordBlock(request.message, 1400),
    '',
    'Choose an action below. **Always** applies only to this run/agent/reason while the gateway process is alive.',
  ].join('\n');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(supervisorButtonId('once', request.id))
      .setLabel('Once')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(supervisorButtonId('always', request.id))
      .setLabel('Always this run')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(supervisorButtonId('best', request.id))
      .setLabel('Best effort')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(supervisorButtonId('cancel', request.id))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );

  await abortableDiscordRequest(
    Promise.resolve().then(() =>
      (channel as TextChannel).send({
        ...discordTextPayload(body),
        components: [row],
      }),
    ),
    signal,
  );
  logger.info({ jid, requestId: request.id, runId: request.runId }, 'Supervisor prompt sent');
}

async function handleSupervisorButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseSupervisorCustomId(interaction.customId, SUPERVISOR_BUTTON_PREFIX);
  if (!parsed) return;
  const request = pendingSupervisorRequests.get(parsed.requestId);
  if (!request) {
    await interaction.reply({
      content: 'This supervisor request is no longer pending.',
      ephemeral: true,
    });
    return;
  }

  if (parsed.action === 'once' || parsed.action === 'always') {
    const modal = new ModalBuilder()
      .setCustomId(`${SUPERVISOR_MODAL_PREFIX}${parsed.action}:${request.id}`)
      .setTitle(parsed.action === 'always' ? 'Always reply for this run' : 'Reply once');
    const input = new TextInputBuilder()
      .setCustomId('reply')
      .setLabel('Supervisor reply')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(3500)
      .setValue(parsed.action === 'always' ? SUPERVISOR_DEFAULT_BEST_EFFORT : '');
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  const message =
    parsed.action === 'cancel' ? SUPERVISOR_CANCEL_REPLY : SUPERVISOR_DEFAULT_BEST_EFFORT;
  await replyToSupervisorRequest(request.id, message);
  await interaction.reply({
    content: `Supervisor ${parsed.action === 'cancel' ? 'cancel' : 'best-effort'} reply sent.`,
    ephemeral: true,
  });
}

async function handleSupervisorModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parsed = parseSupervisorCustomId(interaction.customId, SUPERVISOR_MODAL_PREFIX);
  if (!parsed || (parsed.action !== 'once' && parsed.action !== 'always')) return;
  const request = pendingSupervisorRequests.get(parsed.requestId);
  if (!request) {
    await interaction.reply({
      content: 'This supervisor request is no longer pending.',
      ephemeral: true,
    });
    return;
  }
  const message = interaction.fields.getTextInputValue('reply').trim();
  if (!message) {
    await interaction.reply({ content: 'Reply cannot be empty.', ephemeral: true });
    return;
  }
  if (parsed.action === 'always') {
    alwaysSupervisorReplies.set(supervisorAlwaysKey(request), message);
  }
  await replyToSupervisorRequest(request.id, message);
  await interaction.reply({
    content: `Supervisor reply sent${parsed.action === 'always' ? ' and saved for this run.' : '.'}`,
    ephemeral: true,
  });
}

async function replyToSupervisorRequest(requestId: string, message: string): Promise<void> {
  const request = pendingSupervisorRequests.get(requestId);
  if (!request) throw new Error('Supervisor request is no longer pending');
  await writeSupervisorReply(request, message);
  pendingSupervisorRequests.delete(requestId);
}

function supervisorAlwaysKey(request: SupervisorRequest): string {
  return `${request.runId}:${request.agent}:${request.reason}`;
}

function supervisorButtonId(action: string, requestId: string): string {
  return `${SUPERVISOR_BUTTON_PREFIX}${action}:${requestId}`;
}

function parseSupervisorCustomId(
  customId: string,
  prefix: string,
): { action: string; requestId: string } | undefined {
  if (!customId.startsWith(prefix)) return undefined;
  const rest = customId.slice(prefix.length);
  const separator = rest.indexOf(':');
  if (separator === -1) return undefined;
  return { action: rest.slice(0, separator), requestId: rest.slice(separator + 1) };
}

function truncateForDiscordBlock(text: string, max: number): string {
  const truncated = text.length > max ? `${text.slice(0, max - 20)}\n…[truncated]` : text;
  return `>>> ${truncated.replace(/\n/g, '\n> ')}`;
}

// ── Outbound ──

const DISCORD_MAX_LENGTH = 2000;

export async function sendResponse(
  jid: string,
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!client) return false;

  const channelId = jid.replace(/^dc:/, '');

  try {
    const channel = await abortableDiscordRequest(client.channels.fetch(channelId), signal);
    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Channel not found or not text-based');
      return false;
    }

    const textChannel = channel as TextChannel;

    if (text.length <= DISCORD_MAX_LENGTH) {
      await abortableDiscordRequest(
        Promise.resolve().then(() => textChannel.send(discordTextPayload(text))),
        signal,
      );
    } else {
      // Split at line boundaries when possible
      const chunks = splitMessage(text, DISCORD_MAX_LENGTH);
      for (const chunk of chunks) {
        await abortableDiscordRequest(
          Promise.resolve().then(() => textChannel.send(discordTextPayload(chunk))),
          signal,
        );
      }
    }
    logger.info({ jid, length: text.length }, 'Response sent');
    return true;
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      logger.error({ jid, err: err.message }, 'Failed to send message');
    }
    return false;
  }
}

export function discordTextPayload(content: string): {
  content: string;
  allowedMentions: { parse: [] };
} {
  return { content, allowedMentions: { parse: [] } };
}

export async function setTyping(jid: string, signal?: AbortSignal): Promise<void> {
  if (!client) return;
  try {
    const channelId = jid.replace(/^dc:/, '');
    const channel = await abortableDiscordRequest(client.channels.fetch(channelId), signal);
    if (channel && 'sendTyping' in channel) {
      await abortableDiscordRequest((channel as TextChannel).sendTyping(), signal);
    }
  } catch {
    // best-effort
  }
}

function abortableDiscordRequest<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function abortError(): Error {
  const error = new Error('Discord request aborted');
  error.name = 'AbortError';
  return error;
}

export function stopDiscord(): void {
  if (client) {
    client.destroy();
    client = null;
    logger.info('Discord bot stopped');
  }
}

export function getBotTag(): string | undefined {
  return client?.user?.tag;
}

// ── Helpers ──

function splitMessage(text: string, max: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt <= 0) splitAt = max; // hard split if no newline
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
