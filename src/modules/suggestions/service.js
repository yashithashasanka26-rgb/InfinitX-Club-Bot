const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { GuildConfig, Suggestion, SuggestionLog } = require('../../database/models');
const { isModuleEnabled } = require('../../utils/moduleSettings');
const logger = require('../../utils/logger');

const SUGGESTION_ID_PATTERN = /^[a-f\d]{24}$/i;

async function deferEphemeral(interaction) {
  if (!interaction.replied && !interaction.deferred) await interaction.deferReply({ ephemeral: true });
}

async function respond(interaction, content) {
  if (interaction.deferred && !interaction.replied) return interaction.editReply({ content });
  return interaction.reply({ content, ephemeral: true });
}

function suggestionEmbed(suggestion) {
  const embed = new EmbedBuilder()
    .setColor(suggestion.status === 'approved' ? 0x2ecc71 : suggestion.status === 'rejected' ? 0xe74c3c : 0x5865f2)
    .setTitle(`Suggestion • ${suggestion.status.toUpperCase()}`)
    .setDescription(suggestion.text.slice(0, 4000))
    .addFields(
      { name: '👍 Upvotes', value: String(suggestion.upvotes.length), inline: true },
      { name: '👎 Downvotes', value: String(suggestion.downvotes.length), inline: true },
    )
    .setFooter({ text: `Suggestion ID: ${suggestion.id} • Submitted by ${suggestion.authorId}` })
    .setTimestamp(suggestion.createdAt);
  if (suggestion.decisionReason) embed.addFields({ name: 'Decision note', value: suggestion.decisionReason.slice(0, 1000) });
  return embed;
}

function suggestionButtons(suggestion, disabled = suggestion.status !== 'pending') {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`suggestion:vote:up:${suggestion.id}`)
      .setLabel(`Upvote (${suggestion.upvotes.length})`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`suggestion:vote:down:${suggestion.id}`)
      .setLabel(`Downvote (${suggestion.downvotes.length})`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  )];
}

async function writeLog(LogModel, entry) {
  try {
    await LogModel.create(entry);
  } catch (error) {
    logger.error('Suggestion action was saved but its log could not be persisted', {
      guildId: entry.guildId,
      suggestionId: String(entry.suggestionId),
      action: entry.action,
      error: error.message,
    });
  }
}

