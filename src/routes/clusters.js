'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole } = require('../middleware/roleCheck');
const { ok, fail } = require('../utils/response');

router.use(authenticate, checkSubscription);

// GET /clusters — includes each cluster's location count for the Manage
// Locations screen's cluster picker / summary.
router.get('/', async (req, res) => {
  try {
    const clusters = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query(
        `select c.*, coalesce(l.location_count, 0)::int as location_count
         from clusters c
         left join (select cluster_id, count(*) as location_count from locations where cluster_id is not null group by cluster_id) l
           on l.cluster_id = c.id
         order by c.name`
      );
      return rows;
    });
    return ok(res, clusters);
  } catch (err) {
    return fail(res, err.message);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const cluster = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query('select * from clusters where id = $1', [req.params.id]);
      return rows[0] || null;
    });
    if (!cluster) return fail(res, 'Cluster not found', 404);
    return ok(res, cluster);
  } catch (err) {
    return fail(res, err.message, 404);
  }
});

router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return fail(res, 'name is required');
  try {
    const cluster = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        'insert into clusters (name, description) values ($1, $2) returning *',
        [name, description || null]
      );
      return rows[0];
    });
    return ok(res, cluster, 201);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'A cluster with this name already exists');
    return fail(res, err.message);
  }
});

router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { name, description, is_active } = req.body;
  try {
    const cluster = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `update clusters set
           name = coalesce($2, name),
           description = coalesce($3, description),
           is_active = coalesce($4, is_active)
         where id = $1 returning *`,
        [req.params.id, name ?? null, description ?? null, is_active === undefined ? null : (is_active === true || is_active === 'true')]
      );
      return rows[0] || null;
    });
    if (!cluster) return fail(res, 'Cluster not found', 404);
    return ok(res, cluster);
  } catch (err) {
    return fail(res, err.message);
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      await client.query('delete from clusters where id = $1', [req.params.id]);
    });
    return ok(res, { deleted: true });
  } catch (err) {
    if (err.code === '23503') {
      return fail(res, 'Cannot delete cluster because locations are still assigned to it. Re-assign those locations first.', 409);
    }
    return fail(res, err.message);
  }
});

module.exports = router;
