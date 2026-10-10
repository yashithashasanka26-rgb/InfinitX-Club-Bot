const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { CustomCommand, GuildConfig } = require('../database/models');
const { normalizeButtons, normalizeEmbed } = require('../modules/customCommands/builders');

const data = new SlashCommandBuilder()
  .setName('custom-command')
  .setDescription('Manage this server’s prefix-triggered custom commands.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((option) => option.setName('set').setDescription('Create or update a custom command.')
    .addStringOption((input) => input.setName('name').setDescription('Trigger name (used after the server prefix)').setRequired(true).setMaxLength(32))
    .addStringOption((input) => input.setName('response').setDescription('Plain-text response (optional)').setMaxLength(2000))
    .addStringOption((input) => input.setName('embed').setDescription('Embed JSON: title, description, color, footer, fields').setMaxLength(4000))
    .addStringOption((input) => input.setName('buttons').setDescription('Link button JSON array: [{\"label\":\"Website\",\"url\":\"https://...\"}]').setMaxLength(2000)))
  .addSubcommand((option) => option.setName('delete').setDescription('Delete a custom command.')
    .addStringOption((input) => input.setName('name').setDescription('Custom command trigger name').setRequired(true).setMaxLength(32)))
  .addSubcommand((option) => option.setName('list').setDescription('List this server’s custom commands.'));

function hasManageGuild(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

async function execute(interaction) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: 'Custom commands can only be managed in a server.', ephemeral: true });
    return;
  }
  if (!hasManageGuild(interaction)) {
    await interaction.reply({ content: 'You need Manage Server permission to manage custom commands.', ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'list') {
    const [commands, config] = await Promise.all([
      CustomCommand.find({ guildId: interaction.guildId }).sort({ name: 1 }).limit(25).lean(),
      GuildConfig.findOne({ guildId: interaction.guildId }).select('prefix').lean(),
    ]);
    const prefix = config?.prefix || '!';
    const body = commands.length
      ? commands.map((command) => `\`${prefix}${command.name}\` — ${command.enabled ? 'enabled' : 'disabled'}`).join('\n')
      : 'No custom commands have been configured.';
    await interaction.reply({
      content: `**Custom commands**\n${body}`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const name = interaction.options.getString('name', true).trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
    await interaction.reply({ content: 'Command names may contain only letters, numbers, underscores, and hyphens.', ephemeral: true });
    return;
  }
  if (subcommand === 'delete') {
    const deleted = await CustomCommand.findOneAndDelete({ guildId: interaction.guildId, name });
    await interaction.reply({
      content: deleted ? `Deleted custom command \`${name}\`.` : `Custom command \`${name}\` was not found.`,
      ephemeral: true,
    });
    return;
  }

  const response = interaction.options.getString('response') || '';
  const embedInput = interaction.options.getString('embed');
  const buttonsInput = interaction.options.getString('buttons');
  if (!response.trim() && !embedInput && !buttonsInput) {
    await interaction.reply({ content: 'Provide a response, an embed JSON object, or link buttons.', ephemeral: true });
    return;
  }

  let embed = null;
  let buttons = [];
  try {
    if (embedInput) embed = normalizeEmbed(embedInput);
    if (buttonsInput) buttons = normalizeButtons(buttonsInput);
  } catch (error) {
    await interaction.reply({ content: error.message, ephemeral: true });
    return;
  }

  if (!response.trim() && !embed && !buttons.length) {
    await interaction.reply({ content: 'Provide a non-empty response, embed, or at least one link button.', ephemeral: true });
    return;
  }

  const command = await CustomCommand.findOneAndUpdate(
    { guildId: interaction.guildId, name },
    { $set: { response, embed, buttons, enabled: true }, $setOnInsert: { guildId: interaction.guildId, name } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
  await interaction.reply({
    content: `Custom command \`${name}\` saved. Members can trigger it using the server prefix followed by \`${name}\`.`,
    ephemeral: true,
  });
  return command;
}

module.exports = { module: 'customCommands', data, execute, hasManageGuild };
