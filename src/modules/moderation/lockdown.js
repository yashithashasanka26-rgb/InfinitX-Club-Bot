const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { AuditLog, GuildLockdown } = require('../../database/models');
const logger = require('../../utils/logger');

const supportedChannelTypes = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

function getSendMessagesState(overwrite) {
  if (!overwrite) return 'neutral';
  if (overwrite.allow.has(PermissionFlagsBits.SendMessages)) return 'allow';
  if (overwrite.deny.has(PermissionFlagsBits.SendMessages)) return 'deny';
  return 'neutral';
}

function permissionValue(state) {
  if (state === 'allow') return true;
  if (state === 'deny') return false;
  return null;
}

async function activateLockdown({ guild, actorId, reason, durationMinutes = 10 }) {
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
    throw new RangeError('Lockdown duration must be between 1 and 1440 minutes.');
  }
  const existing = await GuildLockdown.findOne({ guildId: guild.id, status: { $in: ['active', 'restoring'] } });
  if (existing) return { created: false, lockdown: existing };

  const me = guild.members.me || await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('The bot needs Manage Channels permission to activate a server lockdown.');
  }
  let lockdown;
  try {
    lockdown = await GuildLockdown.findOneAndUpdate(
      { guildId: guild.id, status: 'restored' },
      {
        $set: {
          reason: reason.slice(0, 500),
          status: 'active',
          startedBy: actorId,
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + durationMinutes * 60_000),
          channels: [],
        },
      },
      { new: true },
    );
    if (!lockdown) {
      lockdown = await GuildLockdown.create({
        guildId: guild.id,
        startedBy: actorId,
        reason: reason.slice(0, 500),
        expiresAt: new Date(Date.now() + durationMinutes * 60_000),
      });
    }
  } catch (error) {
    if (error.code !== 11000) throw error;
    const active = await GuildLockdown.findOne({ guildId: guild.id, status: { $in: ['active', 'restoring'] } });
    if (active) return { created: false, lockdown: active };
    throw error;
  }

  const failures = [];
  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    if (!supportedChannelTypes.has(channel.type)) continue;
    const overwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    const originalState = getSendMessagesState(overwrite);
    const alreadyRecorded = lockdown.channels.some((entry) => entry.channelId === channel.id);
    if (!alreadyRecorded) {
      lockdown.channels.push({ channelId: channel.id, sendMessagesState: originalState, restored: false });
      await lockdown.save();
    }
    try {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone.id,
        { SendMessages: false },
        { reason: reason.slice(0, 500) },
      );
    } catch (error) {
      failures.push({ channelId: channel.id, error: error.message });
      const failedChannel = lockdown.channels.find((entry) => entry.channelId === channel.id);
      if (failedChannel) failedChannel.restored = true;
      await lockdown.save();
    }
  }

  await AuditLog.create({
    guildId: guild.id,
    actorId,
    action: 'automod.lockdown_started',
    details: {
      reason: reason.slice(0, 500),
      lockdownId: String(lockdown._id),
      channelsLocked: lockdown.channels.filter((channel) => !channel.restored).length,
      failures,
      expiresAt: lockdown.expiresAt,
    },
  });
  if (failures.length && lockdown.channels.every((channel) => channel.restored)) {
    lockdown.status = 'restored';
    await lockdown.save();
    throw new AggregateError(failures.map(({ error }) => new Error(error)), 'Lockdown could not be applied to any channel.');
  }
  return { created: true, lockdown, failures };
}

async function lockNewChannel(channel) {
  if (!channel.guild || !supportedChannelTypes.has(channel.type)) return false;
  const lockdown = await GuildLockdown.findOneAndUpdate({
    guildId: channel.guild.id,
    status: 'active',
    'channels.channelId': { $ne: channel.id },
  }, {
    $push: {
      channels: {
        channelId: channel.id,
        sendMessagesState: getSendMessagesState(channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id)),
        restored: false,
      },
    },
  }, { new: true });
  if (!lockdown) return false;
  try {
    await channel.permissionOverwrites.edit(
      channel.guild.roles.everyone.id,
      { SendMessages: false },
      { reason: `Active lockdown: ${lockdown.reason}`.slice(0, 500) },
    );
  } catch (error) {
    const entry = lockdown.channels.find((item) => item.channelId === channel.id);
    if (entry) entry.restored = true;
    await lockdown.save();
    throw error;
  }
  return true;
}

async function restoreLockdown(lockdown, guild) {
  lockdown.status = 'restoring';
  await lockdown.save();
  const failures = [];

  for (const channelState of lockdown.channels) {
    if (channelState.restored) continue;
    try {
      let channel = guild?.channels.cache.get(channelState.channelId);
      if (!channel && guild) {
        try {
          channel = await guild.channels.fetch(channelState.channelId);
        } catch (error) {
          if (error.code !== 10003) throw error;
        }
      }
      if (channel) {
        await channel.permissionOverwrites.edit(
          guild.roles.everyone.id,
          { SendMessages: permissionValue(channelState.sendMessagesState) },
          { reason: 'Automatic end of anti-raid lockdown; restoring original permission' },
        );
      }
      channelState.restored = true;
      await lockdown.save();
    } catch (error) {
      failures.push({ channelId: channelState.channelId, error: error.message });
      logger.error('Failed to restore lockdown channel', {
        guildId: lockdown.guildId,
        channelId: channelState.channelId,
        error: error.message,
      });
    }
  }

  if (failures.length) return { restored: false, failures };
  lockdown.status = 'restored';
  await lockdown.save();
  await AuditLog.create({
    guildId: lockdown.guildId,
    actorId: guild?.client.user.id || null,
    action: 'automod.lockdown_restored',
    details: { lockdownId: String(lockdown._id), channelsRestored: lockdown.channels.length },
  });
  return { restored: true, failures: [] };
}

async function restoreExpiredLockdowns(client) {
  const now = new Date();
  const expired = await GuildLockdown.find({
    $or: [
      { status: 'active', expiresAt: { $lte: now } },
      { status: 'restoring' },
    ],
  }).limit(100);
  for (const lockdown of expired) {
    const guild = client.guilds.cache.get(lockdown.guildId);
    if (!guild) {
      logger.warn('Lockdown is due for restoration but guild is unavailable', {
        guildId: lockdown.guildId,
        lockdownId: String(lockdown._id),
      });
      continue;
    }
    try {
      await restoreLockdown(lockdown, guild);
    } catch (error) {
      logger.error('Lockdown restoration sweep failed', {
        guildId: lockdown.guildId,
        lockdownId: String(lockdown._id),
        error: error.message,
      });
    }
  }
}

function startLockdownRecovery(client) {
  let running = false;
  let runPromise;
  const run = async () => {
    if (running) return runPromise;
    running = true;
    runPromise = (async () => {
      try {
        await restoreExpiredLockdowns(client);
      } catch (error) {
        logger.error('Lockdown recovery sweep failed', { error: error.message });
      } finally {
        running = false;
      }
    })();
    return runPromise;
  };
  const timer = setInterval(run, 30_000);
  timer.unref();
  void run();
  return async () => {
    clearInterval(timer);
    await runPromise;
  };
}

module.exports = {
  activateLockdown,
  getSendMessagesState,
  lockNewChannel,
  permissionValue,
  restoreExpiredLockdowns,
  restoreLockdown,
  startLockdownRecovery,
};
