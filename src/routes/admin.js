'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool, withTenant, SCHEMA_NAME_RE } = require('../utils/db');
const { generateUniqueSchemaName, createTenantSchema } = require('../utils/tenantProvisioning');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/roleCheck');
const { ok, fail } = require('../utils/response');

// Only the platform super_admin (created once via supabase/create_admin.js) can reach these routes.
router.use(authenticate, requireRole('super_admin'));

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, please try again later' }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-\s()]{7,20}$/;

function assertKnownSchema(schemaName) {
  if (!SCHEMA_NAME_RE.test(schemaName)) throw Object.assign(new Error('Invalid company'), { status: 400 });
}

// GET /admin/companies — every tenant, with a count of admins already provisioned so the
// admin app can prompt "Add Company Admin" for ones that don't have one yet, plus that
// tenant's first-created admin's name/email for the Admin Management table's ADMIN
// column. Each admin_users table lives inside its own tenant schema (not `public`), so
// this can't be a single cross-schema join — one lightweight per-company lookup instead,
// run in parallel. Fine at super-admin-console scale (tens of tenants, not thousands).
router.get('/companies', async (_req, res) => {
  const { rows } = await pool.query(`
    select c.*, coalesce(t.admin_count, 0)::int as admin_count,
           (c.trial_ends_at::date - current_date) as trial_days_left
    from public.companies c
    left join (
      select schema_name, count(*) as admin_count
      from public.tenant_user_index
      group by schema_name
    ) t on t.schema_name = c.schema_name
    order by c.created_at desc
  `);

  const withPrimaryAdmin = await Promise.all(rows.map(async (company) => {
    try {
      const admin = await withTenant(company.schema_name, async (client) => {
        const { rows: adminRows } = await client.query(
          `select full_name, email from admin_users order by created_at limit 1`
        );
        return adminRows[0] || null;
      });
      return { ...company, admin_name: admin?.full_name || null, admin_email: admin?.email || null };
    } catch {
      return { ...company, admin_name: null, admin_email: null };
    }
  }));

  return ok(res, withPrimaryAdmin);
});

// POST /admin/companies { companyName } — provisions a brand new tenant schema (cloned
// from the `template` schema) and registers it. Does NOT create an admin yet — that's a
// separate call, matching the two-step onboarding flow.
router.post('/companies', createLimiter, async (req, res) => {
  const { companyName } = req.body;
  if (!companyName || !companyName.trim()) return fail(res, 'companyName is required');

  const schemaName = await generateUniqueSchemaName(pool, companyName.trim());

  try {
    await createTenantSchema(schemaName);
  } catch (err) {
    return fail(res, `Failed to provision company schema: ${err.message}`);
  }

  try {
    const { rows } = await pool.query(
      `insert into public.companies (name, schema_name, created_by) values ($1, $2, $3) returning *`,
      [companyName.trim(), schemaName, req.user.id]
    );
    return ok(res, rows[0], 201);
  } catch (err) {
    // Schema was created but the registry row failed — drop the orphaned schema so a
    // retry with the same name doesn't collide.
    await pool.query(`drop schema if exists "${schemaName}" cascade`).catch(() => {});
    return fail(res, err.message);
  }
});

