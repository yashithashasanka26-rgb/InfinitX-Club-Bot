const mongoose = require('mongoose');

const botSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  whitelistEnabled: { type: Boolean, default: false },
  updatedBy: { type: String, default: null },
}, { versionKey: false, timestamps: true });

module.exports = mongoose.models.BotSettings || mongoose.model('BotSettings', botSettingsSchema);
