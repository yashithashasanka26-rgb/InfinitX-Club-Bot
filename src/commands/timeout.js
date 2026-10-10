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
    .setName('timeout')
    .setDescription('Timeout a member for a specified number of minutes.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) => option.setName('member').setDescription('Member to timeout').setRequired(true))
    .addIntegerOption((option) => option.setName('minutes').setDescription('Timeout duration (1–40320 minutes)').setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for the timeout').setMaxLength(1000)),
  async execute(interaction) {
    await executeModerationCommand(interaction, async () => {
      await requireModeratorPermission(interaction, PermissionFlagsBits.ModerateMembers, 'Moderate Members');
      const user = interaction.options.getUser('member', true);
      const target = await assertTargetIsModeratable(interaction, user);
      const minutes = interaction.options.getInteger('minutes', true);
      const reason = interaction.options.getString('reason')?.trim() || 'No reason provided';
      const bot = await interaction.guild.members.fetchMe();
      if (!bot.permissions.has(PermissionFlagsBits.ModerateMembers)) throw new Error('I need the Moderate Members permission.');
      await target.timeout(minutes * 60_000, `${interaction.user.tag}: ${reason}`.slice(0, 512));
      const audit = await logModerationCommand(interaction, 'timeout', {
        targetId: user.id,
        reason,
        details: { minutes },
      });
      return { message: `Timed out ${user.tag} for ${minutes} minute(s).`, ...audit };
    });
  },
};
