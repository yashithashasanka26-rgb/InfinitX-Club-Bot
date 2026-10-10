const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  actorId: { type: String, default: null },
  action: { type: String, required: true, maxlength: 100 },
  targetId: { type: String, default: null },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
}, { versionKey: false });

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
