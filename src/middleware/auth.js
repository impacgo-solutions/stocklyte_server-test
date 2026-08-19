'use strict';
const { verifyAccessToken } = require('../utils/jwt');
const { fail } = require('../utils/response');

// Verifies our own backend-issued JWT (not a Supabase session token) — it's the only
// place tenant_schema is carried, since Supabase's own JWT has no room for it without
// the Custom Access Token Hook feature we're deliberately not depending on.
module.exports = function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return fail(res, 'Missing or invalid Authorization header', 401);
  }
  const token = authHeader.slice(7);
  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      role: payload.role,
      tenant_schema: payload.tenant_schema || null,
      email: payload.email || null,
      location_id: payload.location_id || null,
    };
    next();
  } catch (err) {
    return fail(res, 'Invalid or expired token', 401);
  }
};
