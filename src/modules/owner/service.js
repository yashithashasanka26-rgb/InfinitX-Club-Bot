const os = require('node:os');
const { BotAccessControl, BotSettings } = require('../../database/models');
const logger = require('../../utils/logger');

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const GLOBAL_ANNOUNCEMENT_DELAY_MS = 250;

function isBotOwner(client, userId, ownerIds = client.ownerIds || []) {
  return Array.isArray(ownerIds) && ownerIds.includes(userId);
}

function createOwnerService({
  AccessControlModel = BotAccessControl,
  SettingsModel = BotSettings,
  processEmitter = process,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  logger: log = logger,
} = {}) {
  async function enforceAccess(interaction) {
    if (isBotOwner(interaction.client, interaction.user.id)) return { allowed: true, owner: true };
    const conditions = [{ subjectType: 'user', subjectId: interaction.user.id }];
    if (interaction.guildId) conditions.push({ subjectType: 'guild', subjectId: interaction.guildId });
    const records = await AccessControlModel.find({
      action: 'blacklist',
      $or: conditions,
    }).select('subjectType reason').lean();
    const denied = records.find((entry) => entry.subjectType === 'user')
      || records.find((entry) => entry.subjectType === 'guild');
    if (denied) {
      return {
        allowed: false,
        reason: denied.subjectType === 'user'
          ? 'You are not allowed to use this bot.'
          : 'This server is not allowed to use this bot.',
      };
    }
    const settings = await SettingsModel.findById('global').lean();
    if (!settings?.whitelistEnabled) return { allowed: true, owner: false };
    const allowed = await AccessControlModel.exists({
      action: 'whitelist',
      $or: conditions,
    });
    return allowed
      ? { allowed: true, owner: false }
      : { allowed: false, reason: 'This bot is currently restricted to allowlisted users and servers.' };
  }

  async function setAccess(action, subjectType, subjectId, actorId, reason = null) {
    if (!['blacklist', 'whitelist'].includes(action)
      || !['user', 'guild'].includes(subjectType)
      || !SNOWFLAKE_PATTERN.test(subjectId)
      || !SNOWFLAKE_PATTERN.test(actorId)) {
      throw new TypeError('Invalid access-control action or Discord ID.');
    }
    await AccessControlModel.updateOne(
      { action, subjectType, subjectId },
      { $set: { reason: reason?.trim() || null, actorId } },
      { upsert: true, runValidators: true },
    );
  }

  async function removeAccess(action, subjectType, subjectId) {
    if (!['blacklist', 'whitelist'].includes(action)
      || !['user', 'guild'].includes(subjectType)
      || !SNOWFLAKE_PATTERN.test(subjectId)) {
      throw new TypeError('Invalid access-control action or Discord ID.');
    }
    const result = await AccessControlModel.deleteOne({ action, subjectType, subjectId });
    return result.deletedCount === 1;
  }

  async function setWhitelistMode(enabled, actorId) {
    if (typeof enabled !== 'boolean' || !SNOWFLAKE_PATTERN.test(actorId)) {
      throw new TypeError('Invalid whitelist mode or actor ID.');
    }
    await SettingsModel.updateOne(
      { _id: 'global' },
      { $set: { whitelistEnabled: enabled, updatedBy: actorId } },
      { upsert: true, runValidators: true },
    );
  }

  function getSystemStats(client) {
    const guilds = [...client.guilds.cache.values()];
    return {
      guilds: guilds.length,
      approximateMembers: guilds.reduce((total, guild) => total + (guild.memberCount || 0), 0),
      uptimeSeconds: Math.floor((client.uptime || 0) / 1000),
      websocketPingMs: Number.isFinite(client.ws.ping) ? Math.round(client.ws.ping) : null,
      memory: processEmitter.memoryUsage(),
      nodeVersion: processEmitter.version,
      platform: processEmitter.platform,
      architecture: processEmitter.arch,
      hostUptimeSeconds: Math.floor(os.uptime()),
      loadAverage: os.loadavg(),
      cpuCount: os.cpus().length,
      shardStatuses: client.ws.shards.map((shard) => ({ id: shard.id, status: shard.status })),
    };
  }

  async function announceGlobally(client, content) {
    if (typeof content !== 'string' || !content.trim() || content.length > 1900) {
      throw new TypeError('Announcement must be between 1 and 1900 characters.');
    }
    const results = { sent: 0, skipped: 0, failed: 0 };
    for (const guild of client.guilds.cache.values()) {
      const channel = guild.systemChannel;
      if (!channel?.isTextBased() || !channel.send) {
        results.skipped += 1;
        continue;
      }
      try {
        const permissions = guild.members.me?.permissionsIn(channel);
        if (!permissions?.has(['ViewChannel', 'SendMessages'])) {
          results.skipped += 1;
          continue;
        }
        await channel.send({
          content: `**Announcement from ${client.user.username}**\n${content.trim()}`,
          allowedMentions: { parse: [] },
        });
        results.sent += 1;
      } catch (error) {
        results.failed += 1;
        log.error('Global announcement failed for a server', {
          guildId: guild.id,
          error: error.message,
        });
      }
      await wait(GLOBAL_ANNOUNCEMENT_DELAY_MS);
    }
    return results;
  }

  async function stop(client, mode) {
    if (!['restart', 'shutdown'].includes(mode)) throw new TypeError('Unsupported owner stop mode.');
    await client.shutdown();
    processEmitter.exitCode = 0;
  }

  return { enforceAccess, setAccess, removeAccess, setWhitelistMode, getSystemStats, announceGlobally, stop };
}

const ownerService = createOwnerService();

module.exports = {
  GLOBAL_ANNOUNCEMENT_DELAY_MS,
  SNOWFLAKE_PATTERN,
  createOwnerService,
  isBotOwner,
  ownerService,
};
