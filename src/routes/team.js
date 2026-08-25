'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool, withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole } = require('../middleware/roleCheck');
const { ok, fail, stripSensitive, stripSensitiveList } = require('../utils/response');

// Lets a Company Admin create and list Employees inside their own tenant schema.
// Not reachable by super_admin (no tenant_schema on that token) or by employees
// themselves (requireRole('admin')).
router.use(authenticate, checkSubscription, requireRole('admin'));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-\s()]{7,20}$/;
const EMPLOYEE_ROLES = ['manager', 'staff', 'viewer'];

// The reporting hierarchy is automatic and warehouse-aware: a Manager always
// reports to a Tenant Admin (location is irrelevant — there's one admin tier
// per tenant), while Staff must report to a Manager assigned to that same
// warehouse/location (never a manager from a different warehouse). Viewers
// have no hierarchy requirement — reports_to is only meaningful for the
// Transfer Management approval routing, which only ever escalates through
// Manager -> Admin.
// Throws a 400 if `reportsTo` is set but doesn't satisfy the rule for
// (role, locationId); a no-op if `reportsTo` is null/undefined.
async function assertValidReportsTo(client, { reportsTo, role, locationId, selfId }) {
  if (!reportsTo) return;
  if (reportsTo === selfId) {
    throw Object.assign(new Error('A person cannot report to themselves'), { status: 400 });
  }

  const { rows } = await client.query(
    'select id, role, location_id from admin_users where id = $1 and is_active = true',
    [reportsTo]
  );
  const approver = rows[0];
  if (!approver) {
    throw Object.assign(new Error('reportsTo must be an existing, active team member'), { status: 400 });
  }

  if (role === 'manager') {
    if (approver.role !== 'admin') {
      throw Object.assign(new Error('A Manager must report to a Tenant Admin'), { status: 400 });
    }
  } else if (role === 'staff') {
    if (approver.role !== 'manager') {
      throw Object.assign(new Error('Staff must report to a Manager'), { status: 400 });
    }
    if (approver.location_id !== locationId) {
      throw Object.assign(new Error('Staff must report to a Manager at the same warehouse/location'), { status: 400 });
    }
  }
  // 'viewer' (and anyone reporting to a viewer, which the above already
  // rules out since a viewer is never a valid approver.role) — no constraint.
}

// GET /team
router.get('/', async (req, res) => {
  const members = await withTenant(req.user.tenant_schema, async (client) => {
    const { rows } = await client.query('select * from admin_users order by created_at');
    return rows;
  });
  return ok(res, stripSensitiveList(members));
});

// POST /team — creates an Employee (never another 'admin') in the caller's tenant schema.
router.post('/', async (req, res) => {
  const { fullName, email, phone, password, confirmPassword, role, locationId, reportsTo } = req.body;

  if (!fullName || !email || !phone || !password || !confirmPassword || !role) {
    return fail(res, 'fullName, email, phone, password, confirmPassword and role are required');
  }
  if (!EMPLOYEE_ROLES.includes(role)) return fail(res, `role must be one of: ${EMPLOYEE_ROLES.join(', ')}`);
  if (password !== confirmPassword) return fail(res, 'Passwords do not match');
  if (password.length < 8) return fail(res, 'Password must be at least 8 characters');
  if (!EMAIL_RE.test(email)) return fail(res, 'A valid email address is required');
  if (!PHONE_RE.test(phone)) return fail(res, 'A valid phone number is required');

  try {
    const { rows: dup } = await pool.query(
      'select 1 from public.tenant_user_index where email = $1',
      [email.trim().toLowerCase()]
    );
    if (dup.length > 0) return fail(res, 'An account with this email already exists.', 409);

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    const employee = await withTenant(req.user.tenant_schema, async (client) => {
      // A Manager with no explicit reportsTo auto-resolves to the tenant's
      // sole Admin when there's exactly one — the common case — rather than
      // leaving the hierarchy unset. With more than one Admin, the caller
      // must pick which one explicitly (nothing to safely guess).
      let resolvedReportsTo = reportsTo || null;
      if (!resolvedReportsTo && role === 'manager') {
        const { rows: admins } = await client.query(
          `select id from admin_users where role = 'admin' and is_active = true`
        );
        if (admins.length === 1) resolvedReportsTo = admins[0].id;
      }

      await assertValidReportsTo(client, {
        reportsTo: resolvedReportsTo,
        role,
        locationId: locationId || null,
        selfId: null,
      });

      const { rows } = await client.query(
        `insert into admin_users (id, email, full_name, phone, role, location_id, reports_to, password_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [userId, email.trim().toLowerCase(), fullName, phone, role, locationId || null, resolvedReportsTo, passwordHash]
      );
      return rows[0];
    });

    await pool.query(
      'insert into public.tenant_user_index (user_id, schema_name, email) values ($1, $2, $3)',
      [userId, req.user.tenant_schema, email.trim().toLowerCase()]
    );

    return ok(res, stripSensitive(employee), 201);
  } catch (err) {
    return fail(res, err.message);
  }
});

// PUT /team/:id — updates an existing Employee's role, location, reporting
// line, and/or active flag. Deliberately excludes email/password (this is a
// narrow management endpoint, not a general profile editor) and can never
// promote anyone to 'admin'. Primarily needed so an admin can wire up the
// reports_to hierarchy the Transfer Management approval workflow relies on
// for people who already exist (created before that concept did).
router.put('/:id', async (req, res) => {
  const { role, locationId, reportsTo, isActive } = req.body;

  if (role !== undefined && !EMPLOYEE_ROLES.includes(role)) {
    return fail(res, `role must be one of: ${EMPLOYEE_ROLES.join(', ')}`);
  }

  try {
    const updated = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows: existingRows } = await client.query('select * from admin_users where id = $1', [req.params.id]);
      const existing = existingRows[0];
      if (!existing) throw Object.assign(new Error('Team member not found'), { status: 404 });
      if (existing.role === 'admin') throw Object.assign(new Error('Cannot edit an admin account here'), { status: 400 });

      // Validate reportsTo against the resulting role/location — a single
      // PUT can change role and/or location and reportsTo together, so the
      // hierarchy check must use the post-update values, not the stale row.
      if (reportsTo !== undefined) {
        const finalRole = role || existing.role;
        const finalLocationId = locationId !== undefined ? (locationId || null) : existing.location_id;
        await assertValidReportsTo(client, {
          reportsTo,
          role: finalRole,
          locationId: finalLocationId,
          selfId: req.params.id,
        });
      }

      const { rows } = await client.query(
        `update admin_users set
           role = coalesce($2, role),
           location_id = case when $3::boolean then $4::uuid else location_id end,
           reports_to = case when $5::boolean then $6::uuid else reports_to end,
           is_active = coalesce($7, is_active)
         where id = $1
         returning *`,
        [
          req.params.id,
          role || null,
          locationId !== undefined, locationId || null,
          reportsTo !== undefined, reportsTo || null,
          isActive === undefined ? null : Boolean(isActive),
        ]
      );
      return rows[0];
    });
    return ok(res, stripSensitive(updated));
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

module.exports = router;
