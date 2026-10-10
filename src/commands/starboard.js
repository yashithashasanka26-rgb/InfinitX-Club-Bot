const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { starboardService } = require('../modules/starboard/service');

const data = new SlashCommandBuilder()
  .setName('starboard')
  .setDescription('Configure the server starboard.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((option) => option.setName('setup').setDescription('Set the starboard channel, reaction threshold, and emoji.')
    .addChannelOption((channel) => channel.setName('channel').setDescription('Channel where starred messages will be posted').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addIntegerOption((input) => input.setName('threshold').setDescription('Minimum number of reactions').setMinValue(1).setMaxValue(100).setRequired(true))
    .addStringOption((input) => input.setName('emoji').setDescription('Unicode or custom emoji (defaults to ⭐)').setMaxLength(64)))
  .addSubcommand((option) => option.setName('disable').setDescription('Disable starboard posting.'));

module.exports = {
  data,
  execute: (interaction) => starboardService.configure(interaction),
};
