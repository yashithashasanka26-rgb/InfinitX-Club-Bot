const { moderateMessage } = require('../modules/moderation/service');
const { awardMessageXp } = require('../modules/leveling/service');
const { executeCustomCommand } = require('../modules/customCommands/service');
const { getMentionErrorMessage, respondToGreeting, respondToMention } = require('../modules/ai/mention');
const { GuildConfig } = require('../database/models');
const { touchTicketActivity } = require('../modules/tickets/service');
const { analyticsService } = require('../modules/analytics/service');
const { ownerService } = require('../modules/owner/service');
const { isModuleEnabled } = require('../utils/moduleSettings');
const logger = require('../utils/logger');

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (!message.guild || message.author.bot) return;
    try {
      const access = await ownerService.enforceAccess({
        client: message.client,
        user: message.author,
        guildId: message.guild.id,
      });
      if (!access.allowed) return;
      const config = await GuildConfig.findOne({ guildId: message.guild.id }).lean();
      if (!config) return;
      if (isModuleEnabled(config, 'analytics')) await analyticsService.trackMessage(message, config);
      if (isModuleEnabled(config, 'tickets')) {
        await touchTicketActivity(message.guild.id, message.channelId);
      }
      if (isModuleEnabled(config, 'automod') && await moderateMessage(message, config)) return;
      if (isModuleEnabled(config, 'leveling')) await awardMessageXp(message, config);
      await executeCustomCommand(message, config);
      try {
        if (!await respondToMention(message, config)) await respondToGreeting(message, config);
      } catch (error) {
        logger.error('AI mention response failed', {
          guildId: message.guild.id,
          userId: message.author.id,
          error: error.message,
          provider: error.provider,
          status: error.status,
          stack: error.stack,
        });
        if (message.mentions.users.has(message.client.user?.id)) {
          try {
            await message.reply({
              content: getMentionErrorMessage(error),
              allowedMentions: { parse: [], repliedUser: false },
            });
          } catch (replyError) {
            logger.error('AI mention error could not be sent', {
              guildId: message.guild.id,
              error: replyError.message,
              stack: replyError.stack,
            });
          }
        }
      }
    } catch (error) {
      logger.error('Message processing failed', { guildId: message.guild.id, error: error.message });
    }
  },
};
