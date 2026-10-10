const mongoose = require('mongoose');

const commandPermissionSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  commandName: { type: String, required: true, lowercase: true },
  enabled: { type: Boolean, default: true },
  requiredRoleIds: { type: [String], default: [] },
  allowedChannelIds: { type: [String], default: [] },
  deniedChannelIds: { type: [String], default: [] },
  cooldownSeconds: { type: Number, default: 0, min: 0, max: 86400 },
  maxUses: { type: Number, default: null, min: 1 },
  windowSeconds: { type: Number, default: 86400, min: 1, max: 2592000 },
}, { timestamps: true, versionKey: false });

commandPermissionSchema.index({ guildId: 1, commandName: 1 }, { unique: true });

module.exports = mongoose.models.CommandPermission || mongoose.model('CommandPermission', commandPermissionSchema);
