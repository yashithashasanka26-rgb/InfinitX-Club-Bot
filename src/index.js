require('dotenv').config();

const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const mongoose = require('mongoose');
const { loadConfig } = require('./config');
const { connectDatabase } = require('./database/connect');
const { loadModules } = require('./utils/loaders');
const { attachProcessHandlers } = require('./utils/processHandlers');
const { attachShutdown } = require('./utils/shutdown');
const logger = require('./utils/logger');

const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildVoiceStates,
];

const PARTIALS = [
  Partials.Channel,
  Partials.Message,
  Partials.GuildMember,
  Partials.User,
  Partials.Reaction,
];

function createClient() {
  return new Client({ intents: INTENTS, partials: PARTIALS });
}

function createCommandRegistry(commandModules) {
  const commands = new Collection();

  for (const command of commandModules) {
    const name = command.data?.name;
    if (!name || typeof command.data.toJSON !== 'function' || typeof command.execute !== 'function') {
      throw new Error(`Invalid command module: ${name || 'unknown'}`);
    }
    if (commands.has(name)) throw new Error(`Duplicate command: ${name}`);

    const commandData = command.data.toJSON();
    if (!commandData || commandData.name !== name) {
      throw new Error(`Command data name mismatch: ${name}`);
    }
    if (command.module !== undefined && typeof command.module !== 'string') {
      throw new Error(`Invalid module name for command: ${name}`);
    }
    commands.set(name, command);
  }

  return commands;
}

function validateEventModules(eventModules) {
  for (const event of eventModules) {
    if (typeof event.name !== 'string' || !event.name || typeof event.execute !== 'function') {
      throw new Error('Invalid Discord event module');
    }
    if (event.once !== undefined && typeof event.once !== 'boolean') {
      throw new Error(`Invalid once setting for Discord event: ${event.name}`);
    }
  }
}

function registerEvents(client, eventModules) {
  for (const event of eventModules) {
    const handler = async (...args) => {
      try {
        await event.execute(...args);
      } catch (error) {
        logger.error('Discord event handler failed', {
          event: event.name,
          error: error.message,
          stack: error.stack,
        });
      }
    };
    if (event.once) client.once(event.name, handler);
    else client.on(event.name, handler);
  }
}

function registerClientDiagnostics(client) {
  client.on('error', (error) => logger.error('Discord client error', {
    error: error.message,
    stack: error.stack,
  }));
  client.on('warn', (message) => logger.warn('Discord client warning', { message }));
  client.on('shardError', (error, shardId) => logger.error('Discord gateway shard error', {
    shardId,
    error: error.message,
    stack: error.stack,
  }));
  client.on('shardDisconnect', (event, shardId) => logger.warn('Discord gateway shard disconnected', {
    shardId,
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean,
  }));
  client.on('shardReconnecting', (shardId) => logger.info('Discord gateway reconnecting', { shardId }));
  client.on('shardReady', (shardId, unavailableGuilds) => logger.info('Discord gateway shard ready', {
    shardId,
    unavailableGuilds: unavailableGuilds?.size || 0,
  }));
  client.on('shardResume', (shardId, replayedEvents) => logger.info('Discord gateway shard resumed', {
    shardId,
    replayedEvents,
  }));
}

async function startBot() {
  const config = loadConfig();
  if (!config.token) throw new Error('DISCORD_TOKEN is required to start the bot');

  const commandModules = loadModules(path.join(__dirname, 'commands'));
  const eventModules = loadModules(path.join(__dirname, 'events'));
  const commands = createCommandRegistry(commandModules);
  validateEventModules(eventModules);
  const client = createClient();
  client.ownerIds = config.ownerIds;
  client.commands = commands;
  attachShutdown(client, () => mongoose.disconnect());
  registerClientDiagnostics(client);

  try {
    await connectDatabase(config.mongoUri);

    registerEvents(client, eventModules);
    await client.login(config.token);
    return client;
  } catch (error) {
    try {
      await client.shutdown();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Bot startup failed and cleanup was incomplete.');
    }
    throw error;
  }
}

if (require.main === module) {
  startBot().then((client) => {
    attachProcessHandlers(client, { logger });
  }).catch((error) => {
    logger.error('Bot startup failed', { error: error.message });
    process.exitCode = 1;
  });
}

module.exports = { startBot };
