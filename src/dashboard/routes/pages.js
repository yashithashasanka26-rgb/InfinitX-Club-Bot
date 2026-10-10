const express = require('express');
const path = require('node:path');
const { CommandPermission, GuildConfig } = require('../../database/models');
const { DISCORD_API } = require('../auth');
const { loadModules } = require('../../utils/loaders');
const { requireGuildManager, requireLogin } = require('../middleware');

const router = express.Router();

const sections = [
  { id: 'general', label: 'Overview', icon: '⌂', description: 'Server modules, command prefix, and language.' },
  { id: 'welcome', label: 'Welcome & Leave', icon: '✦', description: 'Configure join and leave messages and design the welcome card.', module: 'welcomeLeave' },
  { id: 'commands', label: 'Commands', icon: '⌘', description: 'Control command access, cooldowns, roles, and channels.' },
  { id: 'moderation', label: 'Moderation', icon: '◆', description: 'Configure moderation logs, AutoMod, raid detection, and actions.', module: 'moderation' },
  { id: 'music', label: 'Music', icon: '♫', description: 'Set playback defaults and control the bot’s active player.', module: 'music' },
  { id: 'ticketPanel', label: 'Ticket Panel', icon: '▣', description: 'Customize and deploy the support ticket panel.', module: 'tickets' },
  { id: 'economy', label: 'Economy', icon: '◈', description: 'Manage rewards, work settings, and shop items.', module: 'economy' },
  { id: 'leveling', label: 'Leveling', icon: '↗', description: 'Tune XP, cooldowns, announcements, and role rewards.', module: 'leveling' },
  { id: 'tickets', label: 'Tickets', icon: '▤', description: 'Configure support roles, categories, and auto-close.', module: 'tickets' },
  { id: 'verification', label: 'Verification', icon: '✓', description: 'Choose the verified role and verification channel.', module: 'verification' },
  { id: 'verificationPanel', label: 'Verification Panel', icon: '☑', description: 'Customize and deploy the verification message.', module: 'verification' },
  { id: 'scheduled', label: 'Scheduled Embeds', icon: '◷', description: 'Build, send, and schedule custom embed messages.' },
  { id: 'starboard', label: 'Starboard', icon: '☆', description: 'Choose where starred messages are published.', module: 'starboard' },
  { id: 'suggestions', label: 'Suggestions', icon: '◎', description: 'Set suggestion and moderation log channels.', module: 'suggestions' },
  { id: 'temporaryVoice', label: 'Temporary Voice', icon: '◖', description: 'Set the create-room voice channel and category.', module: 'temporaryVoice' },
  { id: 'ai', label: 'AI Assistant', icon: '✧', description: 'Choose whether the bot responds to mentions.', module: 'ai' },
  { id: 'analytics', label: 'Analytics', icon: '▥', description: 'Toggle server activity analytics.', module: 'analytics' },
  { id: 'giveaways', label: 'Giveaways', icon: '♧', description: 'Toggle giveaway commands and events.', module: 'giveaways' },
  { id: 'customCommands', label: 'Custom Commands', icon: '⚙', description: 'Toggle custom commands and the embed builder.', module: 'customCommands' },
];

