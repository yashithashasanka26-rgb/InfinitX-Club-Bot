const { SlashCommandBuilder } = require('discord.js');
const { musicService, runMusicCommand, trackEmbed } = require('../modules/music/commandUtils');

module.exports = {
  module: 'music',
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing track.'),
  async execute(interaction) {
    await runMusicCommand(interaction, () => {
      const current = musicService.nowPlaying(interaction);
      const embed = trackEmbed(current.track)
        .addFields(
          { name: 'Volume', value: `${current.volume}%`, inline: true },
          { name: 'Repeat', value: current.loopMode, inline: true },
        );
      return { embeds: [embed] };
    }, { ephemeral: false });
  },
};
