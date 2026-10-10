const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { GuildConfig, TempVoiceRoom } = require('../../database/models');
const { isModuleEnabled } = require('../../utils/moduleSettings');

const creating = new Map();
const ID_PATTERN = /^\d{17,20}$/;
const ACTIONS = new Set(['rename', 'lock', 'unlock', 'hide', 'limit', 'invite', 'kick', 'transfer']);
const MODAL_ACTIONS = new Set(['rename', 'limit', 'invite', 'kick', 'transfer']);

async function fetchChannelOrNull(manager, channelId) {
  try {
    return await manager.fetch(channelId);
  } catch (error) {
    if (error.code === 10003) return null;
    throw error;
  }
}

async function fetchMemberOrNull(manager, memberId) {
  try {
    return await manager.fetch(memberId);
  } catch (error) {
    if (error.code === 10007) return null;
    throw error;
  }
}

function buildControlPanel(room) {
  const voiceId = room.voiceChannelId;
  const row = (actions) => new ActionRowBuilder().addComponents(...actions.map(([action, label, style = ButtonStyle.Secondary]) => (
    new ButtonBuilder().setCustomId(`tempvoice:${action}:${voiceId}`).setLabel(label).setStyle(style)
  )));
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Temporary room controls')
      .setDescription(`Room owner: <@${room.ownerId}>\nUse these controls to manage <#${voiceId}>.`)],
    components: [
      row([['rename', 'Rename'], ['lock', 'Lock'], ['unlock', 'Unlock'], ['hide', 'Hide'], ['limit', 'User limit']]),
      row([['invite', 'Invite'], ['kick', 'Kick'], ['transfer', 'Transfer ownership', ButtonStyle.Primary]]),
    ],
    allowedMentions: { parse: [] },
  };
}

