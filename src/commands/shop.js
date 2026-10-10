const { SlashCommandBuilder } = require('discord.js');
const { GuildConfig } = require('../database/models');
const { purchaseItem } = require('../modules/economy/service');

module.exports = {
  module: 'economy',
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Browse the server shop or purchase an item.')
    .addSubcommand((option) => option.setName('view').setDescription('List available items.'))
    .addSubcommand((option) => option.setName('buy').setDescription('Purchase an item.')
      .addStringOption((item) => item.setName('item').setDescription('Shop item ID').setRequired(true).setMaxLength(32))
      .addIntegerOption((quantity) => quantity.setName('quantity').setDescription('Quantity to purchase').setMinValue(1).setMaxValue(99))),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
    const items = config?.economy?.items || [];
    if (interaction.options.getSubcommand() === 'view') {
      const body = items.length
        ? items.map((item) => `• **${item.name}** (\`${item.itemId}\`) — ${item.price} coins${item.description ? `: ${item.description}` : ''}`).join('\n')
        : 'This server shop has no items yet.';
      await interaction.reply({ content: `**${interaction.guild.name} shop**\n${body}`, ephemeral: true });
      return;
    }

    const itemId = interaction.options.getString('item', true).toLowerCase();
    const item = items.find((entry) => entry.itemId === itemId);
    if (!item) {
      await interaction.reply({ content: 'That item is not in this server’s shop.', ephemeral: true });
      return;
    }
    const result = await purchaseItem({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      item,
      quantity: interaction.options.getInteger('quantity') || 1,
    });
    if (!result.account) {
      const message = result.reason === 'inventory-limit'
        ? 'Your inventory cannot hold any more item types or stacks.'
        : 'You do not have enough coins for that purchase.';
      await interaction.reply({ content: message, ephemeral: true });
      return;
    }
    await interaction.reply({
      content: `Purchased ${item.name}. Balance: ${result.account.coins} coins.`,
      ephemeral: true,
    });
  },
};
