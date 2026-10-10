const {
  AttachmentBuilder,
  SlashCommandBuilder,
} = require('discord.js');
const { GuildConfig, Ticket } = require('../database/models');
const {
  canManageTicket,
} = require('../modules/tickets/interactions');
const {
  claimTicket,
  closeTicket,
  generateTicketTranscript,
  reopenTicket,
  updateTicketUser,
} = require('../modules/tickets/service');

module.exports = {
  module: 'tickets',
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Manage the support ticket in this channel.')
    .addSubcommand((option) => option.setName('close').setDescription('Close and archive this ticket.'))
    .addSubcommand((option) => option.setName('reopen').setDescription('Reopen a closed ticket.'))
    .addSubcommand((option) => option.setName('claim').setDescription('Claim this ticket for yourself.'))
    .addSubcommand((option) => option.setName('add-user').setDescription('Give a member access to this ticket.')
      .addUserOption((user) => user.setName('member').setDescription('Member to add').setRequired(true)))
    .addSubcommand((option) => option.setName('remove-user').setDescription('Remove a member added to this ticket.')
      .addUserOption((user) => user.setName('member').setDescription('Member to remove').setRequired(true)))
    .addSubcommand((option) => option.setName('transcript').setDescription('Generate and download the ticket transcript.')),

  async execute(interaction) {
    if (!interaction.guild || !interaction.channel) {
      await interaction.reply({ content: 'Ticket commands can only be used in a server channel.', ephemeral: true });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    const ticket = await Ticket.findOne({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    }).lean();
    if (!ticket) {
      await interaction.reply({ content: 'This channel is not a ticket.', ephemeral: true });
      return;
    }

    const managing = canManageTicket(interaction, await GuildConfig.findOne({
      guildId: interaction.guildId,
    }).lean());
    const isOwner = ticket.userId === interaction.user.id;
    if (['close', 'transcript'].includes(subcommand) && !managing && !isOwner) {
      await interaction.reply({ content: 'Only the ticket owner, configured support role, or a channel manager can do this.', ephemeral: true });
      return;
    }
    if (['reopen', 'claim', 'add-user', 'remove-user'].includes(subcommand) && !managing) {
      await interaction.reply({ content: 'You need the configured support role or Manage Channels permission to do this.', ephemeral: true });
      return;
    }

    if (subcommand === 'close') {
      const result = await closeTicket({
        guild: interaction.guild,
        channel: interaction.channel,
        actorId: interaction.user.id,
      });
      if (!result.closed) {
        await interaction.reply({ content: 'This ticket is not open.', ephemeral: true });
        return;
      }
      const notes = [
        result.auditFailed ? 'Audit logging failed.' : '',
        result.statsFailed ? 'Statistics update failed.' : '',
        result.logDeliveryFailed ? 'The log channel did not receive the transcript.' : '',
      ].filter(Boolean);
      await interaction.reply({
        content: `Ticket closed and archived. The channel was kept so staff can reopen it.${notes.length ? ` ${notes.join(' ')}` : ''}`,
        ephemeral: true,
      });
      try {
        await interaction.channel.permissionOverwrites.edit(ticket.userId, {
          SendMessages: false,
        }, { reason: `Ticket closed by ${interaction.user.tag}` });
      } catch (error) {
        await interaction.followUp({
          content: `Ticket is closed, but the owner's send permission could not be changed: ${error.message}`,
          ephemeral: true,
        });
      }
      return;
    }

    if (subcommand === 'reopen') {
      const result = await reopenTicket({
        guild: interaction.guild,
        channel: interaction.channel,
        actorId: interaction.user.id,
      });
      await interaction.reply({
        content: result.reopened ? 'Ticket reopened.' : 'This ticket is not closed.',
        ephemeral: true,
      });
      return;
    }

    if (subcommand === 'claim') {
      const result = await claimTicket({
        guild: interaction.guild,
        channel: interaction.channel,
        actorId: interaction.user.id,
      });
      await interaction.reply({
        content: result.claimed ? `Ticket claimed by ${interaction.user}.` : 'This ticket is not open.',
        allowedMentions: { users: [interaction.user.id] },
      });
      return;
    }

    if (subcommand === 'add-user' || subcommand === 'remove-user') {
      const user = interaction.options.getUser('member', true);
      const result = await updateTicketUser({
        guild: interaction.guild,
        channel: interaction.channel,
        actorId: interaction.user.id,
        user,
        add: subcommand === 'add-user',
      });
      const response = !result.updated
        ? result.reason === 'already-added'
          ? 'That member already has ticket access.'
          : result.reason === 'not-added'
            ? 'That member was not added to this ticket.'
            : 'This ticket is not open.'
        : `${user} ${subcommand === 'add-user' ? 'was added to' : 'was removed from'} the ticket.`;
      await interaction.reply({
        content: response,
        ephemeral: true,
        allowedMentions: { users: [user.id] },
      });
      return;
    }

    if (subcommand === 'transcript') {
      await interaction.deferReply({ ephemeral: true });
      const result = await generateTicketTranscript({
        guild: interaction.guild,
        channel: interaction.channel,
        actorId: interaction.user.id,
      });
      if (!result) {
        await interaction.editReply('This ticket could not be found.');
        return;
      }
      const filename = `ticket-${result.ticket.id}.txt`;
      await interaction.editReply({
        content: `Transcript generated. It is retained until ${result.transcript.expiresAt.toISOString()}.`,
        files: [new AttachmentBuilder(Buffer.from(result.transcript.content, 'utf8'), { name: filename })],
      });
    }
  },
};
