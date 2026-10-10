require('dotenv').config();

const MongoStore = require('connect-mongo');
const express = require('express');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const helmet = require('helmet');
const mongoose = require('mongoose');
const path = require('node:path');
const { loadConfig } = require('../config');
const { connectDatabase } = require('../database/connect');
const logger = require('../utils/logger');
const { getDashboardErrorResponse, getDashboardErrorStatus, getValidationDetails } = require('./errors');
const { router: authRouter } = require('./auth');
const guildRoutes = require('./routes/guilds');
const { router: serverRoutes } = require('./routes/servers');
const pageRoutes = require('./routes/pages');

function createDashboardApp(config) {
  if (!config.clientSecret) throw new Error('DISCORD_CLIENT_SECRET is required to start the dashboard.');
  const app = express();
  app.locals.config = config;
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { imgSrc: ["'self'", 'data:', 'https:'] },
    },
  }));
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use(session({
    name: 'infinitx.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: config.mongoUri, collectionName: 'dashboard_sessions' }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }));
  app.use('/assets', express.static(path.join(__dirname, 'public'), {
    fallthrough: false,
    index: false,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  }));
  app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
  app.use('/auth', authRouter);
  app.use('/api/guilds', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }), guildRoutes);
  app.use('/api/servers', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }), serverRoutes);
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/', pageRoutes);
  app.use((error, req, res, next) => {
    const status = getDashboardErrorStatus(error);
    logger.error('Dashboard request failed', {
      method: req.method,
      path: req.originalUrl,
      userId: req.session?.user?.id,
      guildId: req.guildId || req.params?.guildId,
      errorName: error.name,
      error: error.message,
      code: error.code,
      status,
      validationErrors: getValidationDetails(error),
      stack: error.stack,
    });
    if (res.headersSent) return next(error);
    res.status(status).json(getDashboardErrorResponse(error, status));
  });
  return app;
}

async function startDashboard() {
  const config = loadConfig();
  if (!config.clientSecret) throw new Error('DISCORD_CLIENT_SECRET is required to start the dashboard.');
  await connectDatabase(config.mongoUri);
  const app = createDashboardApp(config);

  const server = app.listen(config.dashboardPort, () => {
    logger.info(`Dashboard API listening on port ${config.dashboardPort}`);
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close((error) => {
      if (error) {
        logger.error('Dashboard HTTP server shutdown failed', { error: error.message });
        process.exitCode = 1;
      }
      mongoose.disconnect().catch((disconnectError) => {
        logger.error('Dashboard MongoDB disconnect failed', { error: disconnectError.message });
        process.exitCode = 1;
      });
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  startDashboard().catch((error) => {
    logger.error('Dashboard startup failed', { error: error.message });
    process.exitCode = 1;
  });
}

module.exports = { createDashboardApp, startDashboard };
