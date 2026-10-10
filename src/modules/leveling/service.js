const { Level } = require('../../database/models');
const { PermissionFlagsBits } = require('discord.js');
const logger = require('../../utils/logger');

function xpForLevel(level) {
  return 5 * level ** 2 + 50 * level + 100;
}

function levelForXp(xp) {
  let level = 0;
  while (xp >= xpForLevel(level + 1)) level += 1;
  return level;
}

async function awardMessageXp(message, config) {
  if ((config.leveling?.excludedChannels || []).includes(message.channelId)) return;
  const cooldown = (config.leveling?.cooldownSeconds || 60) * 1000;
  const now = new Date();
  const min = config.leveling?.xpMin || 15;
  const max = Math.max(min, config.leveling?.xpMax || 25);
  const amount = Math.floor(Math.random() * (max - min + 1)) + min;
  const identity = { guildId: message.guild.id, userId: message.author.id };
  try {
    await Level.updateOne(identity, { $setOnInsert: identity }, { upsert: true, setDefaultsOnInsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  const result = await Level.findOneAndUpdate(
    {
      ...identity,
      $or: [{ lastXpAt: null }, { lastXpAt: { $lte: new Date(now.getTime() - cooldown) } }],
    },
    { $inc: { xp: amount }, $set: { lastXpAt: now }, $setOnInsert: { level: 0 } },
    { new: true },
  );
  if (!result) return;

  const nextLevel = levelForXp(result.xp);
  if (nextLevel <= result.level) return { xp: amount, level: result.level, leveledUp: false };
  const updated = await Level.findOneAndUpdate(
    { _id: result._id, level: { $lt: nextLevel } },
    { $set: { level: nextLevel } },
    { new: true },
  );
  if (!updated) return { xp: amount, level: nextLevel, leveledUp: false };

  await applyRoleRewards(message, config, updated.level);
  const content = `<@${message.author.id}> reached level ${updated.level}!`;
  const announceChannelId = config.leveling?.announceChannelId;
  const channel = announceChannelId
    ? await message.guild.channels.fetch(announceChannelId)
    : message.channel;
  if (channel?.isTextBased()) {
    await channel.send({ content, allowedMentions: { users: [message.author.id] } });
  }
  return { xp: amount, level: updated.level, leveledUp: true };
}

async function applyRoleRewards(message, config, level) {
  const rewards = (config.leveling?.roleRewards || []).filter((reward) => reward.level <= level);
  if (!rewards.length) return;
  const member = message.member || await message.guild.members.fetch(message.author.id);
  const me = message.guild.members.me || await message.guild.members.fetchMe();

  for (const reward of rewards) {
    if (member.roles.cache.has(reward.roleId)) continue;
    const role = await message.guild.roles.fetch(reward.roleId);
    if (!role) {
      logger.warn('Configured level reward role does not exist', {
        guildId: message.guild.id,
        roleId: reward.roleId,
        level: reward.level,
      });
      continue;
    }
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
      logger.warn('Bot cannot assign configured level reward role', {
        guildId: message.guild.id,
        roleId: reward.roleId,
        level: reward.level,
      });
      continue;
    }
    await member.roles.add(role, `Reached level ${reward.level}`);
  }
}

module.exports = { applyRoleRewards, awardMessageXp, levelForXp, xpForLevel };
