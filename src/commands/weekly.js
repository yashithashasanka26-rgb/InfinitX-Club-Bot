const { SlashCommandBuilder } = require('discord.js');
const { GuildConfig } = require('../database/models');
const { claimWeekly } = require('../modules/economy/service');

module.exports = {
  module: 'economy',
  data: new SlashCommandBuilder().setName('weekly').setDescription('Claim your weekly coins.'),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
    const amount = config?.economy?.weeklyReward || 500;
    const result = await claimWeekly(interaction.guildId, interaction.user.id, amount);
    if (!result.account) {
      await interaction.reply({
        content: result.reason === 'cooldown'
          ? 'You have already claimed your weekly coins. Try again in 7 days.'
          : 'Your balance is at its maximum and cannot receive more coins.',
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({ content: `You claimed ${amount} coins. Balance: ${result.account.coins}.`, ephemeral: true });
  },
};
