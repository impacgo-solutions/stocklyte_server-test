'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool, withTenant } = require('../utils/db');
const { resolveSession } = require('../utils/resolveSession');
const { getCompanySubscription } = require('../utils/subscription');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { generateUniqueSchemaName, createTenantSchema } = require('../utils/tenantProvisioning');
const authenticate = require('../middleware/auth');
const { ok, fail, stripSensitive } = require('../utils/response');
const { sendSignupNotification } = require('../utils/notifyEmail');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, please try again later' }
});

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, please try again later' }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /auth/login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return fail(res, 'Email and password are required');

  const normalizedEmail = email.trim().toLowerCase();

  // Check super admin
  const { rows: saRows } = await pool.query(
    'select * from public.super_admins where email = $1 and is_active = true',
    [normalizedEmail]
  );
  if (saRows.length > 0) {
    const sa = saRows[0];
    const match = await bcrypt.compare(password, sa.password_hash);
    if (!match) return fail(res, 'Invalid email or password', 401);
    const tokenPayload = { sub: sa.id, role: 'super_admin' };
    return ok(res, {
      access_token: signAccessToken({ ...tokenPayload, email: sa.email }),
      refresh_token: signRefreshToken(tokenPayload),
      user: { id: sa.id, email: sa.email, profile: stripSensitive({ ...sa, role: 'super_admin' }) },
    });
  }

  // Check tenant user via index
  const { rows: indexRows } = await pool.query(
    'select user_id, schema_name from public.tenant_user_index where email = $1',
    [normalizedEmail]
  );
  if (indexRows.length === 0) return fail(res, 'Invalid email or password', 401);

  const { user_id, schema_name } = indexRows[0];

  const profile = await withTenant(schema_name, async (client) => {
    const { rows } = await client.query(
      'select * from admin_users where id = $1 and is_active = true',
      [user_id]
    );
    return rows[0] || null;
  });
  if (!profile) return fail(res, 'Your account is inactive. Contact your administrator.', 401);

  const match = await bcrypt.compare(password, profile.password_hash);
  if (!match) return fail(res, 'Invalid email or password', 401);

  const subscription = await getCompanySubscription(schema_name);
  const tokenPayload = {
    sub: user_id,
    role: profile.role,
    tenant_schema: schema_name,
    location_id: profile.location_id || undefined,
  };

  return ok(res, {
    access_token: signAccessToken({ ...tokenPayload, email: profile.email }),
    refresh_token: signRefreshToken(tokenPayload),
    user: {
      id: user_id,
      email: profile.email,
      profile: stripSensitive({
        ...profile,
        subscription_status: subscription?.subscription_status || null,
        trial_ends_at: subscription?.trial_ends_at || null,
      }),
    },
  });
});

// POST /auth/logout — stateless JWTs, client discards the token
router.post('/logout', authenticate, async (_req, res) => {
  return ok(res, { message: 'Logged out successfully' });
});

// GET /auth/me
router.get('/me', authenticate, async (req, res) => {
  if (req.user.role === 'super_admin') {
    const { rows } = await pool.query('select * from public.super_admins where id = $1', [req.user.id]);
    if (rows.length === 0) return fail(res, 'Account not found', 404);
    return ok(res, stripSensitive({ ...rows[0], role: 'super_admin' }));
  }

  const profile = await withTenant(req.user.tenant_schema, async (client) => {
    const { rows } = await client.query('select * from admin_users where id = $1', [req.user.id]);
    return rows[0] || null;
  });
  if (!profile) return fail(res, 'Account not found', 404);

  const subscription = await getCompanySubscription(req.user.tenant_schema);
  return ok(res, stripSensitive({
    ...profile,
    email: req.user.email,
    subscription_status: subscription?.subscription_status || null,
    trial_ends_at: subscription?.trial_ends_at || null,
  }));
});

// POST /auth/refresh
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return fail(res, 'refresh_token required');

  let decoded;
  try {
    decoded = verifyRefreshToken(refresh_token);
  } catch {
    return fail(res, 'Invalid or expired refresh token', 401);
  }

  let session;
  try {
    session = await resolveSession(decoded.sub);
  } catch (err) {
    return fail(res, err.message, 401);
  }

  return ok(res, {
    access_token: signAccessToken(session.tokenPayload),
    refresh_token: signRefreshToken(session.tokenPayload),
  });
});

// POST /auth/signup — self-service trial signup
router.post('/signup', signupLimiter, async (req, res) => {
  const { first_name, last_name, email, phone, organization_name, password } = req.body;

  if (!first_name || !String(first_name).trim()) return fail(res, 'first_name is required');
  if (!organization_name || !String(organization_name).trim()) return fail(res, 'organization_name is required');
  if (!email || !EMAIL_RE.test(email)) return fail(res, 'A valid email address is required');
  if (!password || password.length < 6) return fail(res, 'Password must be at least 6 characters');

  const normalizedEmail = email.trim().toLowerCase();
  const fullName = [first_name, last_name].filter(Boolean).map((p) => String(p).trim()).join(' ');

  const { rows: existing } = await pool.query(
    'select 1 from public.tenant_user_index where email = $1',
    [normalizedEmail]
  );
  if (existing.length > 0) return fail(res, 'An account with this email already exists.', 409);

  const schemaName = await generateUniqueSchemaName(pool, organization_name.trim());
  const userId = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    await createTenantSchema(schemaName);
  } catch (err) {
    return fail(res, `Failed to provision account: ${err.message}`);
  }

  let companyCreated = false;
  try {
    await pool.query(
      'insert into public.companies (name, schema_name) values ($1, $2)',
      [organization_name.trim(), schemaName]
    );
    companyCreated = true;

    const adminProfile = await withTenant(schemaName, async (client) => {
      const { rows } = await client.query(
        `insert into admin_users (id, email, full_name, phone, role, password_hash)
         values ($1, $2, $3, $4, 'admin', $5) returning *`,
        [userId, normalizedEmail, fullName, phone ? String(phone).trim() : null, passwordHash]
      );
      return rows[0];
    });

    await pool.query(
      'insert into public.tenant_user_index (user_id, schema_name, email) values ($1, $2, $3)',
      [userId, schemaName, normalizedEmail]
    );

    sendSignupNotification({ first_name, last_name, email: normalizedEmail, phone, organization_name, req });

    return ok(res, stripSensitive({ ...adminProfile, company: { name: organization_name.trim(), schema_name: schemaName } }), 201);
  } catch (err) {
    if (companyCreated) {
      await pool.query('delete from public.companies where schema_name = $1', [schemaName]).catch(() => {});
    }
    await pool.query(`drop schema if exists "${schemaName}" cascade`).catch(() => {});
    return fail(res, err.message, err.status || 400);
  }
});

// POST /auth/forgot-password — placeholder
router.post('/forgot-password', authLimiter, async (_req, res) => {
  return ok(res, { message: 'If an account exists for that email, a reset link will be sent.' });
});

module.exports = router;
