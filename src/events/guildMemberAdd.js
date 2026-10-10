const { trackGuildJoin } = require('../modules/moderation/service');
const { logMemberJoin } = require('../modules/moderation/logging');
const { analyticsService } = require('../modules/analytics/service');
const { sendWelcomeMessage } = require('../modules/welcomeLeave/service');
const logger = require('../utils/logger');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    try {
      await trackGuildJoin(member);
    } catch (error) {
      logger.error('Guild join tracking failed', { guildId: member.guild.id, error: error.message });
    }
    try {
      await logMemberJoin(member);
    } catch (error) {
      logger.error('Member join logging failed', {
        guildId: member.guild.id,
        userId: member.id,
        error: error.message,
      });
    }
    try {
      await analyticsService.trackMember(member, 'joins');
    } catch (error) {
      logger.error('Member join analytics failed', { guildId: member.guild.id, userId: member.id, error: error.message });
    }
    try {
      await sendWelcomeMessage(member, 'welcome');
    } catch (error) {
      logger.error('Welcome message could not be sent', { guildId: member.guild.id, userId: member.id, error: error.message });
    }
  },
};
