const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  executeModerationCommand,
  logModerationCommand,
  requireModeratorPermission,
} = require('../modules/moderation/commandUtils');

module.exports = {
  module: 'moderation',
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete 1–100 recent messages from this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) => option.setName('amount').setDescription('Number of recent messages to delete').setRequired(true).setMinValue(1).setMaxValue(100))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for deleting the messages').setMaxLength(1000)),
  async execute(interaction) {
    await executeModerationCommand(interaction, async () => {
      await requireModeratorPermission(interaction, PermissionFlagsBits.ManageMessages, 'Manage Messages');
      if (!interaction.channel?.bulkDelete) throw new TypeError('This command requires a text channel that supports bulk deletion.');
      const bot = await interaction.guild.members.fetchMe();
      if (!bot.permissionsIn(interaction.channel).has(PermissionFlagsBits.ManageMessages)) {
        throw new Error('I need Manage Messages permission in this channel.');
      }
      const amount = interaction.options.getInteger('amount', true);
      const reason = interaction.options.getString('reason')?.trim() || 'No reason provided';
      const deleted = await interaction.channel.bulkDelete(amount, true);
      const audit = await logModerationCommand(interaction, 'purge', {
        reason,
        details: { channelId: interaction.channelId, requested: amount, deleted: deleted.size },
      });
      return { message: `Deleted ${deleted.size} message(s).`, ...audit };
    });
  },
};
