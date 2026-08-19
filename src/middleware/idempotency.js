'use strict';

// In-memory idempotency cache — keyed by "userId:idempotencyKey".
// TTL: 10 minutes. Prevents duplicate stock operations when a client
// retries after a network timeout where the server already processed the request.
const CACHE = new Map();
const TTL_MS = 10 * 60 * 1000;

// Evict expired entries every 5 minutes regardless of traffic volume.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of CACHE) {
    if (now - v.ts > TTL_MS) CACHE.delete(k);
  }
}, 5 * 60 * 1000).unref();

function idempotency(req, res, next) {
  const key = req.headers['x-idempotency-key'];
  if (!key) return next();

  const userId = req.user?.id || 'anon';
  const cacheKey = `${userId}:${key}`;

  // Return cached response if this key was already processed
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return res.status(cached.status).json(cached.body);
  }

  // Intercept the response so we can cache it
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500) {
      CACHE.set(cacheKey, { status: res.statusCode, body, ts: Date.now() });
    }
    return originalJson(body);
  };

  next();
}

module.exports = idempotency;
