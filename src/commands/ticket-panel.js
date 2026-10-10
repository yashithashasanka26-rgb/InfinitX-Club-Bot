const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { GuildConfig } = require('../database/models');
const { createTicketPanel } = require('../modules/tickets/interactions');
const { isModuleEnabled } = require('../utils/moduleSettings');

module.exports = {
  module: 'tickets',
  data: new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Post a support-ticket panel in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'You need Manage Server permission to post a ticket panel.', ephemeral: true });
      return;
    }
    const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
    if (!isModuleEnabled(config, 'tickets')) {
      await interaction.reply({ content: 'Enable the tickets module in the dashboard before posting a panel.', ephemeral: true });
      return;
    }
    await interaction.reply(createTicketPanel(config.tickets));
  },
};
