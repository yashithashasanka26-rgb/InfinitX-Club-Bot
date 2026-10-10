const { trackDestructiveAudit } = require('../modules/moderation/service');
const { logDiscordModerationAudit } = require('../modules/moderation/logging');
const logger = require('../utils/logger');

module.exports = {
  name: 'guildAuditLogEntryCreate',
  async execute(entry, guild) {
    try {
      await logDiscordModerationAudit(entry, guild, guild.client);
    } catch (error) {
      logger.error('Discord moderation action logging failed', {
        guildId: guild.id,
        auditEntryId: entry.id,
        error: error.message,
      });
    }
    try {
      await trackDestructiveAudit({
        action: entry.action,
        executorId: entry.executorId,
        guild,
        client: guild.client,
      });
    } catch (error) {
      logger.error('Anti-nuke audit processing failed', {
        guildId: guild.id,
        auditEntryId: entry.id,
        error: error.message,
      });
    }
  },
};
