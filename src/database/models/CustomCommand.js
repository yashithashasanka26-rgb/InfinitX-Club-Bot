const mongoose = require('mongoose');

const embedSchema = new mongoose.Schema({
  title: { type: String, maxlength: 256, default: '' },
  description: { type: String, maxlength: 4096, default: '' },
  color: { type: Number, min: 0, max: 0xffffff, default: null },
  footer: { type: String, maxlength: 2048, default: '' },
  fields: {
    type: [{ name: { type: String, required: true, maxlength: 256 }, value: { type: String, required: true, maxlength: 1024 }, inline: { type: Boolean, default: false } }],
    default: [],
    validate: (fields) => fields.length <= 25,
  },
}, { _id: false });

const buttonSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true, maxlength: 80 },
  url: {
    type: String,
    required: true,
    maxlength: 512,
    validate: {
      validator(value) {
        try {
          const parsed = new URL(value);
          return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
        } catch {
          return false;
        }
      },
      message: 'Button URL must be a valid HTTPS URL without credentials.',
    },
  },
}, { _id: false });

const customCommandSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  name: { type: String, required: true, lowercase: true, match: /^[a-z0-9_-]{1,32}$/ },
  response: { type: String, default: '', maxlength: 2000 },
  embed: { type: embedSchema, default: null },
  buttons: {
    type: [buttonSchema],
    default: [],
    validate: (buttons) => buttons.length <= 5,
  },
  enabled: { type: Boolean, default: true },
}, { timestamps: true, versionKey: false });

customCommandSchema.index({ guildId: 1, name: 1 }, { unique: true });
customCommandSchema.pre('validate', function requireOutput() {
  const embed = this.embed;
  const hasEmbedContent = embed && (
    embed.title?.trim()
    || embed.description?.trim()
    || embed.footer?.trim()
    || embed.fields?.length
  );
  if (!this.response?.trim() && !hasEmbedContent && !this.buttons?.length) {
    this.invalidate('response', 'A response, non-empty embed, or link button is required.');
  }
});

module.exports = mongoose.models.CustomCommand || mongoose.model('CustomCommand', customCommandSchema);
