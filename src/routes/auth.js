'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { supabase } = require('../utils/supabase');
const { pool, withTenant } = require('../utils/db');
const { resolveSession } = require('../utils/resolveSession');
const { getCompanySubscription } = require('../utils/subscription');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { generateUniqueSchemaName, createTenantSchema } = require('../utils/tenantProvisioning');
const authenticate = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const { sendSignupNotification } = require('../utils/notifyEmail');

// Stricter rate limit for sensitive auth endpoints — much more generous outside
// production so local dev/testing doesn't get locked out after a handful of tries.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, please try again later' }
});

// Schema provisioning is expensive (creates a whole Postgres schema), so self-signup
// gets its own tighter limiter rather than sharing authLimiter with /login.
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, please try again later' }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /auth/login — same endpoint for super admins, Company Admins and Employees.
// Supabase Auth verifies the password; we then resolve which tenant schema (if any)
// this user belongs to and mint our own JWT carrying that schema.
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return fail(res, 'Email and password are required');

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return fail(res, error.message, 401);

  let session;
  try {
    session = await resolveSession(data.user.id);
  } catch (err) {
    return fail(res, err.message, 401);
  }

  const access_token = signAccessToken({ ...session.tokenPayload, email: data.user.email });
  const refresh_token = signRefreshToken(session.tokenPayload);

  return ok(res, {
    access_token,
    refresh_token,
    user: { id: data.user.id, email: data.user.email, profile: { ...session.profile, email: data.user.email } }
  });
});

// POST /auth/logout — our JWTs are stateless (no server-side session to revoke); the
// client just discards its stored token.
router.post('/logout', authenticate, async (_req, res) => {
  return ok(res, { message: 'Logged out successfully' });
});

// GET /auth/me
router.get('/me', authenticate, async (req, res) => {
  if (req.user.role === 'super_admin') {
    const { rows } = await pool.query('select * from public.super_admins where id = $1', [req.user.id]);
    if (rows.length === 0) return fail(res, 'Account not found', 404);
    return ok(res, { ...rows[0], role: 'super_admin' });
  }

  const profile = await withTenant(req.user.tenant_schema, async (client) => {
    const { rows } = await client.query('select * from admin_users where id = $1', [req.user.id]);
    return rows[0] || null;
  });
  if (!profile) return fail(res, 'Account not found', 404);

  const subscription = await getCompanySubscription(req.user.tenant_schema);
  return ok(res, {
    ...profile,
    email: req.user.email,
    subscription_status: subscription?.subscription_status || null,
    trial_ends_at: subscription?.trial_ends_at || null,
  });
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

  const access_token = signAccessToken(session.tokenPayload);
  const new_refresh_token = signRefreshToken(session.tokenPayload);
  return ok(res, { access_token, refresh_token: new_refresh_token });
});

// POST /auth/signup — public self-service signup for the marketing-site trial flow.
// Mirrors POST /admin/companies + POST /admin/companies/:schemaName/admins (same
// clone-from-`template` schema provisioning, same admin_users/tenant_user_index rows)
// but as a single unauthenticated call that provisions the org and its first Company
// Admin (role 'admin') together — no table/schema changes, just a new entry point into
// the existing flow.
router.post('/signup', signupLimiter, async (req, res) => {
  const { first_name, last_name, email, phone, organization_name, password } = req.body;

  if (!first_name || !String(first_name).trim()) return fail(res, 'first_name is required');
  if (!organization_name || !String(organization_name).trim()) return fail(res, 'organization_name is required');
  if (!email || !EMAIL_RE.test(email)) return fail(res, 'A valid email address is required');
  if (!password || password.length < 8) return fail(res, 'Password must be at least 8 characters');

  const normalizedEmail = email.trim().toLowerCase();
  const fullName = [first_name, last_name]
    .filter(Boolean)
    .map((part) => String(part).trim())
    .join(' ');

  const schemaName = await generateUniqueSchemaName(pool, organization_name.trim());

  try {
    await createTenantSchema(schemaName);
  } catch (err) {
    return fail(res, `Failed to provision account: ${err.message}`);
  }

  let companyCreated = false;
  let authUserId;
  try {
    await pool.query(
      `insert into public.companies (name, schema_name) values ($1, $2)`,
      [organization_name.trim(), schemaName]
    );
    companyCreated = true;

    const { data: created, error: authError } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
    });
    if (authError) {
      const isDuplicate = authError.code === 'email_exists' || /already been registered|already exists/i.test(authError.message);
      throw Object.assign(new Error(isDuplicate ? 'An account with this email already exists.' : authError.message), {
        status: isDuplicate ? 409 : 400,
      });
    }
    authUserId = created.user.id;

    const adminProfile = await withTenant(schemaName, async (client) => {
      const { rows } = await client.query(
        `insert into admin_users (id, email, full_name, phone, role) values ($1, $2, $3, $4, 'admin') returning *`,
        [authUserId, normalizedEmail, fullName, phone ? String(phone).trim() : null]
      );
      return rows[0];
    });

    await pool.query(
      'insert into public.tenant_user_index (user_id, schema_name) values ($1, $2)',
      [authUserId, schemaName]
    );
    sendSignupNotification({ first_name, last_name, email: normalizedEmail, phone, organization_name, req });

    return ok(res, { ...adminProfile, company: { name: organization_name.trim(), schema_name: schemaName } }, 201);
  } catch (err) {
    if (authUserId) {
      await supabase.auth.admin.deleteUser(authUserId).catch(() => {});
    }
    if (companyCreated) {
      await pool.query('delete from public.companies where schema_name = $1', [schemaName]).catch(() => {});
    }
    // Cascades away any admin_users row already inserted before the failure.
    await pool.query(`drop schema if exists "${schemaName}" cascade`).catch(() => {});
    return fail(res, err.message, err.status || 400);
  }
});

// POST /auth/forgot-password — unaffected by tenant-schema routing, still a plain
// Supabase Auth feature.
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail(res, 'A valid email address is required');
  }
  const redirectTo = process.env.PASSWORD_RESET_REDIRECT_URL;
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    ...(redirectTo ? { redirectTo } : {}),
  });
  if (error) return fail(res, error.message);
  return ok(res, { message: 'Password reset email sent' });
});

module.exports = router;
