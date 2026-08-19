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
  const { name, icon, color, description } = req.body;
  if (!name) return fail(res, 'name is required');
  try {
    const category = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        'insert into categories (name, icon, color, description) values ($1, $2, $3, $4) returning *',
        [name, icon || null, color || null, description || null]
      );
      return rows[0];
    });
    return ok(res, category, 201);
  } catch (err) {
    return fail(res, err.message);
  }
});

router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { name, icon, color, description } = req.body;
  try {
    const category = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        'update categories set name = $2, icon = $3, color = $4, description = $5 where id = $1 returning *',
        [req.params.id, name, icon, color, description]
      );
      return rows[0] || null;
    });
    if (!category) return fail(res, 'Category not found', 404);
    return ok(res, category);
  } catch (err) {
    return fail(res, err.message);
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
