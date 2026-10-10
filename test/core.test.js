const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../src/config');
const CustomCommand = require('../src/database/models/CustomCommand');
const GuildConfig = require('../src/database/models/GuildConfig');
const Ticket = require('../src/database/models/Ticket');
const TicketStats = require('../src/database/models/TicketStats');
const Economy = require('../src/database/models/Economy');
const EconomyTransaction = require('../src/database/models/EconomyTransaction');
const Giveaway = require('../src/database/models/Giveaway');
const ServerAnalytics = require('../src/database/models/ServerAnalytics');
const VoiceSession = require('../src/database/models/VoiceSession');
const StarboardEntry = require('../src/database/models/StarboardEntry');
const Suggestion = require('../src/database/models/Suggestion');
const SuggestionLog = require('../src/database/models/SuggestionLog');
const BotAccessControl = require('../src/database/models/BotAccessControl');
const BotSettings = require('../src/database/models/BotSettings');
const DashboardAction = require('../src/database/models/DashboardAction');
const ScheduledMessage = require('../src/database/models/ScheduledMessage');
const Warning = require('../src/database/models/Warning');
const {
  containsBlockedWord,
  destructiveActions,
  LINK_PATTERN,
} = require('../src/modules/moderation/service');
const { getSendMessagesState, permissionValue } = require('../src/modules/moderation/lockdown');
const { createTicketPanel } = require('../src/modules/tickets/interactions');
const { levelForXp, xpForLevel } = require('../src/modules/leveling/service');
const { formatTranscript, MAX_TRANSCRIPT_CHARS } = require('../src/modules/tickets/transcript');
const { isModuleDisabled, isModuleEnabled } = require('../src/utils/moduleSettings');
const { attachShutdown } = require('../src/utils/shutdown');
const { attachProcessHandlers } = require('../src/utils/processHandlers');
const { loadModules } = require('../src/utils/loaders');
const { createMusicService, formatDuration, shuffleTracks } = require('../src/modules/music/service');
const { ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { AiServiceError, createAiService, MAX_INPUT_CHARS } = require('../src/modules/ai/service');
const { respondToGreeting, respondToMention, splitReply } = require('../src/modules/ai/mention');
const {
  createEmbedPayload,
  normalizeButtons,
  normalizeEmbed,
} = require('../src/modules/customCommands/builders');
const { getCustomCommandName } = require('../src/modules/customCommands/service');
const embedBuilderCommand = require('../src/commands/embed-builder');
const moderationLogging = require('../src/modules/moderation/logging');
const { assertTargetIsModeratable } = require('../src/modules/moderation/commandUtils');
const { buildControlPanel } = require('../src/modules/temporaryVoice/service');
const { createAnalyticsService, utcDateKey } = require('../src/modules/analytics/service');
const { buildStarboardEmbed, createStarboardService, matchesEmoji } = require('../src/modules/starboard/service');
const { createSuggestionsService, suggestionButtons, suggestionEmbed } = require('../src/modules/suggestions/service');
const { createOwnerService, isBotOwner } = require('../src/modules/owner/service');
const {
  buildVerificationPanelFromConfig,
  recoverStaleScheduledMessages,
} = require('../src/modules/dashboard/worker');
const {
  applySettingsPatch,
  validateCommandPermission,
  validateConfigPatch,
  validateDashboardEmbed,
  validateSettings,
} = require('../src/dashboard/routes/servers');
const {
  getDashboardErrorResponse,
  getDashboardErrorStatus,
} = require('../src/dashboard/errors');
const { requireGuildManager } = require('../src/dashboard/middleware');
const { requireSameOrigin } = require('../src/dashboard/origin');
const { buildWelcomeEmbed, interpolateWelcomeText } = require('../src/modules/welcomeLeave/service');
const {
  createVerificationPanel,
  makeChallenge,
  challenges: verificationChallenges,
  submitVerification,
} = require('../src/modules/verification/service');
const { giveawayEmbed, parseDuration, selectWinners } = require('../src/modules/giveaways/service');

test('configuration permits dashboard-only processes without a bot token', () => {
  const previous = {
    clientId: process.env.DISCORD_CLIENT_ID,
    mongoUri: process.env.MONGODB_URI,
    token: process.env.DISCORD_TOKEN,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.DISCORD_CLIENT_ID = 'test-client';
  process.env.MONGODB_URI = 'mongodb://localhost/test';
  delete process.env.DISCORD_TOKEN;
  process.env.NODE_ENV = 'test';
  try {
    assert.equal(loadConfig().token, '');
  } finally {
    for (const [key, value] of Object.entries({
      DISCORD_CLIENT_ID: previous.clientId,
      MONGODB_URI: previous.mongoUri,
      DISCORD_TOKEN: previous.token,
      NODE_ENV: previous.nodeEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('welcome/leave date and time toggles are valid partial Mongo settings', async () => {
  const payload = {
    modules: { welcomeLeave: true },
    settings: {
      welcomeLeave: {
        welcomeEnabled: true,
        leaveEnabled: true,
        welcomeChannelId: '12345678901234568',
        leaveChannelId: '12345678901234569',
        backgroundImageUrl: 'https://cdn.example.test/banner.gif',
        welcome: {
          title: 'Welcome {username}',
          description: 'Welcome {user} to {server}',
          color: '#123abc',
          footer: 'InfinitX • {date} {time}',
          includeDate: false,
          includeTime: true,
          thumbnailUrl: 'https://cdn.example.test/join-thumb.png',
          imageUrl: 'https://cdn.example.test/join.gif',
        },
        leave: {
          title: 'Goodbye {username}',
          description: '{date} {time}',
          color: '#abcdef',
          footer: 'InfinitX • {date} {time}',
          includeDate: true,
          includeTime: false,
          thumbnailUrl: 'https://cdn.example.test/leave-thumb.png',
          imageUrl: 'https://cdn.example.test/leave.gif',
        },
      },
    },
  };
  const patch = validateConfigPatch(payload);
  const welcomeSettings = patch.settings.welcomeLeave;
  assert.doesNotThrow(() => validateSettings('welcomeLeave', welcomeSettings));
  const config = new GuildConfig({ guildId: '12345678901234567' });
  for (const [name, enabled] of Object.entries(patch.modules)) config.modules.set(name, enabled);
  applySettingsPatch(config, 'welcomeLeave', welcomeSettings);
  await assert.doesNotReject(config.validate());
  assert.equal(config.modules.get('welcomeLeave'), true);
  assert.equal(config.welcomeLeave.welcomeEnabled, true);
  assert.equal(config.welcomeLeave.leaveEnabled, true);
  assert.equal(config.welcomeLeave.welcomeChannelId, '12345678901234568');
  assert.equal(config.welcomeLeave.leaveChannelId, '12345678901234569');
  assert.equal(config.welcomeLeave.backgroundImageUrl, 'https://cdn.example.test/banner.gif');
  assert.equal(config.welcomeLeave.welcome.title, 'Welcome {username}');
  assert.equal(config.welcomeLeave.welcome.color, '#123abc');
  assert.equal(config.welcomeLeave.welcome.footer, 'InfinitX • {date} {time}');
  assert.equal(config.welcomeLeave.welcome.includeDate, false);
  assert.equal(config.welcomeLeave.welcome.includeTime, true);
  assert.equal(config.welcomeLeave.welcome.imageUrl, 'https://cdn.example.test/join.gif');
  assert.equal(config.welcomeLeave.welcome.thumbnailUrl, 'https://cdn.example.test/join-thumb.png');
  assert.equal(config.welcomeLeave.leave.includeDate, true);
  assert.equal(config.welcomeLeave.leave.includeTime, false);
  assert.equal(config.welcomeLeave.leave.imageUrl, 'https://cdn.example.test/leave.gif');
  assert.equal(config.welcomeLeave.leave.thumbnailUrl, 'https://cdn.example.test/leave-thumb.png');
  const [, mongoUpdate] = config.$__delta();
  assert.equal(mongoUpdate.$set['welcomeLeave.welcome.includeDate'], false);
  assert.equal(mongoUpdate.$set['welcomeLeave.leave.includeTime'], false);
  assert.equal(mongoUpdate.$set['welcomeLeave.welcome.imageUrl'], 'https://cdn.example.test/join.gif');

  const member = {
    id: '12345678901234567',
    displayName: 'Ada',
    user: { username: 'ada' },
    guild: { name: 'InfinitX', memberCount: 42 },
  };
  const welcome = buildWelcomeEmbed(member, config.welcomeLeave, 'welcome', new Date('2026-10-09T08:05:00.000Z')).toJSON();
  assert.doesNotMatch(`${welcome.description} ${welcome.footer.text}`, /Oct 9, 2026/);
  assert.match(`${welcome.description} ${welcome.footer.text}`, /8:05 AM/);
});

test('bot configuration parses developer IDs and rejects malformed entries', () => {
  const previous = {
    clientId: process.env.DISCORD_CLIENT_ID,
    mongoUri: process.env.MONGODB_URI,
    owners: process.env.BOT_OWNER_IDS,
  };
  process.env.DISCORD_CLIENT_ID = 'test-client';
  process.env.MONGODB_URI = 'mongodb://localhost/test';
  process.env.BOT_OWNER_IDS = '12345678901234567, 12345678901234568,12345678901234567';
  try {
    assert.deepEqual(loadConfig().ownerIds, ['12345678901234567', '12345678901234568']);
    process.env.BOT_OWNER_IDS = 'not-a-discord-id';
    assert.throws(() => loadConfig(), /BOT_OWNER_IDS must be/);
  } finally {
    for (const [key, value] of Object.entries({
      DISCORD_CLIENT_ID: previous.clientId,
      MONGODB_URI: previous.mongoUri,
      BOT_OWNER_IDS: previous.owners,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('production configuration requires a strong session secret', () => {
  const previous = {
    clientId: process.env.DISCORD_CLIENT_ID,
    mongoUri: process.env.MONGODB_URI,
    secret: process.env.SESSION_SECRET,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.DISCORD_CLIENT_ID = 'test-client';
  process.env.MONGODB_URI = 'mongodb://localhost/test';
  process.env.SESSION_SECRET = 'short';
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => loadConfig(), /SESSION_SECRET must contain at least 32 characters/);
  } finally {
    for (const [key, value] of Object.entries({
      DISCORD_CLIENT_ID: previous.clientId,
      MONGODB_URI: previous.mongoUri,
      SESSION_SECRET: previous.secret,
      NODE_ENV: previous.nodeEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('level XP thresholds increase with each level', () => {
  assert.equal(xpForLevel(1), 155);
  assert.equal(xpForLevel(2), 220);
  assert.ok(xpForLevel(2) > xpForLevel(1));
  assert.equal(levelForXp(0), 0);
  assert.equal(levelForXp(154), 0);
  assert.equal(levelForXp(155), 1);
  assert.equal(levelForXp(500), 5);
});

test('economy commands register balance, rewards, work, pay, shop, inventory, and leaderboard', () => {
  const commands = loadModules(path.join(__dirname, '..', 'src', 'commands'));
  const names = new Set(commands.map((command) => command.data.name));
  for (const name of ['balance', 'daily', 'weekly', 'work', 'pay', 'shop', 'inventory', 'leaderboard', 'level']) {
    assert.ok(names.has(name), `Missing /${name} command`);
  }
});

test('moderation commands include ban, kick, timeout, warn, purge, lock, unlock, and slowmode', () => {
  const commands = loadModules(path.join(__dirname, '..', 'src', 'commands'));
  const names = new Set(commands.map((command) => command.data.name));
  for (const name of ['ban', 'kick', 'timeout', 'warn', 'purge', 'lock', 'unlock', 'slowmode']) {
    assert.ok(names.has(name), `Missing /${name} command`);
  }
});

test('moderation settings include a configurable log channel and audit events cover required activity', () => {
  const config = new GuildConfig({ guildId: '12345678901234567' });
  assert.equal(config.moderation.logChannelId, null);
  for (const name of [
    'logDiscordModerationAudit',
    'logMemberJoin',
    'logMemberLeave',
    'logMessageDelete',
    'logMessageUpdate',
    'logVoiceStateUpdate',
    'recordModerationAction',
  ]) {
    assert.equal(typeof moderationLogging[name], 'function');
  }
  const { AuditLogEvent } = require('discord.js');
  assert.ok(moderationLogging.MODERATION_AUDIT_ACTIONS.has(AuditLogEvent.MemberKick));
  assert.ok(moderationLogging.MODERATION_AUDIT_ACTIONS.has(AuditLogEvent.MemberBanAdd));
  assert.ok(moderationLogging.MODERATION_AUDIT_ACTIONS.has(AuditLogEvent.MemberUpdate));
});

test('moderation target checks prevent self-targeting and enforce moderator and bot role hierarchy', async () => {
  const role = (position) => ({
    highest: { position, comparePositionTo: (other) => position - other.position },
  });
  const interaction = {
    user: { id: 'moderator' },
    client: { user: { id: 'bot' } },
    guild: {
      ownerId: 'owner',
      members: {
        me: { roles: role(10) },
        fetch: async (id) => ({ id, roles: role(5) }),
        fetchMe: async () => ({ roles: role(10) }),
      },
    },
    member: { roles: role(8) },
  };
  await assert.rejects(
    assertTargetIsModeratable(interaction, { id: 'moderator' }),
    /You cannot moderate yourself/,
  );
  await assert.rejects(
    assertTargetIsModeratable(interaction, { id: 'target', roles: role(8) }),
    /Your highest role must be above/,
  );
  interaction.member.roles = role(12);
  await assert.rejects(
    assertTargetIsModeratable(interaction, { id: 'target', roles: role(11) }),
    /My highest role must be above/,
  );
  interaction.member.roles = role(8);
  const target = await assertTargetIsModeratable(interaction, { id: 'target', roles: role(4) });
  assert.equal(target.id, 'target');
});

test('music commands register playback, queue, volume, repeat, shuffle, and now-playing controls', () => {
  const commands = loadModules(path.join(__dirname, '..', 'src', 'commands'));
  const musicCommands = commands.filter((command) => command.module === 'music');
  const names = new Set(musicCommands.map((command) => command.data.name));
  for (const name of ['play', 'pause', 'resume', 'skip', 'stop', 'queue', 'volume', 'loop', 'shuffle', 'nowplaying']) {
    assert.ok(names.has(name), `Missing /${name} command`);
  }
  assert.equal(musicCommands.length, names.size);
});

test('music queue utilities keep the source queue unchanged and format durations', () => {
  const tracks = ['a', 'b', 'c', 'd'];
  const shuffled = shuffleTracks(tracks, () => 0);
  assert.deepEqual(shuffled, ['b', 'c', 'd', 'a']);
  assert.deepEqual(tracks, ['a', 'b', 'c', 'd']);
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(Number.NaN), 'Live');
});

test('music service queues tracks and applies player controls through the voice player', async () => {
  const { AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
  class FakePlayer extends EventEmitter {
    constructor() {
      super();
      this.state = { status: AudioPlayerStatus.Idle, resource: null };
    }

    play(resource) {
      const previous = this.state;
      this.state = { status: AudioPlayerStatus.Playing, resource };
      this.emit('stateChange', previous, this.state);
    }

    pause() {
      if (this.state.status !== AudioPlayerStatus.Playing) return false;
      const previous = this.state;
      this.state = { ...this.state, status: AudioPlayerStatus.Paused };
      this.emit('stateChange', previous, this.state);
      return true;
    }

    unpause() {
      if (this.state.status !== AudioPlayerStatus.Paused) return false;
      const previous = this.state;
      this.state = { ...this.state, status: AudioPlayerStatus.Playing };
      this.emit('stateChange', previous, this.state);
      return true;
    }

    stop() {
      if (this.state.status === AudioPlayerStatus.Idle) return false;
      const previous = this.state;
      this.state = { status: AudioPlayerStatus.Idle, resource: null };
      this.emit('stateChange', previous, this.state);
      return true;
    }
  }

  class FakeConnection extends EventEmitter {
    constructor() {
      super();
      this.state = { status: VoiceConnectionStatus.Ready };
    }

    subscribe() {}

    destroy() {
      const previous = this.state;
      this.state = { status: VoiceConnectionStatus.Destroyed };
      this.emit('stateChange', previous, this.state);
    }
  }

  const players = [];
  const voice = {
    AudioPlayerStatus,
    VoiceConnectionStatus,
    NoSubscriberBehavior: { Pause: 'pause' },
    StreamType: { Raw: 'raw' },
    createAudioPlayer: () => {
      const player = new FakePlayer();
      players.push(player);
      return player;
    },
    createAudioResource: () => ({ volume: { setVolume(value) { this.value = value; } } }),
    joinVoiceChannel: () => new FakeConnection(),
    entersState: async (connection) => connection,
  };
  const audioSource = {
    validate: async () => 'search',
    search: async () => [{
      title: 'Test track',
      url: 'https://www.youtube.com/watch?v=example',
      durationInSec: 60,
      thumbnails: [],
    }],
    stream: async () => ({ stream: Readable.from([Buffer.from('audio')]), type: 'arbitrary' }),
  };
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
  };
  const service = createMusicService({
    voice,
    audioSource,
    spawnProcess,
    transcoderPath: 'fake-ffmpeg',
    getGuildConfig: async () => ({ music: { defaultVolume: 75, maxQueueSize: 10 } }),
    logger: { error() {}, warn() {} },
  });
  const interaction = {
    guildId: 'guild',
    guild: {
      members: {
        me: {},
        fetchMe: async () => ({}),
      },
      voiceAdapterCreator: {},
    },
    member: {
      voice: { channel: { id: 'voice-channel', permissionsFor: () => ({ has: () => true }) }, channelId: 'voice-channel' },
    },
    user: { id: 'member' },
  };

  try {
    const added = await service.enqueue(interaction, 'test song');
    assert.equal(added.track.title, 'Test track');
    assert.equal(service.getQueue(interaction).current.title, 'Test track');
    assert.equal(service.getQueue(interaction).volume, 75);
    service.setVolume(interaction, 125);
    assert.equal(service.getQueue(interaction).volume, 125);
    service.pause(interaction);
    assert.equal(service.getQueue(interaction).current.title, 'Test track');
    service.resume(interaction);
    service.setLoop(interaction, 'track');
    players[0].stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.getQueue(interaction).current.title, 'Test track');
    service.setLoop(interaction, 'off');
    service.skip(interaction);
    assert.equal(service.getQueue(interaction).current, null);
    service.stop(interaction);
    assert.equal(service.getQueue(interaction).current, null);
  } finally {
    await service.cleanup();
  }
});

test('AI commands register chat, ticket, moderation, embed, and announcement tools', () => {
    const commands = loadModules(path.join(__dirname, '..', 'src', 'commands'));
    const ai = commands.find((command) => command.data.name === 'ai');
    assert.ok(ai);
    assert.deepEqual(
      ai.data.toJSON().options.map((option) => option.name),
      ['chat', 'ticket-summary', 'ticket-reply', 'moderate', 'embed', 'announcement'],
    );
    assert.equal(ai.module, 'ai');
  });

  test('AI service supports OpenAI responses, input bounds, JSON moderation, and per-user rate limits', async () => {
    let time = 10_000;
    const requests = [];
    const service = createAiService({
      provider: 'openai',
      apiKey: 'test-key',
      fetchImpl: async (url, options) => {
        requests.push({ url, options, body: JSON.parse(options.body) });
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: requests.length === 2
              ? '{"label":"review","confidence":0.9,"reason":"Targeted insult"}'
              : 'Helpful response' } }],
          }),
        };
      },
      now: () => time,
    });
    const first = await service.chat({ guildId: 'guild', userId: 'user', input: 'Hello' });
    assert.equal(first, 'Helpful response');
    assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key');
    assert.match(requests[0].body.messages[1].content, /untrusted user-provided content/);
    assert.match(requests[0].body.messages[1].content, /"Hello"/);
    await assert.rejects(
      service.chat({ guildId: 'guild', userId: 'user', input: 'Again' }),
      (error) => error instanceof AiServiceError && /wait a few seconds/.test(error.publicMessage),
    );
    time += 5_000;
    const moderation = await service.analyzeModeration({ guildId: 'guild', userId: 'user', input: 'That was rude.' });
    assert.deepEqual(moderation, { label: 'review', confidence: 0.9, reason: 'Targeted insult' });
    time += 5_000;
    assert.equal(
      await service.chat({ guildId: 'guild', userId: 'other', input: 'x'.repeat(MAX_INPUT_CHARS + 100) }),
      'Helpful response',
    );
    const sentInput = requests[2].body.messages[1].content;
    assert.equal([...sentInput.matchAll(/x/g)].length, MAX_INPUT_CHARS);
  });

  test('AI service supports Gemini and validates generated embed data', async () => {
    let response = 'A friendly community update.';
    let time = 1_000;
    const requests = [];
    const service = createAiService({
      provider: 'gemini',
      apiKey: 'gemini-test-key',
      fetchImpl: async (url, options) => {
        requests.push({ url, options, body: JSON.parse(options.body) });
        return {
          ok: true,
          json: async () => ({ candidates: [{ content: { parts: [{ text: response }] } }] }),
        };
      },
      now: () => time,
    });
    assert.equal(await service.createAnnouncement({
      guildId: 'guild',
      userId: 'member',
      input: 'Community event; friendly tone',
    }), response);
    assert.match(requests[0].url, /models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(requests[0].options.headers['x-goog-api-key'], 'gemini-test-key');
    assert.ok(requests[0].body.systemInstruction);

    time += 5_000;
    response = '{"title":"Welcome","description":"Hello, members!","color":"5865f2"}';
    const embed = await service.createEmbedContent({ guildId: 'guild', userId: 'member', input: 'Welcome new members' });
    assert.deepEqual(embed, { title: 'Welcome', description: 'Hello, members!', color: 0x5865f2 });
    time += 5_000;
    response = '{"title":"Bad","description":"Hello","color":"not-a-color"}';
    await assert.rejects(
      service.createEmbedContent({ guildId: 'guild', userId: 'member', input: 'Create an embed' }),
      (error) => error instanceof AiServiceError && /expected format/.test(error.publicMessage),
    );
  });

  test('AI service reports missing credentials and provider HTTP errors without leaking response content', async () => {
    const unconfigured = createAiService({ provider: 'openai', apiKey: '' });
    await assert.rejects(
      unconfigured.chat({ guildId: 'guild', userId: 'member', input: 'Hello' }),
      (error) => error instanceof AiServiceError && /not configured yet/.test(error.publicMessage),
    );
    const failing = createAiService({
      provider: 'openai',
      apiKey: 'invalid',
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'private provider response' }),
    });
    await assert.rejects(
      failing.chat({ guildId: 'guild', userId: 'member', input: 'Hello' }),
      (error) => error instanceof AiServiceError
        && /rate-limited or its quota is exhausted/.test(error.publicMessage)
        && !error.publicMessage.includes('private provider response'),
    );
  });

  test('AI service falls back to a configured provider on rate limits and missing primary keys', async () => {
    let time = 20_000;
    const requests = [];
    const service = createAiService({
      provider: 'openai',
      apiKey: 'openai-key',
      fallbackProvider: 'gemini',
      fallbackApiKey: 'gemini-key',
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url.includes('api.openai.com')) return { ok: false, status: 429 };
        return {
          ok: true,
          json: async () => ({ candidates: [{ content: { parts: [{ text: 'Fallback answer' }] } }] }),
        };
      },
      now: () => time,
    });
    assert.equal(await service.chat({ guildId: 'guild', userId: 'one', input: 'Hello' }), 'Fallback answer');
    assert.equal(requests.length, 2);
    assert.ok(requests[0].url.includes('api.openai.com'));
    assert.ok(requests[1].url.includes('generativelanguage.googleapis.com'));

    time += 5_000;
    const missingPrimary = createAiService({
      provider: 'openai',
      apiKey: '',
      fallbackProvider: 'gemini',
      fallbackApiKey: 'gemini-key',
      fetchImpl: async (url) => {
        assert.ok(url.includes('generativelanguage.googleapis.com'));
        return {
          ok: true,
          json: async () => ({ candidates: [{ content: { parts: [{ text: 'Configured fallback' }] } }] }),
        };
      },
      now: () => time,
    });
    assert.equal(await missingPrimary.chat({ guildId: 'guild', userId: 'two', input: 'Hi' }), 'Configured fallback');
  });

  test('AI mention responses require opt-in, skip empty prompts, and suppress Discord pings', async () => {
    const payloads = [];
    const message = {
      client: { user: { id: 'bot-id' } },
      mentions: { users: new Map([['bot-id', {}]]) },
      content: '<@bot-id> hello',
      guild: { id: 'guild' },
      author: { id: 'member' },
      reply: async (payload) => payloads.push(payload),
      channel: { send: async (payload) => payloads.push(payload) },
    };
    let calls = 0;
    const service = { chat: async () => { calls += 1; return '@everyone welcome'; } };
    assert.equal(await respondToMention(message, { modules: { ai: false }, ai: { mentionResponses: true } }, service), false);
    assert.equal(await respondToMention(message, { modules: { ai: true }, ai: { mentionResponses: false } }, service), false);
    assert.equal(await respondToMention(message, { modules: { ai: true }, ai: { mentionResponses: true } }, service), true);
    assert.equal(calls, 1);
    assert.deepEqual(payloads[0].allowedMentions, { parse: [], repliedUser: false });

    payloads.length = 0;
    message.content = '<@bot-id>';
    await respondToMention(message, { modules: { ai: true }, ai: { mentionResponses: true } }, service);
    assert.match(payloads[0].content, /Mention me with a question/);
    assert.equal(calls, 1);
    assert.equal(splitReply('x'.repeat(3600)).length, 2);
});

test('custom command and embed builder slash commands are registered for their module', () => {
  const commands = loadModules(path.join(__dirname, '..', 'src', 'commands'));
  const customCommand = commands.find((command) => command.data.name === 'custom-command');
  const builder = commands.find((command) => command.data.name === 'embed-builder');
  assert.ok(customCommand);
  assert.ok(builder);
  assert.equal(customCommand.module, 'customCommands');
  assert.equal(builder.module, 'customCommands');
  assert.deepEqual(customCommand.data.toJSON().options.map((option) => option.name), ['set', 'delete', 'list']);
  assert.equal(builder.data.toJSON().default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
});

test('embed builder opens a scoped modal session for the initiating administrator', async () => {
  let modal;
  await embedBuilderCommand.execute({
    guildId: 'guild',
    guild: {},
    channelId: 'channel',
    user: { id: 'member' },
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    showModal: async (value) => { modal = value.toJSON(); },
    reply: async () => assert.fail('Authorized builder request should open its modal.'),
  });
  assert.match(modal.custom_id, /^embed-builder:submit:[a-f0-9]{24}$/);
  assert.equal(modal.components.length, 5);
  const token = modal.custom_id.split(':').at(-1);
  assert.equal(embedBuilderCommand.takeBuilderSession(token, {
    customId: modal.custom_id,
    guildId: 'guild',
    channelId: 'channel',
    user: { id: 'member' },
  }).guildId, 'guild');
  assert.equal(embedBuilderCommand.takeBuilderSession(token, {
    customId: modal.custom_id,
    guildId: 'guild',
    channelId: 'channel',
    user: { id: 'member' },
  }), null);
});

test('custom command triggers use the configured prefix and normalize command names', () => {
  assert.equal(getCustomCommandName('!Rules please', '!'), 'rules');
  assert.equal(getCustomCommandName('!hello extra arguments', '!'), 'hello');
  assert.equal(getCustomCommandName('hello', '!'), null);
  assert.equal(getCustomCommandName('!bad/name', '!'), null);
  assert.equal(getCustomCommandName('!help', ''), null);
});

test('custom embeds validate fields and render safe HTTPS link buttons', () => {
  const built = createEmbedPayload({
    title: 'Welcome',
    description: 'Read the rules.',
    color: '#5865f2',
    footer: 'InfinitX',
    fields: [{ name: 'Rules', value: 'Be kind.', inline: true }],
  }, [{ label: 'Website', url: 'https://example.com/help' }]);
  const embed = built.payload.embeds[0].toJSON();
  const button = built.payload.components[0].toJSON().components[0];
  assert.equal(embed.title, 'Welcome');
  assert.equal(embed.color, 0x5865f2);
  assert.deepEqual(embed.fields, [{ name: 'Rules', value: 'Be kind.', inline: true }]);
  assert.equal(button.style, 5);
  assert.equal(button.url, 'https://example.com/help');
  assert.deepEqual(built.payload.allowedMentions, { parse: [] });
  assert.equal(normalizeEmbed({ title: 'Test', fields: [] }).title, 'Test');
  assert.deepEqual(normalizeButtons([]), []);
  assert.throws(() => normalizeEmbed({ title: '', description: ' ' }), /at least one non-empty/);
  assert.throws(() => normalizeEmbed({ title: 'x', unknown: true }), /Embed must be an object/);
  assert.throws(() => normalizeEmbed({ title: 'x', fields: Array(26).fill({ name: 'a', value: 'b' }) }), /at most 25/);
  assert.throws(() => normalizeEmbed({
    description: 'x'.repeat(4096),
    footer: 'f'.repeat(700),
    fields: [{ name: 'a'.repeat(256), value: 'b'.repeat(1024) }],
  }), /6000 characters/);
  assert.throws(() => normalizeButtons([{ label: 'Unsafe', url: 'javascript:alert(1)' }]), /HTTPS/);
  assert.throws(() => normalizeButtons([{ label: 'Credential URL', url: 'https://user:pass@example.com' }]), /HTTPS/);
});

test('economy accounts and ledger records validate persistent reward and purchase data', async () => {
  const account = new Economy({
    guildId: '12345678901234567',
    userId: '12345678901234568',
    coins: 250,
    lastDailyAt: new Date(),
    lastWeeklyAt: new Date(),
    lastWorkAt: new Date(),
    inventory: [{ itemId: 'badge', quantity: 2 }],
  });
  await assert.doesNotReject(account.validate());
  const transaction = new EconomyTransaction({
    guildId: account.guildId,
    type: 'purchase',
    amount: 50,
    recipientId: account.userId,
    itemId: 'badge',
  });
  await assert.doesNotReject(transaction.validate());
});

test('custom command records validate trigger, embed content, and link buttons', async () => {
  const valid = new CustomCommand({
    guildId: '12345678901234567',
    name: 'welcome',
    embed: { title: 'Welcome' },
    buttons: [{ label: 'Rules', url: 'https://example.com/rules' }],
  });
  await assert.doesNotReject(valid.validate());
  const invalid = new CustomCommand({
    guildId: '12345678901234567',
    name: 'welcome',
    buttons: [{ label: 'Unsafe', url: 'javascript:alert(1)' }],
  });
  await assert.rejects(invalid.validate());
});

test('guild economy, level, music, and welcome settings have documented defaults', () => {
  const config = new GuildConfig({ guildId: '12345678901234567' });
  assert.equal(config.economy.dailyReward, 100);
  assert.equal(config.economy.weeklyReward, 500);
  assert.equal(config.economy.workMin, 25);
  assert.equal(config.economy.workMax, 100);
  assert.equal(config.leveling.cooldownSeconds, 60);
  assert.deepEqual(config.leveling.roleRewards, []);
  assert.equal(config.ai.mentionResponses, false);
  assert.equal(config.ai.greetingAutoReply, false);
  assert.equal(config.music.defaultVolume, 50);
  assert.equal(config.modules.get('welcomeLeave'), false);
  assert.equal(config.welcomeLeave.welcomeEnabled, false);
  assert.equal(config.welcomeLeave.welcome.color, '#7478ff');
  assert.equal(config.welcomeLeave.welcome.includeDate, true);
  assert.equal(config.welcomeLeave.welcome.includeTime, true);
  assert.equal(config.tickets.panel.buttonLabel, 'Open a ticket');
  assert.equal(config.verification.panel.buttonLabel, 'Verify');
});

test('dashboard configuration fields are backed by explicit GuildConfig and ScheduledMessage schema paths', () => {
  for (const schemaPath of [
    'welcomeLeave.backgroundImageUrl',
    'welcomeLeave.welcome.includeDate',
    'welcomeLeave.welcome.includeTime',
    'welcomeLeave.leave.includeDate',
    'welcomeLeave.leave.includeTime',
    'welcomeLeave.welcome.imageUrl',
    'welcomeLeave.leave.imageUrl',
    'tickets.panel.title',
    'tickets.panel.buttonLabel',
    'tickets.panel.buttonStyle',
    'verification.panel.title',
    'verification.panel.imageUrl',
    'verification.panel.buttonStyle',
    'ai.greetingAutoReply',
    'ai.greetingTriggers',
  ]) {
    assert.ok(GuildConfig.schema.path(schemaPath), `GuildConfig schema is missing ${schemaPath}`);
  }
  for (const schemaPath of ['guildId', 'channelId', 'createdBy', 'scheduledAt', 'status', 'imageUrl']) {
    assert.ok(ScheduledMessage.schema.path(schemaPath), `ScheduledMessage schema is missing ${schemaPath}`);
  }
});

test('dashboard errors expose Mongoose validation details without masking server failures', async () => {
  let validationError;
  try {
    await new GuildConfig({
      guildId: '12345678901234567',
      prefix: 'prefix-too-long',
    }).validate();
  } catch (error) {
    validationError = error;
  }
  assert.ok(validationError);
  assert.equal(getDashboardErrorStatus(validationError), 400);
  const response = getDashboardErrorResponse(validationError, 400);
  assert.match(response.error, /prefix/);
  assert.ok(response.details.prefix);
  assert.equal(getDashboardErrorStatus({ status: 413 }), 413);
  assert.equal(getDashboardErrorStatus(new Error('database unavailable')), 500);
  assert.deepEqual(
    getDashboardErrorResponse(new Error('database unavailable'), 500),
    { error: 'Internal server error.' },
  );
});

test('partial dashboard section saves preserve sibling settings and nested fields', async () => {
  const config = new GuildConfig({
    guildId: '12345678901234567',
    tickets: {
      categoryId: '12345678901234568',
      supportRoleId: '12345678901234569',
      autoCloseHours: 48,
      categories: [{ key: 'billing', label: 'Billing' }],
      panel: { title: 'Old title', buttonLabel: 'Old button' },
    },
  });
  applySettingsPatch(config, 'tickets', {
    panel: { title: 'New title', buttonLabel: 'Contact support' },
  });
  await assert.doesNotReject(config.validate());
  assert.equal(config.tickets.categoryId, '12345678901234568');
  assert.equal(config.tickets.supportRoleId, '12345678901234569');
  assert.equal(config.tickets.autoCloseHours, 48);
  assert.equal(config.tickets.categories[0].key, 'billing');
  assert.equal(config.tickets.panel.title, 'New title');
  assert.equal(config.tickets.panel.buttonLabel, 'Contact support');
  assert.equal(config.tickets.panel.buttonStyle, 'primary');
});

test('guild welcome configuration validates channels, templates, and embeds', async () => {
  const config = new GuildConfig({
    guildId: '12345678901234567',
    modules: { welcomeLeave: true },
    welcomeLeave: {
      welcomeEnabled: true,
      welcomeChannelId: '12345678901234568',
      backgroundImageUrl: 'https://cdn.example.test/banner.png',
      welcome: {
        title: 'Welcome {user}',
        description: 'Welcome to {server}',
        color: '#7478ff',
        footer: 'Hello',
        thumbnailUrl: 'https://cdn.example.test/avatar.png',
        imageUrl: 'https://cdn.example.test/welcome.gif',
      },
    },
  });
  await assert.doesNotReject(config.validate());
});

test('all command modules load and define unique slash command names', () => {
  const commands = loadModules(path.join(__dirname, '..', 'src', 'commands'));
  const names = commands.map((command) => command.data.toJSON().name);
  assert.ok(names.length > 0);
  assert.equal(new Set(names).size, names.length);
  assert.ok(commands.every((command) => typeof command.execute === 'function'));
  assert.ok(names.includes('verification'));
  assert.ok(names.includes('giveaway'));
  assert.ok(names.includes('tempvoice'));
  assert.ok(names.includes('analytics'));
  assert.ok(names.includes('starboard'));
  assert.ok(names.includes('suggestion'));
  assert.ok(names.includes('owner'));
});

test('owner access policy enforces blacklist precedence and optional whitelist mode', async () => {
  const records = [];
  let whitelistEnabled = false;
  const AccessControlModel = {
    find: (filter) => ({
      select() { return this; },
      lean: async () => records.filter((record) => record.action === filter.action
        && filter.$or.some((condition) => condition.subjectType === record.subjectType
          && condition.subjectId === record.subjectId)),
    }),
    exists: async (filter) => records.some((record) => record.action === filter.action
      && filter.$or.some((condition) => condition.subjectType === record.subjectType
        && condition.subjectId === record.subjectId)),
    updateOne: async (filter, update) => {
      const existing = records.find((record) => record.action === filter.action
        && record.subjectType === filter.subjectType && record.subjectId === filter.subjectId);
      if (existing) Object.assign(existing, update.$set);
      else records.push({ ...filter, ...update.$set });
    },
    deleteOne: async (filter) => {
      const index = records.findIndex((record) => record.action === filter.action
        && record.subjectType === filter.subjectType && record.subjectId === filter.subjectId);
      if (index < 0) return { deletedCount: 0 };
      records.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
  const SettingsModel = {
    findById: () => ({ lean: async () => ({ whitelistEnabled }) }),
    updateOne: async (_filter, update) => { whitelistEnabled = update.$set.whitelistEnabled; },
  };
  const service = createOwnerService({ AccessControlModel, SettingsModel });
  const client = { ownerIds: ['12345678901234567'] };
  const interaction = (userId, guildId = '12345678901234568') => ({ client, user: { id: userId }, guildId });
  assert.equal(isBotOwner(client, '12345678901234567'), true);
  assert.equal((await service.enforceAccess(interaction('12345678901234569'))).allowed, true);

  await service.setWhitelistMode(true, '12345678901234567');
  assert.equal((await service.enforceAccess(interaction('12345678901234569'))).allowed, false);
  await service.setAccess('whitelist', 'guild', '12345678901234568', '12345678901234567');
  assert.equal((await service.enforceAccess(interaction('12345678901234569'))).allowed, true);
  await service.setAccess('blacklist', 'user', '12345678901234569', '12345678901234567', 'abuse');
  assert.equal((await service.enforceAccess(interaction('12345678901234569'))).allowed, false);
  assert.equal((await service.enforceAccess(interaction('12345678901234567'))).owner, true);
  assert.equal(await service.removeAccess('blacklist', 'user', '12345678901234569'), true);
});

test('owner access-control records and global settings validate', async () => {
  const record = new BotAccessControl({
    action: 'blacklist',
    subjectType: 'guild',
    subjectId: '12345678901234567',
    actorId: '12345678901234568',
    reason: 'abuse',
  });
  await assert.doesNotReject(record.validate());
  const settings = new BotSettings({ _id: 'global', whitelistEnabled: true, updatedBy: '12345678901234568' });
  await assert.doesNotReject(settings.validate());
});

test('dashboard server API accepts supported configuration and validates permissions/settings', async () => {
  const patch = validateConfigPatch({
    prefix: '?',
    language: 'en-US',
    modules: { tickets: true, starboard: false, welcomeLeave: true },
    settings: {
      moderation: { antiLink: true },
      starboard: { threshold: 5, emoji: '⭐' },
      music: { defaultVolume: 42 },
      ai: { greetingAutoReply: true, greetingTriggers: ['hi', 'good morning'] },
      tickets: { panel: { title: 'Support', description: 'Open a ticket', color: '#123abc', buttonLabel: 'Contact support', buttonStyle: 'success', imageUrl: null } },
      verification: { enabled: true, roleId: '12345678901234568', panel: { title: 'Verify', buttonLabel: 'Start', buttonStyle: 'primary' } },
      welcomeLeave: {
        welcomeEnabled: true,
        welcomeChannelId: '12345678901234567',
        welcome: { title: 'Hello {user}', description: 'Welcome to {server}', color: '#7478ff', footer: 'Enjoy!', thumbnailUrl: null },
      },
    },
    commandPermissions: [{ commandName: 'warn', enabled: false }],
  });
  assert.equal(patch.prefix, '?');
  assert.equal(patch.modules.tickets, true);
  assert.doesNotThrow(() => validateSettings('tickets', {
    panel: { title: 'Support', description: 'Get help', color: '#123abc', buttonLabel: 'Open', buttonStyle: 'primary', imageUrl: null },
  }));
  assert.throws(() => validateSettings('verification', {
    panel: { buttonStyle: 'link' },
  }), /buttonStyle is invalid/);
  assert.doesNotThrow(() => validateDashboardEmbed({
    title: 'Announcement', description: 'Details', color: '#7478ff', imageUrl: 'https://cdn.example.test/announcement.gif',
  }));
  assert.throws(() => validateDashboardEmbed({
    title: 'Unsafe', imageUrl: 'javascript:alert(1)',
  }), /HTTPS image URL/);
  assert.doesNotThrow(() => validateSettings('moderation', { antiLink: true }));
  assert.doesNotThrow(() => validateSettings('welcomeLeave', {
    backgroundImageUrl: 'https://cdn.example.test/banner.png',
    welcome: { title: 'Welcome {user}', color: '#abcdef', thumbnailUrl: null },
  }));
  assert.throws(() => validateSettings('welcomeLeave', {
    backgroundImageUrl: 'http://example.test/banner.png',
  }), /HTTPS image URL/);
  assert.doesNotThrow(() => validateSettings('welcomeLeave', {
    welcome: { imageUrl: 'https://cdn.example.test/welcome.gif', footer: 'InfinitX • {date} {time}' },
  }));
  assert.throws(() => validateConfigPatch({ modules: { madeUp: true } }), /supported module names/);
  assert.throws(() => validateSettings('leveling', { excludedChannels: ['invalid-id'] }), /Discord channel IDs/);
  await assert.doesNotReject(validateCommandPermission('12345678901234567', 'warn', {
    enabled: false,
    requiredRoleIds: ['12345678901234568'],
    cooldownSeconds: 30,
  }));
  assert.throws(() => validateCommandPermission('12345678901234567', 'warn', {
    cooldownSeconds: -1,
  }), /outside its valid range/);
});

test('dashboard action and scheduled-message records validate queued workflow state', async () => {
  const action = new DashboardAction({
    guildId: '12345678901234567',
    actorId: '12345678901234568',
    type: 'deploy-ticket-panel',
    payload: { channelId: '12345678901234569' },
  });
  await assert.doesNotReject(action.validate());
  await assert.rejects(new DashboardAction({
    guildId: '12345678901234567',
    actorId: '12345678901234568',
    type: 'unknown',
    payload: {},
  }).validate());

  const schedule = new ScheduledMessage({
    guildId: '12345678901234567',
    channelId: '12345678901234569',
    createdBy: '12345678901234568',
    title: 'Maintenance',
    description: 'Scheduled notice',
    imageUrl: 'https://cdn.example.test/maintenance.png',
    scheduledAt: new Date(Date.now() + 60_000),
  });
  await assert.doesNotReject(schedule.validate());
  await assert.rejects(new ScheduledMessage({
    guildId: '12345678901234567',
    channelId: '12345678901234569',
    createdBy: '12345678901234568',
    color: 'red',
    scheduledAt: new Date(Date.now() + 60_000),
  }).validate());
});

test('dashboard worker requeues scheduled deliveries interrupted by a stale process', async () => {
  const originalUpdateMany = ScheduledMessage.updateMany;
  let call;
  ScheduledMessage.updateMany = async (...args) => {
    call = args;
    return { modifiedCount: 2 };
  };
  try {
    const now = new Date('2026-10-09T12:00:00.000Z');
    assert.equal(await recoverStaleScheduledMessages(now), 2);
    assert.deepEqual(call[0], {
      status: 'sending',
      updatedAt: { $lt: new Date('2026-10-09T11:50:00.000Z') },
    });
    assert.deepEqual(call[1].$set, {
      status: 'pending',
      lastError: 'Delivery was interrupted; the bot will retry.',
    });
  } finally {
    ScheduledMessage.updateMany = originalUpdateMany;
  }
});

test('welcome embeds replace identity/date/time placeholders and preserve image/footer branding', () => {
  const now = new Date('2026-10-09T08:05:00.000Z');
  const member = {
    id: '12345678901234567',
    displayName: 'Ada',
    user: { username: 'ada' },
    guild: { name: 'InfinitX', memberCount: 42 },
    client: { user: { displayAvatarURL: () => 'https://cdn.example.test/bot.png' } },
  };
  assert.equal(interpolateWelcomeText('{user}|{username}|{server}|{memberCount}|{date}|{time}', member, now),
    '<@12345678901234567>|Ada|InfinitX|42|Oct 9, 2026|8:05 AM');
  const embed = buildWelcomeEmbed(member, {
    backgroundImageUrl: 'https://cdn.example.test/banner.png',
    welcome: {
      title: 'Welcome {username}',
      description: 'Join {server}, member {memberCount}',
      color: '#123abc',
      footer: 'InfinitX Club • {date} {time}',
      thumbnailUrl: 'https://cdn.example.test/avatar.png',
      imageUrl: 'https://cdn.example.test/welcome.gif',
    },
  }, 'welcome', now).toJSON();
  assert.equal(embed.title, 'Welcome Ada');
  assert.equal(embed.description, 'Join InfinitX, member 42');
  assert.equal(embed.color, 0x123abc);
  assert.equal(embed.footer.text, 'InfinitX Club • Oct 9, 2026 8:05 AM');
  assert.equal(embed.footer.icon_url, 'https://cdn.example.test/bot.png');
  assert.equal(embed.thumbnail.url, 'https://cdn.example.test/avatar.png');
  assert.equal(embed.image.url, 'https://cdn.example.test/welcome.gif');
  assert.equal(interpolateWelcomeText('{date}|{time}', member, now, {
    includeDate: false,
    includeTime: true,
  }), '|8:05 AM');
});

test('AI greeting auto-replies only for enabled exact triggers and suppresses mentions', async () => {
  const payloads = [];
  const message = {
    client: { user: { id: 'bot-id' } },
    mentions: { users: new Map() },
    content: ' Hello! ',
    guild: { id: 'guild' },
    author: { id: 'member' },
    reply: async (payload) => payloads.push(payload),
    channel: { send: async (payload) => payloads.push(payload) },
  };
  const calls = [];
  const service = { chat: async (input) => { calls.push(input); return 'Hello there!'; } };
  const config = { modules: { ai: true }, ai: { greetingAutoReply: true, greetingTriggers: ['hi', 'hello'] } };

  assert.equal(await respondToGreeting(message, config, service), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].guildId, 'guild');
  assert.deepEqual(payloads[0].allowedMentions, { parse: [], repliedUser: false });

  message.content = 'hello there';
  assert.equal(await respondToGreeting(message, config, service), false);
  message.content = 'hi';
  message.mentions.users.set('bot-id', {});
  assert.equal(await respondToGreeting(message, config, service), false);
  assert.equal(calls.length, 1);
});

test('dashboard home template escapes user-controlled data', async () => {
  const ejs = require('ejs');
  const rendered = await ejs.renderFile(path.join(__dirname, '..', 'src', 'dashboard', 'views', 'home.ejs'), {
    user: { id: '12345678901234567', username: '<script>alert(1)</script>', avatar: null },
    servers: [],
    error: null,
  });
  assert.doesNotMatch(rendered, /<script>alert\(1\)<\/script>/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('guild authorization attaches the already-fetched server for the settings page', async () => {
  const previousFetch = global.fetch;
  const guild = {
    id: '12345678901234567',
    name: 'Authorized server',
    owner: false,
    permissions: '32',
  };
  global.fetch = async () => ({
    ok: true,
    async json() {
      return [guild];
    },
  });

  try {
    const req = {
      params: { guildId: guild.id },
      session: { accessToken: 'test-access-token' },
    };
    let nextError;
    await requireGuildManager(req, { status() { return this; }, json() {} }, (error) => {
      nextError = error;
    });
    assert.equal(nextError, undefined);
    assert.equal(req.guildId, guild.id);
    assert.equal(req.guild, guild);
  } finally {
    global.fetch = previousFetch;
  }
});

test('dashboard origin guard allows localhost in development but not production', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const makeRequest = (origin, dashboardBaseUrl, host = 'localhost:3000') => ({
    get: (header) => ({ origin, host })[header],
    method: 'POST',
    originalUrl: '/auth/logout',
    app: { locals: { config: { dashboardBaseUrl } } },
  });
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  try {
    process.env.NODE_ENV = 'development';
    let continued = false;
    requireSameOrigin(makeRequest('http://localhost:3000', 'http://127.0.0.1:3000'), response, () => {
      continued = true;
    });
    assert.equal(continued, true);

    continued = false;
    requireSameOrigin(makeRequest('http://127.0.0.1:3000', 'http://localhost:3000', '127.0.0.1:3000'), response, () => {
      continued = true;
    });
    assert.equal(continued, true);

    continued = false;
    requireSameOrigin(makeRequest('http://localhost:4321', 'http://localhost:3000', 'localhost:4321'), response, () => {
      continued = true;
    });
    assert.equal(continued, true);

    continued = false;
    requireSameOrigin(makeRequest('http://localhost:4321', 'http://localhost:3000', 'attacker.example'), response, () => {
      continued = true;
    });
    assert.equal(continued, false);
    assert.equal(response.statusCode, 403);

    continued = false;
    requireSameOrigin(makeRequest('http://localhost:3000.evil.example', 'http://localhost:3000', 'localhost:3000'), response, () => {
      continued = true;
    });
    assert.equal(continued, false);
    assert.equal(response.statusCode, 403);

    process.env.NODE_ENV = 'production';
    continued = false;
    requireSameOrigin(makeRequest('http://localhost:3000', 'https://dashboard.example.com'), response, () => {
      continued = true;
    });
    assert.equal(continued, false);
    assert.equal(response.statusCode, 403);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('dashboard feature page renders welcome controls without JSON editors', async () => {
  const ejs = require('ejs');
  const config = new GuildConfig({ guildId: '12345678901234567' }).toObject({ flattenMaps: true });
  config.welcomeLeave.welcome.description = '</script><script>alert(1)</script>';
  const sections = [{ id: 'welcome', label: 'Welcome & Leave', icon: '✦', module: 'welcomeLeave' }];
  const rendered = await ejs.renderFile(path.join(__dirname, '..', 'src', 'dashboard', 'views', 'section.ejs'), {
    user: { id: '12345678901234567', username: 'Dashboard user', avatar: null },
    guild: { id: '12345678901234567', name: 'Test server', icon: null },
    guildId: '12345678901234567',
    sections,
    section: sections[0],
    fields: [],
    config,
    permissions: [],
    commands: [],
  });
  assert.match(rendered, /Welcome channel ID/);
  assert.match(rendered, /Background banner image URL/);
  assert.match(rendered, /data-embed-field="welcome\.includeDate"/);
  assert.match(rendered, /data-embed-field="leave\.includeTime"/);
  assert.match(rendered, /data-embed-field="welcome\.color"/);
  assert.doesNotMatch(rendered, /settings-json|permissions-json/);
  assert.doesNotMatch(rendered, /<\/script><script>alert\(1\)<\/script>/);
  const pageData = rendered.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(pageData);
  assert.equal(JSON.parse(pageData).welcomeLeave.welcome.description, '</script><script>alert(1)</script>');

  const commandsSection = { id: 'commands', label: 'Commands', icon: '⌘', description: 'Manage command policies.' };
  const commandsPage = await ejs.renderFile(path.join(__dirname, '..', 'src', 'dashboard', 'views', 'section.ejs'), {
    user: { id: '12345678901234567', username: 'Dashboard user', avatar: null },
    guild: { id: '12345678901234567', name: 'Test server', icon: null },
    guildId: '12345678901234567',
    sections: [commandsSection],
    section: commandsSection,
    fields: [],
    config,
    permissions: [{ commandName: 'warn', enabled: false, requiredRoleIds: ['12345678901234568'], cooldownSeconds: 30 }],
    commands: [{ name: 'warn', description: 'Warn a member.', module: 'moderation' }],
  });
  assert.match(commandsPage, /data-command-field="requiredRoleIds"/);
  assert.match(commandsPage, /data-command-field="allowedChannelIds"/);
  assert.match(commandsPage, /Save command policies/);
  assert.doesNotMatch(commandsPage, /permissions-json/);
});

test('dashboard renders ticket, verification, music, and scheduled-message controls', async () => {
  const ejs = require('ejs');
  const config = new GuildConfig({ guildId: '12345678901234567' }).toObject({ flattenMaps: true });
  const viewPath = path.join(__dirname, '..', 'src', 'dashboard', 'views', 'section.ejs');
  const base = {
    user: { id: '12345678901234567', username: 'Dashboard user', avatar: null },
    guild: { id: '12345678901234567', name: 'Test server', icon: null },
    guildId: '12345678901234567',
    fields: [],
    config,
    permissions: [],
    commands: [],
  };
  const render = (id) => ejs.renderFile(viewPath, {
    ...base,
    sections: [{ id, label: id, icon: '•', description: 'Configure this feature.' }],
    section: { id, label: id, icon: '•', description: 'Configure this feature.' },
  });
  const ticketPage = await render('ticketPanel');
  assert.match(ticketPage, /Save &amp; deploy ticket panel|Save & deploy ticket panel/);
  assert.match(ticketPage, /data-panel-field="buttonStyle"/);
  const verificationPage = await render('verificationPanel');
  assert.match(verificationPage, /Verified role ID/);
  assert.match(verificationPage, /data-verification-enabled/);
  const musicPage = await ejs.renderFile(viewPath, {
    ...base,
    sections: [{ id: 'music', label: 'Music', icon: '♫', description: 'Music controls.' }],
    section: { id: 'music', label: 'Music', icon: '♫', description: 'Music controls.' },
    fields: [{ key: 'defaultVolume', label: 'Default volume', min: 0, max: 200 }],
  });
  assert.match(musicPage, /data-music-action="pause"/);
  assert.match(musicPage, /data-music-queue/);
  const scheduledPage = await render('scheduled');
  assert.match(scheduledPage, /data-scheduled-action="schedule"/);
  assert.match(scheduledPage, /data-scheduled-refresh/);
});

test('starboard matches configured Unicode and custom emojis and formats source posts', async () => {
  assert.equal(matchesEmoji({ id: null, name: '⭐' }, '⭐'), true);
  assert.equal(matchesEmoji({ id: '12345678901234567', name: 'party' }, '<:party:12345678901234567>'), true);
  assert.equal(matchesEmoji({ id: '12345678901234567', name: 'party' }, '<a:party:12345678901234568>'), false);

  const embed = buildStarboardEmbed({
    author: { tag: 'member#0001', displayAvatarURL: () => 'https://cdn.example/avatar.png' },
    content: 'An idea worth starring',
    url: 'https://discord.com/channels/12345678901234567/12345678901234568/12345678901234569',
    channel: { name: 'general' },
    createdAt: new Date('2026-10-09T12:00:00Z'),
    attachments: [],
  }, 4, '⭐').toJSON();
  assert.equal(embed.footer.text, '⭐ 4 | #general');
  assert.equal(embed.description, 'An idea worth starring');

  const entry = new StarboardEntry({
    guildId: '12345678901234567',
    sourceChannelId: '12345678901234568',
    sourceMessageId: '12345678901234569',
    starboardChannelId: '12345678901234570',
    starboardMessageId: '12345678901234571',
    count: 3,
  });
  await assert.doesNotReject(entry.validate());
});

test('starboard creates, refreshes, and removes its post as the reaction count changes', async () => {
  const entries = [];
  let sends = 0;
  let edits = 0;
  let deletes = 0;
  const postedMessage = {
    id: '12345678901234572',
    edit: async () => { edits += 1; },
    delete: async () => { deletes += 1; },
  };
  const channel = {
    id: '12345678901234570',
    name: 'starboard',
    isTextBased: () => true,
    send: async () => { sends += 1; return postedMessage; },
    messages: { fetch: async () => postedMessage },
  };
  const guild = {
    id: '12345678901234567',
    channels: { fetch: async () => channel },
    members: {
      me: { permissionsIn: () => ({ has: () => true }) },
      fetchMe: async () => ({ permissionsIn: () => ({ has: () => true }) }),
    },
  };
  const message = {
    id: '12345678901234569',
    guild,
    channelId: '12345678901234568',
    channel: { name: 'general' },
    author: { tag: 'member#0001', bot: false, displayAvatarURL: () => 'https://cdn.example/avatar.png' },
    content: 'Star-worthy post',
    url: 'https://discord.com/channels/12345678901234567/12345678901234568/12345678901234569',
    createdAt: new Date(),
    attachments: [],
  };
  const service = createStarboardService({
    GuildConfigModel: { findOne: () => ({ lean: async () => ({
      modules: { starboard: true },
      starboard: { channelId: channel.id, threshold: 2, emoji: '⭐' },
    }) }) },
    StarboardEntryModel: {
      findOne: async () => entries[0] || null,
      create: async (entry) => entries.push({ ...entry, _id: 'entry-id' }),
      updateOne: async (_filter, update) => { entries[0].count = update.$set.count; },
      deleteOne: async () => { entries.splice(0, 1); },
    },
  });
  const reaction = { emoji: { id: null, name: '⭐' }, message, partial: false, count: 2 };
  assert.equal(await service.updateReaction(reaction), true);
  assert.equal(sends, 1);
  reaction.count = 3;
  assert.equal(await service.updateReaction(reaction), true);
  assert.equal(edits, 1);
  assert.equal(entries[0].count, 3);
  reaction.count = 1;
  assert.equal(await service.updateReaction(reaction), false);
  assert.equal(deletes, 1);
  assert.equal(entries.length, 0);
});

test('suggestion posts expose interactive votes and store decision/vote audit records', async () => {
  const suggestion = new Suggestion({
    guildId: '12345678901234567',
    channelId: '12345678901234568',
    messageId: '12345678901234569',
    authorId: '12345678901234570',
    text: 'Please add a new server event.',
    upvotes: ['12345678901234571'],
  });
  await assert.doesNotReject(suggestion.validate());
  const embed = suggestionEmbed(suggestion).toJSON();
  assert.equal(embed.fields[0].value, '1');
  assert.match(suggestionButtons(suggestion)[0].toJSON().components[0].custom_id, /^suggestion:vote:up:/);
  assert.equal(suggestionButtons(suggestion)[0].toJSON().components[0].disabled, false);

  const log = new SuggestionLog({
    guildId: suggestion.guildId,
    suggestionId: suggestion._id,
    actorId: '12345678901234571',
    action: 'upvote',
    details: { removed: false },
  });
  await assert.doesNotReject(log.validate());
});

test('suggestion votes toggle and switch directions while recording Mongo-backed activity', async () => {
  const suggestion = {
    _id: '507f1f77bcf86cd799439011',
    id: '507f1f77bcf86cd799439011',
    guildId: '12345678901234567',
    messageId: '12345678901234568',
    status: 'pending',
    text: 'A server suggestion.',
    authorId: '12345678901234569',
    createdAt: new Date(),
    upvotes: [],
    downvotes: [],
    async save() {},
  };
  const logs = [];
  const edits = [];
  const service = createSuggestionsService({
    GuildConfigModel: { findOne: () => ({ lean: async () => ({ modules: { suggestions: true } }) }) },
    SuggestionModel: { findOne: async () => suggestion },
    SuggestionLogModel: { create: async (entry) => logs.push(entry) },
  });
  const interaction = {
    guildId: suggestion.guildId,
    message: {
      id: suggestion.messageId,
      edit: async (payload) => edits.push(payload),
    },
    user: { id: '12345678901234570' },
    deferred: false,
    replied: false,
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => { interaction.response = payload; },
    reply: async (payload) => { interaction.response = payload; },
  };

  await service.vote(interaction, suggestion.id, 'up');
  assert.deepEqual(suggestion.upvotes, [interaction.user.id]);
  await service.vote(interaction, suggestion.id, 'up');
  assert.deepEqual(suggestion.upvotes, []);
  await service.vote(interaction, suggestion.id, 'down');
  assert.deepEqual(suggestion.downvotes, [interaction.user.id]);
  await service.vote(interaction, suggestion.id, 'up');
  assert.deepEqual(suggestion.downvotes, []);
  assert.deepEqual(suggestion.upvotes, [interaction.user.id]);
  assert.equal(logs.length, 4);
  assert.equal(edits.length, 4);
});

test('temporary voice control panels expose room management actions and models validate', async () => {
  const panel = buildControlPanel({ voiceChannelId: '12345678901234567', ownerId: '12345678901234568' });
  const actionIds = panel.components.flatMap((row) => row.toJSON().components.map((button) => button.custom_id));
  for (const action of ['rename', 'lock', 'unlock', 'hide', 'limit', 'invite', 'kick', 'transfer']) {
    assert.ok(actionIds.includes(`tempvoice:${action}:12345678901234567`));
  }

  const daily = new ServerAnalytics({ guildId: '12345678901234567', date: '2026-10-09', messages: 2 });
  await assert.doesNotReject(daily.validate());
  const session = new VoiceSession({
    guildId: '12345678901234567',
    userId: '12345678901234568',
    channelId: '12345678901234569',
  });
  await assert.doesNotReject(session.validate());
});

test('analytics increments aggregate UTC voice time across calendar days', async () => {
  const records = new Map();
  const AnalyticsModel = {
    async updateOne(filter, update) {
      const record = records.get(filter.date) || { guildId: filter.guildId, date: filter.date };
      for (const [field, amount] of Object.entries(update.$inc || {})) record[field] = (record[field] || 0) + amount;
      records.set(filter.date, record);
    },
    find(filter) {
      return {
        sort() { return this; },
        lean: async () => [...records.values()].filter((record) => record.guildId === filter.guildId && record.date > filter.date.$gt),
      };
    },
  };
  const service = createAnalyticsService({
    AnalyticsModel,
    VoiceSessionModel: {},
    GuildConfigModel: {},
    now: () => Date.parse('2026-10-09T00:00:31Z'),
  });
  await service.recordVoiceDuration('12345678901234567', Date.parse('2026-10-08T23:59:30Z'), Date.parse('2026-10-09T00:00:31Z'));
  assert.equal(records.get('2026-10-08').voiceSeconds, 30);
  assert.equal(records.get('2026-10-09').voiceSeconds, 31);
  assert.equal(utcDateKey(Date.parse('2026-10-09T00:00:00Z')), '2026-10-09');
  const summary = await service.getSummary('12345678901234567', 'daily');
  assert.equal(summary.voiceSeconds, 31);
  assert.equal(summary.netGrowth, 0);
});

test('verification panel and arithmetic challenge are built with bounded one-user sessions', async () => {
  const panel = createVerificationPanel();
  assert.equal(panel.components[0].toJSON().components[0].custom_id, 'verification:start');
  const customized = createVerificationPanel({
    panel: {
      title: 'Confirm your access',
      description: 'Read the rules, then verify.',
      color: '#123abc',
      footer: 'InfinitX Club',
      imageUrl: 'https://cdn.example.test/verify.png',
      buttonLabel: 'I agree',
      buttonStyle: 'success',
    },
  });
  const customizedEmbed = customized.embeds[0].toJSON();
  assert.equal(customizedEmbed.title, 'Confirm your access');
  assert.equal(customizedEmbed.description, 'Read the rules, then verify.');
  assert.equal(customizedEmbed.color, 0x123abc);
  assert.equal(customizedEmbed.image.url, 'https://cdn.example.test/verify.png');
  assert.equal(customized.components[0].toJSON().components[0].label, 'I agree');
  assert.equal(customized.components[0].toJSON().components[0].style, ButtonStyle.Success);
  const deployedPanel = buildVerificationPanelFromConfig({
    verification: {
      panel: {
        title: 'Dashboard verification',
        description: 'Use the customized instructions.',
        color: '#2468ac',
        buttonLabel: 'Continue',
        buttonStyle: 'primary',
      },
    },
  });
  assert.equal(deployedPanel.embeds[0].toJSON().title, 'Dashboard verification');
  assert.equal(deployedPanel.embeds[0].toJSON().description, 'Use the customized instructions.');
  assert.equal(deployedPanel.components[0].toJSON().components[0].label, 'Continue');
  assert.equal(deployedPanel.components[0].toJSON().components[0].style, ButtonStyle.Primary);
  assert.deepEqual(makeChallenge((min) => min), { prompt: '2 + 2', answer: '4' });

  verificationChallenges.set('verification-test-token', {
    guildId: 'guild-1',
    userId: 'owner',
    answer: '4',
    expiresAt: Date.now() + 60_000,
  });
  let response;
  const interaction = {
    guild: {},
    guildId: 'guild-1',
    user: { id: 'another-user' },
    customId: 'verification:answer:verification-test-token',
    reply: async (value) => { response = value; },
  };
  assert.equal(await submitVerification(interaction), false);
  assert.match(response.content, /belongs to another member/);
  assert.equal(verificationChallenges.has('verification-test-token'), true);
  verificationChallenges.delete('verification-test-token');
});

test('giveaway duration, unique winner selection, embeds, and persistence schema validate', async () => {
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration('2d'), 2 * 86_400_000);
  assert.throws(() => parseDuration('9s'), /between 10 seconds and 30 days/);
  assert.throws(() => parseDuration('31d'), /between 10 seconds and 30 days/);
  assert.deepEqual(selectWinners(['a', 'b', 'a', 'c'], 2, () => 0), ['a', 'b']);

  const embed = giveawayEmbed({
    prize: 'Role',
    endsAt: new Date(Date.now() + 60_000),
    winnerCount: 1,
    entrants: [],
    hostId: '12345678901234567',
  });
  assert.match(embed.toJSON().title, /Giveaway: Role/);
  assert.equal(embed.toJSON().fields[0].value, '0');

  const giveaway = new Giveaway({
    guildId: '12345678901234567',
    channelId: '12345678901234568',
    messageId: '12345678901234569',
    hostId: '12345678901234570',
    prize: 'Role',
    winnerCount: 1,
    entrants: ['12345678901234571'],
    winners: ['12345678901234571'],
    previousWinners: [],
    endsAt: new Date(Date.now() + 60_000),
  });
  await assert.doesNotReject(giveaway.validate());
});

test('ticket commands register and category ticket panel builds a select menu', () => {
  const commands = loadModules(path.join(__dirname, '..', 'src', 'commands'));
  const ticketCommand = commands.find((command) => command.data.name === 'ticket');
  assert.ok(ticketCommand);
  assert.deepEqual(
    ticketCommand.data.toJSON().options.map((option) => option.name),
    ['close', 'reopen', 'claim', 'add-user', 'remove-user', 'transcript'],
  );

  const panel = createTicketPanel({
    categories: [
      { key: 'billing', label: 'Billing', description: 'Billing questions' },
      { key: 'support', label: 'Technical support' },
    ],
  });
  const serialized = panel.components[0].toJSON();
  assert.equal(serialized.components[0].custom_id, 'tickets:category');
  assert.deepEqual(serialized.components[0].options.map((option) => option.value), ['billing', 'support']);

  const customPanel = createTicketPanel({
    panel: {
      title: 'Contact our team',
      description: 'We are ready to help.',
      color: '#123abc',
      footer: 'InfinitX support',
      imageUrl: 'https://cdn.example.test/tickets.png',
      buttonLabel: 'Get support',
      buttonStyle: 'success',
    },
  });
  assert.equal(customPanel.embeds[0].toJSON().title, 'Contact our team');
  assert.equal(customPanel.embeds[0].toJSON().color, 0x123abc);
  assert.equal(customPanel.embeds[0].toJSON().image.url, 'https://cdn.example.test/tickets.png');
  const button = customPanel.components[0].toJSON().components[0];
  assert.equal(button.label, 'Get support');
  assert.equal(button.style, ButtonStyle.Success);
});

test('ticket records and per-guild ticket statistics validate', async () => {
  const ticket = new Ticket({
    guildId: '12345678901234567',
    channelId: '12345678901234568',
    userId: '12345678901234569',
    category: 'billing',
    claimedBy: '12345678901234570',
    addedUserIds: ['12345678901234571'],
  });
  await assert.doesNotReject(ticket.validate());

  const stats = new TicketStats({ guildId: '12345678901234567', created: 1, closed: 1 });
  await assert.doesNotReject(stats.validate());
});

test('custom commands require a valid response or non-empty embed', async () => {
  const empty = new CustomCommand({ guildId: '12345678901234567', name: 'hello' });
  await assert.rejects(empty.validate(), /response, non-empty embed, or link button/);

  const valid = new CustomCommand({
    guildId: '12345678901234567',
    name: 'hello',
    embed: { title: 'Welcome' },
  });
  await assert.doesNotReject(valid.validate());
});

test('ticket transcript formatter includes author, content, and attachments', () => {
  const message = {
    createdTimestamp: Date.UTC(2026, 0, 1),
    author: { tag: 'member#1234' },
    content: 'Please help',
    attachments: new Map([['file', { url: 'https://cdn.example/file.png' }]]),
    embeds: [],
  };
  const transcript = formatTranscript([message], { guildName: 'InfinitX', channelName: 'ticket-member' });
  assert.match(transcript, /InfinitX \/ #ticket-member/);
  assert.match(transcript, /member#1234: Please help/);
  assert.match(transcript, /https:\/\/cdn\.example\/file\.png/);
});

test('ticket transcript formatter enforces its storage limit', () => {
  const message = {
    createdTimestamp: Date.UTC(2026, 0, 1),
    author: { tag: 'member#1234' },
    content: 'x'.repeat(MAX_TRANSCRIPT_CHARS),
    attachments: new Map(),
    embeds: [],
  };
  assert.ok(formatTranscript([message], { guildName: 'Server', channelName: 'ticket' }).length <= MAX_TRANSCRIPT_CHARS);
});

test('module checks work with Mongo maps and plain lean objects', () => {
  assert.equal(isModuleEnabled({ modules: new Map([['tickets', true]]) }, 'tickets'), true);
  assert.equal(isModuleEnabled({ modules: { tickets: true } }, 'tickets'), true);
  assert.equal(isModuleEnabled({ modules: new Map([['tickets', false]]) }, 'tickets'), false);
  assert.equal(isModuleEnabled({ modules: { tickets: false } }, 'tickets'), false);
  assert.equal(isModuleEnabled({}, 'tickets'), false);
  assert.equal(isModuleDisabled({}, 'tickets'), false);
  assert.equal(isModuleDisabled({ modules: { tickets: false } }, 'tickets'), true);
});

test('AutoMod word filtering matches phrases and whole words without substring false positives', () => {
  assert.equal(containsBlockedWord('That is a BAD word!', ['bad word']), true);
  assert.equal(containsBlockedWord('badminton is a sport', ['bad']), false);
  assert.equal(containsBlockedWord('bad-word', ['bad']), true);
  assert.equal(containsBlockedWord('clean message', ['']), false);
});

test('anti-link recognizes common web and Discord invite URL forms', () => {
  assert.match('https://example.com/path', LINK_PATTERN);
  assert.match('www.example.com', LINK_PATTERN);
  assert.match('discord.gg/example', LINK_PATTERN);
  assert.match('discord.com/invite/example', LINK_PATTERN);
  assert.doesNotMatch('plain text only', LINK_PATTERN);
});

test('guild AutoMod defaults are conservative and actions are stored on warnings', async () => {
  const config = new GuildConfig({ guildId: '12345678901234567' });
  assert.equal(config.moderation.messageAction, 'warn');
  assert.equal(config.moderation.raidAction, 'timeout');
  assert.equal(config.moderation.raidLockdownEnabled, true);
  assert.equal(config.moderation.nukeProtection, false);

  const warning = new Warning({
    guildId: '12345678901234567',
    userId: '12345678901234568',
    moderatorId: '12345678901234569',
    reason: 'Automod: spam',
    action: 'ban',
    actionSucceeded: true,
  });
  await assert.doesNotReject(warning.validate());
});

test('anti-nuke tracks destructive moderation audit events', () => {
  assert.ok(destructiveActions.size >= 5);
});

test('lockdown records and restores allow, deny, and neutral message permissions', () => {
  assert.equal(getSendMessagesState(null), 'neutral');
  assert.equal(getSendMessagesState({
    allow: { has: () => true },
    deny: { has: () => false },
  }), 'allow');
  assert.equal(getSendMessagesState({
    allow: { has: () => false },
    deny: { has: () => true },
  }), 'deny');
  assert.equal(permissionValue('allow'), true);
  assert.equal(permissionValue('deny'), false);
  assert.equal(permissionValue('neutral'), null);
});

test('shutdown cleans up all resources once even if one cleanup fails', async () => {
  const calls = [];
  const client = {
    async destroy() {
      await Promise.resolve();
      calls.push('client');
    },
  };
  attachShutdown(client, async () => {
    calls.push('database');
  });
  client.addCleanupTask(async () => {
    calls.push('first');
  });
  client.addCleanupTask(async () => {
    calls.push('failed');
    throw new Error('cleanup failure');
  });
  client.addCleanupTask(async () => {
    calls.push('last');
  });

  const firstShutdown = client.shutdown();
  const secondShutdown = client.shutdown();
  assert.equal(firstShutdown, secondShutdown);
  await assert.rejects(firstShutdown, AggregateError);
  assert.deepEqual(calls, ['first', 'failed', 'last', 'client', 'database']);
  assert.throws(() => client.addCleanupTask(() => {}), /shutdown has started/);
});

test('process signals trigger one graceful shutdown', async () => {
  const processEmitter = new EventEmitter();
  const calls = [];
  const previousExitCode = processEmitter.exitCode;
  const detach = attachProcessHandlers({
    shutdown: async () => {
      calls.push('shutdown');
    },
  }, {
    processEmitter,
    logger: { info: () => {}, error: () => {} },
  });

  processEmitter.emit('SIGINT');
  processEmitter.emit('SIGTERM');
  await new Promise(setImmediate);

  assert.deepEqual(calls, ['shutdown']);
  assert.equal(processEmitter.exitCode, 0);
  detach();
  processEmitter.exitCode = previousExitCode;
});

test('unhandled rejections trigger shutdown and a failing exit status', async () => {
  const processEmitter = new EventEmitter();
  const calls = [];
  const logged = [];
  const previousExitCode = processEmitter.exitCode;
  const detach = attachProcessHandlers({
    shutdown: async () => {
      calls.push('shutdown');
    },
  }, {
    processEmitter,
    logger: {
      info: () => {},
      error: (message) => logged.push(message),
    },
  });

  processEmitter.emit('unhandledRejection', new Error('unexpected rejection'));
  await new Promise(setImmediate);

  assert.deepEqual(calls, ['shutdown']);
  assert.equal(processEmitter.exitCode, 1);
  assert.deepEqual(logged, ['Unhandled promise rejection; bot will shut down']);
  detach();
  processEmitter.exitCode = previousExitCode;
});

test('shutdown failure sets a failing exit status', async () => {
  const processEmitter = new EventEmitter();
  const previousExitCode = processEmitter.exitCode;
  const logged = [];
  const detach = attachProcessHandlers({
    shutdown: async () => {
      throw new Error('database close failed');
    },
  }, {
    processEmitter,
    logger: { info: () => {}, error: (message) => logged.push(message) },
  });

  processEmitter.emit('SIGTERM');
  await new Promise(setImmediate);

  assert.equal(processEmitter.exitCode, 1);
  assert.deepEqual(logged, ['Bot shutdown failed']);
  detach();
  processEmitter.exitCode = previousExitCode;
});
