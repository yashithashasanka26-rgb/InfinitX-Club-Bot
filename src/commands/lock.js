const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  executeModerationCommand,
  logModerationCommand,
  requireModeratorPermission,
} = require('../modules/moderation/commandUtils');

module.exports = {
  module: 'moderation',
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Prevent @everyone from sending messages in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((option) => option.setName('reason').setDescription('Reason for locking this channel').setMaxLength(1000)),
  async execute(interaction) {
    await executeModerationCommand(interaction, async () => {
      await requireModeratorPermission(interaction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
      const channel = interaction.channel;
      if (!channel?.permissionOverwrites) throw new TypeError('This channel does not support permission overwrites.');
      const bot = await interaction.guild.members.fetchMe();
      if (!bot.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels)) throw new Error('I need Manage Channels permission in this channel.');
      const reason = interaction.options.getString('reason')?.trim() || 'No reason provided';
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false }, {
        reason: `${interaction.user.tag}: ${reason}`.slice(0, 512),
      });
      const audit = await logModerationCommand(interaction, 'lock', {
        reason,
        details: { channelId: channel.id },
      });
      return { message: `Locked <#${channel.id}> for @everyone.`, ...audit };
    });
  },
};
