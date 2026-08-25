'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole } = require('../middleware/roleCheck');
const { ok, fail } = require('../utils/response');

router.use(authenticate, checkSubscription);

const LOCATION_SELECT = `
  select l.*, case when c.id is null then null else jsonb_build_object('id', c.id, 'name', c.name) end as clusters
  from locations l left join clusters c on c.id = l.cluster_id
`;

// GET /locations
router.get('/', async (req, res) => {
  try {
    const locations = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query(`${LOCATION_SELECT} order by l.name`);
      return rows;
    });
    return ok(res, locations);
  } catch (err) {
    return fail(res, err.message);
  }
});

// GET /locations/:id
router.get('/:id', async (req, res) => {
  try {
    const location = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query(`${LOCATION_SELECT} where l.id = $1`, [req.params.id]);
      return rows[0] || null;
    });
    if (!location) return fail(res, 'Location not found', 404);
    return ok(res, location);
  } catch (err) {
    return fail(res, err.message, 404);
  }
});

// POST /locations — admin only
router.post('/', requireRole('admin'), async (req, res) => {
  const { name, address, cluster_id, latitude, longitude } = req.body;
  if (!name) return fail(res, 'name is required');
  try {
    const location = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        'insert into locations (name, address, cluster_id, latitude, longitude) values ($1, $2, $3, $4, $5) returning *',
        [name, address || null, cluster_id || null, latitude ?? null, longitude ?? null]
      );
      return rows[0];
    });
    return ok(res, location, 201);
  } catch (err) {
    return fail(res, err.message);
  }
});

// PUT /locations/:id — admin only
router.put('/:id', requireRole('admin'), async (req, res) => {
  const { name, address, is_active, cluster_id, latitude, longitude } = req.body;
  try {
    const location = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `update locations set
           name = coalesce($2, name),
           address = coalesce($3, address),
           is_active = coalesce($4, is_active),
           cluster_id = case when $5 then null else coalesce($6, cluster_id) end,
           latitude = coalesce($7, latitude),
           longitude = coalesce($8, longitude)
         where id = $1 returning *`,
        [
          req.params.id,
          name ?? null,
          address ?? null,
          is_active === undefined ? null : (is_active === true || is_active === 'true'),
          cluster_id === null,
          cluster_id ?? null,
          latitude ?? null,
          longitude ?? null,
        ]
      );
      return rows[0] || null;
    });
    if (!location) return fail(res, 'Location not found', 404);
    return ok(res, location);
  } catch (err) {
    return fail(res, err.message);
  }
});

// DELETE /locations/:id — admin only
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      await client.query('delete from locations where id = $1', [req.params.id]);
    });
    return ok(res, { deleted: true });
  } catch (err) {
    // FK violation — stock rows still reference this location
    if (err.code === '23503') {
      return fail(res, 'Cannot delete location because it still has stock. Transfer or remove all stock first.', 409);
    }
    return fail(res, err.message);
  }
});

module.exports = router;
