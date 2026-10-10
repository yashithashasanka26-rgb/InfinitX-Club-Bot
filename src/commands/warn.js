const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { Warning } = require('../database/models');
const {
  assertTargetIsModeratable,
  executeModerationCommand,
  logModerationCommand,
  requireModeratorPermission,
} = require('../modules/moderation/commandUtils');

module.exports = {
  module: 'moderation',
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Record a moderation warning for a member.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) => option.setName('member').setDescription('Member to warn').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for the warning').setMaxLength(1000).setRequired(true)),
  async execute(interaction) {
    await executeModerationCommand(interaction, async () => {
      await requireModeratorPermission(interaction, PermissionFlagsBits.ModerateMembers, 'Moderate Members');
      const user = interaction.options.getUser('member', true);
      await assertTargetIsModeratable(interaction, user, { requireBotHierarchy: false });
      const reason = interaction.options.getString('reason', true).trim();
      if (!reason) throw new TypeError('Provide a reason for the warning.');
      await Warning.create({
        guildId: interaction.guildId,
        userId: user.id,
        moderatorId: interaction.user.id,
        reason,
      });
      const audit = await logModerationCommand(interaction, 'warn', { targetId: user.id, reason });
      return { message: `Recorded a warning for ${user.tag}.`, ...audit };
    });
  },
};
