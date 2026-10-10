const mongoose = require('mongoose');

const giveawaySchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  channelId: { type: String, required: true },
  messageId: { type: String, required: true, unique: true },
  hostId: { type: String, required: true },
  prize: { type: String, required: true, trim: true, maxlength: 200 },
  winnerCount: { type: Number, required: true, min: 1, max: 20 },
  requiredRoleId: { type: String, default: null },
  minimumLevel: { type: Number, default: null, min: 1, max: 10000 },
  entrants: { type: [String], default: [] },
  winners: { type: [String], default: [] },
  previousWinners: { type: [String], default: [] },
  status: { type: String, enum: ['active', 'ending', 'ended', 'cancelled'], default: 'active' },
  endsAt: { type: Date, required: true, index: true },
  endedAt: { type: Date, default: null },
  rerollCount: { type: Number, min: 0, default: 0 },
}, { timestamps: true, versionKey: false });

giveawaySchema.index({ status: 1, endsAt: 1 });
giveawaySchema.index({ guildId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.models.Giveaway || mongoose.model('Giveaway', giveawaySchema);
