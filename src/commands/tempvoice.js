const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { tempVoiceService } = require('../modules/temporaryVoice/service');

const data = new SlashCommandBuilder()
  .setName('tempvoice')
  .setDescription('Configure private join-to-create voice rooms.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((option) => option.setName('setup').setDescription('Choose the Join to Create channel.')
    .addChannelOption((channel) => channel.setName('join-channel').setDescription('Voice channel members join to create a room').setRequired(true)
      .addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption((channel) => channel.setName('category').setDescription('Category for created voice and controls channels')
      .addChannelTypes(ChannelType.GuildCategory)));

module.exports = {
  data,
  execute: (interaction) => tempVoiceService.setup(interaction),
};