const fields = {
  moderation: [
    { key: 'logChannelId', label: 'Moderation log channel', type: 'id' },
    { key: 'antiLink', label: 'Block links', type: 'checkbox' },
    { key: 'badWords', label: 'Blocked words and phrases', type: 'lines', help: 'One word or phrase per line.' },
    { key: 'messageAction', label: 'Automod action', type: 'select', options: ['warn', 'timeout', 'ban'] },
    { key: 'timeoutMinutes', label: 'Timeout length (minutes)', type: 'number', min: 1, max: 40320 },
    { key: 'spamThreshold', label: 'Spam message threshold', type: 'number', min: 2, max: 30 },
    { key: 'spamWindowMs', label: 'Spam detection window (ms)', type: 'number', min: 1000, max: 60000 },
    { key: 'floodThreshold', label: 'Flood message threshold', type: 'number', min: 2, max: 20 },
    { key: 'floodWindowMs', label: 'Flood detection window (ms)', type: 'number', min: 500, max: 30000 },
    { key: 'duplicateThreshold', label: 'Repeated message threshold', type: 'number', min: 2, max: 20 },
    { key: 'raidJoinThreshold', label: 'Raid joins threshold', type: 'number', min: 3, max: 100 },
    { key: 'raidWindowMs', label: 'Raid detection window (ms)', type: 'number', min: 1000, max: 120000 },
    { key: 'raidAction', label: 'Raid action', type: 'select', options: ['warn', 'timeout', 'ban'] },
    { key: 'raidLockdownEnabled', label: 'Lock channels during raids', type: 'checkbox' },
    { key: 'raidLockdownMinutes', label: 'Raid lockdown length (minutes)', type: 'number', min: 1, max: 1440 },
    { key: 'nukeProtection', label: 'Enable anti-nuke protection', type: 'checkbox' },
    { key: 'nukeThreshold', label: 'Destructive action threshold', type: 'number', min: 2, max: 20 },
    { key: 'nukeWindowMs', label: 'Anti-nuke detection window (ms)', type: 'number', min: 1000, max: 120000 },
    { key: 'nukeAction', label: 'Anti-nuke action', type: 'select', options: ['warn', 'timeout', 'ban'] },
  ],
  music: [
    { key: 'defaultVolume', label: 'Default volume (%)', type: 'number', min: 0, max: 100 },
    { key: 'maxQueueSize', label: 'Maximum queue size', type: 'number', min: 1, max: 1000 },
  ],
  ai: [
    { key: 'mentionResponses', label: 'Respond when mentioned', type: 'checkbox' },
    { key: 'greetingAutoReply', label: 'AI greeting auto-replies', type: 'checkbox' },
    { key: 'greetingTriggers', label: 'Greeting phrases', type: 'lines', help: 'One phrase per line. The AI replies only when the full message matches a phrase.' },
  ],
  economy: [
    { key: 'dailyReward', label: 'Daily reward', type: 'number', min: 1, max: 1000000 },
    { key: 'weeklyReward', label: 'Weekly reward', type: 'number', min: 1, max: 10000000 },
    { key: 'workMin', label: 'Minimum work reward', type: 'number', min: 1, max: 1000000 },
    { key: 'workMax', label: 'Maximum work reward', type: 'number', min: 1, max: 1000000 },
    { key: 'workCooldownHours', label: 'Work cooldown (hours)', type: 'number', min: 1, max: 168 },
    { key: 'items', label: 'Shop items', type: 'records', recordType: 'shop', help: 'One item per line: item ID | name | description | price.' },
  ],
  leveling: [
    { key: 'xpMin', label: 'Minimum XP per message', type: 'number', min: 1, max: 100 },
    { key: 'xpMax', label: 'Maximum XP per message', type: 'number', min: 1, max: 200 },
    { key: 'cooldownSeconds', label: 'XP cooldown (seconds)', type: 'number', min: 5, max: 3600 },
    { key: 'announceChannelId', label: 'Level-up announcement channel', type: 'id' },
    { key: 'excludedChannels', label: 'Channels excluded from XP', type: 'lines', help: 'Enter one Discord channel ID per line.' },
    { key: 'roleRewards', label: 'Level role rewards', type: 'records', recordType: 'roleReward', help: 'One reward per line: level | role ID.' },
  ],
  tickets: [
    { key: 'categoryId', label: 'Default ticket category ID', type: 'id' },
    { key: 'supportRoleId', label: 'Support role ID', type: 'id' },
    { key: 'logChannelId', label: 'Ticket log channel ID', type: 'id' },
    { key: 'autoCloseHours', label: 'Auto-close after (hours)', type: 'number', min: 1, max: 8760 },
    { key: 'categories', label: 'Ticket categories', type: 'records', recordType: 'ticketCategory', help: 'One category per line: key | label | description | category ID | support role ID.' },
  ],
  verification: [
    { key: 'enabled', label: 'Enable verification challenge', type: 'checkbox' },
    { key: 'roleId', label: 'Verified role ID', type: 'id' },
    { key: 'channelId', label: 'Verification channel ID', type: 'id' },
  ],
  starboard: [
    { key: 'channelId', label: 'Starboard channel ID', type: 'id' },
    { key: 'threshold', label: 'Required reactions', type: 'number', min: 1, max: 100 },
    { key: 'emoji', label: 'Star emoji', type: 'text', maxLength: 64 },
  ],
  suggestions: [
    { key: 'channelId', label: 'Suggestion channel ID', type: 'id' },
    { key: 'logChannelId', label: 'Decision log channel ID', type: 'id' },
  ],
  temporaryVoice: [
    { key: 'joinChannelId', label: 'Join-to-create voice channel ID', type: 'id' },
    { key: 'categoryId', label: 'New room category ID', type: 'id' },
  ],
};

router.get('/', async (req, res, next) => {
  if (!req.session.user || !req.session.accessToken) {
    res.render('home', { user: null, servers: [], error: null });
    return;
  }
  try {
    const response = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${req.session.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      if (response.status === 401) {
        req.session.destroy(() => {});
        res.render('home', { user: null, servers: [], error: 'Your Discord session expired. Please log in again.' });
        return;
      }
      throw new Error(`Discord guild lookup failed with status ${response.status}`);
    }
    const guilds = await response.json();
    if (!Array.isArray(guilds)) throw new Error('Discord guild lookup returned an invalid response.');
    const servers = guilds.filter((guild) => {
      const permissions = BigInt(guild.permissions || '0');
      return guild.owner === true || (permissions & 0x20n) !== 0n || (permissions & 0x8n) !== 0n;
    });
    res.render('home', { user: req.session.user, servers, error: null });
  } catch (error) {
    next(error);
  }
});

router.get('/servers/:guildId', requireLogin, requireGuildManager, (req, res) => {
  res.redirect(`/servers/${req.guildId}/settings/general`);
});

router.get('/servers/:guildId/settings/:section', requireLogin, requireGuildManager, async (req, res, next) => {
  try {
    const section = sections.find((entry) => entry.id === req.params.section);
    if (!section) {
      res.status(404).render('not-found', { user: req.session.user, guild: req.guild, sections, guildId: req.guildId });
      return;
    }
    const [stored, permissions] = await Promise.all([
      GuildConfig.findOne({ guildId: req.guildId }),
      section.id === 'commands'
        ? CommandPermission.find({ guildId: req.guildId }).sort({ commandName: 1 }).lean()
        : Promise.resolve([]),
    ]);
    const config = (stored || new GuildConfig({ guildId: req.guildId })).toObject({ flattenMaps: true });
    const plainConfig = {
      ...config,
      modules: config.modules instanceof Map ? Object.fromEntries(config.modules) : config.modules || {},
    };
    const commands = section.id === 'commands'
      ? loadModules(path.join(__dirname, '../../commands')).map((command) => {
        const data = command.data.toJSON();
        return {
          name: data.name,
          description: data.description,
          module: command.module || 'core',
        };
      }).sort((a, b) => a.name.localeCompare(b.name))
      : [];
    res.render('section', {
      user: req.session.user,
      guild: req.guild,
      guildId: req.guildId,
      sections,
      section,
      fields: fields[section.id] || [],
      config: plainConfig,
      permissions,
      commands,
      music: section.id === 'music' ? require('../../modules/music/service').musicService.getDashboardState(req.guildId) : null,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
