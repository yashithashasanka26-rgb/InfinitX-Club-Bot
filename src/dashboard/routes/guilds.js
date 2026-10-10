const express = require('express');
const {
  AuditLog,
  CommandPermission,
  CustomCommand,
  GuildConfig,
  TicketStats,
  TicketTranscript,
} = require('../../database/models');
const { DISCORD_API } = require('../auth');
const { requireGuildManager, requireLogin, requireSameOrigin } = require('../middleware');
const { normalizeButtons, normalizeEmbed } = require('../../modules/customCommands/builders');

const router = express.Router();
router.use(requireLogin);
router.param('guildId', requireGuildManager);

const moduleNames = new Set(['moderation', 'automod', 'tickets', 'economy', 'leveling', 'music', 'ai', 'customCommands', 'welcomeLeave', 'verification', 'giveaways', 'temporaryVoice', 'analytics', 'starboard', 'suggestions']);
const moderationKeys = new Set([
  'logChannelId', 'antiLink', 'badWords', 'messageAction', 'timeoutMinutes',
  'spamThreshold', 'spamWindowMs', 'floodThreshold', 'floodWindowMs', 'duplicateThreshold',
  'raidJoinThreshold', 'raidWindowMs', 'raidAction', 'raidLockdownEnabled', 'raidLockdownMinutes',
  'nukeProtection', 'nukeThreshold', 'nukeWindowMs', 'nukeAction',
]);
const levelingKeys = new Set(['xpMin', 'xpMax', 'cooldownSeconds', 'excludedChannels', 'announceChannelId', 'roleRewards']);
const economyKeys = new Set(['dailyReward', 'weeklyReward', 'workMin', 'workMax', 'workCooldownHours', 'items']);
const aiKeys = new Set(['mentionResponses', 'greetingAutoReply', 'greetingTriggers']);
const verificationKeys = new Set(['enabled', 'roleId', 'channelId']);
const temporaryVoiceKeys = new Set(['joinChannelId', 'categoryId']);
const starboardKeys = new Set(['channelId', 'threshold', 'emoji']);
const suggestionKeys = new Set(['channelId', 'logChannelId']);
const ticketKeys = new Set(['categoryId', 'supportRoleId', 'logChannelId', 'autoCloseHours', 'categories']);
const musicKeys = new Set(['defaultVolume', 'maxQueueSize']);
const welcomeLeaveKeys = new Set([
  'welcomeEnabled', 'leaveEnabled', 'welcomeChannelId', 'leaveChannelId',
  'backgroundImageUrl', 'welcome', 'leave',
]);
const snowflake = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);

router.get('/:guildId/config/schema', (req, res) => {
  res.json({
    modules: [...moduleNames],
    sections: {
      moderation: [...moderationKeys],
      music: [...musicKeys],
      welcomeLeave: [...welcomeLeaveKeys],
      leveling: [...levelingKeys],
      economy: [...economyKeys],
      ai: [...aiKeys],
      verification: [...verificationKeys],
      temporaryVoice: [...temporaryVoiceKeys],
      starboard: [...starboardKeys],
      suggestions: [...suggestionKeys],
      tickets: [...ticketKeys],
    },
    prefix: { type: 'string', minLength: 1, maxLength: 5 },
    language: { type: 'string', pattern: '^[a-z]{2}(?:-[A-Z]{2})?$' },
  });
});

