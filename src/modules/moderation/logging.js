const {
  AuditLogEvent,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { AuditLog, GuildConfig } = require('../../database/models');
const logger = require('../../utils/logger');

const MODERATION_AUDIT_ACTIONS = new Set([
  AuditLogEvent.MemberKick,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberBanRemove,
  AuditLogEvent.MemberUpdate,
  AuditLogEvent.MemberRoleUpdate,
  AuditLogEvent.MemberDisconnect,
  AuditLogEvent.MemberMove,
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.ChannelOverwriteUpdate,
  AuditLogEvent.RoleUpdate,
  AuditLogEvent.RoleDelete,
]);

function clip(value, limit = 1000) {
  const text = String(value || '').trim();
  if (!text) return '*None*';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function safeActor(id) {
  return id ? `<@${id}> (\`${id}\`)` : 'Unknown';
}

function safeTarget(id) {
  return id ? `<@${id}> (\`${id}\`)` : 'Unknown';
}

async function sendGuildLog(guild, {
  title,
  description,
  color = 0x5865f2,
  fields = [],
  timestamp = new Date(),
  sourceChannelId,
}) {
  const config = await GuildConfig.findOne({ guildId: guild.id }).select('moderation.logChannelId').lean();
  const channelId = config?.moderation?.logChannelId;
  if (!channelId) return { sent: false, reason: 'not-configured' };
  if (sourceChannelId && sourceChannelId === channelId) return { sent: false, reason: 'source-is-log-channel' };
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isTextBased() || typeof channel.send !== 'function') {
    logger.warn('Configured moderation log channel is unavailable or not text-based', {
      guildId: guild.id,
      channelId,
    });
    return { sent: false, reason: 'invalid-channel' };
  }
  const botMember = guild.members.me || await guild.members.fetchMe();
  const permissions = channel.permissionsFor(botMember);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    logger.warn('Bot cannot send embeds to the configured moderation log channel', {
      guildId: guild.id,
      channelId,
    });
    return { sent: false, reason: 'missing-permissions' };
  }
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(clip(title, 256))
    .setDescription(clip(description, 4000))
    .setTimestamp(timestamp);
  if (fields.length) embed.addFields(fields.slice(0, 25).map((field) => ({
    name: clip(field.name, 256),
    value: clip(field.value, 1024),
    inline: field.inline === true,
  })));
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return { sent: true, channelId };
}

async function recordModerationAction({
  guild,
  actorId,
  targetId = null,
  action,
  reason = '',
  details = {},
}) {
  let auditSaved = true;
  try {
    await AuditLog.create({
      guildId: guild.id,
      actorId,
      targetId,
      action: `moderation.${action}`,
      details: { reason: clip(reason, 1000), ...details },
    });
  } catch (error) {
    auditSaved = false;
    logger.error('Moderation audit record could not be saved', {
      guildId: guild.id,
      actorId,
      targetId,
      action,
      error: error.message,
    });
  }
  let channelLogged = true;
  try {
    const result = await sendGuildLog(guild, {
      title: `Moderation: ${action}`,
      description: `Moderator: ${safeActor(actorId)}\nTarget: ${safeTarget(targetId)}\nReason: ${clip(reason, 1000)}`,
      color: 0xed4245,
      fields: Object.entries(details).map(([name, value]) => ({
        name,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      })),
    });
    channelLogged = result.sent || result.reason === 'not-configured';
  } catch (error) {
    channelLogged = false;
    logger.error('Moderation action could not be sent to the log channel', {
      guildId: guild.id,
      actorId,
      targetId,
      action,
      error: error.message,
    });
  }
  return { auditSaved, channelLogged };
}

async function logMessageDelete(message) {
  if (!message.guild || message.author?.bot) return false;
  const attachmentUrls = [...(message.attachments?.values?.() || [])]
    .slice(0, 5)
    .map((attachment) => attachment.url)
    .join('\n');
  const content = clip(message.content, 2500);
  const description = `Author: ${safeActor(message.author?.id)}\nChannel: <#${message.channelId}>\nMessage: ${clip(content, 1800)}${attachmentUrls ? `\nAttachments:\n${clip(attachmentUrls, 1000)}` : ''}`;
  await sendGuildLog(message.guild, {
    title: 'Message deleted',
    description,
    color: 0x992d22,
    timestamp: message.createdAt || new Date(),
    sourceChannelId: message.channelId,
  });
  return true;
}

