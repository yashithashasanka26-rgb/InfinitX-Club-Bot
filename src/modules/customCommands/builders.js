const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const EMBED_KEYS = new Set(['title', 'description', 'color', 'footer', 'fields']);
const BUTTON_KEYS = new Set(['label', 'url']);
const MAX_BUTTONS = 5;

function normalizeEmbed(input) {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      throw new TypeError('Embed must be valid JSON.');
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !EMBED_KEYS.has(key))) {
    throw new TypeError('Embed must be an object with title, description, color, footer, and/or fields.');
  }

  const embed = {};
  for (const key of ['title', 'description', 'footer']) {
    if (input[key] === undefined) continue;
    const max = key === 'title' ? 256 : key === 'description' ? 4096 : 2048;
    if (typeof input[key] !== 'string' || input[key].length > max) {
      throw new TypeError(`Embed ${key} must be a string no longer than ${max} characters.`);
    }
    if (input[key].trim()) embed[key] = input[key].trim();
  }
  if (input.color !== undefined && input.color !== null && input.color !== '') {
    const color = typeof input.color === 'string'
      ? (/^(?:#)?[0-9a-f]{6}$/i.test(input.color) ? Number.parseInt(input.color.replace('#', ''), 16) : NaN)
      : input.color;
    if (!Number.isInteger(color) || color < 0 || color > 0xffffff) {
      throw new TypeError('Embed color must be a 6-digit hexadecimal color or an integer from 0 to 16777215.');
    }
    embed.color = color;
  }
  if (input.fields !== undefined) {
    if (!Array.isArray(input.fields) || input.fields.length > 25) {
      throw new TypeError('Embed fields must be an array with at most 25 entries.');
    }
    embed.fields = input.fields.map((field) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)
        || Object.keys(field).some((key) => !['name', 'value', 'inline', '_id'].includes(key))
        || typeof field.name !== 'string' || !field.name.trim() || field.name.length > 256
        || typeof field.value !== 'string' || !field.value.trim() || field.value.length > 1024
        || (field.inline !== undefined && typeof field.inline !== 'boolean')) {
        throw new TypeError('Each embed field needs a name (max 256), value (max 1024), and optional boolean inline flag.');
      }
      return { name: field.name.trim(), value: field.value.trim(), inline: field.inline === true };
    });
  }
  if (!embed.title && !embed.description && !embed.footer && !embed.fields?.length) {
    throw new TypeError('Provide at least one non-empty embed title, description, footer, or field.');
  }
  const totalText = (embed.title?.length || 0)
    + (embed.description?.length || 0)
    + (embed.footer?.length || 0)
    + (embed.fields || []).reduce((total, field) => total + field.name.length + field.value.length, 0);
  if (totalText > 6000) throw new TypeError('Embed text cannot exceed 6000 characters in total.');
  return embed;
}

function normalizeButtons(input) {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      throw new TypeError('Buttons must be valid JSON.');
    }
  }
  if (input === undefined || input === null || input === '') return [];
  if (!Array.isArray(input) || input.length > MAX_BUTTONS) {
    throw new TypeError(`Buttons must be an array with at most ${MAX_BUTTONS} link buttons.`);
  }
  return input.map((button) => {
    if (!button || typeof button !== 'object' || Array.isArray(button)
      || Object.keys(button).some((key) => !BUTTON_KEYS.has(key))
      || typeof button.label !== 'string' || !button.label.trim() || button.label.length > 80
      || typeof button.url !== 'string' || button.url.length > 512) {
      throw new TypeError('Each button requires a label (max 80 characters) and an HTTPS link URL.');
    }
    let url;
    try {
      url = new URL(button.url);
    } catch {
      throw new TypeError('Each button URL must be a valid HTTPS link.');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new TypeError('Each button URL must be a valid HTTPS link.');
    }
    return { label: button.label.trim(), url: url.toString() };
  });
}

function createEmbedPayload(embedInput, buttonInput = []) {
  const embed = normalizeEmbed(embedInput);
  const buttons = normalizeButtons(buttonInput);
  const builder = new EmbedBuilder();
  if (embed.title) builder.setTitle(embed.title);
  if (embed.description) builder.setDescription(embed.description);
  if (embed.color !== undefined) builder.setColor(embed.color);
  if (embed.footer) builder.setFooter({ text: embed.footer });
  if (embed.fields?.length) builder.addFields(embed.fields);

  const components = createButtonRows(buttons);
  return { embed, buttons, payload: { embeds: [builder], components, allowedMentions: { parse: [] } } };
}

function createButtonRows(buttonInput = []) {
  const buttons = normalizeButtons(buttonInput);
  if (!buttons.length) return [];
  return [new ActionRowBuilder().addComponents(buttons.map((button) => (
    new ButtonBuilder()
      .setLabel(button.label)
      .setStyle(ButtonStyle.Link)
      .setURL(button.url)
  )))];
}

module.exports = {
  BUTTON_KEYS,
  EMBED_KEYS,
  MAX_BUTTONS,
  createEmbedPayload,
  createButtonRows,
  normalizeButtons,
  normalizeEmbed,
};