router.get('/', async (req, res, next) => {
  try {
    const response = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${req.session.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      if (response.status === 401) {
        res.status(401).json({ error: 'Discord session expired. Please sign in again.' });
        return;
      }
      throw new Error(`Discord guild lookup failed with status ${response.status}`);
    }
    const guilds = await response.json();
    const manageable = guilds.filter((guild) => {
      const permissions = BigInt(guild.permissions || '0');
      return guild.owner === true || (permissions & 0x20n) !== 0n || (permissions & 0x8n) !== 0n;
    });
    res.json({
      guilds: manageable.map(({ id, name, icon }) => ({ id, name, icon })),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:guildId/config', async (req, res, next) => {
  try {
    let config = await GuildConfig.findOne({ guildId: req.guildId }).lean();
    if (!config) config = new GuildConfig({ guildId: req.guildId }).toObject({ flattenMaps: true });
    res.json({ config });
  } catch (error) {
    next(error);
  }
});

router.patch('/:guildId/config', requireSameOrigin, async (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Expected a JSON object.' });
      return;
    }
    const update = {};
    if (Object.hasOwn(body, 'prefix')) {
      if (typeof body.prefix !== 'string' || !/^[^\s]{1,5}$/.test(body.prefix)) {
        res.status(400).json({ error: 'Prefix must be 1-5 non-whitespace characters.' });
        return;
      }
      update.prefix = body.prefix;
    }
    if (Object.hasOwn(body, 'language')) {
      if (typeof body.language !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(body.language)) {
        res.status(400).json({ error: 'Language must be a valid locale such as en or en-US.' });
        return;
      }
      update.language = body.language;
    }
    if (Object.hasOwn(body, 'modules')) {
      if (!body.modules || typeof body.modules !== 'object' || Array.isArray(body.modules)
        || Object.keys(body.modules).some((key) => !moduleNames.has(key))
        || Object.values(body.modules).some((value) => typeof value !== 'boolean')) {
        res.status(400).json({ error: 'Invalid module settings.' });
        return;
      }
      for (const [key, value] of Object.entries(body.modules)) update[`modules.${key}`] = value;
    }
    for (const [section, allowedKeys] of [
      ['moderation', moderationKeys],
      ['music', musicKeys],
      ['welcomeLeave', welcomeLeaveKeys],
      ['leveling', levelingKeys],
      ['economy', economyKeys],
      ['ai', aiKeys],
      ['verification', verificationKeys],
      ['temporaryVoice', temporaryVoiceKeys],
      ['starboard', starboardKeys],
      ['suggestions', suggestionKeys],
      ['tickets', ticketKeys],
    ]) {
      if (!Object.hasOwn(body, section)) continue;
      const value = body[section];
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => !allowedKeys.has(key))) {
        res.status(400).json({ error: `Invalid ${section} settings.` });
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (section === 'welcomeLeave' && ['welcome', 'leave'].includes(key)) {
          const embedFields = new Set([
            'title', 'description', 'color', 'footer', 'includeDate', 'includeTime',
            'thumbnailUrl', 'imageUrl',
          ]);
          if (!item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).some((field) => !embedFields.has(field))) {
            res.status(400).json({ error: `Invalid ${section}.${key} embed settings.` });
            return;
          }
          for (const [field, fieldValue] of Object.entries(item)) {
            if (field === 'color' && (typeof fieldValue !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(fieldValue))) {
              res.status(400).json({ error: `Invalid ${section}.${key}.${field}.` });
              return;
            }
            if (['title', 'description', 'footer'].includes(field)
              && typeof fieldValue !== 'string') {
              res.status(400).json({ error: `Invalid ${section}.${key}.${field}.` });
              return;
            }
            if (['includeDate', 'includeTime'].includes(field) && typeof fieldValue !== 'boolean') {
              res.status(400).json({ error: `Invalid ${section}.${key}.${field}.` });
              return;
            }
            if (['thumbnailUrl', 'imageUrl'].includes(field) && fieldValue !== null && fieldValue !== '') {
              if (typeof fieldValue !== 'string') {
                res.status(400).json({ error: `Invalid ${section}.${key}.${field}.` });
                return;
              }
              let url;
              try {
                url = new URL(fieldValue);
              } catch {
                res.status(400).json({ error: `Invalid ${section}.${key}.${field}.` });
                return;
              }
              if (url.protocol !== 'https:' || url.username || url.password || fieldValue.length > 2048) {
                res.status(400).json({ error: `Invalid ${section}.${key}.${field}.` });
                return;
              }
            }
            update[`${section}.${key}.${field}`] = fieldValue;
          }
          continue;
        }
        if (section === 'ai' && key === 'greetingAutoReply') {
          if (typeof item !== 'boolean') {
            res.status(400).json({ error: 'ai.greetingAutoReply must be boolean.' });
            return;
          }
          update[`${section}.${key}`] = item;
          continue;
        }
        if (section === 'ai' && key === 'greetingTriggers') {
          if (!Array.isArray(item) || item.length > 30
            || item.some((phrase) => typeof phrase !== 'string' || !phrase.trim() || phrase.length > 80)) {
            res.status(400).json({ error: 'ai.greetingTriggers must contain at most 30 phrases, each 1–80 characters long.' });
            return;
          }
          update[`${section}.${key}`] = item;
          continue;
        }
        if (section === 'welcomeLeave' && ['backgroundImageUrl'].includes(key)
          && item !== null && item !== '') {
          let url;
          try {
            url = new URL(item);
          } catch {
            res.status(400).json({ error: `Invalid ${section}.${key}.` });
            return;
          }
          if (url.protocol !== 'https:' || url.username || url.password || item.length > 2048) {
            res.status(400).json({ error: `Invalid ${section}.${key}.` });
            return;
          }
        }
        if (section === 'welcomeLeave' && key === 'backgroundImageUrl') {
          if (item !== null && item !== '' && typeof item !== 'string') {
            res.status(400).json({ error: `Invalid ${section}.${key}.` });
            return;
          }
          update[`${section}.${key}`] = item || null;
          continue;
        }
        if (section === 'welcomeLeave' && ['welcomeChannelId', 'leaveChannelId'].includes(key)
          && item !== null && !snowflake(item)) {
          res.status(400).json({ error: `Invalid ${section}.${key}.` });
          return;
        }
        if (['badWords', 'excludedChannels'].includes(key)) {
          if (!Array.isArray(item) || item.length > 100 || item.some((entry) => typeof entry !== 'string' || entry.length > 100)) {
            res.status(400).json({ error: `Invalid ${section}.${key}.` });
            return;
          }
          if (key === 'excludedChannels' && item.some((entry) => !snowflake(entry))) {
            res.status(400).json({ error: `Invalid ${section}.${key}.` });
            return;
          }
        } else if (key === 'items') {
          const valid = Array.isArray(item) && item.length <= 25
            && item.every((shopItem) => shopItem && typeof shopItem === 'object' && !Array.isArray(shopItem)
              && Object.keys(shopItem).every((field) => ['itemId', 'name', 'description', 'price'].includes(field))
              && typeof shopItem.itemId === 'string' && /^[a-z0-9_-]{1,32}$/.test(shopItem.itemId)
              && typeof shopItem.name === 'string' && shopItem.name.trim().length >= 1 && shopItem.name.length <= 80
              && (shopItem.description === undefined || (typeof shopItem.description === 'string' && shopItem.description.length <= 200))
              && Number.isSafeInteger(shopItem.price) && shopItem.price >= 1 && shopItem.price <= 100000000);
          if (!valid || new Set(item.map((shopItem) => shopItem.itemId)).size !== item.length) {
            res.status(400).json({ error: 'Shop items must have unique IDs, valid names, descriptions, and prices.' });
            return;
          }
        } else if (key === 'roleRewards') {
          const valid = Array.isArray(item) && item.length <= 50
            && item.every((reward) => reward && typeof reward === 'object' && !Array.isArray(reward)
              && Object.keys(reward).every((field) => ['level', 'roleId'].includes(field))
              && Number.isSafeInteger(reward.level) && reward.level >= 1 && reward.level <= 10000
              && snowflake(reward.roleId));
          if (!valid || new Set(item.map((reward) => reward.level)).size !== item.length) {
            res.status(400).json({ error: 'Role rewards require unique levels and valid Discord role IDs.' });
            return;
          }
        } else if (key === 'announceChannelId') {
          if (item !== null && !snowflake(item)) {
            res.status(400).json({ error: 'announceChannelId must be a Discord channel ID or null.' });
            return;
          }
        } else if (key === 'emoji') {
          if (typeof item !== 'string' || !item.trim() || item.length > 64) {
            res.status(400).json({ error: 'starboard.emoji must be a non-empty emoji string of at most 64 characters.' });
            return;
          }
        } else if (key === 'categories') {
          const valid = Array.isArray(item) && item.length <= 25
            && item.every((category) => category && typeof category === 'object' && !Array.isArray(category)
              && Object.keys(category).every((field) => ['key', 'label', 'description', 'categoryId', 'supportRoleId'].includes(field))
              && typeof category.key === 'string' && /^[a-z0-9_-]{1,25}$/.test(category.key)
              && typeof category.label === 'string' && category.label.trim().length >= 1 && category.label.length <= 100
              && (category.description === undefined || (typeof category.description === 'string' && category.description.length <= 100))
              && (category.categoryId === undefined || category.categoryId === null || snowflake(category.categoryId))
              && (category.supportRoleId === undefined || category.supportRoleId === null || snowflake(category.supportRoleId)));
          if (!valid || new Set(item.map((category) => category.key)).size !== item.length) {
            res.status(400).json({ error: 'Ticket categories must have unique keys and valid labels, descriptions, and Discord IDs.' });
            return;
          }
        } else if (['categoryId', 'supportRoleId', 'logChannelId', 'announceChannelId', 'roleId', 'channelId', 'joinChannelId', 'welcomeChannelId', 'leaveChannelId'].includes(key)) {
          if (item !== null && !snowflake(item)) {
            res.status(400).json({ error: `Invalid ${section}.${key}.` });
            return;
          }
        } else if (typeof item === 'boolean') {
          if (!['antiLink', 'raidLockdownEnabled', 'nukeProtection', 'mentionResponses', 'enabled', 'welcomeEnabled', 'leaveEnabled'].includes(key)) {
            res.status(400).json({ error: `Invalid ${section}.${key}.` });
            return;
          }
        } else if (['messageAction', 'raidAction', 'nukeAction'].includes(key)) {
          if (!['warn', 'timeout', 'ban'].includes(item)) {
            res.status(400).json({ error: `Invalid ${section}.${key}.` });
            return;
          }
        } else {
          const ranges = {
            spamThreshold: [2, 30],
            spamWindowMs: [1000, 60000],
            floodThreshold: [2, 20],
            floodWindowMs: [500, 30000],
            duplicateThreshold: [2, 20],
            timeoutMinutes: [1, 40320],
            raidJoinThreshold: [3, 100],
            raidWindowMs: [1000, 120000],
            raidLockdownMinutes: [1, 1440],
            nukeThreshold: [2, 20],
            nukeWindowMs: [1000, 120000],
            xpMin: [1, 100],
            xpMax: [1, 200],
            cooldownSeconds: [5, 3600],
            dailyReward: [1, 1000000],
            weeklyReward: [1, 10000000],
            workMin: [1, 1000000],
            workMax: [1, 1000000],
            workCooldownHours: [1, 168],
            autoCloseHours: [1, 8760],
            threshold: [1, 100],
            defaultVolume: [0, 100],
            maxQueueSize: [1, 1000],
          };
          const range = ranges[key];
          if (!Number.isSafeInteger(item) || !range || item < range[0] || item > range[1]) {
            res.status(400).json({ error: `Invalid ${section}.${key}.` });
            return;
          }
        }
        update[`${section}.${key}`] = item;
      }
    }
    if (!Object.keys(update).length) {
      res.status(400).json({ error: 'No supported settings were provided.' });
      return;
    }

    if (body.economy && (Object.hasOwn(body.economy, 'workMin') || Object.hasOwn(body.economy, 'workMax'))) {
      const saved = await GuildConfig.findOne({ guildId: req.guildId }).select('economy.workMin economy.workMax').lean();
      const workMin = body.economy.workMin ?? saved?.economy?.workMin ?? 25;
      const workMax = body.economy.workMax ?? saved?.economy?.workMax ?? 100;
      if (workMin > workMax) {
        res.status(400).json({ error: 'economy.workMin must not be greater than economy.workMax.' });
        return;
      }
    }
    if (body.leveling && (Object.hasOwn(body.leveling, 'xpMin') || Object.hasOwn(body.leveling, 'xpMax'))) {
      const saved = await GuildConfig.findOne({ guildId: req.guildId }).select('leveling.xpMin leveling.xpMax').lean();
      const xpMin = body.leveling.xpMin ?? saved?.leveling?.xpMin ?? 15;
      const xpMax = body.leveling.xpMax ?? saved?.leveling?.xpMax ?? 25;
      if (xpMin > xpMax) {
        res.status(400).json({ error: 'leveling.xpMin must not be greater than leveling.xpMax.' });
        return;
      }
    }

    const config = await GuildConfig.findOneAndUpdate(
      { guildId: req.guildId },
      { $set: { ...update, updatedAt: new Date() }, $setOnInsert: { guildId: req.guildId } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
    await AuditLog.create({
      guildId: req.guildId,
      actorId: req.session.user.id,
      action: 'dashboard.guild_config_updated',
      details: { fields: Object.keys(update) },
    });
    res.json({ config });
  } catch (error) {
    next(error);
  }
});

