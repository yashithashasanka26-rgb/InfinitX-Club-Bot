const { EmbedBuilder } = require('discord.js');
const { GuildConfig } = require('../../database/models');
const { isModuleEnabled } = require('../../utils/moduleSettings');

function interpolateWelcomeText(template, member, now = new Date(), { includeDate = true, includeTime = true } = {}) {
  const date = includeDate
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(now)
    : '';
  const time = includeTime
    ? new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone: 'UTC' }).format(now)
    : '';
  return template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', member.displayName || member.user.username)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{memberCount}', String(member.guild.memberCount || 0))
    .replaceAll('{date}', date)
    .replaceAll('{time}', time);
}

function buildWelcomeEmbed(member, settings, type, now = new Date()) {
  const embedSettings = settings[type];
  const embed = new EmbedBuilder()
    .setColor(Number.parseInt(embedSettings.color.slice(1), 16));
  const dateTimeOptions = {
    includeDate: embedSettings.includeDate !== false,
    includeTime: embedSettings.includeTime !== false,
  };
  const title = interpolateWelcomeText(embedSettings.title, member, now, dateTimeOptions);
  const description = interpolateWelcomeText(embedSettings.description, member, now, dateTimeOptions);
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (embedSettings.footer) {
    const botUser = member.client?.user;
    embed.setFooter({
      text: interpolateWelcomeText(embedSettings.footer, member, now, dateTimeOptions),
      ...(botUser ? { iconURL: botUser.displayAvatarURL() } : {}),
    });
  }
  if (embedSettings.thumbnailUrl) embed.setThumbnail(embedSettings.thumbnailUrl);
  const imageUrl = embedSettings.imageUrl || (type === 'welcome' ? settings.backgroundImageUrl : null);
  if (imageUrl) embed.setImage(imageUrl);
  return embed;
}

async function sendWelcomeMessage(member, type) {
  if (!['welcome', 'leave'].includes(type)) throw new TypeError('Welcome message type must be welcome or leave.');
  const config = await GuildConfig.findOne({ guildId: member.guild.id }).lean();
  if (!isModuleEnabled(config, 'welcomeLeave')) return false;

  const settings = config?.welcomeLeave;
  const enabledKey = type === 'welcome' ? 'welcomeEnabled' : 'leaveEnabled';
  const channelKey = type === 'welcome' ? 'welcomeChannelId' : 'leaveChannelId';
  if (!settings?.[enabledKey] || !settings[channelKey]) return false;

  const channel = await member.guild.channels.fetch(settings[channelKey]);
  if (!channel?.isTextBased() || typeof channel.send !== 'function') {
    throw new Error(`Configured ${type} channel is unavailable or is not a text channel.`);
  }
  await channel.send({
    embeds: [buildWelcomeEmbed(member, settings, type)],
    allowedMentions: { parse: [], users: [member.id] },
  });
  return true;
}

module.exports = { buildWelcomeEmbed, interpolateWelcomeText, sendWelcomeMessage };
