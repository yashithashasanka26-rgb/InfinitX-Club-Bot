const { CommandPermission, GuildConfig } = require('../database/models');
const { isModuleEnabled } = require('../utils/moduleSettings');

const cooldowns = new Map();
const usageWindows = new Map();

async function checkCommandPolicy(interaction, command) {
  if (!interaction.guildId) return { allowed: true };

  const [config, policy] = await Promise.all([
    GuildConfig.findOne({ guildId: interaction.guildId }).lean(),
    CommandPermission.findOne({ guildId: interaction.guildId, commandName: command.data.name }).lean(),
  ]);

  const moduleName = command.module;
  if (moduleName && !isModuleEnabled(config, moduleName)) {
    return { allowed: false, reason: 'This module is disabled in this server.' };
  }
  if (!policy) return { allowed: true };
  if (!policy.enabled) return { allowed: false, reason: 'This command is disabled in this server.' };
  if (policy.allowedChannelIds.length && !policy.allowedChannelIds.includes(interaction.channelId)) {
    return { allowed: false, reason: 'This command is not allowed in this channel.' };
  }
  if (policy.deniedChannelIds.includes(interaction.channelId)) {
    return { allowed: false, reason: 'This command is not allowed in this channel.' };
  }

  const roles = interaction.member?.roles;
  const hasRole = (id) => Array.isArray(roles) ? roles.includes(id) : Boolean(roles?.cache?.has(id));
  if (policy.requiredRoleIds.length && !policy.requiredRoleIds.some(hasRole)) {
    return { allowed: false, reason: 'You do not have a required role for this command.' };
  }

  const now = Date.now();
  const scope = `${interaction.guildId}:${command.data.name}:${interaction.user.id}`;
  const cooldownMs = policy.cooldownSeconds * 1000;
  const lastUsed = cooldowns.get(scope) || 0;
  if (cooldownMs && now - lastUsed < cooldownMs) {
    const seconds = Math.ceil((cooldownMs - (now - lastUsed)) / 1000);
    return { allowed: false, reason: `Please wait ${seconds}s before using this command again.` };
  }

  if (policy.maxUses !== null) {
    const windowStart = now - policy.windowSeconds * 1000;
    const current = usageWindows.get(scope);
    const usage = !current || current.startedAt < windowStart ? { startedAt: now, count: 0 } : current;
    if (usage.count >= policy.maxUses) {
      return { allowed: false, reason: 'You have reached this command’s usage limit.' };
    }
    usageWindows.set(scope, { ...usage, count: usage.count + 1 });
  }
  cooldowns.set(scope, now);
  return { allowed: true };
}

module.exports = { checkCommandPolicy };