function createTempVoiceService({ GuildConfigModel = GuildConfig, TempVoiceRoomModel = TempVoiceRoom } = {}) {
  async function createRoom(member, config) {
    const guild = member.guild;
    const active = await TempVoiceRoomModel.findOne({ guildId: guild.id, ownerId: member.id });
    if (active) {
      const existing = await fetchChannelOrNull(guild.channels, active.voiceChannelId);
      if (existing?.type === ChannelType.GuildVoice) {
        await member.voice.setChannel(existing);
        return existing;
      }
      await TempVoiceRoomModel.deleteOne({ _id: active._id });
    }

    const botMember = guild.members.me || await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)
      || !botMember.permissions.has(PermissionFlagsBits.MoveMembers)) {
      throw new Error('The bot needs Manage Channels and Move Members permissions to create temporary rooms.');
    }
    const joinChannel = await fetchChannelOrNull(guild.channels, config.temporaryVoice?.joinChannelId);
    const categoryId = config.temporaryVoice?.categoryId || joinChannel?.parentId || null;
    const voiceOverwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
      { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    ];
    const textOverwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
      { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];
    let voiceChannel;
    let textChannel;
    try {
      voiceChannel = await guild.channels.create({
        name: `${member.user.username}'s room`.slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: categoryId,
        permissionOverwrites: voiceOverwrites,
        reason: `Temporary voice room for ${member.user.tag}`,
      });
      textChannel = await guild.channels.create({
        name: `room-${member.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 100),
        type: ChannelType.GuildText,
        parent: categoryId,
        permissionOverwrites: textOverwrites,
        reason: `Temporary voice controls for ${member.user.tag}`,
      });
      const room = await TempVoiceRoomModel.create({
        guildId: guild.id,
        voiceChannelId: voiceChannel.id,
        textChannelId: textChannel.id,
        ownerId: member.id,
      });
      await textChannel.send(buildControlPanel(room));
      await member.voice.setChannel(voiceChannel);
      return voiceChannel;
    } catch (error) {
      const cleanup = await Promise.allSettled(
        [voiceChannel, textChannel].filter(Boolean).map((channel) => channel.delete('Temporary voice room setup failed')),
      );
      const cleanupErrors = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (voiceChannel) {
        try {
          await TempVoiceRoomModel.deleteOne({ voiceChannelId: voiceChannel.id });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], 'Temporary room setup failed and cleanup was incomplete.');
      }
      throw error;
    }
  }

  async function onVoiceStateUpdate(oldState, newState) {
    const { guild } = newState;
    if (!guild) return;
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      const oldRoom = await TempVoiceRoomModel.findOne({ guildId: guild.id, voiceChannelId: oldState.channelId });
      if (oldRoom && oldState.channel?.members?.size === 0) await deleteRoom(guild, oldRoom);
    }
    if (!newState.channelId || newState.channelId === oldState.channelId) return;

    const guildConfig = await GuildConfigModel.findOne({ guildId: guild.id }).lean();
    if (!isModuleEnabled(guildConfig, 'temporaryVoice')) return;
    if (guildConfig?.temporaryVoice?.joinChannelId !== newState.channelId) return;
    const key = `${guild.id}:${newState.id}`;
    if (creating.has(key)) return;
    const operation = createRoom(newState.member || await guild.members.fetch(newState.id), guildConfig);
    creating.set(key, operation);
    try {
      await operation;
    } finally {
      creating.delete(key);
    }
  }

  async function deleteRoom(guild, room) {
    const failures = [];
    for (const id of [room.voiceChannelId, room.textChannelId]) {
      const channel = await fetchChannelOrNull(guild.channels, id);
      if (!channel) continue;
      try {
        await channel.delete('Temporary voice room is empty');
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Could not delete every temporary room channel.');
    await TempVoiceRoomModel.deleteOne({ _id: room._id });
  }

  async function recoverRooms(client) {
    const rooms = await TempVoiceRoomModel.find({}).exec();
    for (const room of rooms) {
      const guild = client.guilds.cache.get(room.guildId);
      if (!guild) continue;
      const voice = await fetchChannelOrNull(guild.channels, room.voiceChannelId);
      if (voice?.type === ChannelType.GuildVoice && voice.members.size > 0) continue;
      await deleteRoom(guild, room);
    }
  }

  function getModal(action, voiceChannelId) {
    const modal = new ModalBuilder()
      .setCustomId(`tempvoice:modal:${action}:${voiceChannelId}`)
      .setTitle(({ rename: 'Rename room', limit: 'Set user limit', invite: 'Invite a member', kick: 'Remove a member', transfer: 'Transfer ownership' })[action]);
    const input = new TextInputBuilder()
      .setCustomId('value')
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
    if (action === 'rename') input.setLabel('Room name').setMaxLength(90).setPlaceholder('My private room');
    else if (action === 'limit') input.setLabel('User limit (0–99, 0 means unlimited)').setMaxLength(2).setPlaceholder('0');
    else input.setLabel('Member Discord user ID').setMinLength(17).setMaxLength(20).setPlaceholder('123456789012345678');
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
  }

  async function getOwnedRoom(interaction, voiceChannelId) {
    if (!interaction.guild || !ID_PATTERN.test(voiceChannelId)) return null;
    const room = await TempVoiceRoomModel.findOne({ guildId: interaction.guildId, voiceChannelId });
    if (!room) return null;
    if (room.ownerId !== interaction.user.id
      && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      return null;
    }
    return room;
  }

  async function handleButton(interaction) {
    const [, action, voiceChannelId] = interaction.customId.split(':');
    if (!ACTIONS.has(action) || !interaction.guild) return false;
    const config = await GuildConfigModel.findOne({ guildId: interaction.guildId }).lean();
    if (!isModuleEnabled(config, 'temporaryVoice')) {
      await interaction.reply({ content: 'Temporary Voice is disabled in this server.', ephemeral: true });
      return true;
    }
    const room = await getOwnedRoom(interaction, voiceChannelId);
    if (!room) {
      await interaction.reply({ content: 'Only this room’s owner or a server manager can use its controls.', ephemeral: true });
      return true;
    }
    if (['rename', 'limit', 'invite', 'kick', 'transfer'].includes(action)) {
      await interaction.showModal(getModal(action, voiceChannelId));
      return true;
    }
    const voiceChannel = await fetchChannelOrNull(interaction.guild.channels, voiceChannelId);
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      await interaction.reply({ content: 'This temporary voice room no longer exists.', ephemeral: true });
      return true;
    }
    const everyone = interaction.guild.roles.everyone.id;
    const changes = action === 'lock'
      ? { ViewChannel: true, Connect: false }
      : action === 'hide'
        ? { ViewChannel: false, Connect: false }
        : { ViewChannel: true, Connect: true };
    await voiceChannel.permissionOverwrites.edit(everyone, changes);
    await interaction.reply({ content: action === 'lock' ? 'Room locked.' : action === 'hide' ? 'Room hidden and locked.' : 'Room visible and unlocked.', ephemeral: true });
    return true;
  }

  async function handleModal(interaction) {
    const [, , action, voiceChannelId] = interaction.customId.split(':');
    if (!MODAL_ACTIONS.has(action) || !interaction.guild) return false;
    const config = await GuildConfigModel.findOne({ guildId: interaction.guildId }).lean();
    if (!isModuleEnabled(config, 'temporaryVoice')) {
      await interaction.reply({ content: 'Temporary Voice is disabled in this server.', ephemeral: true });
      return true;
    }
    const room = await getOwnedRoom(interaction, voiceChannelId);
    if (!room) {
      await interaction.reply({ content: 'Only this room’s owner or a server manager can use its controls.', ephemeral: true });
      return true;
    }
    const voice = await fetchChannelOrNull(interaction.guild.channels, voiceChannelId);
    const text = await fetchChannelOrNull(interaction.guild.channels, room.textChannelId);
    if (!voice || voice.type !== ChannelType.GuildVoice) {
      await interaction.reply({ content: 'This temporary voice room no longer exists.', ephemeral: true });
      return true;
    }
    const value = interaction.fields.getTextInputValue('value').trim();
    if (action === 'rename') {
      if (!value) {
        await interaction.reply({ content: 'Enter a non-empty room name.', ephemeral: true });
        return true;
      }
      await voice.setName(value);
      if (text) await text.setName(`room-${value}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 100));
      await interaction.reply({ content: 'Room renamed.', ephemeral: true });
      return true;
    }
    if (action === 'limit') {
      if (!/^(?:0|[1-9]\d?)$/.test(value) || Number(value) > 99) {
        await interaction.reply({ content: 'User limit must be between 0 and 99; use 0 for unlimited.', ephemeral: true });
        return true;
      }
      await voice.setUserLimit(Number(value));
      await interaction.reply({ content: `Room user limit set to ${Number(value) || 'unlimited'}.`, ephemeral: true });
      return true;
    }
    if (!ID_PATTERN.test(value)) {
      await interaction.reply({ content: 'Enter a valid Discord user ID.', ephemeral: true });
      return true;
    }
    const target = await fetchMemberOrNull(interaction.guild.members, value);
    if (!target || target.user.bot) {
      await interaction.reply({ content: 'That member could not be found.', ephemeral: true });
      return true;
    }
    if (action === 'invite') {
      await voice.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true });
      if (text) await text.permissionOverwrites.edit(target, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      await interaction.reply({ content: `${target} can now view and join the room.`, ephemeral: true, allowedMentions: { parse: [] } });
      return true;
    }
    if (action === 'kick') {
      if (target.id === room.ownerId || target.voice.channelId !== voice.id) {
        await interaction.reply({ content: 'Choose a different member who is currently in this room.', ephemeral: true });
        return true;
      }
      await target.voice.disconnect('Removed by temporary room owner');
      if (voice.permissionOverwrites.cache.has(target.id)) await voice.permissionOverwrites.delete(target.id);
      if (text?.permissionOverwrites.cache.has(target.id)) await text.permissionOverwrites.delete(target.id);
      await interaction.reply({ content: `${target} was removed from the room.`, ephemeral: true, allowedMentions: { parse: [] } });
      return true;
    }
    if (action === 'transfer') {
      if (target.id === room.ownerId || target.voice.channelId !== voice.id) {
        await interaction.reply({ content: 'The new owner must be a different member currently in this room.', ephemeral: true });
        return true;
      }
      await voice.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true });
      if (text) await text.permissionOverwrites.edit(target, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      room.ownerId = target.id;
      await room.save();
      const message = interaction.message;
      await message.edit(buildControlPanel(room));
      await interaction.reply({ content: `Room ownership transferred to ${target}.`, ephemeral: true, allowedMentions: { parse: [] } });
      return true;
    }
    await interaction.reply({ content: 'Unknown room control.', ephemeral: true });
    return true;
  }

  async function setup(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'Temporary Voice setup can only be used in a server.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'You need Manage Server permission to configure temporary rooms.', ephemeral: true });
      return;
    }
    const joinChannel = interaction.options.getChannel('join-channel', true);
    const category = interaction.options.getChannel('category');
    if (joinChannel.type !== ChannelType.GuildVoice) {
      await interaction.reply({ content: 'Choose a standard voice channel as the Join to Create channel.', ephemeral: true });
      return;
    }
    if (category && category.type !== ChannelType.GuildCategory) {
      await interaction.reply({ content: 'Choose a channel category for temporary rooms.', ephemeral: true });
      return;
    }
    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)
      || !botMember.permissions.has(PermissionFlagsBits.MoveMembers)) {
      await interaction.reply({ content: 'The bot needs Manage Channels and Move Members permissions.', ephemeral: true });
      return;
    }
    await GuildConfigModel.updateOne(
      { guildId: interaction.guildId },
      { $set: {
        'modules.temporaryVoice': true,
        'temporaryVoice.joinChannelId': joinChannel.id,
        'temporaryVoice.categoryId': category?.id || joinChannel.parentId || null,
        updatedAt: new Date(),
      }, $setOnInsert: { guildId: interaction.guildId } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    await interaction.reply({ content: `Temporary rooms are enabled. Members can join <#${joinChannel.id}> to create a private room.`, ephemeral: true });
  }

  return { onVoiceStateUpdate, handleButton, handleModal, setup, recoverRooms, buildControlPanel };
}

const tempVoiceService = createTempVoiceService();

module.exports = { ACTIONS, MODAL_ACTIONS, buildControlPanel, createTempVoiceService, fetchChannelOrNull, fetchMemberOrNull, tempVoiceService };
