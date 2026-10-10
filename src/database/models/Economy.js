const mongoose = require('mongoose');

const economySchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  coins: { type: Number, default: 0, min: 0 },
  inventory: {
    type: [{
      itemId: { type: String, required: true },
      quantity: { type: Number, min: 1, max: 1_000_000, validate: Number.isSafeInteger },
    }],
    default: [],
    validate: (items) => items.length <= 100,
  },
  lastDailyAt: { type: Date, default: null },
  lastWeeklyAt: { type: Date, default: null },
  lastWorkAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

economySchema.index({ guildId: 1, userId: 1 }, { unique: true });
economySchema.index({ guildId: 1, coins: -1 });

module.exports = mongoose.models.Economy || mongoose.model('Economy', economySchema);
