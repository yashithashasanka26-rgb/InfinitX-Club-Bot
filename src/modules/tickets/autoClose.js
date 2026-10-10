const { AuditLog, GuildConfig, Ticket } = require('../../database/models');
const logger = require('../../utils/logger');
const { closeTicket } = require('./service');

const RUN_INTERVAL_MS = 5 * 60 * 1000;
const CLOSING_RECOVERY_MS = 15 * 60 * 1000;

async function processAutoClose(client) {
  const staleBefore = new Date(Date.now() - CLOSING_RECOVERY_MS);
  await Ticket.updateMany(
    { status: 'closing', closingAt: { $lte: staleBefore } },
    { $set: { status: 'open' }, $unset: { closingAt: 1 } },
  );

  const configs = await GuildConfig.find({ 'modules.tickets': true }).select('guildId tickets.autoCloseHours').lean();
  const now = Date.now();
  for (const config of configs) {
    const hours = config.tickets?.autoCloseHours || 72;
    const cutoff = new Date(now - hours * 60 * 60 * 1000);
    const tickets = await Ticket.find({
      guildId: config.guildId,
      status: 'open',
      updatedAt: { $lte: cutoff },
    }).limit(100).lean();

    for (const ticket of tickets) {
      try {
        const guild = client.guilds.cache.get(ticket.guildId);
        if (!guild) {
          await markUnavailableTicket(ticket, client.user.id, 'ticket.guild_unavailable');
          continue;
        }
        let channel;
        try {
          channel = await guild.channels.fetch(ticket.channelId);
        } catch (error) {
          if (error.code !== 10003) throw error;
        }
        if (!channel) {
          await markUnavailableTicket(ticket, client.user.id, 'ticket.channel_unavailable');
          continue;
        }
        const result = await closeTicket({
          guild,
          channel,
          actorId: client.user.id,
          reason: 'automatic inactivity close',
          inactiveBefore: cutoff,
        });
        if (result.closed) await channel.delete('Ticket automatically closed due to inactivity');
      } catch (error) {
        logger.error('Automatic ticket closure failed', {
          ticketId: String(ticket._id),
          guildId: ticket.guildId,
          error: error.message,
        });
      }
    }
  }
}

async function markUnavailableTicket(ticket, actorId, action) {
  const result = await Ticket.updateOne(
    { _id: ticket._id, status: 'open' },
    { $set: { status: 'closed', closedAt: new Date() } },
  );
  if (result.modifiedCount) {
    await AuditLog.create({
      guildId: ticket.guildId,
      actorId,
      targetId: ticket.channelId,
      action,
      details: { ticketId: String(ticket._id) },
    });
  }
}

function startAutoCloser(client) {
  let running = false;
  let runPromise;
  const run = async () => {
    if (running) return runPromise;
    running = true;
    runPromise = (async () => {
      try {
        await processAutoClose(client);
      } catch (error) {
        logger.error('Ticket auto-close sweep failed', { error: error.message });
      } finally {
        running = false;
      }
    })();
    return runPromise;
  };
  const timer = setInterval(run, RUN_INTERVAL_MS);
  timer.unref();
  void run();
  return async () => {
    clearInterval(timer);
    await runPromise;
  };
}

module.exports = { processAutoClose, startAutoCloser };
