const { ServerAnalytics, VoiceSession } = require('../../database/models');
const { isModuleEnabled } = require('../../utils/moduleSettings');
const GuildConfig = require('../../database/models/GuildConfig');

const DAY_MS = 86_400_000;
const PERIOD_DAYS = Object.freeze({ daily: 1, weekly: 7, monthly: 30 });

function utcDateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

async function incrementDaily(Model, guildId, date, increments) {
  const values = Object.fromEntries(Object.entries(increments).filter(([, value]) => value !== 0));
  if (!Object.keys(values).length) return;
  await Model.updateOne(
    { guildId, date: utcDateKey(date) },
    { $setOnInsert: { guildId, date: utcDateKey(date) }, $inc: values },
    { upsert: true },
  );
}

function createAnalyticsService({ AnalyticsModel = ServerAnalytics, VoiceSessionModel = VoiceSession, GuildConfigModel = GuildConfig, now = Date.now } = {}) {
  async function enabled(guildId) {
    const config = await GuildConfigModel.findOne({ guildId }).lean();
    return isModuleEnabled(config, 'analytics');
  }

  async function trackMessage(message, config = null) {
    if (config ? isModuleEnabled(config, 'analytics') : await enabled(message.guild.id)) {
      await incrementDaily(AnalyticsModel, message.guild.id, now(), { messages: 1 });
    }
  }

  async function trackMember(member, field) {
    if (await enabled(member.guild.id)) await incrementDaily(AnalyticsModel, member.guild.id, now(), { [field]: 1 });
  }

  async function trackVoice(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;
    const isEnabled = await enabled(guild.id);
    const userId = newState.id || oldState.id;
    if (!oldState.channelId && newState.channelId && isEnabled) {
      await VoiceSessionModel.updateOne(
        { guildId: guild.id, userId },
        { $set: { channelId: newState.channelId, joinedAt: new Date(now()) } },
        { upsert: true },
      );
      await incrementDaily(AnalyticsModel, guild.id, now(), { voiceSessions: 1 });
      return;
    }
    if (oldState.channelId && !newState.channelId) {
      const session = await VoiceSessionModel.findOneAndDelete({ guildId: guild.id, userId });
      if (session && isEnabled) await recordVoiceDuration(guild.id, session.joinedAt.getTime(), now());
      return;
    }
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      if (isEnabled) {
        await VoiceSessionModel.updateOne(
          { guildId: guild.id, userId },
          { $set: { channelId: newState.channelId } },
          { upsert: true, setOnInsert: { joinedAt: new Date(now()) } },
        );
      } else {
        await VoiceSessionModel.deleteOne({ guildId: guild.id, userId });
      }
    }
  }

  async function recordVoiceDuration(guildId, start, end) {
    let cursor = start;
    while (cursor < end) {
      const dayStart = Math.floor(cursor / DAY_MS) * DAY_MS;
      const segmentEnd = Math.min(end, dayStart + DAY_MS);
      const seconds = Math.floor((segmentEnd - cursor) / 1000);
      if (seconds > 0) await incrementDaily(AnalyticsModel, guildId, cursor, { voiceSeconds: seconds });
      cursor = segmentEnd;
    }
  }

  async function recoverVoiceSessions(client) {
    const sessions = await VoiceSessionModel.find({}).exec();
    const at = now();
    for (const session of sessions) {
      const guild = client.guilds.cache.get(session.guildId);
      const member = guild?.channels.cache.get(session.channelId)?.members.get(session.userId)
        || guild?.members.cache.get(session.userId);
      if (member?.voice?.channelId) {
        session.channelId = member.voice.channelId;
        session.joinedAt = new Date(at);
        await session.save();
      } else {
        await VoiceSessionModel.deleteOne({ _id: session._id });
      }
    }
  }

  async function getSummary(guildId, period = 'daily') {
    const days = PERIOD_DAYS[period];
    if (!days) throw new TypeError('Period must be daily, weekly, or monthly.');
    const startDate = utcDateKey(now() - days * DAY_MS);
    const records = await AnalyticsModel.find({ guildId, date: { $gt: startDate } })
      .sort({ date: 1 })
      .lean();
    const summary = records.reduce((total, item) => {
      total.joins += item.joins || 0;
      total.leaves += item.leaves || 0;
      total.messages += item.messages || 0;
      total.voiceSeconds += item.voiceSeconds || 0;
      total.voiceSessions += item.voiceSessions || 0;
      return total;
    }, { joins: 0, leaves: 0, messages: 0, voiceSeconds: 0, voiceSessions: 0 });
    return { period, days, ...summary, netGrowth: summary.joins - summary.leaves };
  }

  return { trackMessage, trackMember, trackVoice, recordVoiceDuration, recoverVoiceSessions, getSummary };
}

const analyticsService = createAnalyticsService();

module.exports = { DAY_MS, PERIOD_DAYS, analyticsService, createAnalyticsService, incrementDaily, utcDateKey };
