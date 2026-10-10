const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { aiService, AiServiceError } = require('../modules/ai/service');
const { getStaffTicketContext, TicketAiError } = require('../modules/ai/tickets');
const logger = require('../utils/logger');

const commandData = new SlashCommandBuilder()
  .setName('ai')
  .setDescription('Ask the AI assistant or use its staff tools.')
  .addSubcommand((option) => option.setName('chat').setDescription('Ask the AI assistant a question.')
    .addStringOption((input) => input.setName('prompt').setDescription('Your question').setRequired(true).setMaxLength(4000)))
  .addSubcommand((option) => option.setName('ticket-summary').setDescription('Summarize this ticket for support staff.'))
  .addSubcommand((option) => option.setName('ticket-reply').setDescription('Draft a staff reply to this ticket.'))
  .addSubcommand((option) => option.setName('moderate').setDescription('Get an advisory analysis of a message.')
    .addStringOption((input) => input.setName('text').setDescription('Message text to analyze').setRequired(true).setMaxLength(3000)))
  .addSubcommand((option) => option.setName('embed').setDescription('Generate a Discord embed preview.')
    .addStringOption((input) => input.setName('topic').setDescription('Topic and details for the embed').setRequired(true).setMaxLength(3000)))
  .addSubcommand((option) => option.setName('announcement').setDescription('Draft an announcement preview.')
    .addStringOption((input) => input.setName('details').setDescription('Announcement details, facts, and tone').setRequired(true).setMaxLength(3000)));

function splitDiscordText(text, limit = 1900) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < limit / 2) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ['The AI did not return a response.'];
}

async function defer(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
}

async function respondText(interaction, text) {
  const chunks = splitDiscordText(text);
  await interaction.editReply({ content: chunks[0], allowedMentions: { parse: [] } });
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, ephemeral: true, allowedMentions: { parse: [] } });
  }
}

async function execute(interaction) {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'The AI assistant can only be used in a server.', ephemeral: true });
    return;
  }
  const subcommand = interaction.options.getSubcommand();
  const scope = { guildId: interaction.guildId, userId: interaction.user.id };
  await defer(interaction);
  try {
    if (subcommand === 'chat') {
      const response = await aiService.chat({
        ...scope,
        input: interaction.options.getString('prompt', true),
      });
      await respondText(interaction, response);
      return;
    }
    if (subcommand === 'ticket-summary' || subcommand === 'ticket-reply') {
      const { context } = await getStaffTicketContext(interaction);
      const response = subcommand === 'ticket-summary'
        ? await aiService.summarizeTicket({ ...scope, input: context })
        : await aiService.draftTicketReply({ ...scope, input: context });
      await respondText(interaction, `${subcommand === 'ticket-summary' ? '**Ticket summary**' : '**Draft reply — review before sending**'}\n${response}`);
      return;
    }
    if (subcommand === 'moderate') {
      const result = await aiService.analyzeModeration({
        ...scope,
        input: interaction.options.getString('text', true),
      });
      const embed = new EmbedBuilder()
        .setColor(result.label === 'high-risk' ? 0xed4245 : result.label === 'review' ? 0xfee75c : 0x57f287)
        .setTitle('Advisory moderation analysis')
        .addFields(
          { name: 'Assessment', value: result.label, inline: true },
          { name: 'Confidence', value: `${Math.round(result.confidence * 100)}%`, inline: true },
          { name: 'Reason', value: result.reason.slice(0, 1024) || 'No additional details.' },
        )
        .setFooter({ text: 'AI analysis is advisory; review context before taking action.' });
      await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    }
    if (subcommand === 'embed') {
      const content = await aiService.createEmbedContent({
        ...scope,
        input: interaction.options.getString('topic', true),
      });
      const embed = new EmbedBuilder()
        .setColor(content.color)
        .setTitle(content.title || 'Generated embed')
        .setDescription(content.description || ' ')
        .setFooter({ text: 'AI-generated preview — review before publishing.' });
      await interaction.editReply({ content: 'Embed preview:', embeds: [embed], allowedMentions: { parse: [] } });
      return;
    }
    if (subcommand === 'announcement') {
      const announcement = await aiService.createAnnouncement({
        ...scope,
        input: interaction.options.getString('details', true),
      });
      await respondText(interaction, `**Announcement draft — review before publishing**\n${announcement}`);
      return;
    }
    throw new Error(`Unsupported AI command: ${subcommand}`);
  } catch (error) {
    if (error instanceof AiServiceError) {
      await interaction.editReply({ content: error.publicMessage, allowedMentions: { parse: [] } });
      return;
    }
    if (error instanceof TicketAiError) {
      await interaction.editReply({ content: error.message, allowedMentions: { parse: [] } });
      return;
    }
    logger.error('AI command failed', {
      command: subcommand,
      guildId: interaction.guildId,
      error: error.message,
    });
    await interaction.editReply({
      content: 'The AI request failed. Please try again later.',
      allowedMentions: { parse: [] },
    });
  }
}

module.exports = {
  module: 'ai',
  data: commandData,
  execute,
  splitDiscordText,
};
