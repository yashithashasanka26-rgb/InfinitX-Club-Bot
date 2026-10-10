const { SlashCommandBuilder } = require('discord.js');
const { musicService, runMusicCommand } = require('../modules/music/commandUtils');

module.exports = {
  module: 'music',
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track.'),
  async execute(interaction) {
    await runMusicCommand(interaction, () => {
      musicService.skip(interaction);
      return { content: 'Skipped the current track.' };
    });
  },
};
