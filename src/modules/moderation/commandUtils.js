const { PermissionFlagsBits } = require('discord.js');
const { recordModerationAction } = require('./logging');

function hasPermission(interaction, permission) {
  return interaction.memberPermissions?.has(permission) === true;
}

async function getBotMember(guild) {
  return guild.members.me || guild.members.fetchMe();
}

async function assertTargetIsModeratable(interaction, target, {
  allowNonMember = false,
  requireBotHierarchy = true,
} = {}) {
  if (!target) throw new TypeError('Select a valid server member.');
  if (target.id === interaction.user.id) throw new TypeError('You cannot moderate yourself.');
  if (target.id === interaction.client.user.id) throw new TypeError('You cannot moderate the bot.');
  if (target.id === interaction.guild.ownerId) throw new TypeError('The server owner cannot be moderated.');

  const targetMember = target.roles ? target : await interaction.guild.members.fetch(target.id).catch((error) => {
    if (allowNonMember && (error.code === 10007 || error.code === 404)) return null;
    throw error;
  });
  if (!targetMember) return null;
  const moderator = interaction.member?.roles?.highest
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id);
  if (interaction.user.id !== interaction.guild.ownerId
    && moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    throw new TypeError('Your highest role must be above the target member’s highest role.');
  }
  const bot = requireBotHierarchy ? await getBotMember(interaction.guild) : null;
  if (bot && bot.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    throw new TypeError('My highest role must be above the target member’s highest role.');
  }
  return targetMember;
}

async function requireModeratorPermission(interaction, permission, label) {
  if (!interaction.guild || !interaction.guildId) throw new TypeError('This command can only be used in a server.');
  if (!hasPermission(interaction, permission)) {
    throw new TypeError(`You need the ${label} permission to use this command.`);
  }
}

async function logModerationCommand(interaction, action, { targetId = null, reason = '', details = {} } = {}) {
  const result = await recordModerationAction({
    guild: interaction.guild,
    actorId: interaction.user.id,
    targetId,
    action,
    reason,
    details,
  });
  return result;
}

async function executeModerationCommand(interaction, callback) {
  try {
    const result = await callback();
    const suffix = [];
    if (result?.auditSaved === false) suffix.push('The action succeeded, but its database audit record could not be saved.');
    if (result?.channelLogged === false) suffix.push('The action succeeded, but the log channel could not be reached.');
    await interaction.reply({
      content: `${result?.message || 'Moderation action completed.'}${suffix.length ? ` ${suffix.join(' ')}` : ''}`,
      ephemeral: result?.ephemeral !== false,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (error instanceof TypeError && (error.message.startsWith('You need')
      || error.message.startsWith('This command')
      || error.message.startsWith('Select')
      || error.message.startsWith('You cannot')
      || error.message.startsWith('The server owner')
      || error.message.startsWith('Your highest')
      || error.message.startsWith('My highest'))) {
      await interaction.reply({ content: error.message, ephemeral: true });
      return;
    }
    throw error;
  }
}

module.exports = {
  assertTargetIsModeratable,
  executeModerationCommand,
  hasPermission,
  logModerationCommand,
  requireModeratorPermission,
  PermissionFlagsBits,
};
