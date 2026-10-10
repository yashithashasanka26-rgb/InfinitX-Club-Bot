const mongoose = require('mongoose');

const ticketTranscriptSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  ticketId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  content: { type: String, required: true, maxlength: 8_000_000 },
  messageCount: { type: Number, min: 0, default: 0 },
  generatedBy: { type: String, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });

ticketTranscriptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.TicketTranscript
  || mongoose.model('TicketTranscript', ticketTranscriptSchema);
