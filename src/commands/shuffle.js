const { SlashCommandBuilder } = require('discord.js');
const { musicService, runMusicCommand } = require('../modules/music/commandUtils');

module.exports = {
  module: 'music',
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle upcoming tracks.'),
  async execute(interaction) {
    await runMusicCommand(interaction, () => {
      const count = musicService.shuffle(interaction);
      return { content: `Shuffled ${count} upcoming tracks.` };
    });
  },
};
