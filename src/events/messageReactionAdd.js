const { starboardService } = require('../modules/starboard/service');
const logger = require('../utils/logger');

module.exports = {
  name: 'messageReactionAdd',
  async execute(reaction) {
    try {
      await starboardService.updateReaction(reaction);
    } catch (error) {
      logger.error('Starboard reaction handling failed', {
        guildId: reaction.message.guild?.id,
        messageId: reaction.message.id,
        error: error.message,
      });
    }
  },
};
