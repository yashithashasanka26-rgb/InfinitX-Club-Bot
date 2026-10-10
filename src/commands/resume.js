const { SlashCommandBuilder } = require('discord.js');
const { musicService, runMusicCommand } = require('../modules/music/commandUtils');

module.exports = {
  module: 'music',
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume the paused track.'),
  async execute(interaction) {
    await runMusicCommand(interaction, () => {
      musicService.resume(interaction);
      return { content: 'Playback resumed.' };
    });
  },
};
