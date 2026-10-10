const { SlashCommandBuilder } = require('discord.js');
const { ownerService, isBotOwner } = require('../modules/owner/service');
const logger = require('../utils/logger');

const data = new SlashCommandBuilder()
  .setName('owner')
  .setDescription('Private global bot developer controls.')
  .addSubcommand((option) => option.setName('status').setDescription('Show server and member totals.'))
  .addSubcommand((option) => option.setName('monitor').setDescription('Show process, memory, gateway, and host information.'))
  .addSubcommand((option) => option.setName('announce').setDescription('Send an announcement to server system channels.')
    .addStringOption((input) => input.setName('message').setDescription('Announcement text; mentions are disabled').setRequired(true).setMaxLength(1900))
    .addBooleanOption((input) => input.setName('confirm').setDescription('Confirm global delivery to all available system channels').setRequired(true)))
  .addSubcommand((option) => option.setName('restart').setDescription('Gracefully stop for restart by the process supervisor.')
    .addBooleanOption((input) => input.setName('confirm').setDescription('Confirm that the bot should stop').setRequired(true)))
  .addSubcommand((option) => option.setName('shutdown').setDescription('Gracefully shut down the bot.')
    .addBooleanOption((input) => input.setName('confirm').setDescription('Confirm that the bot should stop').setRequired(true)))
  .addSubcommandGroup((group) => group.setName('blacklist').setDescription('Block a user or server from using the bot.')
    .addSubcommand((option) => option.setName('add').setDescription('Add a user or server to the blacklist.')
      .addStringOption((input) => input.setName('type').setDescription('Target type').setRequired(true)
        .addChoices({ name: 'User', value: 'user' }, { name: 'Server', value: 'guild' }))
      .addStringOption((input) => input.setName('id').setDescription('Discord user or server ID').setRequired(true).setMinLength(17).setMaxLength(20))
      .addStringOption((input) => input.setName('reason').setDescription('Optional internal reason').setMaxLength(500)))
    .addSubcommand((option) => option.setName('remove').setDescription('Remove a user or server from the blacklist.')
      .addStringOption((input) => input.setName('type').setDescription('Target type').setRequired(true)
        .addChoices({ name: 'User', value: 'user' }, { name: 'Server', value: 'guild' }))
      .addStringOption((input) => input.setName('id').setDescription('Discord user or server ID').setRequired(true).setMinLength(17).setMaxLength(20))))
  .addSubcommandGroup((group) => group.setName('whitelist').setDescription('Manage allowlists and restricted mode.')
    .addSubcommand((option) => option.setName('add').setDescription('Allow a user or server.')
      .addStringOption((input) => input.setName('type').setDescription('Target type').setRequired(true)
        .addChoices({ name: 'User', value: 'user' }, { name: 'Server', value: 'guild' }))
      .addStringOption((input) => input.setName('id').setDescription('Discord user or server ID').setRequired(true).setMinLength(17).setMaxLength(20))
      .addStringOption((input) => input.setName('reason').setDescription('Optional internal reason').setMaxLength(500)))
    .addSubcommand((option) => option.setName('remove').setDescription('Remove a user or server from the allowlist.')
      .addStringOption((input) => input.setName('type').setDescription('Target type').setRequired(true)
        .addChoices({ name: 'User', value: 'user' }, { name: 'Server', value: 'guild' }))
      .addStringOption((input) => input.setName('id').setDescription('Discord user or server ID').setRequired(true).setMinLength(17).setMaxLength(20)))
    .addSubcommand((option) => option.setName('mode').setDescription('Enable or disable allowlist-only bot access.')
      .addBooleanOption((input) => input.setName('enabled').setDescription('When enabled, only allowlisted users or servers can use the bot').setRequired(true))));

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function execute(interaction) {
  if (!isBotOwner(interaction.client, interaction.user.id)) {
    await interaction.reply({ content: 'This command is restricted to bot developers.', ephemeral: true });
    return;
  }
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  if (group) {
    if (group === 'blacklist' || (group === 'whitelist' && subcommand !== 'mode')) {
      const action = group;
      const type = interaction.options.getString('type', true);
      const targetId = interaction.options.getString('id', true);
      if (subcommand === 'add') {
        await ownerService.setAccess(action, type, targetId, interaction.user.id, interaction.options.getString('reason'));
        await interaction.reply({ content: `Added ${type} \`${targetId}\` to the ${action}.`, ephemeral: true });
        return;
      }
      const removed = await ownerService.removeAccess(action, type, targetId);
      await interaction.reply({
        content: removed ? `Removed ${type} \`${targetId}\` from the ${action}.` : `That ${type} was not on the ${action}.`,
        ephemeral: true,
      });
      return;
    }
    if (group === 'whitelist' && subcommand === 'mode') {
      const enabled = interaction.options.getBoolean('enabled', true);
      await ownerService.setWhitelistMode(enabled, interaction.user.id);
      await interaction.reply({
        content: `Allowlist-only access is now ${enabled ? 'enabled' : 'disabled'}.`,
        ephemeral: true,
      });
      return;
    }
  }

  if (subcommand === 'status' || subcommand === 'monitor') {
    const stats = ownerService.getSystemStats(interaction.client);
    const memory = stats.memory;
    const shardLines = stats.shardStatuses.map((shard) => `Shard ${shard.id}: ${shard.status}`).join('\n') || 'No shard status available.';
    await interaction.reply({
      content: [
        `**Bot totals**\nServers: ${stats.guilds}\nApproximate member count (summed per server): ${stats.approximateMembers.toLocaleString()}`,
        `**Runtime**\nUptime: ${stats.uptimeSeconds}s\nGateway ping: ${stats.websocketPingMs ?? 'unknown'}ms\nProcess memory: RSS ${formatBytes(memory.rss)}, heap ${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)}`,
        `**Host**\nNode ${stats.nodeVersion} • ${stats.platform}/${stats.architecture}\nCPU cores: ${stats.cpuCount} • Host uptime: ${stats.hostUptimeSeconds}s\nLoad average: ${stats.loadAverage.map((value) => value.toFixed(2)).join(', ')}`,
        `**Shards**\n${shardLines}`,
      ].join('\n\n'),
      ephemeral: true,
    });
    return;
  }

  if (subcommand === 'announce') {
    if (!interaction.options.getBoolean('confirm', true)) {
      await interaction.reply({ content: 'Global announcement cancelled.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const results = await ownerService.announceGlobally(
      interaction.client,
      interaction.options.getString('message', true),
    );
    await interaction.editReply(`Announcement complete: sent to ${results.sent}; skipped ${results.skipped}; failed ${results.failed}.`);
    return;
  }

  if (subcommand === 'restart' || subcommand === 'shutdown') {
    if (!interaction.options.getBoolean('confirm', true)) {
      await interaction.reply({ content: `${subcommand === 'restart' ? 'Restart' : 'Shutdown'} cancelled.`, ephemeral: true });
      return;
    }
    if (subcommand === 'restart' && !process.env.PROCESS_MANAGER) {
      await interaction.reply({
        content: 'No PROCESS_MANAGER is configured. Restart requires a supervisor such as systemd, PM2, or Docker to relaunch the bot process.',
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content: subcommand === 'restart'
        ? 'Graceful restart requested. The process supervisor must relaunch the bot.'
        : 'Graceful shutdown requested.',
      ephemeral: true,
    });
    setTimeout(() => {
      ownerService.stop(interaction.client, subcommand).catch((error) => {
        logger.error('Owner requested bot shutdown failed', { mode: subcommand, error: error.message });
        process.exitCode = 1;
      });
    }, 1000);
  }
}

module.exports = {
  ownerOnly: true,
  data,
  execute,
  formatBytes,
};
