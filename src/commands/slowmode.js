const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  executeModerationCommand,
  logModerationCommand,
  requireModeratorPermission,
} = require('../modules/moderation/commandUtils');

module.exports = {
  module: 'moderation',
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Set this channel’s slowmode (0 disables it, maximum 6 hours).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((option) => option.setName('seconds').setDescription('Slowmode delay in seconds (0–21600)').setRequired(true).setMinValue(0).setMaxValue(21600))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for changing slowmode').setMaxLength(1000)),
  async execute(interaction) {
    await executeModerationCommand(interaction, async () => {
      await requireModeratorPermission(interaction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
      const channel = interaction.channel;
      if (!channel?.setRateLimitPerUser) throw new TypeError('This channel does not support slowmode.');
      const bot = await interaction.guild.members.fetchMe();
      if (!bot.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels)) throw new Error('I need Manage Channels permission in this channel.');
      const seconds = interaction.options.getInteger('seconds', true);
      const reason = interaction.options.getString('reason')?.trim() || 'No reason provided';
      await channel.setRateLimitPerUser(seconds, `${interaction.user.tag}: ${reason}`.slice(0, 512));
      const audit = await logModerationCommand(interaction, 'slowmode', {
        reason,
        details: { channelId: channel.id, seconds },
      });
      return { message: seconds ? `Slowmode set to ${seconds} second(s).` : 'Slowmode disabled.', ...audit };
    });
  },
};
