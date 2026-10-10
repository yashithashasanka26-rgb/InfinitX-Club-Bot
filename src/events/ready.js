const logger = require('../utils/logger');
const { startAutoCloser } = require('../modules/tickets/autoClose');
const { startLockdownRecovery } = require('../modules/moderation/lockdown');
const { musicService } = require('../modules/music/service');
const { giveawayService } = require('../modules/giveaways/service');
const { analyticsService } = require('../modules/analytics/service');
const { tempVoiceService } = require('../modules/temporaryVoice/service');
const { startDashboardWorker } = require('../modules/dashboard/worker');

module.exports = {
  name: 'ready',
  once: true,
  execute(client) {
    logger.info(`Discord client ready as ${client.user.tag}`);
    client.addCleanupTask(startAutoCloser(client));
    client.addCleanupTask(startLockdownRecovery(client));
    client.addCleanupTask(() => musicService.cleanup());
    client.addCleanupTask(giveawayService.startScheduler(client));
    client.addCleanupTask(startDashboardWorker(client));
    void analyticsService.recoverVoiceSessions(client).catch((error) => logger.error('Voice analytics recovery failed', { error: error.message }));
    void tempVoiceService.recoverRooms(client).catch((error) => logger.error('Temporary voice room recovery failed', { error: error.message }));
  },
};
