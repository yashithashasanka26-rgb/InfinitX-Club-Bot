const mongoose = require('mongoose');

const ticketStatsSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  created: { type: Number, default: 0, min: 0 },
  closed: { type: Number, default: 0, min: 0 },
  reopened: { type: Number, default: 0, min: 0 },
  claimed: { type: Number, default: 0, min: 0 },
  transcripts: { type: Number, default: 0, min: 0 },
  usersAdded: { type: Number, default: 0, min: 0 },
  usersRemoved: { type: Number, default: 0, min: 0 },
  totalResolutionMs: { type: Number, default: 0, min: 0 },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.TicketStats || mongoose.model('TicketStats', ticketStatsSchema);