function createSuggestionsService({
  GuildConfigModel = GuildConfig,
  SuggestionModel = Suggestion,
  SuggestionLogModel = SuggestionLog,
} = {}) {
  async function isEnabled(guildId) {
    const config = await GuildConfigModel.findOne({ guildId }).lean();
    return isModuleEnabled(config, 'suggestions');
  }

  async function setup(interaction) {
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'Configure suggestions in a server with Manage Server permission.', ephemeral: true });
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    const logChannel = interaction.options.getChannel('log-channel');
    const validText = (candidate) => candidate?.type === ChannelType.GuildText || candidate?.type === ChannelType.GuildAnnouncement;
    if (!validText(channel) || (logChannel && !validText(logChannel))) {
      await interaction.reply({ content: 'Choose regular text or announcement channels.', ephemeral: true });
      return;
    }
    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
    for (const target of [channel, logChannel].filter(Boolean)) {
      if (!botMember.permissionsIn(target).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        await interaction.reply({ content: `I need View Channel, Send Messages, and Embed Links in <#${target.id}>.`, ephemeral: true });
        return;
      }
    }
    await deferEphemeral(interaction);
    await GuildConfigModel.updateOne(
      { guildId: interaction.guildId },
      { $set: {
        'modules.suggestions': true,
        'suggestions.channelId': channel.id,
        'suggestions.logChannelId': logChannel?.id || null,
        updatedAt: new Date(),
      }, $setOnInsert: { guildId: interaction.guildId } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    await interaction.editReply({
      content: `Suggestions are enabled in <#${channel.id}>${logChannel ? ` with logs in <#${logChannel.id}>` : ''}.`,
    });
  }

  async function submit(interaction, text) {
    if (!interaction.guild) {
      await respond(interaction, 'Suggestions can only be submitted in a server.');
      return false;
    }
    await deferEphemeral(interaction);
    if (!await isEnabled(interaction.guildId)) {
      await interaction.editReply({ content: 'Suggestions are not enabled in this server.' });
      return false;
    }
    const config = await GuildConfigModel.findOne({ guildId: interaction.guildId }).lean();
    const channel = await interaction.guild.channels.fetch(config?.suggestions?.channelId);
    if (!channel?.isTextBased() || !channel.send) throw new Error('The configured suggestions channel is unavailable.');
    const suggestion = await SuggestionModel.create({
      guildId: interaction.guildId,
      channelId: channel.id,
      authorId: interaction.user.id,
      text: text.trim(),
    });
    let message;
    try {
      message = await channel.send({
        embeds: [suggestionEmbed(suggestion)],
        components: suggestionButtons(suggestion),
        allowedMentions: { parse: [] },
      });
      suggestion.messageId = message.id;
      await suggestion.save();
    } catch (error) {
      const cleanupErrors = [];
      if (message) {
        try {
          await message.delete();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await SuggestionModel.deleteOne({ _id: suggestion._id });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], 'Suggestion submission failed and cleanup was incomplete.');
      }
      throw error;
    }
    await writeLog(SuggestionLogModel, {
      guildId: interaction.guildId,
      suggestionId: suggestion._id,
      actorId: interaction.user.id,
      action: 'submitted',
      details: { messageId: message.id, channelId: channel.id },
    });
    if (config.suggestions.logChannelId) {
      const logChannel = await interaction.guild.channels.fetch(config.suggestions.logChannelId).catch((error) => {
        if (error.code === 10003) return null;
        throw error;
      });
      if (logChannel?.send) {
        try {
          await logChannel.send({
            content: `New suggestion **${suggestion.id}** from <@${interaction.user.id}> in <#${channel.id}>.`,
            allowedMentions: { users: [interaction.user.id] },
          });
        } catch (error) {
          logger.error('Suggestion was submitted but its Discord log notice failed', {
            guildId: interaction.guildId,
            suggestionId: suggestion.id,
            error: error.message,
          });
        }
      }
    }
    await interaction.editReply({
      content: `Your suggestion was submitted: [view suggestion](https://discord.com/channels/${interaction.guildId}/${channel.id}/${message.id})`,
      allowedMentions: { parse: [] },
    });
    return true;
  }

  async function vote(interaction, suggestionId, direction) {
    if (!interaction.guildId) {
      await respond(interaction, 'Suggestions can only be voted on in a server.');
      return false;
    }
    await deferEphemeral(interaction);
    if (!SUGGESTION_ID_PATTERN.test(suggestionId) || !['up', 'down'].includes(direction)) {
      await interaction.editReply({ content: 'This suggestion vote is invalid.' });
      return false;
    }
    if (!await isEnabled(interaction.guildId)) {
      await interaction.editReply({ content: 'Suggestions are disabled in this server.' });
      return false;
    }
    const suggestion = await SuggestionModel.findOne({
      _id: suggestionId,
      guildId: interaction.guildId,
      messageId: interaction.message.id,
      status: 'pending',
    });
    if (!suggestion) {
      await interaction.editReply({ content: 'This suggestion is no longer open for voting.' });
      return false;
    }
    const voterId = interaction.user.id;
    const upIndex = suggestion.upvotes.indexOf(voterId);
    const downIndex = suggestion.downvotes.indexOf(voterId);
    const sameDirection = direction === 'up' ? upIndex >= 0 : downIndex >= 0;
    if (upIndex >= 0) suggestion.upvotes.splice(upIndex, 1);
    if (downIndex >= 0) suggestion.downvotes.splice(downIndex, 1);
    if (!sameDirection) (direction === 'up' ? suggestion.upvotes : suggestion.downvotes).push(voterId);
    try {
      await suggestion.save();
    } catch (error) {
      if (error.name === 'VersionError') {
        await interaction.editReply({ content: 'Votes changed at the same time. Please vote again.' });
        return false;
      }
      throw error;
    }
    const logAction = sameDirection ? 'vote-removed' : `${direction}vote`;
    await writeLog(SuggestionLogModel, {
      guildId: interaction.guildId,
      suggestionId: suggestion._id,
      actorId: voterId,
      action: direction === 'up' ? 'upvote' : 'downvote',
      details: { removed: sameDirection, resultingAction: logAction },
    });
    let refreshed = true;
    try {
      await interaction.message.edit({
        embeds: [suggestionEmbed(suggestion)],
        components: suggestionButtons(suggestion),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      refreshed = false;
      logger.error('Suggestion vote was recorded but its post could not be refreshed', {
        guildId: interaction.guildId,
        suggestionId,
        error: error.message,
      });
    }
    await interaction.editReply({
      content: `${sameDirection ? 'Your vote was removed.' : `Your ${direction}vote was recorded.`}${refreshed ? '' : ' The post could not be refreshed; the vote is saved.'}`,
    });
    return true;
  }

  async function decide(interaction, messageId, status, reason = '') {
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({ content: 'You need Manage Messages permission to decide suggestions.', ephemeral: true });
      return false;
    }
    await deferEphemeral(interaction);
    if (!await isEnabled(interaction.guildId)) {
      await interaction.editReply({ content: 'Suggestions are disabled in this server.' });
      return false;
    }
    if (!/^\d{17,20}$/.test(messageId)) {
      await interaction.editReply({ content: 'Provide a valid suggestion message ID.' });
      return false;
    }
    const suggestion = await SuggestionModel.findOneAndUpdate(
      { guildId: interaction.guildId, messageId, status: 'pending' },
      { $set: {
        status,
        decidedBy: interaction.user.id,
        decisionReason: reason.trim() || null,
        decidedAt: new Date(),
      } },
      { new: true },
    );
    if (!suggestion) {
      await interaction.editReply({ content: 'No pending suggestion was found for that message ID.' });
      return false;
    }
    await writeLog(SuggestionLogModel, {
      guildId: interaction.guildId,
      suggestionId: suggestion._id,
      actorId: interaction.user.id,
      action: status,
      details: { messageId, reason: suggestion.decisionReason },
    });
    try {
      const channel = await interaction.guild.channels.fetch(suggestion.channelId);
      const message = await channel.messages.fetch(messageId);
      await message.edit({
        embeds: [suggestionEmbed(suggestion)],
        components: suggestionButtons(suggestion, true),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      logger.error('Suggestion decision was saved but its post could not be updated', {
        guildId: interaction.guildId,
        suggestionId: suggestion.id,
        error: error.message,
      });
    }
    const config = await GuildConfigModel.findOne({ guildId: interaction.guildId }).lean();
    if (config?.suggestions?.logChannelId) {
      const logChannel = await interaction.guild.channels.fetch(config.suggestions.logChannelId).catch((error) => {
        if (error.code === 10003) return null;
        throw error;
      });
      if (logChannel?.send) {
        try {
          await logChannel.send({
            content: `Suggestion **${suggestion.id}** was **${status}** by <@${interaction.user.id}>.${suggestion.decisionReason ? ` Note: ${suggestion.decisionReason}` : ''}`,
            allowedMentions: { users: [interaction.user.id] },
          });
        } catch (error) {
          logger.error('Suggestion decision was saved but its Discord log notice failed', {
            guildId: interaction.guildId,
            suggestionId: suggestion.id,
            error: error.message,
          });
        }
      }
    }
    await interaction.editReply({ content: `Suggestion ${status}.` });
    return true;
  }

  return { setup, submit, vote, decide };
}

const suggestionsService = createSuggestionsService();

const submitModal = new ModalBuilder()
  .setCustomId('suggestion:submit')
  .setTitle('Submit a suggestion')
  .addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('text')
      .setLabel('What would you like to suggest?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMinLength(5)
      .setMaxLength(4000),
  ));

const data = new SlashCommandBuilder()
  .setName('suggestion')
  .setDescription('Submit and manage server suggestions.')
  .addSubcommand((option) => option.setName('setup').setDescription('Configure the suggestion and optional log channels.')
    .addChannelOption((channel) => channel.setName('channel').setDescription('Channel where suggestions are posted').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addChannelOption((channel) => channel.setName('log-channel').setDescription('Optional suggestion decision log channel')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand((option) => option.setName('submit').setDescription('Submit a suggestion for community voting.'))
  .addSubcommand((option) => option.setName('approve').setDescription('Approve a pending suggestion.')
    .addStringOption((input) => input.setName('message-id').setDescription('Suggestion post message ID').setRequired(true).setMaxLength(20))
    .addStringOption((input) => input.setName('reason').setDescription('Optional decision note').setMaxLength(500)))
  .addSubcommand((option) => option.setName('reject').setDescription('Reject a pending suggestion.')
    .addStringOption((input) => input.setName('message-id').setDescription('Suggestion post message ID').setRequired(true).setMaxLength(20))
    .addStringOption((input) => input.setName('reason').setDescription('Optional decision note').setMaxLength(500)));

async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'setup') return suggestionsService.setup(interaction);
  if (subcommand === 'submit') {
    if (!interaction.guildId || !await suggestionsServiceEnabled(interaction.guildId)) {
      await interaction.reply({ content: 'Suggestions are not enabled in this server.', ephemeral: true });
      return;
    }
    await interaction.showModal(submitModal);
    return;
  }
  return suggestionsService.decide(
    interaction,
    interaction.options.getString('message-id', true),
    subcommand === 'approve' ? 'approved' : 'rejected',
    interaction.options.getString('reason') || '',
  );
}

async function suggestionsServiceEnabled(guildId) {
  const config = await GuildConfig.findOne({ guildId }).lean();
  return isModuleEnabled(config, 'suggestions');
}

module.exports = {
  data,
  execute,
  submitModal,
  suggestionsService,
  createSuggestionsService,
  suggestionButtons,
  suggestionEmbed,
  SUGGESTION_ID_PATTERN,
};
