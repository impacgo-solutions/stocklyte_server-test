'use strict';
const router = require('express').Router();
const { supabase } = require('../utils/supabase');
const { pool, withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole } = require('../middleware/roleCheck');
const { ok, fail } = require('../utils/response');

// Lets a Company Admin create and list Employees inside their own tenant schema.
// Not reachable by super_admin (no tenant_schema on that token) or by employees
// themselves (requireRole('admin')).
router.use(authenticate, checkSubscription, requireRole('admin'));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-\s()]{7,20}$/;
const EMPLOYEE_ROLES = ['manager', 'staff', 'viewer'];

// GET /team
router.get('/', async (req, res) => {
  const members = await withTenant(req.user.tenant_schema, async (client) => {
    const { rows } = await client.query('select * from admin_users order by created_at');
    return rows;
  });
  return ok(res, members);
});

// POST /team — creates an Employee (never another 'admin') in the caller's tenant schema.
router.post('/', async (req, res) => {
  const { fullName, email, phone, password, confirmPassword, role, locationId } = req.body;

  if (!fullName || !email || !phone || !password || !confirmPassword || !role) {
    return fail(res, 'fullName, email, phone, password, confirmPassword and role are required');
  }
  if (!EMPLOYEE_ROLES.includes(role)) return fail(res, `role must be one of: ${EMPLOYEE_ROLES.join(', ')}`);
  if (password !== confirmPassword) return fail(res, 'Passwords do not match');
  if (password.length < 8) return fail(res, 'Password must be at least 8 characters');
  if (!EMAIL_RE.test(email)) return fail(res, 'A valid email address is required');
  if (!PHONE_RE.test(phone)) return fail(res, 'A valid phone number is required');

  let authUserId;
  try {
    const { data: created, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (authError) throw new Error(authError.message);
    authUserId = created.user.id;

    const employee = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `insert into admin_users (id, email, full_name, phone, role, location_id)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [authUserId, email, fullName, phone, role, locationId || null]
      );
      return rows[0];
    });

    await pool.query(
      'insert into public.tenant_user_index (user_id, schema_name) values ($1, $2)',
      [authUserId, req.user.tenant_schema]
    );

    return ok(res, employee, 201);
  } catch (err) {
    if (authUserId) {
      await supabase.auth.admin.deleteUser(authUserId).catch(() => {});
    }
    return fail(res, err.message);
  }
});

module.exports = router;
