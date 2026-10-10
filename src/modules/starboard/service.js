const { ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { GuildConfig, StarboardEntry } = require('../../database/models');
const { isModuleEnabled } = require('../../utils/moduleSettings');

const processing = new Map();
const CUSTOM_EMOJI_PATTERN = /^<a?:([A-Za-z0-9_]{2,32}):(\d{17,20})>$/;

function matchesEmoji(reactionEmoji, configuredEmoji) {
  const configured = String(configuredEmoji || '').trim();
  const custom = CUSTOM_EMOJI_PATTERN.exec(configured);
  if (custom) return reactionEmoji.id === custom[2];
  return !reactionEmoji.id && reactionEmoji.name === configured;
}

function buildStarboardEmbed(message, count, emoji) {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setAuthor({
      name: message.author.tag || message.author.username,
      iconURL: message.author.displayAvatarURL(),
    })
    .setDescription(message.content?.slice(0, 4000) || '*No text content.*')
    .addFields({ name: 'Source', value: `[Jump to message](${message.url})` })
    .setFooter({ text: `${emoji} ${count} | #${message.channel.name}` })
    .setTimestamp(message.createdAt);
  const attachment = message.attachments?.find((item) => item.contentType?.startsWith('image/'));
  if (attachment) embed.setImage(attachment.url);
  return embed;
}

function createStarboardService({ GuildConfigModel = GuildConfig, StarboardEntryModel = StarboardEntry } = {}) {
  async function runSerialized(key, task) {
    const previous = processing.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    processing.set(key, current);
    try {
      return await current;
    } finally {
      if (processing.get(key) === current) processing.delete(key);
    }
  }

  async function updateReaction(reaction) {
    if (reaction.partial) reaction = await reaction.fetch();
    let { message } = reaction;
    if (message.partial) message = await message.fetch();
    if (!message.guild || !message.author || message.author.bot) return false;
    const guildId = message.guild.id;
    return runSerialized(`${guildId}:${message.id}`, async () => {
      const config = await GuildConfigModel.findOne({ guildId }).lean();
      if (!isModuleEnabled(config, 'starboard')) return false;
      const settings = config.starboard || {};
      if (!settings.channelId || !matchesEmoji(reaction.emoji, settings.emoji)) return false;
      if (message.channelId === settings.channelId) return false;
      const count = reaction.count || 0;
      const entry = await StarboardEntryModel.findOne({ guildId, sourceMessageId: message.id });
      if (count < settings.threshold) {
        if (entry) {
          const starboard = await message.guild.channels.fetch(entry.starboardChannelId).catch((error) => {
            if (error.code === 10003) return null;
            throw error;
          });
          const post = await starboard?.messages.fetch(entry.starboardMessageId).catch((error) => {
            if (error.code === 10008) return null;
            throw error;
          });
          if (post) await post.delete();
          await StarboardEntryModel.deleteOne({ _id: entry._id });
        }
        return false;
      }

      const channel = await message.guild.channels.fetch(settings.channelId);
      if (!channel?.isTextBased() || !channel.send) throw new Error('The configured starboard channel is unavailable.');
      const botMember = message.guild.members.me || await message.guild.members.fetchMe();
      if (!botMember.permissionsIn(channel).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw new Error('The bot needs View Channel, Send Messages, and Embed Links permissions in the starboard channel.');
      }
      const embed = buildStarboardEmbed(message, count, settings.emoji);
      if (entry) {
        try {
          const post = await channel.messages.fetch(entry.starboardMessageId);
          await post.edit({ embeds: [embed], allowedMentions: { parse: [] } });
          await StarboardEntryModel.updateOne({ _id: entry._id }, { $set: { count } });
          return true;
        } catch (error) {
          if (error.code !== 10008 && error.code !== 10003) throw error;
          await StarboardEntryModel.deleteOne({ _id: entry._id });
        }
      }
      const post = await channel.send({
        embeds: [embed],
        allowedMentions: { parse: [] },
      });
      try {
        await StarboardEntryModel.create({
          guildId,
          sourceChannelId: message.channelId,
          sourceMessageId: message.id,
          starboardChannelId: channel.id,
          starboardMessageId: post.id,
          count,
        });
      } catch (error) {
        try {
          await post.delete();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Starboard record creation failed and its post could not be removed.');
        }
        if (error.code === 11000) return false;
        throw error;
      }
      return true;
    });
  }

  async function handleDeletedMessage(message) {
    if (!message.guild) return;
    const entry = await StarboardEntryModel.findOne({ guildId: message.guild.id, sourceMessageId: message.id });
    if (!entry) return;
    const channel = await message.guild.channels.fetch(entry.starboardChannelId).catch((error) => {
      if (error.code === 10003) return null;
      throw error;
    });
    if (channel) {
      const post = await channel.messages.fetch(entry.starboardMessageId).catch((error) => {
        if (error.code === 10008) return null;
        throw error;
      });
      if (post) await post.delete();
    }
    await StarboardEntryModel.deleteOne({ _id: entry._id });
  }

  async function configure(interaction) {
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'Configure starboard in a server with Manage Server permission.', ephemeral: true });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'disable') {
      await interaction.deferReply({ ephemeral: true });
      await GuildConfigModel.updateOne(
        { guildId: interaction.guildId },
        { $set: { 'modules.starboard': false, updatedAt: new Date() }, $setOnInsert: { guildId: interaction.guildId } },
        { upsert: true, setDefaultsOnInsert: true },
      );
      await interaction.editReply({ content: 'Starboard has been disabled.' });
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    const threshold = interaction.options.getInteger('threshold', true);
    const emoji = interaction.options.getString('emoji')?.trim() || '⭐';
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || !emoji || emoji.length > 64
      || (!CUSTOM_EMOJI_PATTERN.test(emoji) && [...emoji].length > 8)) {
      await interaction.reply({ content: 'Choose a text channel and a valid Unicode or custom Discord emoji.', ephemeral: true });
      return;
    }
    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
    if (!botMember.permissionsIn(channel).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      await interaction.reply({ content: 'I need View Channel, Send Messages, and Embed Links in that channel.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await GuildConfigModel.updateOne(
      { guildId: interaction.guildId },
      { $set: {
        'modules.starboard': true,
        'starboard.channelId': channel.id,
        'starboard.threshold': threshold,
        'starboard.emoji': emoji,
        updatedAt: new Date(),
      }, $setOnInsert: { guildId: interaction.guildId } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    await interaction.editReply({
      content: `Starboard will post messages in <#${channel.id}> at ${threshold} ${emoji} reactions.`,
      allowedMentions: { parse: [] },
    });
  }

  return { updateReaction, handleDeletedMessage, configure };
}

const starboardService = createStarboardService();

module.exports = { buildStarboardEmbed, createStarboardService, matchesEmoji, starboardService };
