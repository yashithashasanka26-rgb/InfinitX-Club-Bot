const { SlashCommandBuilder } = require('discord.js');
const { GuildConfig } = require('../database/models');
const { work } = require('../modules/economy/service');

module.exports = {
  module: 'economy',
  data: new SlashCommandBuilder().setName('work').setDescription('Work for coins.'),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
    const settings = config?.economy || {};
    const result = await work({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      min: settings.workMin || 25,
      max: settings.workMax || 100,
      cooldownHours: settings.workCooldownHours || 1,
    });
    if (!result.account) {
      await interaction.reply({
        content: result.reason === 'cooldown'
          ? `You already worked recently. Try again in ${settings.workCooldownHours || 1} hour(s).`
          : 'Your balance is at its maximum and cannot receive more coins.',
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content: `You earned ${result.amount} coins. Balance: ${result.account.coins}.`,
      ephemeral: true,
    });
  },
};
