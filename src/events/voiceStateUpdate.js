const { logVoiceStateUpdate } = require('../modules/moderation/logging');
const { analyticsService } = require('../modules/analytics/service');
const { tempVoiceService } = require('../modules/temporaryVoice/service');
const logger = require('../utils/logger');

module.exports = {
  name: 'voiceStateUpdate',
  async execute(oldState, newState) {
    try {
      await logVoiceStateUpdate(oldState, newState);
    } catch (error) {
      logger.error('Voice state logging failed', {
        guildId: newState.guild?.id || oldState.guild?.id,
        userId: newState.id || oldState.id,
        error: error.message,
      });
    }
    try {
      await analyticsService.trackVoice(oldState, newState);
    } catch (error) {
      logger.error('Voice analytics tracking failed', {
        guildId: newState.guild?.id || oldState.guild?.id,
        userId: newState.id || oldState.id,
        error: error.message,
      });
    }
    try {
      await tempVoiceService.onVoiceStateUpdate(oldState, newState);
    } catch (error) {
      logger.error('Temporary voice room handling failed', {
        guildId: newState.guild?.id || oldState.guild?.id,
        userId: newState.id || oldState.id,
        error: error.message,
      });
    }
  },
};
