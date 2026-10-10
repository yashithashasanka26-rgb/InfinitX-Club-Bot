const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { musicService, runMusicCommand } = require('../modules/music/commandUtils');
const { formatDuration } = require('../modules/music/service');

module.exports = {
  module: 'music',
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current track and upcoming queue.'),
  async execute(interaction) {
    await runMusicCommand(interaction, () => {
      const queue = musicService.getQueue(interaction);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Music queue')
        .addFields({ name: 'Playback', value: `${queue.volume}% volume · repeat ${queue.loopMode}`, inline: false });
      if (queue.current) embed.addFields({
        name: 'Now playing',
        value: `[${queue.current.title}](${queue.current.url}) · ${formatDuration(queue.current.duration)}`.slice(0, 1024),
      });
      if (queue.upcoming.length) {
        embed.addFields({
          name: `Up next (${queue.upcoming.length})`,
          value: queue.upcoming.slice(0, 10)
            .map((track, index) => `${index + 1}. [${track.title}](${track.url}) · ${formatDuration(track.duration)}`)
            .join('\n').slice(0, 1024),
        });
      } else if (!queue.current) {
        embed.setDescription('The queue is empty.');
      } else {
        embed.addFields({ name: 'Up next', value: 'No upcoming tracks.' });
      }
      if (queue.upcoming.length > 10) embed.setFooter({ text: `Showing 10 of ${queue.upcoming.length} upcoming tracks.` });
      if (queue.current && queue.current.thumbnail && /^https:\/\/\S+$/i.test(queue.current.thumbnail)) {
        embed.setThumbnail(queue.current.thumbnail);
      }
      return { embeds: [embed] };
    });
  },
};
