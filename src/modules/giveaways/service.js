const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { AuditLog, Giveaway, GuildConfig, Level } = require('../../database/models');
const { isModuleEnabled } = require('../../utils/moduleSettings');
const logger = require('../../utils/logger');

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_DURATION_MS = 10_000;
const MAX_ENTRANTS = 100_000;
const SWEEP_INTERVAL_MS = 15_000;
const ENDING_RECOVERY_DELAY_MS = 60_000;

async function writeAudit(AuditLogModel, log, entry) {
  try {
    await AuditLogModel.create(entry);
  } catch (error) {
    log.error('Giveaway audit record could not be saved', {
      guildId: entry.guildId,
      action: entry.action,
      error: error.message,
    });
  }
}

function parseDuration(value) {
  const match = /^(\d{1,6})(s|m|h|d|w)$/i.exec(String(value || '').trim());
  if (!match) throw new TypeError('Duration must be a number followed by s, m, h, d, or w (for example 30m or 2d).');
  const amount = Number(match[1]);
  const factors = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const durationMs = amount * factors[match[2].toLowerCase()];
  if (!Number.isSafeInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
    throw new RangeError('Giveaway duration must be between 10 seconds and 30 days.');
  }
  return durationMs;
}

function selectWinners(entrants, count, randomInt = crypto.randomInt) {
  if (!Array.isArray(entrants)) throw new TypeError('Giveaway entrants must be an array.');
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new RangeError('Winner count must be between 1 and 20.');
  const pool = [...new Set(entrants)];
  const winners = [];
  const winnerCount = Math.min(count, pool.length);
  for (let index = 0; index < winnerCount; index += 1) {
    const selected = randomInt(pool.length);
    if (!Number.isInteger(selected) || selected < 0 || selected >= pool.length) {
      throw new RangeError('Random source returned an invalid winner index.');
    }
    winners.push(pool[selected]);
    pool.splice(selected, 1);
  }
  return winners;
}

function giveawayEmbed(giveaway, { ended = false } = {}) {
  const requirements = [];
  if (giveaway.requiredRoleId) requirements.push(`Required role: <@&${giveaway.requiredRoleId}>`);
  if (giveaway.minimumLevel) requirements.push(`Minimum level: ${giveaway.minimumLevel}`);
  const winners = giveaway.winners || [];
  const description = ended
    ? winners.length
      ? `Winner${winners.length === 1 ? '' : 's'}: ${winners.map((id) => `<@${id}>`).join(', ')}`
      : 'No eligible entries. No winner could be selected.'
    : `Click the button below to enter.\nEnds <t:${Math.floor(new Date(giveaway.endsAt).getTime() / 1000)}:R>\nWinner${giveaway.winnerCount === 1 ? '' : 's'}: ${giveaway.winnerCount}${requirements.length ? `\n${requirements.join('\n')}` : ''}`;
  return new EmbedBuilder()
    .setColor(ended ? 0x95a5a6 : 0xf1c40f)
    .setTitle(ended ? `Giveaway ended: ${giveaway.prize}` : `🎉 Giveaway: ${giveaway.prize}`)
    .setDescription(description.slice(0, 4096))
    .addFields({ name: 'Entries', value: String(giveaway.entrants?.length || 0), inline: true })
    .setFooter({ text: `Hosted by ${giveaway.hostId}` });
}

