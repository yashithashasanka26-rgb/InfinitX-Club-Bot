const { lockNewChannel } = require('../modules/moderation/lockdown');
const logger = require('../utils/logger');

module.exports = {
  name: 'channelCreate',
  async execute(channel) {
    if (!channel.guild) return;
    try {
      await lockNewChannel(channel);
    } catch (error) {
      logger.error('Failed to apply active lockdown to a new channel', {
        guildId: channel.guild.id,
        channelId: channel.id,
        error: error.message,
      });
    }
  },
};
