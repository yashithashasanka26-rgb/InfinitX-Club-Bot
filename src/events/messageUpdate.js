const { logMessageUpdate } = require('../modules/moderation/logging');
const logger = require('../utils/logger');

module.exports = {
  name: 'messageUpdate',
  async execute(oldMessage, newMessage) {
    try {
      if (oldMessage.partial) await oldMessage.fetch();
      if (newMessage.partial) await newMessage.fetch();
      if (!newMessage.guild) return;
      await logMessageUpdate(oldMessage, newMessage);
    } catch (error) {
      logger.error('Edited message logging failed', {
        guildId: newMessage.guild.id,
        channelId: newMessage.channelId,
        error: error.message,
      });
    }
  },
};
