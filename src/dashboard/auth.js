const crypto = require('node:crypto');
const express = require('express');
const logger = require('../utils/logger');
const { requireSameOrigin } = require('./origin');

const router = express.Router();
const DISCORD_API = 'https://discord.com/api/v10';

function requireOAuthConfig(config) {
  if (!config.clientSecret) {
    throw new Error('DISCORD_CLIENT_SECRET is required to use dashboard OAuth');
  }
}

router.get(['/login', '/discord'], (req, res, next) => {
  try {
    requireOAuthConfig(req.app.locals.config);
    const state = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = state;
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: req.app.locals.config.clientId,
      redirect_uri: req.app.locals.config.redirectUri,
      response_type: 'code',
      scope: 'identify guilds',
      state,
    }).toString();
    res.redirect(url.toString());
  } catch (error) {
    next(error);
  }
});

router.get(['/callback', '/discord/callback'], async (req, res, next) => {
  const { code, state } = req.query;
  if (!code || typeof code !== 'string' || !state || state !== req.session.oauthState) {
    req.session.oauthState = null;
    res.status(400).json({ error: 'Invalid OAuth callback state or code.' });
    return;
  }
  req.session.oauthState = null;

  try {
    const config = req.app.locals.config;
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) {
      logger.warn('Discord OAuth token exchange rejected', { status: tokenResponse.status });
      res.status(401).json({ error: 'Discord authorization failed.' });
      return;
    }
    const token = await tokenResponse.json();
    const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userResponse.ok) {
      res.status(401).json({ error: 'Unable to verify Discord account.' });
      return;
    }
    const user = await userResponse.json();
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
    req.session.accessToken = token.access_token;
    res.redirect(req.app.locals.config.dashboardBaseUrl);
  } catch (error) {
    next(error);
  }
});

router.post('/logout', requireSameOrigin, (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('infinitx.sid');
    res.status(204).end();
  });
});

module.exports = { DISCORD_API, router };
