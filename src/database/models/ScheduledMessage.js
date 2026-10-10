const mongoose = require('mongoose');

const scheduledMessageSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  channelId: { type: String, required: true },
  createdBy: { type: String, required: true },
  title: { type: String, default: '', maxlength: 256 },
  description: { type: String, default: '', maxlength: 4000 },
  color: { type: String, default: '#7478ff', match: /^#[0-9a-fA-F]{6}$/ },
  footer: { type: String, default: '', maxlength: 2048 },
  imageUrl: { type: String, default: null, maxlength: 2048 },
  scheduledAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['pending', 'sending', 'sent', 'failed', 'cancelled'], default: 'pending', index: true },
  sentAt: { type: Date, default: null },
  lastError: { type: String, default: null, maxlength: 500 },
}, { timestamps: true, versionKey: false });

scheduledMessageSchema.index({ guildId: 1, scheduledAt: 1, status: 1 });

module.exports = mongoose.models.ScheduledMessage || mongoose.model('ScheduledMessage', scheduledMessageSchema);
