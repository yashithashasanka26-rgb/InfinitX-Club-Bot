const { SlashCommandBuilder } = require('discord.js');
const { claimDaily } = require('../modules/economy/service');
const { GuildConfig } = require('../database/models');

module.exports = {
  module: 'economy',
  data: new SlashCommandBuilder().setName('daily').setDescription('Claim your daily coins.'),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
    const result = await claimDaily(
      interaction.guildId,
      interaction.user.id,
      config?.economy?.dailyReward || 100,
    );
    if (!result.account) {
      await interaction.reply({
        content: result.reason === 'cooldown'
          ? 'You have already claimed your daily coins. Try again in 24 hours.'
          : 'Your balance is at its maximum and cannot receive more coins.',
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({ content: `You claimed ${config?.economy?.dailyReward || 100} coins. Balance: ${result.account.coins}.`, ephemeral: true });
  },
};
