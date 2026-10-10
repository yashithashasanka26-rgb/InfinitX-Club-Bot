const { checkCommandPolicy } = require('../middleware/commandPolicy');
const { handleTicketButton } = require('../modules/tickets/interactions');
const { isModuleEnabled } = require('../utils/moduleSettings');
const { GuildConfig } = require('../database/models');
const { createEmbedPayload } = require('../modules/customCommands/builders');
const { hasManageGuild } = require('../commands/custom-command');
const { takeBuilderSession } = require('../commands/embed-builder');
const { startVerification, submitVerification } = require('../modules/verification/service');
const { giveawayService } = require('../modules/giveaways/service');
const { tempVoiceService } = require('../modules/temporaryVoice/service');
const { suggestionsService } = require('../modules/suggestions/service');
const { ownerService, isBotOwner } = require('../modules/owner/service');
const logger = require('../utils/logger');

async function handleEmbedBuilderSubmit(interaction) {
  const [, , token] = interaction.customId.split(':');
  const session = takeBuilderSession(token, interaction);
  if (!session) {
    await interaction.reply({ content: 'This embed builder session expired or belongs to another user. Run `/embed-builder` again.', ephemeral: true });
    return;
  }
  if (!interaction.guild || !hasManageGuild(interaction)) {
    await interaction.reply({ content: 'You need Manage Server permission to send custom embeds.', ephemeral: true });
    return;
  }
  const config = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
  if (!isModuleEnabled(config, 'customCommands')) {
    await interaction.reply({ content: 'Enable the Custom Commands module in the dashboard before using the embed builder.', ephemeral: true });
    return;
  }

  let style;
  try {
    const value = interaction.fields.getTextInputValue('style').trim();
    style = value ? JSON.parse(value) : {};
    if (!style || typeof style !== 'object' || Array.isArray(style)
      || Object.keys(style).some((key) => !['color', 'footer'].includes(key))) {
      throw new TypeError('Style must be JSON with only color and/or footer properties.');
    }
  } catch (error) {
    await interaction.reply({
      content: error instanceof SyntaxError ? 'Style must be valid JSON.' : error.message,
      ephemeral: true,
    });
    return;
  }

  let built;
  try {
    const fieldsInput = interaction.fields.getTextInputValue('fields').trim();
    const buttonsInput = interaction.fields.getTextInputValue('buttons').trim();
    const embed = {
      title: interaction.fields.getTextInputValue('title'),
      description: interaction.fields.getTextInputValue('description'),
      ...(style.color !== undefined ? { color: style.color } : {}),
      ...(style.footer !== undefined ? { footer: style.footer } : {}),
      fields: fieldsInput ? JSON.parse(fieldsInput) : [],
    };
    built = createEmbedPayload(embed, buttonsInput ? JSON.parse(buttonsInput) : []);
  } catch (error) {
    await interaction.reply({ content: error.message, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const channel = await interaction.guild.channels.fetch(session.channelId);
  if (!channel?.isTextBased() || !channel.send) {
    await interaction.editReply('The original channel is no longer available for sending this embed.');
    return;
  }
  await channel.send(built.payload);
  await interaction.editReply('Your custom embed and buttons were sent.');
}

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    let access;
    try {
      access = await ownerService.enforceAccess(interaction);
    } catch (error) {
      logger.error('Bot access policy could not be checked', {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        error: error.message,
      });
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Access could not be verified right now. Please try again shortly.', ephemeral: true });
      }
      return;
    }
    if (!access.allowed) {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: access.reason, ephemeral: true });
      }
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('suggestion:vote:')) {
      try {
        const [, , direction, suggestionId] = interaction.customId.split(':');
        await suggestionsService.vote(interaction, suggestionId, direction);
      } catch (error) {
        logger.error('Suggestion vote failed', { guildId: interaction.guildId, error: error.message });
        const response = { content: 'Your vote could not be recorded. Please try again.', ephemeral: true };
        if (interaction.deferred && !interaction.replied) await interaction.editReply(response);
        else if (interaction.replied || interaction.deferred) await interaction.followUp(response);
        else await interaction.reply(response);
      }
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId === 'suggestion:submit') {
      try {
        await suggestionsService.submit(interaction, interaction.fields.getTextInputValue('text'));
      } catch (error) {
        logger.error('Suggestion submission failed', { guildId: interaction.guildId, userId: interaction.user.id, error: error.message });
        const response = { content: 'Your suggestion could not be submitted. Please try again.', ephemeral: true };
        if (interaction.deferred && !interaction.replied) await interaction.editReply(response);
        else if (interaction.replied || interaction.deferred) await interaction.followUp(response);
        else await interaction.reply(response);
      }
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('tempvoice:')) {
      try {
        await tempVoiceService.handleButton(interaction);
      } catch (error) {
        logger.error('Temporary voice button failed', { guildId: interaction.guildId, error: error.message });
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'The room control could not be applied. Please try again.', ephemeral: true });
        }
      }
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('tempvoice:modal:')) {
      try {
        await tempVoiceService.handleModal(interaction);
      } catch (error) {
        logger.error('Temporary voice modal failed', { guildId: interaction.guildId, error: error.message });
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'The room control could not be applied. Please try again.', ephemeral: true });
        }
      }
      return;
    }
    if (interaction.isButton() && interaction.customId === 'verification:start') {
      try {
        await startVerification(interaction);
      } catch (error) {
        logger.error('Verification button failed', { guildId: interaction.guildId, error: error.message });
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Verification could not start. Please contact a server administrator.', ephemeral: true });
        }
      }
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('verification:answer:')) {
      try {
        await submitVerification(interaction);
      } catch (error) {
        logger.error('Verification challenge failed', { guildId: interaction.guildId, userId: interaction.user.id, error: error.message });
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Verification could not be completed. Please try again.', ephemeral: true });
        }
      }
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('giveaway:join:')) {
      try {
        const giveawayId = interaction.customId.split(':')[2];
        const result = await giveawayService.enter(interaction, giveawayId);
        await interaction.reply({
          content: result.message,
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        logger.error('Giveaway entry failed', { guildId: interaction.guildId, error: error.message });
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Your giveaway entry could not be processed. Please try again.', ephemeral: true });
        }
      }
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('embed-builder:submit:')) {
      try {
        await handleEmbedBuilderSubmit(interaction);
      } catch (error) {
        logger.error('Embed builder submission failed', { guildId: interaction.guildId, error: error.message });
        const reply = { content: 'The embed could not be sent. Please try again.', ephemeral: true };
        if (interaction.deferred && !interaction.replied) await interaction.editReply(reply);
        else if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
        else await interaction.reply(reply);
      }
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('tickets:')) {
      try {
        await handleTicketButton(interaction);
      } catch (error) {
        logger.error('Ticket interaction failed', { guildId: interaction.guildId, error: error.message });
        const reply = { content: 'The ticket action failed. Please try again or contact a server manager.', ephemeral: true };
        if (interaction.deferred && !interaction.replied) await interaction.editReply(reply);
        else if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
        else await interaction.reply(reply);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
      await interaction.reply({ content: 'This command is unavailable.', ephemeral: true });
      return;
    }

    try {
      if (command.ownerOnly && !isBotOwner(interaction.client, interaction.user.id)) {
        await interaction.reply({ content: 'This command is restricted to bot developers.', ephemeral: true });
        return;
      }
      if (command.ownerOnly) {
        await command.execute(interaction);
        return;
      }
      const policy = await checkCommandPolicy(interaction, command);
      if (!policy.allowed) {
        await interaction.reply({ content: policy.reason, ephemeral: true });
        return;
      }
      await command.execute(interaction);
    } catch (error) {
      logger.error('Command execution failed', {
        command: interaction.commandName,
        guildId: interaction.guildId,
        error: error.message,
      });
      const reply = { content: 'The command failed. Please try again later.', ephemeral: true };
      if (interaction.deferred && !interaction.replied) await interaction.editReply(reply);
      else if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
      else await interaction.reply(reply);
    }
  },
};

module.exports.handleEmbedBuilderSubmit = handleEmbedBuilderSubmit;
