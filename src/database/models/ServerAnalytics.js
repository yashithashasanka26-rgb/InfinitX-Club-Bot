const mongoose = require('mongoose');

const serverAnalyticsSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  joins: { type: Number, min: 0, default: 0 },
  leaves: { type: Number, min: 0, default: 0 },
  messages: { type: Number, min: 0, default: 0 },
  voiceSeconds: { type: Number, min: 0, default: 0 },
  voiceSessions: { type: Number, min: 0, default: 0 },
}, { timestamps: true, versionKey: false });

serverAnalyticsSchema.index({ guildId: 1, date: 1 }, { unique: true });
serverAnalyticsSchema.index({ guildId: 1, date: -1 });

module.exports = mongoose.models.ServerAnalytics || mongoose.model('ServerAnalytics', serverAnalyticsSchema);
