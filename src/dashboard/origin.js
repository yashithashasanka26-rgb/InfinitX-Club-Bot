const logger = require('../utils/logger');

const DEVELOPMENT_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
const DEVELOPMENT_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

function getRequestOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function getRequestHost(host) {
  if (typeof host !== 'string' || !host) return null;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.host !== host || parsed.username || parsed.password || parsed.pathname !== '/') return null;
    return parsed;
  } catch {
    return null;
  }
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  const host = req.get('host');
  const isDevelopment = process.env.NODE_ENV !== 'production';
  if (isDevelopment) {
    logger.info('Dashboard request origin check', {
      method: req.method,
      path: req.originalUrl || req.url,
      origin: origin || null,
      host: host || null,
      forwardedHost: req.get('x-forwarded-host') || null,
    });
  }

  const requestOrigin = getRequestOrigin(origin);
  if (!requestOrigin) {
    res.status(403).json({ error: 'Request origin is not allowed.' });
    return;
  }

  let configuredOrigin;
  try {
    configuredOrigin = new URL(req.app.locals.config.dashboardBaseUrl).origin;
  } catch (error) {
    next(new Error(`Invalid DASHBOARD_BASE_URL: ${error.message}`));
    return;
  }

  const exactAllowed = requestOrigin.origin === configuredOrigin
    || (isDevelopment && DEVELOPMENT_ORIGINS.has(requestOrigin.origin));
  const requestHost = isDevelopment ? getRequestHost(host) : null;
  const matchesLocalRequestHost = Boolean(
    requestHost
    && DEVELOPMENT_HOSTNAMES.has(requestHost.hostname)
    && requestOrigin.protocol === 'http:'
    && requestOrigin.hostname === requestHost.hostname
    && requestOrigin.port === requestHost.port,
  );

  if (!exactAllowed && !matchesLocalRequestHost) {
    res.status(403).json({ error: 'Request origin is not allowed.' });
    return;
  }
  next();
}

module.exports = { requireSameOrigin };
