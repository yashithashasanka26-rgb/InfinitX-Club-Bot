const mongoose = require('mongoose');

const suggestionSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  channelId: { type: String, required: true },
  messageId: { type: String, default: null, index: true },
  authorId: { type: String, required: true, index: true },
  text: { type: String, required: true, trim: true, minlength: 1, maxlength: 4000 },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  upvotes: { type: [String], default: [] },
  downvotes: { type: [String], default: [] },
  decidedBy: { type: String, default: null },
  decisionReason: { type: String, default: null, maxlength: 1000 },
  decidedAt: { type: Date, default: null },
}, { timestamps: true, optimisticConcurrency: true });

suggestionSchema.index(
  { guildId: 1, messageId: 1 },
  { unique: true, partialFilterExpression: { messageId: { $type: 'string' } } },
);
suggestionSchema.index({ guildId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.models.Suggestion || mongoose.model('Suggestion', suggestionSchema);
