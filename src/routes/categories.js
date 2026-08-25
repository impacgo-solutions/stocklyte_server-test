'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole } = require('../middleware/roleCheck');
const { ok, fail } = require('../utils/response');

router.use(authenticate, checkSubscription);

router.get('/', async (req, res) => {
  try {
    const categories = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query('select * from categories order by name');
      return rows;
    });
    return ok(res, categories);
  } catch (err) {
    return fail(res, err.message);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const category = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query('select * from categories where id = $1', [req.params.id]);
      return rows[0] || null;
    });
    if (!category) return fail(res, 'Category not found', 404);
    return ok(res, category);
  } catch (err) {
    return fail(res, err.message, 404);
  }
});

router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  const { name, icon, color, description, is_active } = req.body;
  if (!name) return fail(res, 'name is required');
  try {
    const category = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows: dupe } = await client.query('select id from categories where lower(name) = lower($1)', [name]);
      if (dupe.length) throw Object.assign(new Error('A category with this name already exists'), { status: 409 });

      const { rows } = await client.query(
        'insert into categories (name, icon, color, description, is_active) values ($1, $2, $3, $4, $5) returning *',
        [name, icon || null, color || null, description || null, is_active === undefined ? true : (is_active === true || is_active === 'true')]
      );
      return rows[0];
    });
    return ok(res, category, 201);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { name, icon, color, description, is_active } = req.body;
  try {
    const category = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      if (name) {
        const { rows: dupe } = await client.query(
          'select id from categories where lower(name) = lower($1) and id <> $2',
          [name, req.params.id]
        );
        if (dupe.length) throw Object.assign(new Error('A category with this name already exists'), { status: 409 });
      }

      // is_active is tri-state (leave unchanged when omitted / set explicitly
      // otherwise), same convention as racks.capacity / products.is_active.
      const isActiveProvided = is_active !== undefined;

      const { rows } = await client.query(
        `update categories set
           name = coalesce($2, name),
           icon = coalesce($3, icon),
           color = coalesce($4, color),
           description = coalesce($5, description),
           is_active = case when $6 then $7 else is_active end
         where id = $1 returning *`,
        [
          req.params.id,
          name ?? null,
          icon ?? null,
          color ?? null,
          description ?? null,
          isActiveProvided,
          isActiveProvided ? (is_active === true || is_active === 'true') : null,
        ]
      );
      return rows[0] || null;
    });
    if (!category) return fail(res, 'Category not found', 404);
    return ok(res, category);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      await client.query('delete from categories where id = $1', [req.params.id]);
    });
    return ok(res, { deleted: true });
  } catch (err) {
    // FK violation — products still reference this category
    if (err.code === '23503') {
      return fail(res, 'Cannot delete category because products are assigned to it. Re-assign or archive those products first.', 409);
    }
    return fail(res, err.message);
  }
});

module.exports = router;
