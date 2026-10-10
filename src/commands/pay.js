const { SlashCommandBuilder } = require('discord.js');
const { pay } = require('../modules/economy/service');

module.exports = {
  module: 'economy',
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Transfer coins to another server member.')
    .addUserOption((option) => option.setName('member').setDescription('Recipient').setRequired(true))
    .addIntegerOption((option) => option.setName('amount').setDescription('Number of coins').setMinValue(1).setRequired(true)),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    const recipient = interaction.options.getUser('member', true);
    const amount = interaction.options.getInteger('amount', true);
    if (recipient.bot || recipient.id === interaction.user.id) {
      await interaction.reply({ content: 'Choose another server member who is not a bot.', ephemeral: true });
      return;
    }
    const result = await pay({
      guildId: interaction.guildId,
      senderId: interaction.user.id,
      recipientId: recipient.id,
      amount,
    });
    const errors = {
      'insufficient-funds': 'You do not have enough coins.',
      'balance-limit': 'Your balance is at its maximum and cannot send this amount.',
      'recipient-balance-limit': 'The recipient balance is at its maximum.',
    };
    if (result.reason) {
      await interaction.reply({ content: errors[result.reason] || 'The transfer could not be completed.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: `Transferred ${amount} coins to ${recipient}. Your balance is ${result.sender.coins}.`,
      allowedMentions: { users: [recipient.id] },
    });
  },
};
