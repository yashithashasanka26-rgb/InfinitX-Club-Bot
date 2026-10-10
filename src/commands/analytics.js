const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { analyticsService } = require('../modules/analytics/service');

const data = new SlashCommandBuilder()
  .setName('analytics')
  .setDescription('View member growth, message counts, and voice activity.')
  .addStringOption((option) => option.setName('period').setDescription('Time period to summarize')
    .addChoices(
      { name: 'Daily (UTC)', value: 'daily' },
      { name: 'Weekly (UTC)', value: 'weekly' },
      { name: 'Monthly (last 30 days, UTC)', value: 'monthly' },
    ));

function formatVoiceTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function execute(interaction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'Server analytics are only available in a server.', ephemeral: true });
    return;
  }
  const period = interaction.options.getString('period') || 'daily';
  const summary = await analyticsService.getSummary(interaction.guildId, period);
  const title = period === 'monthly' ? 'Monthly analytics (last 30 days)' : `${period[0].toUpperCase()}${period.slice(1)} analytics`;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .addFields(
      { name: 'Members joined', value: String(summary.joins), inline: true },
      { name: 'Members left', value: String(summary.leaves), inline: true },
      { name: 'Net growth', value: `${summary.netGrowth >= 0 ? '+' : ''}${summary.netGrowth}`, inline: true },
      { name: 'Messages', value: String(summary.messages), inline: true },
      { name: 'Voice time', value: formatVoiceTime(summary.voiceSeconds), inline: true },
      { name: 'Voice sessions', value: String(summary.voiceSessions), inline: true },
    )
    .setFooter({ text: 'Activity is aggregated by UTC calendar day.' });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { module: 'analytics', data, execute, formatVoiceTime };
