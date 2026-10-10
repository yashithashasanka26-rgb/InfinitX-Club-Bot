const { SlashCommandBuilder } = require('discord.js');
const { musicService, runMusicCommand } = require('../modules/music/commandUtils');

module.exports = {
  module: 'music',
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set repeat mode.')
    .addStringOption((option) => option.setName('mode').setDescription('Repeat mode').setRequired(true).addChoices(
      { name: 'Off', value: 'off' },
      { name: 'Current track', value: 'track' },
      { name: 'Queue', value: 'queue' },
    )),
  async execute(interaction) {
    await runMusicCommand(interaction, () => {
      const mode = musicService.setLoop(interaction, interaction.options.getString('mode', true));
      return { content: `Repeat mode set to ${mode}.` };
    });
  },
};