// GET /admin/companies/:schemaName/admins
router.get('/companies/:schemaName/admins', async (req, res) => {
  const { schemaName } = req.params;
  try {
    assertKnownSchema(schemaName);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
  const admins = await withTenant(schemaName, async (client) => {
    const { rows } = await client.query('select * from admin_users order by created_at');
    return rows;
  });
  return ok(res, admins);
});

// POST /admin/companies/:schemaName/admins — creates the Company Admin inside that
// tenant's own admin_users table.
router.post('/companies/:schemaName/admins', createLimiter, async (req, res) => {
  const { schemaName } = req.params;
  const { fullName, email, phone, password, confirmPassword } = req.body;

  try {
    assertKnownSchema(schemaName);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
  if (!fullName || !email || !phone || !password || !confirmPassword) {
    return fail(res, 'fullName, email, phone, password and confirmPassword are required');
  }
  if (password !== confirmPassword) return fail(res, 'Passwords do not match');
  if (password.length < 8) return fail(res, 'Password must be at least 8 characters');
  if (!EMAIL_RE.test(email)) return fail(res, 'A valid email address is required');
  if (!PHONE_RE.test(phone)) return fail(res, 'A valid phone number is required');

  const { rows: companyRows } = await pool.query('select 1 from public.companies where schema_name = $1', [schemaName]);
  if (companyRows.length === 0) return fail(res, 'Unknown company', 404);

  try {
    const { rows: dup } = await pool.query(
      'select 1 from public.tenant_user_index where email = $1',
      [email.trim().toLowerCase()]
    );
    if (dup.length > 0) return fail(res, 'An account with this email already exists.', 409);

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    const adminProfile = await withTenant(schemaName, async (client) => {
      const { rows } = await client.query(
        `insert into admin_users (id, email, full_name, phone, role, password_hash)
         values ($1, $2, $3, $4, 'admin', $5) returning *`,
        [userId, email.trim().toLowerCase(), fullName, phone, passwordHash]
      );
      return rows[0];
    });

    await pool.query(
      'insert into public.tenant_user_index (user_id, schema_name, email) values ($1, $2, $3)',
      [userId, schemaName, email.trim().toLowerCase()]
    );

    return ok(res, adminProfile, 201);
  } catch (err) {
    return fail(res, err.message);
  }
});

const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'expired', 'cancelled'];

// PATCH /admin/companies/:schemaName/subscription { subscription_status?, trial_ends_at? }
// Manual resume/adjust lever for the platform team — there is no payment gateway
// integrated yet, so once a tenant's 15-day trial expires and they've paid outside the
// app, a super_admin calls this to flip them back to 'active' (or extend the trial).
router.patch('/companies/:schemaName/subscription', async (req, res) => {
  const { schemaName } = req.params;
  const { subscription_status, trial_ends_at } = req.body;

  try {
    assertKnownSchema(schemaName);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
  if (subscription_status && !SUBSCRIPTION_STATUSES.includes(subscription_status)) {
    return fail(res, `subscription_status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}`);
  }
  if (trial_ends_at && Number.isNaN(Date.parse(trial_ends_at))) {
    return fail(res, 'trial_ends_at must be a valid date');
  }

  const fields = [];
  const values = [];
  if (subscription_status) {
    values.push(subscription_status);
    fields.push(`subscription_status = $${values.length}`);
  }
  if (trial_ends_at) {
    values.push(trial_ends_at);
    fields.push(`trial_ends_at = $${values.length}`);
  }
  if (fields.length === 0) return fail(res, 'subscription_status or trial_ends_at is required');

  values.push(schemaName);
  const { rows } = await pool.query(
    `update public.companies set ${fields.join(', ')} where schema_name = $${values.length} returning *`,
    values
  );
  if (rows.length === 0) return fail(res, 'Unknown company', 404);
  return ok(res, rows[0]);
});

// POST /admin/companies/:schemaName/extend-trial { days }
// Grants `days` more from whichever is later — now, or the current trial_ends_at — so an
// already-lapsed trial gets `days` from today while a still-running one gets `days` added
// on top rather than wasted. Always puts the tenant back into 'trialing' and clears
// trial_expiry_notified_at so the reminder/expired cron can fire again for the new window.
router.post('/companies/:schemaName/extend-trial', createLimiter, async (req, res) => {
  const { schemaName } = req.params;
  const { days } = req.body;

  try {
    assertKnownSchema(schemaName);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }

  const parsedDays = Number(days);
  if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 365) {
    return fail(res, 'days must be an integer between 1 and 365');
  }

  const { rows } = await pool.query(
    `update public.companies
     set subscription_status = 'trialing',
         trial_ends_at = greatest(now(), trial_ends_at) + ($1 || ' days')::interval,
         trial_expiry_notified_at = null
     where schema_name = $2
     returning *, (trial_ends_at::date - current_date) as trial_days_left`,
    [parsedDays, schemaName]
  );
  if (rows.length === 0) return fail(res, 'Unknown company', 404);
  return ok(res, rows[0]);
});

// POST /admin/companies/:schemaName/suspend — manual kill switch (e.g. abuse, non-payment
// outside the trial window). `isExpired()` already treats 'cancelled' like an expired
// trial, so checkSubscription blocks the tenant on its very next request.
router.post('/companies/:schemaName/suspend', createLimiter, async (req, res) => {
  const { schemaName } = req.params;
  try {
    assertKnownSchema(schemaName);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }

  const { rows } = await pool.query(
    `update public.companies
     set subscription_status = 'cancelled'
     where schema_name = $1
     returning *, (trial_ends_at::date - current_date) as trial_days_left`,
    [schemaName]
  );
  if (rows.length === 0) return fail(res, 'Unknown company', 404);
  return ok(res, rows[0]);
});

// POST /admin/companies/:schemaName/reactivate — restores full (non-trial) access, e.g.
// after a suspended tenant resolves payment/abuse outside the app.
router.post('/companies/:schemaName/reactivate', createLimiter, async (req, res) => {
  const { schemaName } = req.params;
  try {
    assertKnownSchema(schemaName);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }

  const { rows } = await pool.query(
    `update public.companies
     set subscription_status = 'active',
         trial_expiry_notified_at = null
     where schema_name = $1
     returning *, (trial_ends_at::date - current_date) as trial_days_left`,
    [schemaName]
  );
  if (rows.length === 0) return fail(res, 'Unknown company', 404);
  return ok(res, rows[0]);
});

// GET /admin/dashboard/stats — live company/trial health summary for the admin Dashboard.
router.get('/dashboard/stats', async (_req, res) => {
  const { rows: [totals] } = await pool.query(`
    select
      count(*)::int as total,
      count(*) filter (where subscription_status = 'trialing')::int as trialing,
      count(*) filter (where subscription_status = 'active')::int as active,
      count(*) filter (where subscription_status = 'expired')::int as expired,
      count(*) filter (where subscription_status = 'cancelled')::int as cancelled,
      count(*) filter (
        where subscription_status = 'trialing'
          and trial_ends_at is not null
          and trial_ends_at between now() and now() + interval '3 days'
      )::int as expiring_soon
    from public.companies
  `);

  const { rows: recent } = await pool.query(`
    select id, name, schema_name, subscription_status, trial_ends_at, created_at
    from public.companies
    order by created_at desc
    limit 5
  `);

  return ok(res, { ...totals, recent });
});

module.exports = router;
