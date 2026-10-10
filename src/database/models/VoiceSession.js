const mongoose = require('mongoose');

const voiceSessionSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  channelId: { type: String, required: true },
  joinedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true, versionKey: false });

voiceSessionSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.models.VoiceSession || mongoose.model('VoiceSession', voiceSessionSchema);
