const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  assertTargetIsModeratable,
  executeModerationCommand,
  requireModeratorPermission,
  logModerationCommand,
} = require('../modules/moderation/commandUtils');

module.exports = {
  module: 'moderation',
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((option) => option.setName('member').setDescription('Member or user to ban').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for the ban').setMaxLength(1000))
    .addIntegerOption((option) => option.setName('delete-days').setDescription('Delete recent messages (0–7 days)').setMinValue(0).setMaxValue(7)),
  async execute(interaction) {
    await executeModerationCommand(interaction, async () => {
      await requireModeratorPermission(interaction, PermissionFlagsBits.BanMembers, 'Ban Members');
      const user = interaction.options.getUser('member', true);
      const reason = interaction.options.getString('reason')?.trim() || 'No reason provided';
      const deleteDays = interaction.options.getInteger('delete-days') || 0;
      const bot = await interaction.guild.members.fetchMe();
      if (!bot.permissions.has(PermissionFlagsBits.BanMembers)) throw new Error('I need the Ban Members permission.');
      await assertTargetIsModeratable(interaction, user, { allowNonMember: true });
      await interaction.guild.members.ban(user.id, {
        reason: `${interaction.user.tag}: ${reason}`.slice(0, 512),
        deleteMessageSeconds: deleteDays * 86400,
      });
      const audit = await logModerationCommand(interaction, 'ban', {
        targetId: user.id,
        reason,
        details: { deleteDays },
      });
      return { message: `Banned ${user.tag}.`, ...audit };
    });
  },
};
