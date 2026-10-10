const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js');
const { GuildConfig, Ticket } = require('../../database/models');
const { closeTicket, createTicket } = require('./service');

function memberHasRole(interaction, roleId) {
  if (!roleId) return false;
  const roles = interaction.member?.roles;
  return Array.isArray(roles) ? roles.includes(roleId) : Boolean(roles?.cache?.has(roleId));
}

function canManageTicket(interaction, config) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)
    || memberHasRole(interaction, config?.tickets?.supportRoleId);
}

async function handleTicketButton(interaction) {
  const isTicketButton = interaction.isButton() && interaction.customId.startsWith('tickets:');
  const isTicketSelect = interaction.isStringSelectMenu() && interaction.customId === 'tickets:category';
  if (!isTicketButton && !isTicketSelect) return false;
  if (!interaction.guild) {
    await interaction.reply({ content: 'Tickets can only be used in a server.', ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  if (interaction.customId === 'tickets:open' || isTicketSelect) {
    const result = await createTicket(interaction);
    await interaction.editReply(result.existing
      ? 'You already have an open ticket. Please use it before opening another.'
      : `Your ticket is ready: <#${result.channel.id}>${result.auditFailed ? ' (The ticket was created, but its audit record could not be saved.)' : ''}${result.statsFailed ? ' (Ticket statistics could not be updated.)' : ''}`);
    return true;
  }

  if (interaction.customId !== 'tickets:close') {
    await interaction.editReply('This ticket action is not supported.');
    return true;
  }

  const ticket = await Ticket.findOne({
    guildId: interaction.guild.id,
    channelId: interaction.channelId,
    status: 'open',
  }).lean();
  if (!ticket) {
    await interaction.editReply('This channel is not an open ticket.');
    return true;
  }
  const config = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();
  const isOwner = ticket.userId === interaction.user.id;
  if (!isOwner && !canManageTicket(interaction, config)) {
    await interaction.editReply('Only the ticket owner, configured support role, or a channel manager can close this ticket.');
    return true;
  }

  const result = await closeTicket({
    guild: interaction.guild,
    channel: interaction.channel,
    actorId: interaction.user.id,
  });
  if (!result.closed) {
    await interaction.editReply('This ticket is already closing or closed.');
    return true;
  }
  const notes = [
    result.auditFailed ? 'The audit entry could not be saved.' : '',
    result.statsFailed ? 'Ticket statistics could not be updated.' : '',
    result.logDeliveryFailed ? 'The configured log channel did not receive a copy; the transcript remains available in the dashboard for 30 days.' : '',
  ].filter(Boolean);
  await interaction.editReply(`Ticket closed and transcript archived.${notes.length ? ` ${notes.join(' ')}` : ''} This channel will now be removed.`);
  try {
    await interaction.channel.delete(`Ticket closed by ${interaction.user.tag}`);
  } catch (error) {
    await interaction.followUp({
      content: `The transcript is archived, but the channel could not be deleted: ${error.message}`,
      ephemeral: true,
    });
  }
  return true;
}

function createTicketPanel(ticketSettings = {}) {
  const categories = ticketSettings.categories || [];
  const panel = ticketSettings.panel || {};
  const styles = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
  };
  const components = [];
  if (categories.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('tickets:category')
        .setPlaceholder('Choose a support category')
        .addOptions(categories.map((category) => ({
          label: category.label,
          value: category.key,
          ...(category.description ? { description: category.description } : {}),
        }))),
    ));
  } else {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('tickets:open')
        .setLabel(panel.buttonLabel || 'Open a ticket')
        .setStyle(styles[panel.buttonStyle] || ButtonStyle.Primary),
    ));
  }
  const embed = new EmbedBuilder()
    .setColor(Number.parseInt((panel.color || '#5865f2').slice(1), 16))
    .setTitle(panel.title || 'Need help?')
    .setDescription(panel.description || (categories.length
          ? 'Choose a category below to open a private support ticket.'
          : 'Press the button below to open a private support ticket.'));
  if (panel.footer) embed.setFooter({ text: panel.footer });
  if (panel.imageUrl) embed.setImage(panel.imageUrl);
  return {
    embeds: [embed],
    components,
  };
}

module.exports = { canManageTicket, createTicketPanel, handleTicketButton, memberHasRole };
