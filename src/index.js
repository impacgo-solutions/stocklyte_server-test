'use strict';
require('dotenv').config();

// Validate required env vars at startup — fail fast with a clear message.
const REQUIRED_ENV = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY',
  'DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[startup] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const { pool } = require('./utils/db');
const { startTrialExpiryCron } = require('./utils/trialExpiryCron');

const app = express();
const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });

// Deployed behind a reverse proxy/load balancer (Render, Railway, Heroku, nginx, etc.),
// Express otherwise sees the proxy's IP for every request — breaking per-client rate
// limiting and audit-adjacent logging. TRUST_PROXY lets the operator match their actual
// hop count; 1 is correct for the common single-proxy PaaS setup.
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// ── Security & Middleware ──────────────────────────────────
// Both Flutter web apps (Tenant, Super Admin) run on their own origin/port and call this
// API cross-origin — the `cors` package was already a dependency but was never actually
// wired up, so every browser-based request (including the login preflight) was silently
// blocked by the browser itself. CORS_ORIGIN is a comma-separated allowlist so multiple
// local dev ports / deployed frontend domains can be configured without a code change.
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({
  origin: corsOrigins.length > 0 ? corsOrigins : true,
  credentials: true,
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Idempotency-Key'],
}));
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later' }
}));

// ── Request Logger ─────────────────────────────────────────
app.use((req, _res, next) => {
  if (process.env.NODE_ENV !== 'test') {
    logger.debug({ method: req.method, url: req.url });
  }
  next();
});

// ── Health Check ───────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── API Routes ─────────────────────────────────────────────
const V1 = '/api/v1';
app.use(`${V1}/auth`, require('./routes/auth'));
app.use(`${V1}/admin`, require('./routes/admin'));
app.use(`${V1}/team`, require('./routes/team'));
app.use(`${V1}/locations`, require('./routes/locations'));
app.use(`${V1}/clusters`, require('./routes/clusters'));
app.use(`${V1}/cluster-relationships`, require('./routes/clusterRelationships'));
app.use(`${V1}/racks`, require('./routes/racks'));
app.use(`${V1}/bins`, require('./routes/bins'));
app.use(`${V1}/routing-rules`, require('./routes/routingRules'));
app.use(`${V1}/product-requests`, require('./routes/productRequests'));
app.use(`${V1}/categories`, require('./routes/categories'));
app.use(`${V1}/products`, require('./routes/products'));
app.use(`${V1}/stock`, require('./routes/stock'));
app.use(`${V1}/transfers`, require('./routes/transfers'));
app.use(`${V1}/transactions`, require('./routes/transactions'));
app.use(`${V1}/reports`, require('./routes/reports'));
app.use(`${V1}/predictions`, require('./routes/predictions'));
app.use(`${V1}/audit`, require('./routes/audit'));
app.use(`${V1}/notifications`, require('./routes/notifications'));

// ── 404 Handler ────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, error: 'Route not found' }));

// ── Global Error Handler ───────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error(err);
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => logger.info(`Vaultiq API running on port ${PORT}`));
// DISABLE_TRIAL_CRON lets a local instance pointed at the real database skip the daily
// reminder/expiry email job, so it doesn't fire duplicate customer emails alongside
// whatever production instance already runs this cron. Unset in every real deployment.
if (process.env.DISABLE_TRIAL_CRON === 'true') {
  logger.warn('DISABLE_TRIAL_CRON set — skipping trial expiry cron on this instance.');
} else {
  startTrialExpiryCron();
}

// ── Fail loudly, exit cleanly ────────────────────────────────
// An uncaught error anywhere left the process silently running in an unknown state
// otherwise. Log it and let the host's process manager (Render/Railway/PM2/systemd)
// restart us clean, rather than limp along.
process.on('unhandledRejection', (err) => {
  logger.error(err, 'Unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error(err, 'Uncaught exception');
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────
// Stop accepting new connections, let in-flight requests finish, then close the DB
// pool — so a platform-issued SIGTERM (deploy, scale-down) doesn't cut requests off
// mid-flight or leak connections.
function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