router.get('/:guildId/commands', async (req, res, next) => {
  try {
    const permissions = await CommandPermission.find({ guildId: req.guildId }).sort({ commandName: 1 }).lean();
    res.json({ permissions });
  } catch (error) {
    next(error);
  }
});

router.get('/:guildId/tickets', async (req, res, next) => {
  const status = req.query.status ?? 'closed';
  const rawLimit = req.query.limit ?? '50';
  const before = req.query.before;
  const limit = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (typeof status !== 'string' || !['open', 'closing', 'closed'].includes(status)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || (before !== undefined && (typeof before !== 'string' || !/^[a-f\d]{24}$/i.test(before)))) {
    res.status(400).json({ error: 'Use a valid ticket status and a limit between 1 and 100.' });
    return;
  }
  try {
    const filter = { guildId: req.guildId, status };
    if (before) filter._id = { $lt: before };
    const tickets = await Ticket.find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .select('_id channelId userId status subject category claimedBy createdAt closedAt transcriptId')
      .lean();
    res.json({ tickets, nextBefore: tickets.length === limit ? String(tickets[tickets.length - 1]._id) : null });
  } catch (error) {
    next(error);
  }
});

router.get('/:guildId/tickets/stats', async (req, res, next) => {
  try {
    const stats = await TicketStats.findOne({ guildId: req.guildId }).lean();
    const totals = stats || {
      created: 0,
      closed: 0,
      reopened: 0,
      claimed: 0,
      transcripts: 0,
      usersAdded: 0,
      usersRemoved: 0,
      totalResolutionMs: 0,
    };
    res.json({
      stats: {
        ...totals,
        averageResolutionMs: totals.closed ? Math.round(totals.totalResolutionMs / totals.closed) : 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:guildId/tickets/:ticketId/transcript', async (req, res, next) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.ticketId)) {
    res.status(400).json({ error: 'Invalid ticket ID.' });
    return;
  }
  try {
    const transcript = await TicketTranscript.findOne({
      ticketId: req.params.ticketId,
      guildId: req.guildId,
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!transcript) {
      res.status(404).json({ error: 'Transcript not found or expired.' });
      return;
    }
    res.json({ transcript: { ticketId: transcript.ticketId, content: transcript.content, expiresAt: transcript.expiresAt } });
  } catch (error) {
    next(error);
  }
});

router.put('/:guildId/commands/:commandName', requireSameOrigin, async (req, res, next) => {
  const commandName = req.params.commandName.toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(commandName)) {
    res.status(400).json({ error: 'Invalid command name.' });
    return;
  }
  try {
    const body = req.body || {};
    const allowed = new Set(['enabled', 'requiredRoleIds', 'allowedChannelIds', 'deniedChannelIds', 'cooldownSeconds', 'maxUses', 'windowSeconds']);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      res.status(400).json({ error: 'Unsupported command permission field.' });
      return;
    }
    if (Object.hasOwn(body, 'enabled') && typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be boolean.' });
      return;
    }
    for (const key of ['requiredRoleIds', 'allowedChannelIds', 'deniedChannelIds']) {
      if (Object.hasOwn(body, key) && (!Array.isArray(body[key]) || body[key].length > 100 || body[key].some((id) => !snowflake(id)))) {
        res.status(400).json({ error: `${key} must be an array of Discord IDs.` });
        return;
      }
    }
    for (const key of ['cooldownSeconds', 'maxUses', 'windowSeconds']) {
      if (Object.hasOwn(body, key) && body[key] !== null
        && (!Number.isSafeInteger(body[key])
          || body[key] < (key === 'maxUses' || key === 'windowSeconds' ? 1 : 0)
          || body[key] > (key === 'cooldownSeconds' ? 86400 : 2592000))) {
        res.status(400).json({ error: `${key} must be a valid integer.` });
        return;
      }
    }

    const permission = await CommandPermission.findOneAndUpdate(
      { guildId: req.guildId, commandName },
      { $set: body, $setOnInsert: { guildId: req.guildId, commandName } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
    await AuditLog.create({
      guildId: req.guildId,
      actorId: req.session.user.id,
      action: 'dashboard.command_permission_updated',
      details: { commandName, fields: Object.keys(body) },
    });
    res.json({ permission });
  } catch (error) {
    next(error);
  }
});

router.get('/:guildId/custom-commands', async (req, res, next) => {
  try {
    const commands = await CustomCommand.find({ guildId: req.guildId }).sort({ name: 1 }).lean();
    res.json({ commands });
  } catch (error) {
    next(error);
  }
});

router.put('/:guildId/custom-commands/:commandName', requireSameOrigin, async (req, res, next) => {
  const name = req.params.commandName.toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
    res.status(400).json({ error: 'Invalid custom command name.' });
    return;
  }
  const body = req.body || {};
  const allowed = new Set(['response', 'embed', 'buttons', 'enabled']);
  if (Object.keys(body).some((key) => !allowed.has(key))
    || (Object.hasOwn(body, 'response') && (typeof body.response !== 'string' || body.response.length > 2000))
    || (Object.hasOwn(body, 'enabled') && typeof body.enabled !== 'boolean')
    || (Object.hasOwn(body, 'embed') && body.embed !== null && (!body.embed || typeof body.embed !== 'object' || Array.isArray(body.embed)))
    || (Object.hasOwn(body, 'buttons') && !Array.isArray(body.buttons))) {
    res.status(400).json({ error: 'Invalid custom command settings.' });
    return;
  }
  try {
    const normalized = { ...body };
    if (Object.hasOwn(body, 'embed') && body.embed !== null) normalized.embed = normalizeEmbed(body.embed);
    if (Object.hasOwn(body, 'buttons')) normalized.buttons = normalizeButtons(body.buttons);
    const command = await CustomCommand.findOne({ guildId: req.guildId, name })
      || new CustomCommand({ guildId: req.guildId, name });
    for (const [key, value] of Object.entries(normalized)) command.set(key, value);
    await command.save();
    await AuditLog.create({
      guildId: req.guildId,
      actorId: req.session.user.id,
      action: 'dashboard.custom_command_updated',
      details: { name, fields: Object.keys(normalized) },
    });
    res.json({ command });
  } catch (error) {
    if (error instanceof TypeError || error.name === 'ValidationError') {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.delete('/:guildId/custom-commands/:commandName', requireSameOrigin, async (req, res, next) => {
  const name = req.params.commandName.toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
    res.status(400).json({ error: 'Invalid custom command name.' });
    return;
  }
  try {
    const command = await CustomCommand.findOneAndDelete({ guildId: req.guildId, name });
    if (!command) {
      res.status(404).json({ error: 'Custom command not found.' });
      return;
    }
    await AuditLog.create({
      guildId: req.guildId,
      actorId: req.session.user.id,
      action: 'dashboard.custom_command_deleted',
      details: { name },
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
