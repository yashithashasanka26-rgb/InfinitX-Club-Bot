const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { Giveaway, GuildConfig } = require('../database/models');
const { giveawayService, parseDuration } = require('../modules/giveaways/service');
const { isModuleEnabled } = require('../utils/moduleSettings');

const data = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Create, end, or reroll a server giveaway.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((option) => option.setName('start').setDescription('Start a giveaway in this channel.')
    .addStringOption((input) => input.setName('prize').setDescription('What members can win').setRequired(true).setMaxLength(200))
    .addStringOption((input) => input.setName('duration').setDescription('Duration such as 30m, 2h, or 3d').setRequired(true).setMaxLength(10))
    .addIntegerOption((input) => input.setName('winners').setDescription('Number of winners (1–20)').setMinValue(1).setMaxValue(20))
    .addRoleOption((input) => input.setName('required-role').setDescription('Optional role required to enter'))
    .addIntegerOption((input) => input.setName('minimum-level').setDescription('Optional minimum leveling-system level').setMinValue(1).setMaxValue(10000)))
  .addSubcommand((option) => option.setName('end').setDescription('End an active giveaway immediately.')
    .addStringOption((input) => input.setName('message-id').setDescription('Giveaway announcement message ID').setRequired(true).setMaxLength(20)))
  .addSubcommand((option) => option.setName('reroll').setDescription('Select new winner(s) from remaining entrants.')
    .addStringOption((input) => input.setName('message-id').setDescription('Ended giveaway announcement message ID').setRequired(true).setMaxLength(20)));

function canManage(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

async function execute(interaction) {
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({ content: 'Giveaways can only be managed in a server.', ephemeral: true });
    return;
  }
  if (!canManage(interaction)) {
    await interaction.reply({ content: 'You need Manage Server permission to manage giveaways.', ephemeral: true });
    return;
  }
  const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
  if (!isModuleEnabled(config, 'giveaways')) {
    await interaction.reply({ content: 'Enable the Giveaways module in the dashboard first.', ephemeral: true });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'start') {
    let durationMs;
    try {
      durationMs = parseDuration(interaction.options.getString('duration', true));
    } catch (error) {
      await interaction.reply({ content: error.message, ephemeral: true });
      return;
    }
    if (!interaction.channel?.isTextBased() || interaction.channel.isThread?.()) {
      await interaction.reply({ content: 'Start giveaways in a regular server text or announcement channel, not a thread.', ephemeral: true });
      return;
    }
    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
    if (!botMember.permissionsIn(interaction.channel).has(PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks)) {
      await interaction.reply({ content: 'I need Send Messages and Embed Links permissions in this channel.', ephemeral: true });
      return;
    }
    const giveaway = await giveawayService.create({
      guild: interaction.guild,
      channel: interaction.channel,
      hostId: interaction.user.id,
      prize: interaction.options.getString('prize', true),
      durationMs,
      winnerCount: interaction.options.getInteger('winners') || 1,
      requiredRoleId: interaction.options.getRole('required-role')?.id || null,
      minimumLevel: interaction.options.getInteger('minimum-level') || null,
    });
    await interaction.reply({
      content: `Giveaway started: [view giveaway](https://discord.com/channels/${interaction.guildId}/${giveaway.channelId}/${giveaway.messageId})`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const messageId = interaction.options.getString('message-id', true);
  if (!/^\d{17,20}$/.test(messageId)) {
    await interaction.reply({ content: 'Provide a valid giveaway message ID.', ephemeral: true });
    return;
  }
  const giveaway = await Giveaway.findOne({ guildId: interaction.guildId, messageId }).select('_id status').lean();
  if (!giveaway) {
    await interaction.reply({ content: 'No giveaway was found for that message ID.', ephemeral: true });
    return;
  }
  if (subcommand === 'end') {
    const result = await giveawayService.finish(giveaway._id, { force: true, actorId: interaction.user.id });
    await interaction.reply({
      content: result.ended
        ? `Giveaway ended${result.winners.length ? `; winner${result.winners.length === 1 ? '' : 's'} selected.` : '; there were no eligible entrants.'}`
        : 'This giveaway is already ended or is being processed.',
      ephemeral: true,
    });
    return;
  }
  const result = await giveawayService.reroll(giveaway._id, { guildId: interaction.guildId, actorId: interaction.user.id });
  const response = !result.rerolled
    ? result.reason === 'no-entrants'
      ? 'There are no remaining entrants to reroll.'
      : 'This giveaway has not ended or does not exist.'
    : `Rerolled winner${result.winners.length === 1 ? '' : 's'}: ${result.winners.map((id) => `<@${id}>`).join(', ')}.`;
  await interaction.reply({
    content: response,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

module.exports = { module: 'giveaways', data, execute, canManage };
