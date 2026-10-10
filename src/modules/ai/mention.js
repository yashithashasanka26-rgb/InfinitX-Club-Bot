const { aiService, AiServiceError } = require('./service');
const { isModuleEnabled } = require('../../utils/moduleSettings');

const MAX_REPLY_CHARS = 1800;

function splitReply(text) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > MAX_REPLY_CHARS) {
    let splitAt = remaining.lastIndexOf('\n', MAX_REPLY_CHARS);
    if (splitAt < MAX_REPLY_CHARS / 2) splitAt = MAX_REPLY_CHARS;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function respondToMention(message, config, service = aiService) {
  const botId = message.client.user?.id;
  if (!botId || !message.mentions.users.has(botId)
    || !isModuleEnabled(config, 'ai') || config.ai?.mentionResponses !== true) return false;

  const mention = new RegExp(`<@!?${botId}>`, 'g');
  const prompt = message.content.replace(mention, '').trim();
  if (!prompt) {
    await message.reply({
      content: 'Mention me with a question to chat. You can also use `/ai chat`.',
      allowedMentions: { parse: [], repliedUser: false },
    });
    return true;
  }

  const response = await service.chat({
    guildId: message.guild.id,
    userId: message.author.id,
    input: prompt,
  });
  const chunks = splitReply(response);
  for (let index = 0; index < chunks.length; index += 1) {
    const payload = {
      content: chunks[index],
      allowedMentions: { parse: [], repliedUser: false },
    };
    if (index === 0) await message.reply(payload);
    else await message.channel.send(payload);
  }
  return true;
}

async function respondToGreeting(message, config, service = aiService) {
  if (!isModuleEnabled(config, 'ai') || config.ai?.greetingAutoReply !== true
    || message.mentions.users.has(message.client.user?.id)) return false;
  const normalized = message.content.trim().toLocaleLowerCase().replace(/[.!?,;:]+$/g, '');
  const triggers = config.ai.greetingTriggers || [];
  if (!triggers.some((trigger) => normalized === trigger.trim().toLocaleLowerCase().replace(/[.!?,;:]+$/g, ''))) return false;
  const response = await service.chat({
    guildId: message.guild.id,
    userId: message.author.id,
    input: `Reply briefly and warmly to this greeting: "${normalized}". Do not use markdown or mention anyone.`,
  });
  for (const [index, chunk] of splitReply(response).entries()) {
    const payload = { content: chunk, allowedMentions: { parse: [], repliedUser: false } };
    if (index === 0) await message.reply(payload);
    else await message.channel.send(payload);
  }
  return true;
}

function getMentionErrorMessage(error) {
  return error instanceof AiServiceError
    ? error.publicMessage
    : 'The AI assistant could not respond right now. Please try again later.';
}

module.exports = { getMentionErrorMessage, respondToGreeting, respondToMention, splitReply };
