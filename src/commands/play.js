const { SlashCommandBuilder } = require('discord.js');
const { musicService, runMusicCommand, trackEmbed } = require('../modules/music/commandUtils');

module.exports = {
  module: 'music',
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube or SoundCloud track, or search YouTube.')
    .addStringOption((option) => option.setName('query').setDescription('Track name or supported track URL').setRequired(true).setMaxLength(200)),
  async execute(interaction) {
    await runMusicCommand(interaction, async () => {
      const result = await musicService.enqueue(interaction, interaction.options.getString('query', true));
      return {
        content: `Added **${result.track.title}** to the queue (position ${result.position}).`,
        embeds: [trackEmbed(result.track, result.position === 1 ? 'Starting' : 'Queued')],
        allowedMentions: { parse: [] },
      };
    }, { deferred: true, ephemeral: false });
  },
};
