const { SlashCommandBuilder } = require('discord.js');
const { musicService, runMusicCommand } = require('../modules/music/commandUtils');

module.exports = {
  module: 'music',
  data: new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue.'),
  async execute(interaction) {
    await runMusicCommand(interaction, () => {
      musicService.stop(interaction);
      return { content: 'Playback stopped and the queue was cleared.' };
    });
  },
};
