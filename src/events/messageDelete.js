const { logMessageDelete } = require('../modules/moderation/logging');
const { starboardService } = require('../modules/starboard/service');
const logger = require('../utils/logger');

module.exports = {
  name: 'messageDelete',
  async execute(message) {
    try {
      if (message.partial) await message.fetch();
      if (!message.guild) return;
      try {
        await logMessageDelete(message);
      } catch (error) {
        logger.error('Deleted message logging failed', {
          guildId: message.guild?.id,
          channelId: message.channelId,
          error: error.message,
        });
      }
      await starboardService.handleDeletedMessage(message);
    } catch (error) {
      logger.error('Deleted message logging failed', {
        guildId: message.guild.id,
        channelId: message.channelId,
        error: error.message,
      });
    }
  },
};
