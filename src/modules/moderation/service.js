const { AuditLogEvent } = require('discord.js');
const { AuditLog, GuildConfig, Warning } = require('../../database/models');
const { isModuleEnabled } = require('../../utils/moduleSettings');
const { activateLockdown } = require('./lockdown');
const { sendGuildLog } = require('./logging');

const messageWindows = new Map();
const joinWindows = new Map();
const destructiveWindows = new Map();
const raidCooldowns = new Map();
const messageActionCooldowns = new Map();
const MAX_TRACKED_KEYS = 50_000;
const LINK_PATTERN = /(?:https?:\/\/|www\.|discord(?:app)?\.com\/invite\/|discord\.gg\/)/i;
const destructiveActions = new Set([
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.RoleDelete,
  AuditLogEvent.WebhookCreate,
  AuditLogEvent.WebhookDelete,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.BotAdd,
  AuditLogEvent.IntegrationCreate,
  AuditLogEvent.IntegrationDelete,
  AuditLogEvent.EmojiDelete,
  AuditLogEvent.StickerDelete,
]);

function setBounded(map, key, value) {
  if (!map.has(key) && map.size >= MAX_TRACKED_KEYS) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  map.set(key, value);
}

function containsBlockedWord(content, words) {
  const normalized = content.toLocaleLowerCase();
  return words.some((word) => {
    const candidate = word.trim().toLocaleLowerCase();
    if (!candidate) return false;
    if (/[\s]/u.test(candidate)) return normalized.includes(candidate);
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(normalized);
  });
}

async function applyModerationAction({ guild, userId, member, actorId, reason, action, settings }) {
  const warning = await Warning.create({
    guildId: guild.id,
    userId,
    moderatorId: actorId,
    reason: reason.slice(0, 1000),
    action,
    actionSucceeded: false,
  });
  let actionError;

  try {
    if (action === 'timeout') {
      const target = member || await guild.members.fetch(userId);
      if (target.id === guild.ownerId || target.id === guild.client.user.id) {
        throw new Error('Protected guild owner or bot account cannot be automatically timed out.');
      }
      await target.timeout((settings.timeoutMinutes || 10) * 60_000, reason.slice(0, 512));
    } else if (action === 'ban') {
      const target = member || await guild.members.fetch(userId);
      if (target.id === guild.ownerId || target.id === guild.client.user.id) {
        throw new Error('Protected guild owner or bot account cannot be automatically banned.');
      }
      await guild.members.ban(userId, { reason: reason.slice(0, 512), deleteMessageSeconds: 0 });
    } else if (action !== 'warn') {
      throw new Error(`Unsupported moderation action: ${action}`);
    }
    warning.actionSucceeded = true;
    await warning.save();
  } catch (error) {
    actionError = error;
    warning.actionSucceeded = false;
    await warning.save();
  }

  const audit = await AuditLog.create({
    guildId: guild.id,
    actorId,
    targetId: userId,
    action: `automod.${action}`,
    details: {
      reason: reason.slice(0, 512),
      warningId: String(warning._id),
      actionSucceeded: !actionError,
      ...(actionError ? { error: actionError.message.slice(0, 500) } : {}),
    },
  }).catch((error) => {
    throw new AggregateError(
      actionError ? [actionError, error] : [error],
      'Moderation action audit record could not be saved.',
    );
  });

  try {
    await sendGuildLog(guild, {
      title: `Automod: ${action}${actionError ? ' failed' : ''}`,
      description: `Member: <@${userId}>\nAction: ${actionError ? 'failed' : 'applied'}\nReason: ${reason.slice(0, 1000)}${actionError ? `\nError: ${actionError.message.slice(0, 500)}` : ''}`,
      color: actionError ? 0xe67e22 : 0xed4245,
    });
  } catch (error) {
    logger.error('Automod action could not be sent to the moderation log channel', {
      guildId: guild.id,
      targetId: userId,
      action,
      error: error.message,
    });
  }

  if (actionError) {
    actionError.warningId = String(warning._id);
    actionError.auditId = String(audit._id);
    throw actionError;
  }
  return warning;
}

async function moderateMessage(message, config) {
  if (!message.guild || message.author.bot || !isModuleEnabled(config, 'automod')) return false;
  const settings = config.moderation || {};
  const now = Date.now();
  const key = `${message.guild.id}:${message.author.id}`;
  const spamWindowMs = settings.spamWindowMs || 5000;
  const floodWindowMs = settings.floodWindowMs || 2000;
  const spamThreshold = settings.spamThreshold || 6;
  const floodThreshold = settings.floodThreshold || 4;
  const duplicateThreshold = settings.duplicateThreshold || 4;
  const normalized = message.content.trim().toLocaleLowerCase();
  const state = (messageWindows.get(key) || { times: [], contents: [] });
  state.times = state.times.filter((time) => now - time < Math.max(spamWindowMs, floodWindowMs));
  state.contents = state.contents.filter((item) => now - item.time < spamWindowMs);
  state.times.push(now);
  if (normalized) state.contents.push({ content: normalized.slice(0, 500), time: now });
  state.times = state.times.slice(-Math.max(spamThreshold, floodThreshold) * 2);
  state.contents = state.contents.slice(-duplicateThreshold * 2);
  setBounded(messageWindows, key, state);

  const recentDuplicates = normalized
    ? state.contents.filter((item) => item.content === normalized.slice(0, 500)).length
    : 0;
  const isSpam = state.times.filter((time) => now - time < spamWindowMs).length >= spamThreshold;
  const isFlood = state.times.filter((time) => now - time < floodWindowMs).length >= floodThreshold;
  const isDuplicateFlood = recentDuplicates >= duplicateThreshold;
  const isLink = settings.antiLink && LINK_PATTERN.test(message.content);
  const isBadWord = containsBlockedWord(message.content, settings.badWords || []);

  if (!isSpam && !isFlood && !isDuplicateFlood && !isLink && !isBadWord) return false;
  const lastAction = messageActionCooldowns.get(key) || 0;
  if (now - lastAction < 30_000) {
    try {
      await message.delete();
    } catch (error) {
      if (error.code !== 10008 && error.code !== 50013) throw error;
    }
    return true;
  }
  setBounded(messageActionCooldowns, key, now);
  state.times = [];
  state.contents = [];
  try {
    await message.delete();
  } catch (error) {
    if (error.code !== 10008 && error.code !== 50013) throw error;
  }

  const reason = isBadWord
    ? 'Automod: prohibited word'
    : isLink
      ? 'Automod: link'
      : isDuplicateFlood
        ? 'Automod: repeated-message flood'
        : isFlood
          ? 'Automod: message flood'
          : 'Automod: spam';
  await applyModerationAction({
    guild: message.guild,
    userId: message.author.id,
    member: message.member,
    actorId: message.client.user.id,
    reason,
    action: settings.messageAction || 'warn',
    settings,
  });
  return true;
}

