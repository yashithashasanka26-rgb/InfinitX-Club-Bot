const mongoose = require('mongoose');

const economyTransactionSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  type: { type: String, enum: ['daily', 'weekly', 'work', 'pay', 'purchase'], required: true },
  amount: { type: Number, required: true, min: 1 },
  senderId: { type: String, default: null },
  recipientId: { type: String, default: null },
  itemId: { type: String, default: null },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 365 },
}, { versionKey: false });

economyTransactionSchema.index({ guildId: 1, createdAt: -1 });

module.exports = mongoose.models.EconomyTransaction
  || mongoose.model('EconomyTransaction', economyTransactionSchema);
