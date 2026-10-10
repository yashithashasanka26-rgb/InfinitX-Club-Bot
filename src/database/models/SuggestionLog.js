const mongoose = require('mongoose');

const suggestionLogSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  suggestionId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  actorId: { type: String, required: true },
  action: { type: String, enum: ['submitted', 'upvote', 'downvote', 'approved', 'rejected'], required: true },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 365 },
}, { versionKey: false });

suggestionLogSchema.index({ guildId: 1, createdAt: -1 });

module.exports = mongoose.models.SuggestionLog || mongoose.model('SuggestionLog', suggestionLogSchema);
