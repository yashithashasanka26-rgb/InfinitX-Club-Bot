const { SlashCommandBuilder } = require('discord.js');
const { Economy, Level } = require('../database/models');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show this server’s top members.')
    .addStringOption((option) => option.setName('type').setDescription('Leaderboard type').addChoices(
      { name: 'Coins', value: 'coins' },
      { name: 'XP', value: 'xp' },
      { name: 'Levels', value: 'levels' },
    )),
  async execute(interaction) {
      if (!interaction.guildId) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return;
      }
      const type = interaction.options.getString('type') || 'xp';
    const isEconomy = type === 'coins';
    const Model = isEconomy ? Economy : Level;
    const sort = type === 'levels' ? { level: -1, xp: -1 } : { [type === 'coins' ? 'coins' : 'xp']: -1 };
    const rows = await Model.find({ guildId: interaction.guildId }).sort(sort).limit(10).lean();
    const body = rows.length
      ? rows.map((row, index) => `${index + 1}. <@${row.userId}> — ${isEconomy ? `${row.coins} coins` : `Level ${row.level} (${row.xp} XP)`}`).join('\n')
      : 'No leaderboard data yet.';
    await interaction.reply({ content: `**${isEconomy ? 'COINS' : type === 'levels' ? 'LEVELS' : 'XP'} leaderboard**\n${body}`, allowedMentions: { parse: [] } });
  },
};
