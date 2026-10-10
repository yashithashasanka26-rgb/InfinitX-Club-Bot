const { SlashCommandBuilder } = require('discord.js');
const { musicService, runMusicCommand } = require('../modules/music/commandUtils');

module.exports = {
  module: 'music',
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume (0–200%).')
    .addIntegerOption((option) => option.setName('percent').setDescription('Volume percentage').setRequired(true).setMinValue(0).setMaxValue(200)),
  async execute(interaction) {
    await runMusicCommand(interaction, () => {
      const volume = musicService.setVolume(interaction, interaction.options.getInteger('percent', true));
      return { content: `Playback volume set to ${volume}%.` };
    });
  },
};
