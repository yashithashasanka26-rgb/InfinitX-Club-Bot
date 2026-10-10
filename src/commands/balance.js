const { SlashCommandBuilder } = require('discord.js');
const { getBalance } = require('../modules/economy/service');

module.exports = {
  module: 'economy',
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Show a member’s coin balance.')
    .addUserOption((option) => option.setName('member').setDescription('Member to check')),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }
    const user = interaction.options.getUser('member') || interaction.user;
    const account = await getBalance(interaction.guildId, user.id);
    await interaction.reply({
      content: `${user} has **${account.coins}** coins.`,
      allowedMentions: { users: [user.id] },
    });
  },
};
