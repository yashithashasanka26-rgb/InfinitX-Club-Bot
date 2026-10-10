const { PermissionFlagsBits } = require('discord.js');
const { GuildConfig, Ticket } = require('../../database/models');
const { canManageTicket } = require('../tickets/interactions');

const MAX_TICKET_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 400;

class TicketAiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TicketAiError';
  }
}

async function getStaffTicketContext(interaction) {
  if (!interaction.guild || !interaction.channel || !interaction.guildId) {
    throw new TicketAiError('Ticket AI tools can only be used inside a server ticket.');
  }
  const ticket = await Ticket.findOne({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
  }).lean();
  if (!ticket) throw new TicketAiError('This channel is not a registered support ticket.');

  const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
  const canManage = canManageTicket(interaction, config)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
  if (!canManage) throw new TicketAiError('Only support staff or members with ticket-management permissions can use ticket AI tools.');

  const page = await interaction.channel.messages.fetch({ limit: MAX_TICKET_MESSAGES });
  const messages = [...page.values()]
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map((message) => {
      const author = String(message.member?.displayName || message.author.username).slice(0, 80);
      const content = String(message.content || '[message has no text]')
        .replace(/<@!?(\d+)>/g, '@member')
        .replace(/<@&(\d+)>/g, '@role')
        .replace(/<#(\d+)>/g, '#channel')
        .slice(0, MAX_MESSAGE_CHARS);
      return `${author}: ${content}`;
    });

  if (!messages.length) throw new TicketAiError('This ticket has no messages to analyze.');
  return {
    ticket,
    context: `Ticket category: ${ticket.category}\nConversation (oldest first):\n${messages.join('\n')}`,
  };
}

module.exports = { getStaffTicketContext, MAX_TICKET_MESSAGES, MAX_MESSAGE_CHARS, TicketAiError };
