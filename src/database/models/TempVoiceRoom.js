const mongoose = require('mongoose');

const tempVoiceRoomSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  voiceChannelId: { type: String, required: true, unique: true },
  textChannelId: { type: String, required: true, unique: true },
  ownerId: { type: String, required: true, index: true },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.TempVoiceRoom || mongoose.model('TempVoiceRoom', tempVoiceRoomSchema);
