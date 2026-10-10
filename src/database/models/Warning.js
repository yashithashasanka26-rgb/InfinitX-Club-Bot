const mongoose = require('mongoose');

const warningSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  moderatorId: { type: String, required: true },
  reason: { type: String, required: true, maxlength: 1000 },
  action: { type: String, enum: ['warn', 'timeout', 'ban'], default: 'warn' },
  actionSucceeded: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

warningSchema.index({ guildId: 1, userId: 1, createdAt: -1 });

module.exports = mongoose.models.Warning || mongoose.model('Warning', warningSchema);
