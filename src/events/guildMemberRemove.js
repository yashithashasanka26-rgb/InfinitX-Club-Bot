const { logMemberLeave } = require('../modules/moderation/logging');
const { analyticsService } = require('../modules/analytics/service');
const { sendWelcomeMessage } = require('../modules/welcomeLeave/service');
const logger = require('../utils/logger');

module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    try {
      await logMemberLeave(member);
    } catch (error) {
      logger.error('Member leave logging failed', {
        guildId: member.guild.id,
        userId: member.id,
        error: error.message,
      });
    }
    try {
      await analyticsService.trackMember(member, 'leaves');
    } catch (error) {
      logger.error('Member leave analytics failed', { guildId: member.guild.id, userId: member.id, error: error.message });
    }
    try {
      await sendWelcomeMessage(member, 'leave');
    } catch (error) {
      logger.error('Leave message could not be sent', { guildId: member.guild.id, userId: member.id, error: error.message });
    }
  },
};
