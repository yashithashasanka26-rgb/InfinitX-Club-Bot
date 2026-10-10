const {
  ActionRowBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const crypto = require('node:crypto');
const { hasManageGuild } = require('./custom-command');

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 1000;
const sessions = new Map();

const data = new SlashCommandBuilder()
  .setName('embed-builder')
  .setDescription('Build and send a custom embed with optional link buttons.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

function pruneSessions(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

async function execute(interaction) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: 'The embed builder can only be used in a server.', ephemeral: true });
    return;
  }
  if (!hasManageGuild(interaction)) {
    await interaction.reply({ content: 'You need Manage Server permission to send custom embeds.', ephemeral: true });
    return;
  }

  pruneSessions();
  const token = crypto.randomBytes(12).toString('hex');
  sessions.set(token, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  const modal = new ModalBuilder()
    .setCustomId(`embed-builder:submit:${token}`)
    .setTitle('Build a custom embed');
  const inputs = [
    new TextInputBuilder()
      .setCustomId('title')
      .setLabel('Title (optional)')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(256)
      .setRequired(false),
    new TextInputBuilder()
      .setCustomId('description')
      .setLabel('Description (optional)')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setRequired(false),
    new TextInputBuilder()
      .setCustomId('fields')
      .setLabel('Fields JSON array (optional, max 25)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('[{"name":"Rules","value":"Be kind","inline":false}]')
      .setMaxLength(4000)
      .setRequired(false),
    new TextInputBuilder()
      .setCustomId('style')
      .setLabel('Style JSON: color and footer (optional)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('{"color":"5865f2","footer":"InfinitX Club"}')
      .setMaxLength(500)
      .setRequired(false),
    new TextInputBuilder()
      .setCustomId('buttons')
      .setLabel('Link buttons JSON array (optional, max 5)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('[{"label":"Website","url":"https://example.com"}]')
      .setMaxLength(2000)
      .setRequired(false),
  ];
  modal.addComponents(inputs.map((input) => new ActionRowBuilder().addComponents(input)));
  await interaction.showModal(modal);
}

function takeBuilderSession(token, interaction) {
  const session = sessions.get(token);
  sessions.delete(token);
  if (!session || session.expiresAt <= Date.now()) return null;
  if (session.userId !== interaction.user.id
    || session.guildId !== interaction.guildId
    || session.channelId !== interaction.channelId) return null;
  return session;
}

module.exports = {
  module: 'customCommands',
  data,
  execute,
  pruneSessions,
  sessions,
  takeBuilderSession,
};