function giveawayComponents(giveaway, ended = false) {
  if (ended) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway:join:${giveaway.id || giveaway._id}`)
      .setLabel('Enter giveaway')
      .setStyle(ButtonStyle.Primary),
  )];
}

function createGiveawayService({
  GiveawayModel = Giveaway,
  LevelModel = Level,
  GuildConfigModel = GuildConfig,
  AuditLogModel = AuditLog,
  randomInt = crypto.randomInt,
  now = Date.now,
  log = logger,
} = {}) {
  let timer = null;
  let sweepPromise = null;

  async function isEnabled(guildId) {
    const config = await GuildConfigModel.findOne({ guildId }).lean();
    return isModuleEnabled(config, 'giveaways');
  }

  async function create({ guild, channel, hostId, prize, durationMs, winnerCount, requiredRoleId = null, minimumLevel = null }) {
    if (!await isEnabled(guild.id)) throw new Error('Enable the Giveaways module in the dashboard first.');
    if (!prize || typeof prize !== 'string' || !prize.trim() || prize.length > 200) {
      throw new TypeError('Prize must be 1–200 characters.');
    }
    if (!Number.isSafeInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
      throw new RangeError('Giveaway duration must be between 10 seconds and 30 days.');
    }
    if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 20) {
      throw new RangeError('Winner count must be between 1 and 20.');
    }
    if (minimumLevel !== null && (!Number.isInteger(minimumLevel) || minimumLevel < 1 || minimumLevel > 10000)) {
      throw new RangeError('Minimum level must be between 1 and 10000.');
    }
    if (requiredRoleId && !await guild.roles.fetch(requiredRoleId)) throw new TypeError('The required role does not exist in this server.');
    const id = new GiveawayModel()._id;
    const placeholder = {
      id,
      _id: id,
      prize: prize.trim(),
      endsAt: new Date(now() + durationMs),
      winnerCount,
      requiredRoleId,
      minimumLevel,
      entrants: [],
      winners: [],
      hostId,
    };
    const message = await channel.send({
      embeds: [giveawayEmbed(placeholder)],
      components: giveawayComponents(placeholder),
      allowedMentions: { parse: [] },
    });
    let giveaway;
    try {
      giveaway = await GiveawayModel.create({
        _id: id,
        guildId: guild.id,
        channelId: channel.id,
        messageId: message.id,
        hostId,
        prize: prize.trim(),
        endsAt: placeholder.endsAt,
        winnerCount,
        requiredRoleId,
        minimumLevel,
      });
    } catch (error) {
      await message.delete().catch((deleteError) => log.error('Failed to remove giveaway panel after database write failed', {
        guildId: guild.id,
        messageId: message.id,
        error: deleteError.message,
      }));
      throw error;
    }
    await writeAudit(AuditLogModel, log, {
      guildId: guild.id,
      actorId: hostId,
      action: 'giveaway.created',
      targetId: message.id,
      details: { prize: giveaway.prize, winnerCount, endsAt: giveaway.endsAt },
    });
    return giveaway;
  }

  async function enter(interaction, giveawayId) {
    if (!interaction.guild || !interaction.guildId) return { entered: false, message: 'Giveaways can only be entered in a server.' };
    if (!await isEnabled(interaction.guildId)) return { entered: false, message: 'Giveaways are disabled in this server.' };
    const giveaway = await GiveawayModel.findOne({
      _id: giveawayId,
      guildId: interaction.guildId,
      messageId: interaction.message.id,
      status: 'active',
      endsAt: { $gt: new Date(now()) },
    }).lean();
    if (!giveaway) return { entered: false, message: 'This giveaway has ended or is no longer available.' };
    const member = interaction.member?.roles?.cache
      ? interaction.member
      : await interaction.guild.members.fetch(interaction.user.id);
    if (giveaway.requiredRoleId && !member.roles.cache.has(giveaway.requiredRoleId)) {
      return { entered: false, message: 'You do not have the role required to enter this giveaway.' };
    }
    if (giveaway.minimumLevel) {
      const level = await LevelModel.findOne({ guildId: interaction.guildId, userId: interaction.user.id }).select('level').lean();
      if ((level?.level || 0) < giveaway.minimumLevel) {
        return { entered: false, message: `You need to be level ${giveaway.minimumLevel} to enter this giveaway.` };
      }
    }
    const result = await GiveawayModel.updateOne({
      _id: giveaway._id,
      guildId: interaction.guildId,
      status: 'active',
      endsAt: { $gt: new Date(now()) },
      entrants: { $ne: interaction.user.id },
      $expr: { $lt: [{ $size: { $ifNull: ['$entrants', []] } }, MAX_ENTRANTS] },
    }, { $addToSet: { entrants: interaction.user.id } });
    if (result.modifiedCount === 1) {
      await interaction.message.edit({
        embeds: [giveawayEmbed({ ...giveaway, entrants: [...giveaway.entrants, interaction.user.id] })],
        components: giveawayComponents(giveaway),
        allowedMentions: { parse: [] },
      }).catch((error) => log.warn('Giveaway entry count could not be refreshed', {
        guildId: interaction.guildId,
        messageId: interaction.message.id,
        error: error.message,
      }));
      return { entered: true, message: 'You have entered the giveaway!' };
    }
    const latest = await GiveawayModel.findById(giveaway._id).select('status endsAt entrants').lean();
    if (latest?.entrants?.includes(interaction.user.id)) return { entered: false, message: 'You have already entered this giveaway.' };
    if (latest?.entrants?.length >= MAX_ENTRANTS) return { entered: false, message: 'This giveaway has reached its entry limit.' };
    return { entered: false, message: 'This giveaway has ended.' };
  }

  async function finish(giveawayId, { force = false, actorId = null } = {}) {
    const filter = {
      _id: giveawayId,
      status: 'active',
      ...(force ? {} : { endsAt: { $lte: new Date(now()) } }),
    };
    const giveaway = await GiveawayModel.findOneAndUpdate(filter, { $set: { status: 'ending' } }, { new: true });
    if (!giveaway) return { ended: false };
    const winners = selectWinners(giveaway.entrants, giveaway.winnerCount, randomInt);
    giveaway.winners = winners;
    giveaway.status = 'ended';
    giveaway.endedAt = new Date(now());
    await giveaway.save();
    await writeAudit(AuditLogModel, log, {
      guildId: giveaway.guildId,
      actorId: actorId || giveaway.hostId,
      targetId: giveaway.messageId,
      action: 'giveaway.ended',
      details: { prize: giveaway.prize, winners, winnerCount: giveaway.winnerCount },
    });
    try {
      await updateAnnouncement(giveaway, true);
    } catch (error) {
      log.error('Giveaway ended but announcement could not be updated', {
        guildId: giveaway.guildId,
        messageId: giveaway.messageId,
        error: error.message,
      });
    }
    try {
      await announceWinners(giveaway, winners);
    } catch (error) {
      log.error('Giveaway ended but winner announcement failed', {
        guildId: giveaway.guildId,
        messageId: giveaway.messageId,
        error: error.message,
      });
    }
    return { ended: true, giveaway, winners };
  }

  async function reroll(giveawayId, { actorId, guildId } = {}) {
    const giveaway = await GiveawayModel.findOne({ _id: giveawayId, guildId, status: 'ended' });
    if (!giveaway) return { rerolled: false, reason: 'not-ended' };
    const ineligible = new Set([...(giveaway.previousWinners || []), ...giveaway.winners]);
    const availableEntrants = giveaway.entrants.filter((entrant) => !ineligible.has(entrant));
    const winners = selectWinners(availableEntrants, giveaway.winnerCount, randomInt);
    if (!winners.length) return { rerolled: false, reason: 'no-entrants' };
    giveaway.previousWinners = [...new Set([...(giveaway.previousWinners || []), ...giveaway.winners])];
    giveaway.winners = winners;
    giveaway.rerollCount += 1;
    await giveaway.save();
    await writeAudit(AuditLogModel, log, {
      guildId,
      actorId,
      targetId: giveaway.messageId,
      action: 'giveaway.rerolled',
      details: { prize: giveaway.prize, winners, rerollCount: giveaway.rerollCount },
    });
    try {
      await updateAnnouncement(giveaway, true);
    } catch (error) {
      log.error('Rerolled giveaway announcement could not be updated', {
        guildId,
        messageId: giveaway.messageId,
        error: error.message,
      });
    }
    try {
      await announceWinners(giveaway, winners, `New winner${winners.length === 1 ? '' : 's'} for`);
    } catch (error) {
      log.error('Rerolled giveaway winner announcement failed', {
        guildId,
        messageId: giveaway.messageId,
        error: error.message,
      });
    }
    return { rerolled: true, giveaway, winners };
  }

  async function processEnding(giveaway) {
    const winners = selectWinners(giveaway.entrants, giveaway.winnerCount, randomInt);
    giveaway.winners = winners;
    giveaway.status = 'ended';
    giveaway.endedAt = new Date(now());
    await giveaway.save();
    await writeAudit(AuditLogModel, log, {
      guildId: giveaway.guildId,
      actorId: giveaway.hostId,
      targetId: giveaway.messageId,
      action: 'giveaway.ended',
      details: { prize: giveaway.prize, winners, winnerCount: giveaway.winnerCount, recovered: true },
    });
    try {
      await updateAnnouncement(giveaway, true);
    } catch (error) {
      log.error('Recovered giveaway announcement could not be updated', {
        guildId: giveaway.guildId,
        messageId: giveaway.messageId,
        error: error.message,
      });
    }
    try {
      await announceWinners(giveaway, winners);
    } catch (error) {
      log.error('Recovered giveaway winner announcement failed', {
        guildId: giveaway.guildId,
        messageId: giveaway.messageId,
        error: error.message,
      });
    }
  }

  async function runDueGiveaways() {
    if (sweepPromise) return sweepPromise;
    sweepPromise = (async () => {
      const ending = await GiveawayModel.find({
        status: 'ending',
        updatedAt: { $lte: new Date(now() - ENDING_RECOVERY_DELAY_MS) },
      }).limit(100).exec();
      for (const giveaway of ending) {
        try {
          await processEnding(giveaway);
        } catch (error) {
          log.error('Interrupted giveaway recovery failed', {
            giveawayId: String(giveaway._id),
            error: error.message,
          });
        }
      }
      const expired = await GiveawayModel.find({
        status: 'active',
        endsAt: { $lte: new Date(now()) },
      }).limit(100).select('_id').lean();
      for (const { _id } of expired) {
        try {
          await finish(_id);
        } catch (error) {
          log.error('Automatic giveaway ending failed', { giveawayId: String(_id), error: error.message });
        }
      }
    })().finally(() => { sweepPromise = null; });
    return sweepPromise;
  }

  function startScheduler(client) {
    if (timer) throw new Error('Giveaway scheduler is already running.');
    serviceClient = client;
    void runDueGiveaways().catch((error) => log.error('Initial giveaway sweep failed', { error: error.message }));
    timer = setInterval(() => {
      void runDueGiveaways().catch((error) => log.error('Giveaway sweep failed', { error: error.message }));
    }, SWEEP_INTERVAL_MS);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      timer = null;
      serviceClient = null;
    };
  }

  let serviceClient = null;

  async function updateAnnouncement(giveaway, ended) {
    const guild = serviceClient?.guilds?.cache?.get(giveaway.guildId)
      || await serviceClient?.guilds?.fetch(giveaway.guildId);
    if (!guild) throw new Error('Giveaway guild is unavailable.');
    const channel = await guild.channels.fetch(giveaway.channelId);
    const message = await channel?.messages?.fetch(giveaway.messageId);
    if (!message) throw new Error('Giveaway announcement message is unavailable.');
    await message.edit({
      embeds: [giveawayEmbed(giveaway, { ended })],
      components: giveawayComponents(giveaway, ended),
      allowedMentions: { parse: [] },
    });
  }

  async function announceWinners(giveaway, winners, prefix = 'Congratulations') {
    if (!winners.length) return;
    const guild = serviceClient?.guilds?.cache?.get(giveaway.guildId)
      || await serviceClient?.guilds?.fetch(giveaway.guildId);
    if (!guild) throw new Error('Giveaway guild is unavailable.');
    const channel = await guild.channels.fetch(giveaway.channelId);
    if (!channel?.send) throw new Error('Giveaway announcement channel is unavailable.');
    await channel.send({
      content: `${prefix} ${winners.map((id) => `<@${id}>`).join(', ')}! You won **${giveaway.prize}**.`,
      allowedMentions: { users: winners },
    });
  }

  return {
    create,
    enter,
    finish,
    reroll,
    runDueGiveaways,
    startScheduler,
    get timer() { return timer; },
  };
}

const giveawayService = createGiveawayService();

module.exports = {
  MAX_DURATION_MS,
  MAX_ENTRANTS,
  MIN_DURATION_MS,
  ENDING_RECOVERY_DELAY_MS,
  SWEEP_INTERVAL_MS,
  createGiveawayService,
  giveawayComponents,
  giveawayEmbed,
  giveawayService,
  parseDuration,
  selectWinners,
};
