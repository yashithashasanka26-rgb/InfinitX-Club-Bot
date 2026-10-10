const mongoose = require('mongoose');

const lockedChannelSchema = new mongoose.Schema({
  channelId: { type: String, required: true },
  sendMessagesState: { type: String, enum: ['allow', 'deny', 'neutral'], required: true },
  restored: { type: Boolean, default: false },
}, { _id: false });

const guildLockdownSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  reason: { type: String, required: true, maxlength: 500 },
  status: { type: String, enum: ['active', 'restoring', 'restored'], default: 'active' },
  startedBy: { type: String, default: null },
  startedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  channels: { type: [lockedChannelSchema], default: [] },
}, { versionKey: false });

guildLockdownSchema.index({ guildId: 1 }, { unique: true });
guildLockdownSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.models.GuildLockdown || mongoose.model('GuildLockdown', guildLockdownSchema);
