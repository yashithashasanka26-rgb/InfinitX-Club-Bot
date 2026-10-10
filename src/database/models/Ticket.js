const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  userId: { type: String, required: true },
  status: { type: String, enum: ['open', 'closing', 'closed'], default: 'open' },
  subject: { type: String, maxlength: 200, default: '' },
  category: { type: String, maxlength: 50, default: 'general' },
  claimedBy: { type: String, default: null },
  addedUserIds: { type: [String], default: [] },
  closedBy: { type: String, default: null },
  transcriptId: { type: mongoose.Schema.Types.ObjectId, default: null },
  closingAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

ticketSchema.index({ guildId: 1, channelId: 1 }, { unique: true });
ticketSchema.index(
  { guildId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['open', 'closing'] } } },
);

module.exports = mongoose.models.Ticket || mongoose.model('Ticket', ticketSchema);
