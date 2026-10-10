const { SlashCommandBuilder } = require('discord.js');
const { GuildConfig } = require('../database/models');
const { getInventory } = require('../modules/economy/service');

module.exports = {
  module: 'economy',
  data: new SlashCommandBuilder().setName('inventory').setDescription('View your purchased shop items.'),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    const [inventory, config] = await Promise.all([
      getInventory(interaction.guildId, interaction.user.id),
      GuildConfig.findOne({ guildId: interaction.guildId }).lean(),
    ]);
    const names = new Map((config?.economy?.items || []).map((item) => [item.itemId, item.name]));
    const body = inventory.length
      ? inventory.map((item) => `• ${names.get(item.itemId) || item.itemId} × ${item.quantity}`).join('\n')
      : 'Your inventory is empty.';
    await interaction.reply({ content: `**${interaction.user.username}’s inventory**\n${body}`, ephemeral: true });
  },
};
