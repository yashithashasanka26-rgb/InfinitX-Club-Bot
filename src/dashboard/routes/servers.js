const express = require('express');
const { AuditLog, CommandPermission, DashboardAction, GuildConfig, ScheduledMessage } = require('../../database/models');
const { DISCORD_API } = require('../auth');
const { requireGuildManager, requireLogin, requireSameOrigin } = require('../middleware');
const logger = require('../../utils/logger');
const { getValidationDetails } = require('../errors');

const router = express.Router();
const modules = new Set([
  'moderation', 'automod', 'tickets', 'economy', 'leveling', 'music', 'ai',
  'customCommands', 'welcomeLeave', 'verification', 'giveaways', 'temporaryVoice', 'analytics',
  'starboard', 'suggestions',
]);
const snowflake = /^\d{17,20}$/;
const permissionFields = new Set([
  'enabled', 'requiredRoleIds', 'allowedChannelIds', 'deniedChannelIds',
  'cooldownSeconds', 'maxUses', 'windowSeconds',
]);
const idFields = new Set([
  'logChannelId', 'announceChannelId', 'roleId', 'channelId', 'joinChannelId',
  'categoryId', 'supportRoleId', 'welcomeChannelId', 'leaveChannelId',
]);

function validateSettings(section, values) {
  for (const [field, value] of Object.entries(values)) {
    if (section === 'welcomeLeave' && field === 'backgroundImageUrl') {
      validateImageUrl(value, `${section}.${field}`);
    }
    if ((section === 'welcomeLeave' && ['welcome', 'leave'].includes(field))
      || (['tickets', 'verification'].includes(section) && field === 'panel')) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${section}.${field} must be an object.`);
      }
      for (const [embedField, embedValue] of Object.entries(value)) {
        const allowedFields = section === 'welcomeLeave'
          ? ['title', 'description', 'color', 'footer', 'includeDate', 'includeTime', 'thumbnailUrl', 'imageUrl']
          : ['title', 'description', 'color', 'footer', 'imageUrl', 'buttonLabel', 'buttonStyle'];
        if (!allowedFields.includes(embedField)) {
          throw new TypeError(`Unsupported setting: ${section}.${field}.${embedField}.`);
        }
        if (['thumbnailUrl', 'imageUrl'].includes(embedField)) validateImageUrl(embedValue, `${section}.${field}.${embedField}`);
        if (embedField === 'color' && (typeof embedValue !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(embedValue))) {
          throw new TypeError(`${section}.${field}.color must be a six-digit hex color.`);
        }
        if (['title', 'description', 'footer'].includes(embedField)) {
          const max = { title: 256, description: 4000, footer: 2048 }[embedField];
          if (typeof embedValue !== 'string' || embedValue.length > max) {
            throw new TypeError(`${section}.${field}.${embedField} must be text no longer than ${max} characters.`);
          }
        }
        if (['buttonLabel', 'buttonStyle'].includes(embedField)
          && (typeof embedValue !== 'string'
            || embedField === 'buttonLabel' && (!embedValue.trim() || embedValue.length > 80)
            || embedField === 'buttonStyle' && !['primary', 'secondary', 'success'].includes(embedValue))) {
          throw new TypeError(`${section}.${field}.${embedField} is invalid.`);
        }
      }
    }
    if (section === 'ai' && field === 'greetingTriggers'
      && (!Array.isArray(value) || value.length > 30
        || value.some((phrase) => typeof phrase !== 'string' || !phrase.trim() || phrase.length > 80))) {
      throw new TypeError('ai.greetingTriggers must contain at most 30 phrases, each 1–80 characters long.');
    }
    if (idFields.has(field) && value !== null && (typeof value !== 'string' || !snowflake.test(value))) {
      throw new TypeError(`${section}.${field} must be a Discord ID or null.`);
    }
    if (field === 'badWords' && (!Array.isArray(value) || value.length > 100
      || value.some((word) => typeof word !== 'string' || word.length > 100))) {
      throw new TypeError('moderation.badWords must be an array of at most 100 strings, each no longer than 100 characters.');
    }
    if (field === 'excludedChannels' && (!Array.isArray(value) || value.length > 100
      || value.some((id) => typeof id !== 'string' || !snowflake.test(id)))) {
      throw new TypeError('leveling.excludedChannels must contain valid Discord channel IDs.');
    }
    if (field === 'roleRewards') {
      const valid = Array.isArray(value) && value.length <= 50
        && value.every((reward) => reward && typeof reward === 'object' && !Array.isArray(reward)
          && Object.keys(reward).every((key) => ['level', 'roleId'].includes(key))
          && Number.isSafeInteger(reward.level) && reward.level >= 1 && reward.level <= 10000
          && typeof reward.roleId === 'string' && snowflake.test(reward.roleId));
      if (!valid || new Set(value.map((reward) => reward.level)).size !== value.length) {
        throw new TypeError('leveling.roleRewards must have unique levels and valid role IDs.');
      }
    }
    if (field === 'items') {
      const valid = Array.isArray(value) && value.length <= 25
        && value.every((item) => item && typeof item === 'object' && !Array.isArray(item)
          && Object.keys(item).every((key) => ['itemId', 'name', 'description', 'price'].includes(key))
          && typeof item.itemId === 'string' && /^[a-z0-9_-]{1,32}$/.test(item.itemId)
          && typeof item.name === 'string' && item.name.trim().length >= 1 && item.name.length <= 80
          && (item.description === undefined || (typeof item.description === 'string' && item.description.length <= 200))
          && Number.isSafeInteger(item.price) && item.price >= 1 && item.price <= 100000000);
      if (!valid || new Set(value.map((item) => item.itemId)).size !== value.length) {
        throw new TypeError('economy.items must contain unique item IDs and valid item data.');
      }
    }
    if (field === 'categories') {
      const valid = Array.isArray(value) && value.length <= 25
        && value.every((category) => category && typeof category === 'object' && !Array.isArray(category)
          && Object.keys(category).every((key) => ['key', 'label', 'description', 'categoryId', 'supportRoleId'].includes(key))
          && typeof category.key === 'string' && /^[a-z0-9_-]{1,25}$/.test(category.key)
          && typeof category.label === 'string' && category.label.trim().length >= 1 && category.label.length <= 100
          && (category.description === undefined || (typeof category.description === 'string' && category.description.length <= 100))
          && (category.categoryId === undefined || category.categoryId === null || (typeof category.categoryId === 'string' && snowflake.test(category.categoryId)))
          && (category.supportRoleId === undefined || category.supportRoleId === null || (typeof category.supportRoleId === 'string' && snowflake.test(category.supportRoleId))));
      if (!valid || new Set(value.map((category) => category.key)).size !== value.length) {
        throw new TypeError('tickets.categories must have unique valid keys and valid category data.');
      }
    }
  }
}

function validateImageUrl(value, field) {
  if (value === null || value === '') return;
  if (typeof value !== 'string' || value.length > 2048) {
    throw new TypeError(`${field} must be an HTTPS image URL or empty.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${field} must be a valid HTTPS image URL.`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new TypeError(`${field} must be a valid HTTPS image URL.`);
  }
}

router.use(requireLogin);
router.param('guildId', requireGuildManager);

router.get('/', async (req, res, next) => {
  try {
    const authorization = `Bearer ${req.session.accessToken}`;
    const response = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      if (response.status === 401) {
        res.status(401).json({ error: 'Discord session expired. Please sign in again.' });
        return;
      }
      throw new Error(`Discord guild lookup failed with status ${response.status}`);
    }
    const guilds = await response.json();
    res.json({
      servers: guilds.filter((guild) => {
        const permissions = BigInt(guild.permissions || '0');
        return guild.owner === true || (permissions & 0x20n) !== 0n || (permissions & 0x8n) !== 0n;
      }).map(({ id, name, icon, owner }) => ({ id, name, icon, owner: Boolean(owner) })),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:guildId', async (req, res, next) => {
  try {
    const [stored, commandPermissions] = await Promise.all([
      GuildConfig.findOne({ guildId: req.guildId }),
      CommandPermission.find({ guildId: req.guildId }).sort({ commandName: 1 }).lean(),
    ]);
    const config = (stored || new GuildConfig({ guildId: req.guildId })).toObject({ flattenMaps: true });
    res.json({ server: { id: req.guildId }, config, commandPermissions });
  } catch (error) {
    next(error);
  }
});

function validateCommandPermission(guildId, commandName, values) {
  if (typeof commandName !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(commandName)
    || !values || typeof values !== 'object' || Array.isArray(values)
    || Object.keys(values).some((key) => !permissionFields.has(key))) {
    throw new TypeError('Invalid command permission entry.');
  }
  for (const field of ['enabled']) {
    if (Object.hasOwn(values, field) && typeof values[field] !== 'boolean') {
      throw new TypeError(`${commandName}.${field} must be boolean.`);
    }
  }
  for (const field of ['requiredRoleIds', 'allowedChannelIds', 'deniedChannelIds']) {
    if (Object.hasOwn(values, field)
      && (!Array.isArray(values[field]) || values[field].length > 100 || values[field].some((id) => typeof id !== 'string' || !snowflake.test(id)))) {
      throw new TypeError(`${commandName}.${field} must be an array of Discord IDs.`);
    }
  }
  for (const [field, min, max] of [['cooldownSeconds', 0, 86400], ['maxUses', 1, 1000000], ['windowSeconds', 1, 2592000]]) {
    if (Object.hasOwn(values, field) && values[field] !== null
      && (!Number.isSafeInteger(values[field]) || values[field] < min || values[field] > max)) {
      throw new TypeError(`${commandName}.${field} is outside its valid range.`);
    }
  }
  const permission = new CommandPermission({ guildId, commandName, ...values });
  return permission.validate().then(() => permission);
}

function validateConfigPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Expected a JSON object.');
  const allowedRoot = new Set(['prefix', 'language', 'modules', 'settings', 'commandPermissions']);
  if (Object.keys(body).some((key) => !allowedRoot.has(key))) throw new TypeError('Unsupported server configuration field.');
  const patch = { prefix: body.prefix, language: body.language, modules: body.modules };
  const settings = body.settings ?? {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('settings must be an object.');
  const sectionNames = [
    'moderation', 'music', 'leveling', 'economy', 'ai', 'welcomeLeave',
    'verification', 'temporaryVoice', 'starboard', 'suggestions', 'tickets',
  ];
  if (Object.keys(settings).some((section) => !sectionNames.includes(section))) throw new TypeError('Unsupported settings section.');
  patch.settings = settings;
  if (body.prefix !== undefined && (typeof body.prefix !== 'string' || !/^[^\s]{1,5}$/.test(body.prefix))) {
    throw new TypeError('Prefix must contain 1–5 non-whitespace characters.');
  }
  if (body.language !== undefined && (typeof body.language !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(body.language))) {
    throw new TypeError('Language must be a locale such as en or en-US.');
  }
  if (body.modules !== undefined && (!body.modules || typeof body.modules !== 'object' || Array.isArray(body.modules)
    || Object.keys(body.modules).some((name) => !modules.has(name))
    || Object.values(body.modules).some((value) => typeof value !== 'boolean'))) {
    throw new TypeError('modules must contain supported module names and boolean values.');
  }
  return patch;
}

function rejectSettingsSave(req, res, message) {
  logger.warn('Dashboard server settings validation failed', {
    method: req.method,
    path: req.originalUrl,
    guildId: req.guildId,
    userId: req.session?.user?.id,
    reason: message,
  });
  res.status(400).json({ error: message });
}

function applySettingsPatch(config, section, values, prefix = '') {
  for (const [field, value] of Object.entries(values)) {
    const path = prefix ? `${prefix}.${field}` : field;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      applySettingsPatch(config, section, value, path);
    } else {
      config.set(`${section}.${path}`, value);
    }
  }
}

async function updateServerSettings(req, res, next) {
  try {
    logger.info('Dashboard settings update request received', {
      method: req.method,
      path: req.originalUrl,
      guildId: req.guildId,
      userId: req.session?.user?.id,
      body: req.body,
    });
    const patch = validateConfigPatch(req.body);
    const commandPermissions = req.body.commandPermissions ?? [];
    if (!Array.isArray(commandPermissions) || commandPermissions.length > 100) {
      rejectSettingsSave(req, res, 'commandPermissions must be an array with at most 100 entries.');
      return;
    }
    const config = await GuildConfig.findOne({ guildId: req.guildId }) || new GuildConfig({ guildId: req.guildId });
    if (patch.prefix !== undefined) config.prefix = patch.prefix;
    if (patch.language !== undefined) config.language = patch.language;
    if (patch.modules !== undefined) {
      for (const [name, enabled] of Object.entries(patch.modules)) config.modules.set(name, enabled);
    }
    for (const [section, values] of Object.entries(patch.settings)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        rejectSettingsSave(req, res, `${section} settings must be an object.`);
        return;
      }
      const validateSchemaValues = (object, prefix = '') => {
        for (const [field, value] of Object.entries(object)) {
          const fieldPath = prefix ? `${prefix}.${field}` : field;
          const schemaPath = `${section}.${fieldPath}`;
          const schemaType = GuildConfig.schema.path(schemaPath);
          if (!schemaType && value && typeof value === 'object' && !Array.isArray(value)) {
            validateSchemaValues(value, fieldPath);
            continue;
          }
          if (!schemaType) throw new TypeError(`Unsupported setting: ${schemaPath}.`);
          if (schemaType.instance === 'Number' && !Number.isSafeInteger(value)) {
            throw new TypeError(`${schemaPath} must be an integer.`);
          }
          if (schemaType.instance === 'Boolean' && typeof value !== 'boolean') {
            throw new TypeError(`${schemaPath} must be boolean.`);
          }
          if (schemaType.instance === 'String' && value !== null && typeof value !== 'string') {
            throw new TypeError(`${schemaPath} must be a string or null.`);
          }
          if (schemaType.instance === 'Array' && !Array.isArray(value)) {
            throw new TypeError(`${schemaPath} must be an array.`);
          }
        }
      };
      validateSchemaValues(values);
      validateSettings(section, values);
      applySettingsPatch(config, section, values);
    }
    if (patch.settings.economy
      && (Object.hasOwn(patch.settings.economy, 'workMin') || Object.hasOwn(patch.settings.economy, 'workMax'))) {
      const min = config.economy.workMin;
      const max = config.economy.workMax;
      if (min > max) {
        rejectSettingsSave(req, res, 'economy.workMin must not be greater than economy.workMax.');
        return;
      }
    }
    if (patch.settings.leveling
      && (Object.hasOwn(patch.settings.leveling, 'xpMin') || Object.hasOwn(patch.settings.leveling, 'xpMax'))
      && config.leveling.xpMin > config.leveling.xpMax) {
      rejectSettingsSave(req, res, 'leveling.xpMin must not be greater than leveling.xpMax.');
      return;
    }
    if (config.welcomeLeave.welcomeEnabled && !config.welcomeLeave.welcomeChannelId) {
      rejectSettingsSave(req, res, 'Choose a welcome channel before enabling welcome messages.');
      return;
    }
    if (config.welcomeLeave.leaveEnabled && !config.welcomeLeave.leaveChannelId) {
      rejectSettingsSave(req, res, 'Choose a leave channel before enabling leave messages.');
      return;
    }
    for (const type of ['welcome', 'leave']) {
      const embed = config.welcomeLeave[type];
      if (!embed.title?.trim() && !embed.description?.trim()) {
        rejectSettingsSave(req, res, `The ${type} embed needs a title or description.`);
        return;
      }
    }
    await config.validate();

    const validatedPermissions = [];
    const names = new Set();
    for (const entry of commandPermissions) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some((key) => !['commandName', ...permissionFields].includes(key))
        || names.has(entry.commandName)) {
        rejectSettingsSave(req, res, 'Each command permission must have a unique commandName and supported fields.');
        return;
      }
      names.add(entry.commandName);
      const { commandName, ...values } = entry;
      validatedPermissions.push(await validateCommandPermission(req.guildId, commandName, values));
    }

    await config.save();
    if (validatedPermissions.length) {
      const writeResult = await CommandPermission.bulkWrite(validatedPermissions.map((permission) => ({
        updateOne: {
          filter: { guildId: req.guildId, commandName: permission.commandName },
          update: {
            $set: Object.fromEntries([...permissionFields].map((field) => [field, permission[field]])),
            $setOnInsert: { guildId: req.guildId, commandName: permission.commandName },
          },
          upsert: true,
        },
      })));
      if (writeResult.matchedCount + writeResult.upsertedCount !== validatedPermissions.length) {
        throw new Error(`Command permission persistence was incomplete: expected ${validatedPermissions.length} writes, received ${writeResult.matchedCount + writeResult.upsertedCount}.`);
      }
    }
    const [savedConfig, savedPermissions] = await Promise.all([
      GuildConfig.findOne({ guildId: req.guildId }).lean(),
      CommandPermission.find({ guildId: req.guildId }).sort({ commandName: 1 }).lean(),
    ]);
    await AuditLog.create({
      guildId: req.guildId,
      actorId: req.session.user.id,
      action: 'dashboard.server_configuration_updated',
      details: {
        configFields: [
          ...(patch.prefix !== undefined ? ['prefix'] : []),
          ...(patch.language !== undefined ? ['language'] : []),
          ...(patch.modules !== undefined ? ['modules'] : []),
          ...Object.keys(patch.settings).map((section) => `settings.${section}`),
        ],
        commandPermissionNames: validatedPermissions.map((permission) => permission.commandName),
      },
    });
    if (!savedConfig) throw new Error('Settings save completed, but the saved guild configuration could not be read back.');
    logger.info('Dashboard server settings saved', {
      guildId: req.guildId,
      userId: req.session.user.id,
      configSections: Object.keys(patch.settings),
      moduleCount: Object.keys(patch.modules || {}).length,
      commandPermissionCount: validatedPermissions.length,
    });
    res.json({
      config: {
        ...savedConfig,
        modules: savedConfig.modules instanceof Map
          ? Object.fromEntries(savedConfig.modules)
          : savedConfig.modules || {},
      },
      commandPermissions: savedPermissions,
    });
  } catch (error) {
    if (error instanceof TypeError || error.name === 'ValidationError' || error.name === 'CastError') {
      logger.error('Dashboard server settings validation failed', {
        method: req.method,
        path: req.originalUrl,
        guildId: req.guildId,
        userId: req.session?.user?.id,
        errorName: error.name,
        reason: error.message,
        validationErrors: getValidationDetails(error),
        stack: error.stack,
      });
      const validationErrors = getValidationDetails(error);
      res.status(400).json({
        error: error.message,
        ...(validationErrors ? { details: validationErrors } : {}),
      });
      return;
    }
    logger.error('Dashboard server settings persistence failed', {
      method: req.method,
      path: req.originalUrl,
      guildId: req.guildId,
      userId: req.session?.user?.id,
      errorName: error.name,
      error: error.message,
      code: error.code,
      validationErrors: getValidationDetails(error),
      stack: error.stack,
    });
    next(error);
  }
}

router.post('/:guildId/update', requireSameOrigin, updateServerSettings);
router.put('/:guildId/update', requireSameOrigin, updateServerSettings);

function validateDashboardEmbed(body) {
  const fields = ['title', 'description', 'color', 'footer', 'imageUrl'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !fields.includes(key))) {
    throw new TypeError('Provide a supported embed object.');
  }
  const embed = {
    title: body.title ?? '',
    description: body.description ?? '',
    color: body.color ?? '#7478ff',
    footer: body.footer ?? '',
    imageUrl: body.imageUrl || null,
  };
  if (typeof embed.title !== 'string' || embed.title.length > 256
    || typeof embed.description !== 'string' || embed.description.length > 4000
    || typeof embed.footer !== 'string' || embed.footer.length > 2048) {
    throw new TypeError('Embed text exceeds the supported field limits.');
  }
  if (!embed.title.trim() && !embed.description.trim() && !embed.footer.trim()) {
    throw new TypeError('Add a title, description, or footer to the embed.');
  }
  if (typeof embed.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(embed.color)) {
    throw new TypeError('Embed color must be a six-digit hexadecimal color.');
  }
  if (embed.imageUrl) validateImageUrl(embed.imageUrl, 'imageUrl');
  return embed;
}

router.post('/:guildId/actions', requireSameOrigin, async (req, res, next) => {
  try {
    const { type, payload } = req.body || {};
    const snowflakeValue = (value) => typeof value === 'string' && snowflake.test(value);
    let safePayload;
    if (type === 'deploy-ticket-panel' || type === 'deploy-verification-panel') {
      if (!snowflakeValue(payload?.channelId)) throw new TypeError('Choose a valid Discord text channel.');
      safePayload = { channelId: payload.channelId };
    } else if (type === 'send-embed') {
      if (!snowflakeValue(payload?.channelId)) throw new TypeError('Choose a valid Discord text channel.');
      safePayload = { channelId: payload.channelId, ...validateDashboardEmbed(payload.embed) };
    } else if (type === 'music') {
      const operation = payload?.operation;
      if (!['status', 'play', 'pause', 'resume', 'skip', 'stop', 'volume'].includes(operation)) {
        throw new TypeError('Choose a supported music action.');
      }
      if (operation === 'play' && (typeof payload.query !== 'string' || !payload.query.trim() || payload.query.length > 200)) {
        throw new TypeError('Enter a track URL or search query (up to 200 characters).');
      }
      if (operation === 'volume' && (!Number.isSafeInteger(payload.volume) || payload.volume < 0 || payload.volume > 200)) {
        throw new TypeError('Volume must be a whole number between 0 and 200.');
      }
      safePayload = {
        operation,
        ...(operation === 'play' ? { query: payload.query.trim() } : {}),
        ...(operation === 'volume' ? { volume: payload.volume } : {}),
      };
    } else {
      throw new TypeError('Unsupported dashboard action.');
    }
    const action = await DashboardAction.create({
      guildId: req.guildId,
      actorId: req.session.user.id,
      type,
      payload: safePayload,
      expiresAt: new Date(Date.now() + 2 * 60_000),
    });
    res.status(202).json({ actionId: action.id, status: action.status });
  } catch (error) {
    if (error instanceof TypeError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.get('/:guildId/actions/:actionId', async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.actionId)) {
      res.status(400).json({ error: 'Invalid action ID.' });
      return;
    }
    const action = await DashboardAction.findOne({
      _id: req.params.actionId,
      guildId: req.guildId,
      actorId: req.session.user.id,
    }).lean();
    if (!action) {
      res.status(404).json({ error: 'Dashboard action was not found.' });
      return;
    }
    res.json({ status: action.status, result: action.result, error: action.error });
  } catch (error) {
    next(error);
  }
});

router.get('/:guildId/scheduled-messages', async (req, res, next) => {
  try {
    const messages = await ScheduledMessage.find({ guildId: req.guildId })
      .sort({ scheduledAt: -1 }).limit(50).lean();
    res.json({ messages });
  } catch (error) {
    next(error);
  }
});

router.post('/:guildId/scheduled-messages', requireSameOrigin, async (req, res, next) => {
  try {
    const channelId = req.body?.channelId;
    if (typeof channelId !== 'string' || !snowflake.test(channelId)) {
      res.status(400).json({ error: 'Choose a valid Discord text channel.' });
      return;
    }
    const embed = validateDashboardEmbed(req.body.embed);
    if (req.body.sendNow === true) {
      const action = await DashboardAction.create({
        guildId: req.guildId,
        actorId: req.session.user.id,
        type: 'send-embed',
        payload: { channelId, ...embed },
        expiresAt: new Date(Date.now() + 2 * 60_000),
      });
      res.status(202).json({ actionId: action.id, status: action.status });
      return;
    }
    const scheduledAt = new Date(req.body.scheduledAt);
    if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000
      || scheduledAt.getTime() > Date.now() + 365 * 24 * 60 * 60_000) {
      res.status(400).json({ error: 'Choose a schedule time at least one minute and no more than one year from now.' });
      return;
    }
    const message = await ScheduledMessage.create({
      guildId: req.guildId,
      channelId,
      createdBy: req.session.user.id,
      ...embed,
      scheduledAt,
    });
    res.status(201).json({ message });
  } catch (error) {
    if (error instanceof TypeError || error.name === 'ValidationError') {
      const validationErrors = getValidationDetails(error);
      logger.warn('Dashboard custom command save rejected', {
        method: req.method,
        path: req.originalUrl,
        guildId: req.guildId,
        userId: req.session?.user?.id,
        errorName: error.name,
        reason: error.message,
        validationErrors,
        stack: error.stack,
      });
      res.status(400).json({
        error: error.message,
        ...(validationErrors ? { details: validationErrors } : {}),
      });
      return;
    }
    next(error);
  }
});

router.delete('/:guildId/scheduled-messages/:messageId', requireSameOrigin, async (req, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.messageId)) {
      res.status(400).json({ error: 'Invalid scheduled message ID.' });
      return;
    }
    const message = await ScheduledMessage.findOneAndUpdate(
      { _id: req.params.messageId, guildId: req.guildId, status: 'pending' },
      { $set: { status: 'cancelled' } },
      { new: true },
    ).lean();
    if (!message) {
      res.status(404).json({ error: 'Pending scheduled message was not found.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = {
  applySettingsPatch,
  router,
  validateCommandPermission,
  validateConfigPatch,
  validateDashboardEmbed,
  validateSettings,
};
