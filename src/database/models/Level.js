const mongoose = require('mongoose');

const levelSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  xp: { type: Number, default: 0, min: 0 },
  level: { type: Number, default: 0, min: 0 },
  lastXpAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

levelSchema.index({ guildId: 1, userId: 1 }, { unique: true });
levelSchema.index({ guildId: 1, xp: -1 });

module.exports = mongoose.models.Level || mongoose.model('Level', levelSchema);
