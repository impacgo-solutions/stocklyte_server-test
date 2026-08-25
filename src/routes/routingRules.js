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
                jsonb_build_object('id', sl.id, 'name', sl.name, 'address', sl.address, 'latitude', sl.latitude, 'longitude', sl.longitude) as source_location,
                jsonb_build_object('id', tl.id, 'name', tl.name, 'address', tl.address, 'latitude', tl.latitude, 'longitude', tl.longitude) as target_location
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

// POST /routing-rules/generate { source_location_id }
// Auto-computes and PERSISTS a nearest-to-farthest sequence for the given
// source, replacing whatever rules it currently has, from that location's
// own latitude/longitude against every other active, coordinate-having,
// cluster-eligible location (same eligibility next_eligible_location's
// fallback tier already uses) — the same generate_routing_sequence()
// function next_eligible_location() calls automatically the first time a
// source with no rules is ever routed. Exposed here so an admin can
// explicitly refresh a source's sequence on demand (e.g. after adding a
// new warehouse or updating coordinates) without waiting for that
// first-use bootstrap.
router.post('/generate', async (req, res) => {
  const { source_location_id } = req.body;
  if (!source_location_id) return fail(res, 'source_location_id is required');

  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows: locRows } = await client.query(
        'select latitude, longitude from locations where id = $1',
        [source_location_id]
      );
      if (!locRows[0]) throw Object.assign(new Error('Location not found'), { status: 404 });
      if (locRows[0].latitude == null || locRows[0].longitude == null) {
        throw Object.assign(
          new Error('This location has no latitude/longitude configured — add coordinates first'),
          { status: 400 }
        );
      }

      await client.query('select generate_routing_sequence($1)', [source_location_id]);

      const { rows } = await client.query(
        `select rr.*,
                jsonb_build_object('id', sl.id, 'name', sl.name, 'address', sl.address, 'latitude', sl.latitude, 'longitude', sl.longitude) as source_location,
                jsonb_build_object('id', tl.id, 'name', tl.name, 'address', tl.address, 'latitude', tl.latitude, 'longitude', tl.longitude) as target_location
         from location_routing_rules rr
         join locations sl on sl.id = rr.source_location_id
         join locations tl on tl.id = rr.target_location_id
         where rr.source_location_id = $1
         order by rr.priority`,
        [source_location_id]
      );
      return rows;
    });
    return ok(res, result, 201);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// POST /routing-rules { source_location_id, target_location_id, priority, distance_km? }
// distance_km is the admin's manually-entered distance — only meaningful
// when the source and/or target location has no Latitude/Longitude, since
// next_eligible_location() always prefers a live GPS-computed distance over
// this value whenever both ends of the pair have coordinates. Stored either
// way so the value survives if coordinates are removed later; a rule added
// here is always labelled distance_source = 'manual' (an admin chose this
// target/priority by hand), independent of whether GPS ends up overriding
// the distance shown at decision time.
router.post('/', async (req, res) => {
  const { source_location_id, target_location_id, priority, distance_km } = req.body;
  if (!source_location_id || !target_location_id || priority == null) {
    return fail(res, 'source_location_id, target_location_id and priority are required');
  }
  if (source_location_id === target_location_id) return fail(res, 'source and target locations must differ');
  const p = parseInt(priority, 10);
  if (isNaN(p) || p < 1) return fail(res, 'priority must be a positive integer (1 = tried first)');
  let dist = null;
  if (distance_km !== undefined && distance_km !== null && distance_km !== '') {
    dist = Number(distance_km);
    if (isNaN(dist) || dist < 0) return fail(res, 'distance_km must be a non-negative number');
  }

  try {
    const rule = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `insert into location_routing_rules (source_location_id, target_location_id, priority, distance_km, distance_source)
         values ($1,$2,$3,$4,'manual') returning *`,
        [source_location_id, target_location_id, p, dist]
      );
      return rows[0];
    });
    return ok(res, rule, 201);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'A rule for this source+target (or this priority) already exists', 409);
    return fail(res, err.message);
  }
});

// PUT /routing-rules/:id { target_location_id?, priority?, distance_km?, is_active? }
// Supplying distance_km re-labels the rule distance_source = 'manual' (the
// admin just hand-edited it), independent of what GPS may compute for it at
// decision time. Omitting it leaves the stored distance/source untouched.
router.put('/:id', async (req, res) => {
  const { target_location_id, priority, distance_km, is_active } = req.body;
  let dist;
  let hasDist = false;
  if (distance_km !== undefined) {
    hasDist = true;
    if (distance_km === null || distance_km === '') {
      dist = null;
    } else {
      dist = Number(distance_km);
      if (isNaN(dist) || dist < 0) return fail(res, 'distance_km must be a non-negative number');
    }
  }

  try {
    const rule = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `update location_routing_rules set
           target_location_id = coalesce($2, target_location_id),
           priority = coalesce($3, priority),
           distance_km = case when $4 then $5 else distance_km end,
           distance_source = case when $4 then 'manual' else distance_source end,
           is_active = coalesce($6, is_active),
           updated_at = now()
         where id = $1 returning *`,
        [
          req.params.id,
          target_location_id || null,
          priority != null ? parseInt(priority, 10) : null,
          hasDist,
          hasDist ? dist : null,
          is_active === undefined ? null : (is_active === true || is_active === 'true'),
        ]
      );
      return rows[0] || null;
    });
    if (!rule) return fail(res, 'Routing rule not found', 404);
    return ok(res, rule);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'Another rule already uses that target or priority for this source location', 409);
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
