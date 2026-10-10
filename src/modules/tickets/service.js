const { AttachmentBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { AuditLog, GuildConfig, Ticket, TicketStats, TicketTranscript } = require('../../database/models');
const logger = require('../../utils/logger');
const { isModuleEnabled } = require('../../utils/moduleSettings');
const { createTranscript } = require('./transcript');

const activityUpdates = new Map();

async function createTicket(interaction) {
  const { guild, user, client } = interaction;
  const config = await GuildConfig.findOne({ guildId: guild.id }).lean();
  if (!isModuleEnabled(config, 'tickets')) throw new Error('The ticket module is disabled for this server.');

  const existing = await Ticket.findOne({
    guildId: guild.id,
    userId: user.id,
    status: { $in: ['open', 'closing'] },
  }).lean();
  if (existing) return { existing: true };

  const settings = config.tickets || {};
  const categoryKey = interaction.values?.[0] || 'general';
  const category = settings.categories?.find((entry) => entry.key === categoryKey);
  if (categoryKey !== 'general' && !category) throw new Error('This ticket category is no longer available.');
  const categoryId = category?.categoryId || settings.categoryId;
  const supportRoleId = category?.supportRoleId || settings.supportRoleId;
  const me = guild.members.me || await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('The bot needs Manage Channels permission to create tickets.');
  }

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];

  if (supportRoleId) {
    const role = await guild.roles.fetch(supportRoleId);
    if (!role) throw new Error('The configured ticket support role no longer exists.');
    overwrites.push({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  let parent;
  if (categoryId) {
    parent = await guild.channels.fetch(categoryId);
    if (!parent || parent.type !== ChannelType.GuildCategory) {
      throw new Error('The configured ticket category is missing or is not a category.');
    }
  }

  const base = (user.username || user.id).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 80);
  const channel = await guild.channels.create({
    name: `ticket-${base || user.id.slice(-6)}`.slice(0, 100),
    type: ChannelType.GuildText,
    ...(parent ? { parent: parent.id } : {}),
    permissionOverwrites: overwrites,
    reason: `Support ticket opened by ${user.tag}`,
  });

  let ticket;
  try {
    ticket = await Ticket.create({
      guildId: guild.id,
      channelId: channel.id,
      userId: user.id,
      subject: 'Support request',
      category: categoryKey,
    });
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
    await channel.send({
      content: `<@${user.id}>${supportRoleId ? ` <@&${supportRoleId}>` : ''}`,
      embeds: [
        new EmbedBuilder()
          .setTitle(category?.label ? `Support ticket: ${category.label}` : 'Support ticket')
          .setDescription('Describe your request here. A support team member will be with you shortly.')
          .setColor(0x5865f2),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('tickets:close').setLabel('Close ticket').setStyle(ButtonStyle.Danger),
        ),
      ],
      allowedMentions: { users: [user.id], roles: supportRoleId ? [supportRoleId] : [] },
    });
  } catch (error) {
    if (ticket) await Ticket.deleteOne({ _id: ticket._id });
    try {
      await channel.delete('Ticket creation failed; cleaning up incomplete ticket');
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Ticket creation failed and its channel could not be cleaned up.');
    }
    if (error.code === 11000) return { existing: true };
    throw error;
  }

  let auditFailed = false;
  let statsFailed = false;
  try {
    await TicketStats.findOneAndUpdate(
      { guildId: guild.id },
      { $inc: { created: 1 } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    statsFailed = true;
    logger.error('Ticket created but statistics could not be updated', {
      guildId: guild.id,
      ticketId: ticket.id,
      error: error.message,
    });
  }
  try {
    await AuditLog.create({
      guildId: guild.id,
      actorId: user.id,
      targetId: channel.id,
      action: 'ticket.opened',
      details: { ticketId: ticket.id },
    });
  } catch (error) {
    auditFailed = true;
    logger.error('Ticket opened but audit record could not be saved', {
      guildId: guild.id,
      ticketId: ticket.id,
      error: error.message,
    });
  }
  return { channel, ticket, existing: false, auditFailed, statsFailed };
}

async function closeTicket({ guild, channel, actorId, reason = 'closed', inactiveBefore, generateTranscript = true }) {
  const eligibility = inactiveBefore ? { updatedAt: { $lte: inactiveBefore } } : {};
  const ticket = await Ticket.findOneAndUpdate(
    { guildId: guild.id, channelId: channel.id, status: 'open', ...eligibility },
    { $set: { status: 'closing', closingAt: new Date() } },
    { new: true },
  );
  if (!ticket) return { closed: false };
  activityUpdates.delete(`${guild.id}:${channel.id}`);

  let transcript;
  let transcriptText;
  let transcriptCreated = false;
  let logDeliveryFailed = false;
  try {
    if (generateTranscript) {
      transcriptText = await createTranscript(channel);
      transcript = await TicketTranscript.findOne({ ticketId: ticket._id });
      if (!transcript) {
        transcript = await TicketTranscript.create({
          guildId: guild.id,
          ticketId: ticket._id,
          content: transcriptText,
          messageCount: Math.max(0, transcriptText.split('\n').length - 3),
          generatedBy: actorId,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        transcriptCreated = true;
        await TicketStats.findOneAndUpdate(
          { guildId: guild.id },
          { $inc: { transcripts: 1 } },
          { upsert: true, setDefaultsOnInsert: true },
        );
      }
    }

    const config = await GuildConfig.findOne({ guildId: guild.id }).lean();
    if (transcriptText && config?.tickets?.logChannelId) {
      try {
        const logChannel = await guild.channels.fetch(config.tickets.logChannelId);
        if (!logChannel?.isTextBased() || !logChannel.messages) {
          throw new Error('Configured ticket log channel is missing or is not a text channel.');
        }
        await logChannel.send({
          content: `Ticket <#${channel.id}> closed by <@${actorId}>. Transcript is also retained in the dashboard for 30 days.`,
          files: [new AttachmentBuilder(Buffer.from(transcriptText, 'utf8'), { name: `ticket-${ticket.id}.txt` })],
          allowedMentions: { users: [actorId] },
        });
      } catch (error) {
        logDeliveryFailed = true;
        logger.warn('Ticket transcript saved, but log-channel delivery failed', {
          guildId: guild.id,
          ticketId: ticket.id,
          error: error.message,
        });
      }
    }

  } catch (error) {
    const rollbackErrors = [];
    try {
      await Ticket.updateOne(
        { _id: ticket._id, status: 'closing' },
        { $set: { status: 'open' }, $unset: { closingAt: 1 } },
      );
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (transcriptCreated && transcript) {
      try {
        await TicketTranscript.deleteOne({ _id: transcript._id });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Ticket close failed and rollback was incomplete.');
    throw error;
  }

  const closed = await Ticket.findOneAndUpdate(
    { _id: ticket._id, status: 'closing' },
    {
        $set: {
        status: 'closed',
        closedAt: new Date(),
        closedBy: actorId,
        ...(transcript ? { transcriptId: transcript._id } : {}),
        updatedAt: new Date(),
      },
      $unset: { closingAt: 1 },
    },
    { new: true },
  );
  if (!closed) throw new Error('Ticket closure state changed before the transcript was archived.');
  let statsFailed = false;
  try {
    await TicketStats.findOneAndUpdate(
      { guildId: guild.id },
      {
        $inc: {
          closed: 1,
          ...(closed.createdAt ? { totalResolutionMs: Math.max(0, closed.closedAt - closed.createdAt) } : {}),
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    statsFailed = true;
    logger.error('Ticket closed but statistics could not be updated', {
      guildId: guild.id,
      ticketId: ticket.id,
      error: error.message,
    });
  }
  try {
    await AuditLog.create({
      guildId: guild.id,
      actorId,
      targetId: channel.id,
      action: 'ticket.closed',
      details: {
        ticketId: ticket.id,
        reason,
        ...(transcript ? { transcriptId: transcript.id } : {}),
      },
    });
  } catch (error) {
    logger.error('Ticket closed but audit record could not be saved', {
      guildId: guild.id,
      ticketId: ticket.id,
      error: error.message,
    });
    return { closed: true, ticket: closed, auditFailed: true, logDeliveryFailed, statsFailed };
  }
  return { closed: true, ticket: closed, auditFailed: false, logDeliveryFailed, statsFailed };
}

async function reopenTicket({ guild, channel, actorId }) {
  const ticket = await Ticket.findOneAndUpdate(
    { guildId: guild.id, channelId: channel.id, status: 'closed' },
    {
      $set: { status: 'open', updatedAt: new Date() },
      $unset: { closedAt: 1, closedBy: 1, closingAt: 1 },
    },
    { new: true },
  );
  if (!ticket) return { reopened: false };
  const config = await GuildConfig.findOne({ guildId: guild.id }).lean();
  const roleId = config?.tickets?.categories?.find((item) => item.key === ticket.category)?.supportRoleId
    || config?.tickets?.supportRoleId;
  const ownerOverwrite = channel.permissionOverwrites.cache.get(ticket.userId);
  const supportOverwrite = roleId ? channel.permissionOverwrites.cache.get(roleId) : null;
  try {
    await channel.permissionOverwrites.edit(ticket.userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    }, { reason: `Ticket reopened by ${actorId}` });
    if (roleId) {
      await channel.permissionOverwrites.edit(roleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      }, { reason: `Ticket reopened by ${actorId}` });
    }
    await TicketStats.findOneAndUpdate(
      { guildId: guild.id },
      { $inc: { reopened: 1 } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    await AuditLog.create({
      guildId: guild.id,
      actorId,
      targetId: channel.id,
      action: 'ticket.reopened',
      details: { ticketId: String(ticket._id) },
    });
  } catch (error) {
    const rollbackErrors = [];
    try {
      await Ticket.updateOne(
        { _id: ticket._id, status: 'open' },
        { $set: { status: 'closed', closedAt: ticket.closedAt || new Date(), closedBy: ticket.closedBy || actorId } },
      );
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    for (const [id, overwrite] of [[ticket.userId, ownerOverwrite], [roleId, supportOverwrite]]) {
      if (!id) continue;
      try {
        await restoreOverwrite(channel, id, overwrite, 'Rolling back failed ticket reopen');
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], 'Ticket reopen failed and rollback was incomplete.');
    }
    throw error;
  }
  return { reopened: true, ticket };
}

async function claimTicket({ guild, channel, actorId }) {
  const ticket = await Ticket.findOneAndUpdate(
    { guildId: guild.id, channelId: channel.id, status: 'open' },
    { $set: { claimedBy: actorId, updatedAt: new Date() } },
    { new: true },
  );
  if (!ticket) return { claimed: false };
  const previousOverwrite = channel.permissionOverwrites.cache.get(actorId);
  const previousState = previousOverwrite
    ? {
      ViewChannel: previousOverwrite.allow.has(PermissionFlagsBits.ViewChannel)
        ? true
        : previousOverwrite.deny.has(PermissionFlagsBits.ViewChannel) ? false : null,
      SendMessages: previousOverwrite.allow.has(PermissionFlagsBits.SendMessages)
        ? true
        : previousOverwrite.deny.has(PermissionFlagsBits.SendMessages) ? false : null,
      ReadMessageHistory: previousOverwrite.allow.has(PermissionFlagsBits.ReadMessageHistory)
        ? true
        : previousOverwrite.deny.has(PermissionFlagsBits.ReadMessageHistory) ? false : null,
    }
    : null;
  try {
    await channel.permissionOverwrites.edit(actorId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }, { reason: `Ticket claimed by ${actorId}` });
  } catch (error) {
    const rollbackErrors = [];
    try {
      await Ticket.updateOne({ _id: ticket._id, claimedBy: actorId }, { $set: { claimedBy: null } });
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      if (previousState) {
        await channel.permissionOverwrites.edit(actorId, previousState, { reason: 'Rolling back failed ticket claim' });
      } else {
        await channel.permissionOverwrites.delete(actorId, 'Rolling back failed ticket claim');
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], 'Ticket claim failed and rollback was incomplete.');
    }
    throw error;
  }
  await TicketStats.findOneAndUpdate(
    { guildId: guild.id },
    { $inc: { claimed: 1 } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  await AuditLog.create({
    guildId: guild.id,
    actorId,
    targetId: channel.id,
    action: 'ticket.claimed',
    details: { ticketId: String(ticket._id) },
  });
  const config = await GuildConfig.findOne({ guildId: guild.id }).lean();
  if (config?.tickets?.logChannelId) {
    const logChannel = await guild.channels.fetch(config.tickets.logChannelId);
    if (logChannel?.isTextBased()) {
      await logChannel.send({
        content: `Ticket <#${channel.id}> claimed by <@${actorId}>.`,
        allowedMentions: { users: [actorId] },
      });
    }
  }
  return { claimed: true, ticket };
}

async function updateTicketUser({ guild, channel, actorId, user, add }) {
  const ticket = await Ticket.findOne({ guildId: guild.id, channelId: channel.id, status: 'open' });
  if (!ticket) return { updated: false };
  if (user.bot || user.id === guild.ownerId) throw new Error('Bots and the server owner cannot be added or removed this way.');
  const alreadyAdded = ticket.addedUserIds.includes(user.id);
  if (add && alreadyAdded) return { updated: false, reason: 'already-added' };
  if (!add && !alreadyAdded) return { updated: false, reason: 'not-added' };

  const previousOverwrite = channel.permissionOverwrites.cache.get(user.id);
  if (add) {
    await channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    }, { reason: `Added to ticket by ${actorId}` });
    ticket.addedUserIds.push(user.id);
  } else {
    await channel.permissionOverwrites.delete(user.id, `Removed from ticket by ${actorId}`);
    ticket.addedUserIds = ticket.addedUserIds.filter((id) => id !== user.id);
  }
  ticket.updatedAt = new Date();
  try {
    await ticket.save();
  } catch (error) {
    try {
      await restoreOverwrite(channel, user.id, previousOverwrite, 'Rolling back failed ticket member update');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Ticket member update failed and permission rollback was incomplete.');
    }
    throw error;
  }
  await TicketStats.findOneAndUpdate(
    { guildId: guild.id },
    { $inc: { [add ? 'usersAdded' : 'usersRemoved']: 1 } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  await AuditLog.create({
    guildId: guild.id,
    actorId,
    targetId: channel.id,
    action: add ? 'ticket.user_added' : 'ticket.user_removed',
    details: { ticketId: String(ticket._id), userId: user.id },
  });
  const config = await GuildConfig.findOne({ guildId: guild.id }).lean();
  if (config?.tickets?.logChannelId) {
    const logChannel = await guild.channels.fetch(config.tickets.logChannelId);
    if (logChannel?.isTextBased()) {
      await logChannel.send({
        content: add
          ? `<@${user.id}> was added to ticket <#${channel.id}> by <@${actorId}>.`
          : `<@${user.id}> was removed from ticket <#${channel.id}> by <@${actorId}>.`,
        allowedMentions: { users: [user.id, actorId] },
      });
    }
  }
  return { updated: true, ticket };
}

async function restoreOverwrite(channel, id, overwrite, reason) {
  if (!overwrite) {
    await channel.permissionOverwrites.delete(id, reason);
    return;
  }
  const valueFor = (permission) => overwrite.allow.has(permission)
    ? true
    : overwrite.deny.has(permission) ? false : null;
  await channel.permissionOverwrites.edit(id, {
    ViewChannel: valueFor(PermissionFlagsBits.ViewChannel),
    SendMessages: valueFor(PermissionFlagsBits.SendMessages),
    ReadMessageHistory: valueFor(PermissionFlagsBits.ReadMessageHistory),
    AttachFiles: valueFor(PermissionFlagsBits.AttachFiles),
  }, { reason });
}

async function generateTicketTranscript({ guild, channel, actorId }) {
  const ticket = await Ticket.findOne({ guildId: guild.id, channelId: channel.id }).lean();
  if (!ticket) return null;
  const content = await createTranscript(channel);
  const transcript = await TicketTranscript.findOneAndUpdate(
    { ticketId: ticket._id },
    {
      $set: {
        guildId: guild.id,
        content,
        messageCount: Math.max(0, content.split('\n').length - 3),
        generatedBy: actorId,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
      $setOnInsert: { ticketId: ticket._id },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
  await Ticket.updateOne({ _id: ticket._id }, { $set: { transcriptId: transcript._id } });
  await TicketStats.findOneAndUpdate(
    { guildId: guild.id },
    { $inc: { transcripts: 1 } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  await AuditLog.create({
    guildId: guild.id,
    actorId,
    targetId: channel.id,
    action: 'ticket.transcript_generated',
    details: { ticketId: String(ticket._id), transcriptId: String(transcript._id) },
  });
  return { ticket, transcript };
}

async function recordTicketAction({ guildId, actorId, channelId, action, details = {} }) {
  await AuditLog.create({ guildId, actorId, targetId: channelId, action, details });
}

async function touchTicketActivity(guildId, channelId) {
  const now = Date.now();
  const key = `${guildId}:${channelId}`;
  if (now - (activityUpdates.get(key) || 0) < 30_000) return;
  activityUpdates.set(key, now);
  try {
    await Ticket.updateOne(
      { guildId, channelId, status: 'open' },
      { $set: { updatedAt: new Date(now) } },
    );
  } catch (error) {
    activityUpdates.delete(key);
    throw error;
  }
}

module.exports = {
  claimTicket,
  closeTicket,
  createTicket,
  generateTicketTranscript,
  recordTicketAction,
  reopenTicket,
  touchTicketActivity,
  updateTicketUser,
};
