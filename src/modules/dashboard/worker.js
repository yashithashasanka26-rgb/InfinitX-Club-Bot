const { EmbedBuilder } = require('discord.js');
const { DashboardAction, GuildConfig, ScheduledMessage } = require('../../database/models');
const { createTicketPanel } = require('../tickets/interactions');
const { createVerificationPanel } = require('../verification/service');
const { musicService } = require('../music/service');
const { isModuleEnabled } = require('../../utils/moduleSettings');
const logger = require('../../utils/logger');

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_BATCH = 10;
const STALE_SCHEDULE_MS = 10 * 60_000;

function buildEmbed(payload) {
  const embed = new EmbedBuilder().setColor(Number.parseInt(payload.color.replace('#', ''), 16));
  if (payload.title) embed.setTitle(payload.title);
  if (payload.description) embed.setDescription(payload.description);
  if (payload.footer) embed.setFooter({ text: payload.footer });
  if (payload.imageUrl) embed.setImage(payload.imageUrl);
  return embed;
}

async function fetchTextChannel(guild, channelId) {
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isTextBased() || typeof channel.send !== 'function') {
    throw new Error('Selected channel is unavailable or cannot receive messages.');
  }
  return channel;
}

function buildVerificationPanelFromConfig(config) {
  return createVerificationPanel(config || {});
}

async function executeMusicAction(client, action) {
  const { guildId, actorId, payload } = action;
  const guild = await client.guilds.fetch(guildId);
  if (payload.operation === 'status') return musicService.getDashboardState(guildId);
  const member = await guild.members.fetch(actorId);
  const interaction = { guildId, guild, member, user: member.user };
  if (payload.operation === 'play') {
    if (!member.voice.channel) throw new Error('Join a voice channel before starting music from the dashboard.');
    const result = await musicService.enqueue(interaction, payload.query);
    return { message: `Queued ${result.track.title}.` };
  }
  if (payload.operation === 'pause') musicService.pause(interaction);
  else if (payload.operation === 'resume') musicService.resume(interaction);
  else if (payload.operation === 'skip') musicService.skip(interaction);
  else if (payload.operation === 'stop') musicService.stop(interaction);
  else if (payload.operation === 'volume') musicService.setVolume(interaction, payload.volume);
  else throw new Error('Unsupported music operation.');
  return { message: `Music ${payload.operation} completed.` };
}

async function processAction(client, action) {
  const guild = await client.guilds.fetch(action.guildId);
  if (action.type === 'music') return executeMusicAction(client, action);
  const channel = await fetchTextChannel(guild, action.payload.channelId);
  if (action.type === 'deploy-ticket-panel') {
    const config = await GuildConfig.findOne({ guildId: action.guildId }).lean();
    if (!isModuleEnabled(config, 'tickets')) throw new Error('Enable the Tickets module before deploying its panel.');
    const message = await channel.send(createTicketPanel(config?.tickets));
    return { messageId: message.id, channelId: channel.id };
  }
  if (action.type === 'deploy-verification-panel') {
    const config = await GuildConfig.findOne({ guildId: action.guildId }).lean();
    if (!isModuleEnabled(config, 'verification') || config?.verification?.enabled !== true || !config.verification.roleId) {
      throw new Error('Configure the Verification module and verified role before deploying its panel.');
    }
    const message = await channel.send(buildVerificationPanelFromConfig(config));
    return { messageId: message.id, channelId: channel.id };
  }
  if (action.type === 'send-embed') {
    const message = await channel.send({
      embeds: [buildEmbed(action.payload)],
      allowedMentions: { parse: [] },
    });
    return { messageId: message.id, channelId: channel.id };
  }
  throw new Error('Unsupported dashboard action.');
}

async function processDueMessages(client) {
  for (let index = 0; index < MAX_POLL_BATCH; index += 1) {
    const message = await ScheduledMessage.findOneAndUpdate(
      { status: 'pending', scheduledAt: { $lte: new Date() } },
      { $set: { status: 'sending' } },
      { new: true, sort: { scheduledAt: 1 } },
    );
    if (!message) return;
    try {
      const guild = await client.guilds.fetch(message.guildId);
      const channel = await fetchTextChannel(guild, message.channelId);
      await channel.send({
        embeds: [buildEmbed(message)],
        allowedMentions: { parse: [] },
      });
      message.status = 'sent';
      message.sentAt = new Date();
      message.lastError = null;
      await message.save();
    } catch (error) {
      message.status = 'failed';
      message.lastError = error.message.slice(0, 500);
      await message.save();
      logger.error('Scheduled dashboard message failed', {
        guildId: message.guildId,
        scheduledMessageId: message.id,
        error: error.message,
      });
    }
  }
}

async function recoverStaleScheduledMessages(now = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_SCHEDULE_MS);
  const result = await ScheduledMessage.updateMany(
    { status: 'sending', updatedAt: { $lt: staleBefore } },
    {
      $set: {
        status: 'pending',
        lastError: 'Delivery was interrupted; the bot will retry.',
      },
    },
  );
  if (result.modifiedCount > 0) {
    logger.warn('Recovered scheduled messages interrupted by a worker restart', {
      count: result.modifiedCount,
    });
  }
  return result.modifiedCount;
}

async function processPendingActions(client) {
  for (let index = 0; index < MAX_POLL_BATCH; index += 1) {
    const action = await DashboardAction.findOneAndUpdate(
      { status: 'pending', expiresAt: { $gt: new Date() } },
      { $set: { status: 'processing' } },
      { new: true, sort: { createdAt: 1 } },
    );
    if (!action) return;
    try {
      const result = await processAction(client, action);
      action.result = result;
      action.status = 'completed';
      await action.save();
    } catch (error) {
      action.status = 'failed';
      action.error = error.message.slice(0, 500);
      await action.save();
      logger.error('Dashboard bot action failed', {
        guildId: action.guildId,
        actionId: action.id,
        type: action.type,
        error: error.message,
      });
    }
  }
}

function startDashboardWorker(client, { intervalMs = POLL_INTERVAL_MS } = {}) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await recoverStaleScheduledMessages();
      await processPendingActions(client);
      await processDueMessages(client);
    } catch (error) {
      logger.error('Dashboard action worker failed', { error: error.message, stack: error.stack });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref?.();
  void run();
  return () => clearInterval(timer);
}

module.exports = {
  buildEmbed,
  buildVerificationPanelFromConfig,
  processAction,
  recoverStaleScheduledMessages,
  startDashboardWorker,
};
