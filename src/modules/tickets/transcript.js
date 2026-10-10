const MAX_MESSAGES = 5000;
const MAX_TRANSCRIPT_CHARS = 8_000_000;

function formatTranscript(messages, { guildName, channelName }) {
  const lines = [
    `Transcript: ${guildName} / #${channelName}`,
    `Messages included: ${messages.length}`,
    '',
  ];
  let length = lines[0].length + lines[1].length + 2;

  for (const message of messages) {
    const attachments = [...message.attachments.values()].map((attachment) => attachment.url);
    const embeds = message.embeds.flatMap((embed) => [embed.title, embed.description].filter(Boolean));
    const body = [message.content, ...embeds, ...attachments].filter(Boolean).join('\n');
    const line = `[${new Date(message.createdTimestamp).toISOString()}] ${message.author.tag}: ${body || '[no text]'}`;
    if (length + line.length + 1 > MAX_TRANSCRIPT_CHARS) {
      lines.push('[Transcript truncated at size limit.]');
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }

  return lines.join('\n').slice(0, MAX_TRANSCRIPT_CHARS);
}

async function createTranscript(channel) {
  const messages = [];
  let before;
  while (messages.length < MAX_MESSAGES) {
    const page = await channel.messages.fetch({
      limit: Math.min(100, MAX_MESSAGES - messages.length),
      ...(before ? { before } : {}),
    });
    if (page.size === 0) break;
    messages.push(...page.values());
    before = page.last().id;
    if (page.size < 100) break;
  }

  messages.sort((left, right) => left.createdTimestamp - right.createdTimestamp);
  return formatTranscript(messages, {
    guildName: channel.guild.name,
    channelName: channel.name,
  });
}

module.exports = { createTranscript, formatTranscript, MAX_TRANSCRIPT_CHARS, MAX_MESSAGES };
