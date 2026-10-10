const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { AuditLog, GuildConfig } = require('../../database/models');
const { isModuleEnabled } = require('../../utils/moduleSettings');
const logger = require('../../utils/logger');

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 10_000;
const challenges = new Map();

function createVerificationPanel(settings = {}) {
  const panel = settings.verification?.panel || settings.panel || {};
  const styles = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
  };
  const embed = new EmbedBuilder()
    .setColor(Number.parseInt((panel.color || '#5865f2').slice(1), 16))
    .setTitle(panel.title || 'Server verification')
    .setDescription(panel.description || 'Click the button below and solve a short arithmetic check to receive the verified role.');
  if (panel.footer) embed.setFooter({ text: panel.footer });
  if (panel.imageUrl) embed.setImage(panel.imageUrl);
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('verification:start')
          .setLabel(panel.buttonLabel || 'Verify')
          .setStyle(styles[panel.buttonStyle] || ButtonStyle.Success),
      ),
    ],
  };
}

function makeChallenge(randomInt = crypto.randomInt) {
  const left = randomInt(2, 10);
  const right = randomInt(2, 10);
  const operation = randomInt(0, 2) === 0 ? '+' : '×';
  const answer = operation === '+' ? left + right : left * right;
  return { prompt: `${left} ${operation} ${right}`, answer: String(answer) };
}

function pruneChallenges(now = Date.now()) {
  for (const [token, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(token);
  }
}

async function startVerification(interaction, { randomInt = crypto.randomInt, now = Date.now } = {}) {
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({ content: 'Verification can only be completed in a server.', ephemeral: true });
    return false;
  }
  const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
  if (!isModuleEnabled(config, 'verification') || config?.verification?.enabled !== true) {
    await interaction.reply({ content: 'Verification is not enabled in this server.', ephemeral: true });
    return false;
  }
  pruneChallenges(now());
  const roleId = config.verification.roleId;
  if (!roleId) {
    await interaction.reply({ content: 'The verified role is not configured. Please contact a server administrator.', ephemeral: true });
    return false;
  }
  const role = await interaction.guild.roles.fetch(roleId);
  if (!role || role.id === interaction.guild.id || role.managed) {
    await interaction.reply({ content: 'The configured verified role is unavailable. Please contact a server administrator.', ephemeral: true });
    return false;
  }
  const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)
    || role.position >= botMember.roles.highest.position) {
    await interaction.reply({ content: 'The bot needs Manage Roles permission and a role above the verified role.', ephemeral: true });
    return false;
  }
  const member = interaction.member?.roles?.cache
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id);
  if (member.roles.cache.has(role.id)) {
    await interaction.reply({ content: 'You are already verified.', ephemeral: true });
    return false;
  }

  for (const [token, challenge] of challenges) {
    if (challenge.guildId === interaction.guildId && challenge.userId === interaction.user.id) challenges.delete(token);
  }
  if (challenges.size >= MAX_CHALLENGES) {
    await interaction.reply({ content: 'Verification is busy right now. Please try again in a moment.', ephemeral: true });
    return false;
  }
  const challenge = makeChallenge(randomInt);
  const token = crypto.randomBytes(12).toString('hex');
  challenges.set(token, {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    answer: challenge.answer,
    expiresAt: now() + CHALLENGE_TTL_MS,
  });
  const modal = new ModalBuilder()
    .setCustomId(`verification:answer:${token}`)
    .setTitle('Server verification')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('answer')
        .setLabel(`Solve: ${challenge.prompt}`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(3),
    ));
  await interaction.showModal(modal);
  return true;
}

