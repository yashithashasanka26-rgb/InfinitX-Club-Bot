const required = ['DISCORD_CLIENT_ID', 'MONGODB_URI'];

function loadConfig() {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
    throw new Error('SESSION_SECRET must contain at least 32 characters in production');
  }

  const ownerIds = (process.env.BOT_OWNER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (ownerIds.some((id) => !/^\d{17,20}$/.test(id))) {
    throw new Error('BOT_OWNER_IDS must be a comma-separated list of Discord user IDs.');
  }

  return {
    token: process.env.DISCORD_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    mongoUri: process.env.MONGODB_URI,
    sessionSecret: process.env.SESSION_SECRET || 'development-only-change-before-deploy',
    dashboardBaseUrl: (process.env.DASHBOARD_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    redirectUri: process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback',
    dashboardPort: Number.parseInt(process.env.DASHBOARD_PORT || '3000', 10),
    trustProxy: Number.parseInt(process.env.TRUST_PROXY || '0', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    ownerIds: [...new Set(ownerIds)],
  };
}

module.exports = { loadConfig };
