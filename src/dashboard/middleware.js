const { DISCORD_API } = require('./auth');
const { requireSameOrigin } = require('./origin');

function requireLogin(req, res, next) {
  if (!req.session.user || !req.session.accessToken) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  next();
}

async function requireGuildManager(req, res, next) {
  const guildId = req.params.guildId;
  if (!/^\d{17,20}$/.test(guildId)) {
    res.status(400).json({ error: 'Invalid guild ID.' });
    return;
  }
  try {
    const response = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${req.session.accessToken}` },
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
    if (!Array.isArray(guilds)) {
      throw new Error('Discord guild lookup returned an invalid response.');
    }
    const guild = guilds.find((entry) => entry.id === guildId);
    const permissions = BigInt(guild?.permissions || '0');
    const canManage = guild?.owner === true || (permissions & 0x20n) !== 0n || (permissions & 0x8n) !== 0n;
    if (!guild || !canManage) {
      res.status(403).json({ error: 'You need Manage Server permission for this guild.' });
      return;
    }
    req.guildId = guildId;
    req.guild = guild;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { requireGuildManager, requireLogin, requireSameOrigin };
