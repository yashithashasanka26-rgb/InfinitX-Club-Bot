const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  assertTargetIsModeratable,
  executeModerationCommand,
  logModerationCommand,
  requireModeratorPermission,
} = require('../modules/moderation/commandUtils');

module.exports = {
  module: 'moderation',
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((option) => option.setName('member').setDescription('Member to kick').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for the kick').setMaxLength(1000)),
  async execute(interaction) {
    await executeModerationCommand(interaction, async () => {
      await requireModeratorPermission(interaction, PermissionFlagsBits.KickMembers, 'Kick Members');
      const user = interaction.options.getUser('member', true);
      const reason = interaction.options.getString('reason')?.trim() || 'No reason provided';
      const target = await assertTargetIsModeratable(interaction, user);
      const bot = await interaction.guild.members.fetchMe();
      if (!bot.permissions.has(PermissionFlagsBits.KickMembers)) throw new Error('I need the Kick Members permission.');
      await target.kick(`${interaction.user.tag}: ${reason}`.slice(0, 512));
      const audit = await logModerationCommand(interaction, 'kick', { targetId: user.id, reason });
      return { message: `Kicked ${user.tag}.`, ...audit };
    });
  },
};
