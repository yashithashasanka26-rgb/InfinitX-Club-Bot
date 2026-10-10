const { EmbedBuilder } = require('discord.js');
const { MusicError, formatDuration, musicService } = require('./service');

async function runMusicCommand(interaction, operation, { deferred = false, ephemeral = true } = {}) {
  if (deferred) await interaction.deferReply({ ephemeral });
  try {
    const result = await operation();
    if (deferred) await interaction.editReply(result);
    else await interaction.reply({ ...result, ephemeral });
  } catch (error) {
    if (!(error instanceof MusicError)) throw error;
    const reply = { content: error.message, ephemeral };
    if (interaction.deferred && !interaction.replied) await interaction.editReply(reply);
    else if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
}

function trackEmbed(track, title = 'Now playing') {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(track.title.slice(0, 256))
    .setURL(track.url)
    .setDescription(`[Open track](${track.url})`)
    .addFields(
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      { name: 'Requested by', value: `<@${track.requestedById}>`, inline: true },
    );
  if (track.thumbnail && /^https:\/\/\S+$/i.test(track.thumbnail)) embed.setThumbnail(track.thumbnail);
  return embed.setAuthor({ name: title });
}

module.exports = { musicService, runMusicCommand, trackEmbed };
