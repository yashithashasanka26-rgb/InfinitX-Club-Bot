const mongoose = require('mongoose');

const starboardEntrySchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  sourceChannelId: { type: String, required: true },
  sourceMessageId: { type: String, required: true },
  starboardChannelId: { type: String, required: true },
  starboardMessageId: { type: String, required: true },
  count: { type: Number, required: true, min: 1 },
}, { timestamps: true, versionKey: false });

starboardEntrySchema.index({ guildId: 1, sourceMessageId: 1 }, { unique: true });

module.exports = mongoose.models.StarboardEntry || mongoose.model('StarboardEntry', starboardEntrySchema);