async function trackGuildJoin(member) {
  const config = await GuildConfig.findOne({ guildId: member.guild.id }).lean();
  if (!isModuleEnabled(config, 'automod')) return false;
  const settings = config.moderation || {};
  const now = Date.now();
  const recent = (joinWindows.get(member.guild.id) || [])
    .filter((entry) => now - entry.joinedAt < (settings.raidWindowMs || 10_000))
    .slice(-999);
  recent.push({ joinedAt: now, userId: member.id });
  setBounded(joinWindows, member.guild.id, recent);

  const threshold = settings.raidJoinThreshold || 10;
  const lastIncident = raidCooldowns.get(member.guild.id) || 0;
  if (recent.length < threshold) return false;
  const incidentStarted = now - lastIncident >= (settings.raidWindowMs || 10_000);
  if (incidentStarted) setBounded(raidCooldowns, member.guild.id, now);

  const reason = `Anti-raid: ${recent.length} members joined within ${settings.raidWindowMs || 10_000}ms`;
  const actorId = member.client.user.id;
  let lockdownError;
  if (incidentStarted && settings.raidLockdownEnabled !== false) {
    try {
      await activateLockdown({
        guild: member.guild,
        actorId,
        reason,
        durationMinutes: settings.raidLockdownMinutes || 10,
      });
    } catch (error) {
      lockdownError = error;
    }
  }
  await applyModerationAction({
    guild: member.guild,
    userId: member.id,
    member,
    actorId,
    reason,
    action: settings.raidAction || 'timeout',
    settings,
  });
  if (lockdownError) throw lockdownError;
  return true;
}

async function trackDestructiveAudit(entry) {
  if (!destructiveActions.has(entry.action) || !entry.guild || !entry.executorId) return false;
  const config = await GuildConfig.findOne({ guildId: entry.guild.id }).lean();
  if (!isModuleEnabled(config, 'automod') || !config.moderation?.nukeProtection) return false;

  const executorId = entry.executorId;
  if (executorId === entry.guild.ownerId || executorId === entry.client.user.id) return false;
  const settings = config.moderation;
  const now = Date.now();
  const windowMs = settings.nukeWindowMs || 10_000;
  const key = `${entry.guild.id}:${executorId}`;
  const recent = (destructiveWindows.get(key) || []).filter((time) => now - time < windowMs);
  recent.push(now);
  setBounded(destructiveWindows, key, recent);

  if (recent.length < (settings.nukeThreshold || 3)) return false;
  destructiveWindows.delete(key);

  const reason = `Anti-nuke: ${recent.length} destructive actions within ${windowMs}ms`;
  const incidentKey = `${entry.guild.id}:${executorId}`;
  const lastIncident = raidCooldowns.get(`nuke:${incidentKey}`) || 0;
  if (now - lastIncident < 60_000) return false;
  setBounded(raidCooldowns, `nuke:${incidentKey}`, now);
  destructiveWindows.delete(key);
  let lockdownError;
  try {
    await activateLockdown({
      guild: entry.guild,
      actorId: entry.client.user.id,
      reason,
      durationMinutes: settings.raidLockdownMinutes || 10,
    });
  } catch (error) {
    lockdownError = error;
  }
  let member;
  try {
    member = await entry.guild.members.fetch(executorId);
  } catch (error) {
    if (error.code !== 10007) throw error;
  }
  if (member) {
    await applyModerationAction({
      guild: entry.guild,
      userId: executorId,
      member,
      actorId: entry.client.user.id,
      reason,
      action: settings.nukeAction || 'timeout',
      settings,
    });
  } else {
    await AuditLog.create({
      guildId: entry.guild.id,
      actorId: entry.client.user.id,
      targetId: executorId,
      action: 'automod.nuke_executor_not_in_guild',
      details: { reason, auditAction: entry.action },
    });
  }
  if (lockdownError) throw lockdownError;
  return true;
}

module.exports = {
  applyModerationAction,
  containsBlockedWord,
  destructiveActions,
  LINK_PATTERN,
  moderateMessage,
  trackDestructiveAudit,
  trackGuildJoin,
};
