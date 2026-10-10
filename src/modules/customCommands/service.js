const { CustomCommand } = require('../../database/models');
const { isModuleEnabled } = require('../../utils/moduleSettings');
const { createButtonRows, createEmbedPayload } = require('./builders');

function getCustomCommandName(content, prefix) {
  if (typeof content !== 'string' || typeof prefix !== 'string' || !prefix
    || !content.startsWith(prefix)) return null;
  const name = content.slice(prefix.length).trim().split(/\s+/, 1)[0]?.toLowerCase();
  return name && /^[a-z0-9_-]{1,32}$/.test(name) ? name : null;
}

async function executeCustomCommand(message, config) {
  if (!isModuleEnabled(config, 'customCommands')) return false;
  const name = getCustomCommandName(message.content, config.prefix);
  if (!name) return false;

  const command = await CustomCommand.findOne({
    guildId: message.guild.id,
    name,
    enabled: true,
  }).lean();
  if (!command) return false;
  const payload = {
    content: command.response || undefined,
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  };
  if (command.embed && (command.embed.title || command.embed.description || command.embed.footer || command.embed.fields?.length)) {
    const built = createEmbedPayload(command.embed, command.buttons || []);
    payload.embeds = built.payload.embeds;
    payload.components = built.payload.components;
  } else payload.components = createButtonRows(command.buttons || []);
  await message.reply(payload);
  return true;
}

module.exports = { executeCustomCommand, getCustomCommandName };
