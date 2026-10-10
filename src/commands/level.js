const { SlashCommandBuilder } = require('discord.js');
const { Level } = require('../database/models');
const { levelForXp, xpForLevel } = require('../modules/leveling/service');

module.exports = {
  module: 'leveling',
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription('Show a member’s level and XP progress.')
    .addUserOption((option) => option.setName('member').setDescription('Member to check')),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    const user = interaction.options.getUser('member') || interaction.user;
    const record = await Level.findOne({ guildId: interaction.guildId, userId: user.id }).lean();
    const xp = record?.xp || 0;
    const level = levelForXp(xp);
    const nextLevelXp = xpForLevel(level + 1);
    await interaction.reply({
      content: `${user} is level **${level}** with **${xp} XP**. ${nextLevelXp - xp} XP to level ${level + 1}.`,
      allowedMentions: { users: [user.id] },
    });
  },
};
