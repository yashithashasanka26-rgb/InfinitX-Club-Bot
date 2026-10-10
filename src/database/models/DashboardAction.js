const mongoose = require('mongoose');

const dashboardActionSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  actorId: { type: String, required: true },
  type: { type: String, enum: ['deploy-ticket-panel', 'deploy-verification-panel', 'send-embed', 'music'], required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending', index: true },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  error: { type: String, default: null, maxlength: 500 },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 5 * 60_000), index: { expires: 0 } },
}, { timestamps: true, versionKey: false });

dashboardActionSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.models.DashboardAction || mongoose.model('DashboardAction', dashboardActionSchema);
