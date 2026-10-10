const { SlashCommandBuilder } = require('discord.js');
const { musicService, runMusicCommand } = require('../modules/music/commandUtils');

module.exports = {
  module: 'music',
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause the current track.'),
  async execute(interaction) {
    await runMusicCommand(interaction, () => {
      musicService.pause(interaction);
      return { content: 'Playback paused.' };
    });
  },
};
