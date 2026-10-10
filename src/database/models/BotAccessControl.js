const mongoose = require('mongoose');

const botAccessControlSchema = new mongoose.Schema({
  action: { type: String, enum: ['blacklist', 'whitelist'], required: true },
  subjectType: { type: String, enum: ['user', 'guild'], required: true },
  subjectId: { type: String, required: true, match: /^\d{17,20}$/ },
  reason: { type: String, default: null, maxlength: 500 },
  actorId: { type: String, required: true },
}, { timestamps: true, versionKey: false });

botAccessControlSchema.index({ action: 1, subjectType: 1, subjectId: 1 }, { unique: true });

module.exports = mongoose.models.BotAccessControl || mongoose.model('BotAccessControl', botAccessControlSchema);
