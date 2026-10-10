require('dotenv').config();

const { REST, Routes } = require('discord.js');
const path = require('node:path');
const { loadConfig } = require('./config');
const { loadModules } = require('./utils/loaders');

async function deployCommands() {
  const config = loadConfig();
  if (!config.token) throw new Error('DISCORD_TOKEN is required to deploy commands');
  const commands = loadModules(path.join(__dirname, 'commands'));
  const body = commands.map((command) => command.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationCommands(config.clientId), { body });
  console.log(`Registered ${body.length} global application commands.`);
}

deployCommands().catch((error) => {
  console.error('Command deployment failed:', error.message);
  process.exitCode = 1;
});
