'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole } = require('../middleware/roleCheck');
const { ok, fail } = require('../utils/response');

// Tenant-configurable escalation priority (per source location). Admin-only —
// this is the "who do we ask next when they reject" business policy.
router.use(authenticate, checkSubscription, requireRole('admin'));

// GET /routing-rules?source_location_id=
router.get('/', async (req, res) => {
  const { source_location_id } = req.query;
  try {
    const rules = await withTenant(req.user.tenant_schema, async (client) => {
      const params = [];
      let where = '';
      if (source_location_id) { params.push(source_location_id); where = 'where rr.source_location_id = $1'; }
      const { rows } = await client.query(
        `select rr.*,
                jsonb_build_object('id', sl.id, 'name', sl.name) as source_location,
                jsonb_build_object('id', tl.id, 'name', tl.name) as target_location
         from location_routing_rules rr
         join locations sl on sl.id = rr.source_location_id
         join locations tl on tl.id = rr.target_location_id
         ${where}
         order by rr.source_location_id, rr.priority`,
        params
      );
      return rows;
    });
    return ok(res, rules);
  } catch (err) {
    return fail(res, err.message);
  }
});

// POST /routing-rules { source_location_id, target_location_id, priority }
router.post('/', async (req, res) => {
  const { source_location_id, target_location_id, priority } = req.body;
  if (!source_location_id || !target_location_id || priority == null) {
    return fail(res, 'source_location_id, target_location_id and priority are required');
  }
  if (source_location_id === target_location_id) return fail(res, 'source and target locations must differ');
  const p = parseInt(priority, 10);
  if (isNaN(p) || p < 1) return fail(res, 'priority must be a positive integer (1 = tried first)');

  try {
    const rule = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        'insert into location_routing_rules (source_location_id, target_location_id, priority) values ($1,$2,$3) returning *',
        [source_location_id, target_location_id, p]
      );
      return rows[0];
    });
    return ok(res, rule, 201);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'A rule for this source+target (or this priority) already exists', 409);
    return fail(res, err.message);
  }
});

// PUT /routing-rules/:id { priority?, is_active? }
router.put('/:id', async (req, res) => {
  const { priority, is_active } = req.body;
  try {
    const rule = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `update location_routing_rules set
           priority = coalesce($2, priority),
           is_active = coalesce($3, is_active),
           updated_at = now()
         where id = $1 returning *`,
        [req.params.id, priority != null ? parseInt(priority, 10) : null, is_active === undefined ? null : (is_active === true || is_active === 'true')]
      );
      return rows[0] || null;
    });
    if (!rule) return fail(res, 'Routing rule not found', 404);
    return ok(res, rule);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'Another rule already uses that priority for this source location', 409);
    return fail(res, err.message);
  }
});

// DELETE /routing-rules/:id
router.delete('/:id', async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      await client.query('delete from location_routing_rules where id = $1', [req.params.id]);
    });
    return ok(res, { deleted: true });
  } catch (err) {
    return fail(res, err.message);
  }
});

module.exports = router;