async function submitVerification(interaction, { now = Date.now } = {}) {
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({ content: 'Verification can only be completed in a server.', ephemeral: true });
    return false;
  }
  const token = interaction.customId.split(':')[2];
  const challenge = challenges.get(token);
  if (!challenge) {
    await interaction.reply({ content: 'This verification expired. Click the verification button to try again.', ephemeral: true });
    return false;
  }
  if (challenge.guildId !== interaction.guildId
    || challenge.userId !== interaction.user.id) {
    await interaction.reply({ content: 'This verification challenge belongs to another member.', ephemeral: true });
    return false;
  }
  challenges.delete(token);
  if (challenge.expiresAt <= now()) {
    await interaction.reply({ content: 'This verification expired. Click the verification button to try again.', ephemeral: true });
    return false;
  }
  const suppliedAnswer = interaction.fields.getTextInputValue('answer').trim();
  if (!/^\d{1,3}$/.test(suppliedAnswer) || suppliedAnswer !== challenge.answer) {
    await interaction.reply({ content: 'That answer was incorrect. Click the verification button to try again.', ephemeral: true });
    return false;
  }

  const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
  if (!isModuleEnabled(config, 'verification') || config?.verification?.enabled !== true) {
    await interaction.reply({ content: 'Verification is no longer enabled in this server.', ephemeral: true });
    return false;
  }
  const role = await interaction.guild.roles.fetch(config.verification.roleId);
  if (!role || role.id === interaction.guild.id || role.managed) {
    await interaction.reply({ content: 'The configured verified role is unavailable. Please contact a server administrator.', ephemeral: true });
    return false;
  }
  const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)
    || role.position >= botMember.roles.highest.position) {
    await interaction.reply({ content: 'The bot cannot assign the configured verified role. Please contact a server administrator.', ephemeral: true });
    return false;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (member.roles.cache.has(role.id)) {
    await interaction.reply({ content: 'You are already verified.', ephemeral: true });
    return false;
  }
  await member.roles.add(role, 'Completed server verification challenge');
  try {
    await AuditLog.create({
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      targetId: interaction.user.id,
      action: 'verification.completed',
      details: { roleId: role.id },
    });
  } catch (error) {
    logger.error('Verification succeeded but audit logging failed', {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      error: error.message,
    });
  }
  await interaction.reply({ content: 'Verification complete. You now have access to the server.', ephemeral: true });
  return true;
}

async function executeVerificationCommand(interaction) {
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({ content: 'Verification setup can only be used in a server.', ephemeral: true });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'You need Manage Server permission to configure verification.', ephemeral: true });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'disable') {
    await GuildConfig.updateOne(
      { guildId: interaction.guildId },
      { $set: { 'verification.enabled': false, updatedAt: new Date() }, $setOnInsert: { guildId: interaction.guildId } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    await interaction.reply({ content: 'Verification has been disabled.', ephemeral: true });
    return;
  }
  if (!isModuleEnabled(await GuildConfig.findOne({ guildId: interaction.guildId }).lean(), 'verification')) {
    await interaction.reply({ content: 'Enable the Verification module in the dashboard before setup.', ephemeral: true });
    return;
  }
  const role = interaction.options.getRole('role', true);
  const channel = interaction.options.getChannel('channel', true);
  const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)
    || role.id === interaction.guild.id || role.managed || role.position >= botMember.roles.highest.position) {
    await interaction.reply({ content: 'Choose a normal role that is below the bot’s highest role.', ephemeral: true });
    return;
  }
  if (!channel.isTextBased() || !channel.send) {
    await interaction.reply({ content: 'Choose a text channel for the verification panel.', ephemeral: true });
    return;
  }
  if (!botMember.permissionsIn(channel).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    await interaction.reply({ content: 'The bot needs View Channel, Send Messages, and Embed Links permissions in the panel channel.', ephemeral: true });
    return;
  }
  const panel = await channel.send(createVerificationPanel(await GuildConfig.findOne({ guildId: interaction.guildId }).lean()));
  try {
    await GuildConfig.updateOne(
      { guildId: interaction.guildId },
      { $set: {
        'verification.enabled': true,
        'verification.roleId': role.id,
        'verification.channelId': channel.id,
        updatedAt: new Date(),
      }, $setOnInsert: { guildId: interaction.guildId } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    await panel.delete().catch((deleteError) => logger.error('Verification config failed and its panel could not be removed', {
      guildId: interaction.guildId,
      messageId: panel.id,
      error: deleteError.message,
    }));
    throw error;
  }
  await interaction.reply({
    content: `Verification panel posted in <#${channel.id}>. Members receive <@&${role.id}> after passing the challenge.`,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
  return panel;
}

const data = new SlashCommandBuilder()
  .setName('verification')
  .setDescription('Configure the server verification panel.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((option) => option.setName('setup').setDescription('Post a verification panel and configure its role.')
    .addRoleOption((role) => role.setName('role').setDescription('Role given after verification').setRequired(true))
    .addChannelOption((channel) => channel.setName('channel').setDescription('Channel where the panel will be posted').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand((option) => option.setName('disable').setDescription('Disable verification challenges.'));

module.exports = {
  module: 'verification',
  data,
  execute: executeVerificationCommand,
  createVerificationPanel,
  makeChallenge,
  pruneChallenges,
  startVerification,
  submitVerification,
  challenges,
  CHALLENGE_TTL_MS,
  MAX_CHALLENGES,
};
