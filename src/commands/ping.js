const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check bot responsiveness.'),
  async execute(interaction) {
    await interaction.reply({ content: `Pong! ${interaction.client.ws.ping}ms`, ephemeral: true });
  },
};