async function logMessageUpdate(oldMessage, newMessage) {
  if (!newMessage.guild || newMessage.author?.bot || oldMessage.content === newMessage.content) return false;
  await sendGuildLog(newMessage.guild, {
    title: 'Message edited',
    description: `Author: ${safeActor(newMessage.author?.id)}\nChannel: <#${newMessage.channelId}>\nBefore: ${clip(oldMessage.content || '*Unavailable*', 1500)}\nAfter: ${clip(newMessage.content || '*Empty*', 1500)}\n[Jump to message](${newMessage.url})`,
    color: 0xe67e22,
    timestamp: newMessage.editedAt || new Date(),
    sourceChannelId: newMessage.channelId,
  });
  return true;
}

async function logMemberJoin(member) {
  await sendGuildLog(member.guild, {
    title: 'Member joined',
    description: `${safeActor(member.id)}\nAccount created: <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
    color: 0x57f287,
    timestamp: member.joinedAt || new Date(),
  });
}

async function logMemberLeave(member) {
  await sendGuildLog(member.guild, {
    title: 'Member left',
    description: `${safeActor(member.id)}${member.user?.tag ? `\nUsername: ${clip(member.user.tag, 100)}` : ''}`,
    color: 0xed4245,
  });
}

async function logVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;
  const before = oldState.channel;
  const after = newState.channel;
  const changes = [];
  let title = 'Voice state updated';
  if (!before && after) {
    title = 'Member joined voice';
    changes.push(`Channel: <#${after.id}>`);
  } else if (before && !after) {
    title = 'Member left voice';
    changes.push(`Channel: <#${before.id}>`);
  } else if (before && after && before.id !== after.id) {
    title = 'Member moved voice channel';
    changes.push(`From: <#${before.id}>\nTo: <#${after.id}>`);
  }
  for (const [label, key] of [
    ['Server mute', 'serverMute'],
    ['Server deafen', 'serverDeaf'],
    ['Self mute', 'selfMute'],
    ['Self deafen', 'selfDeaf'],
    ['Streaming', 'streaming'],
    ['Camera', 'selfVideo'],
  ]) {
    if (oldState[key] !== newState[key]) changes.push(`${label}: ${newState[key] ? 'enabled' : 'disabled'}`);
  }
  if (!changes.length) return;
  await sendGuildLog(guild, {
    title,
    description: `${safeActor(newState.id || oldState.id)}\n${changes.join('\n')}`,
    color: 0x5865f2,
  });
}

async function logDiscordModerationAudit(entry, guild, client) {
  if (!MODERATION_AUDIT_ACTIONS.has(entry.action) || !entry.executorId || entry.executorId === client.user?.id) return false;
  const actionName = Object.entries(AuditLogEvent).find(([, value]) => value === entry.action)?.[0] || `action-${entry.action}`;
  const targetId = entry.targetId || entry.target?.id || null;
  const reason = entry.reason || '';
  const changes = (entry.changes || []).slice(0, 10).map((change) => {
    const before = change.old === undefined ? '' : `\nBefore: ${clip(JSON.stringify(change.old), 300)}`;
    const after = change.new === undefined ? '' : `\nAfter: ${clip(JSON.stringify(change.new), 300)}`;
    return { name: change.key || 'Change', value: `${before}${after}`.trim() || 'Updated' };
  });
  await AuditLog.create({
    guildId: guild.id,
    actorId: entry.executorId,
    targetId,
    action: `discord.${actionName}`,
    details: {
      reason: clip(reason, 1000),
      auditEntryId: entry.id,
      ...(entry.changes?.length ? { changes: entry.changes.slice(0, 10) } : {}),
    },
  });
  await sendGuildLog(guild, {
    title: `Discord audit: ${actionName}`,
    description: `Moderator: ${safeActor(entry.executorId)}\nTarget: ${safeTarget(targetId)}\nReason: ${clip(reason, 1000)}`,
    color: 0xe67e22,
    fields: changes,
    timestamp: entry.createdAt || new Date(),
  });
  return true;
}

module.exports = {
  MODERATION_AUDIT_ACTIONS,
  logDiscordModerationAudit,
  logMemberJoin,
  logMemberLeave,
  logMessageDelete,
  logMessageUpdate,
  logVoiceStateUpdate,
  recordModerationAction,
  sendGuildLog,
};
