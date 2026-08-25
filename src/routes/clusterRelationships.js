'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole } = require('../middleware/roleCheck');
const { ok, fail } = require('../utils/response');

router.use(authenticate, checkSubscription);

const SELECT_JOINED = `
  select cr.*,
    jsonb_build_object('id', sc.id, 'name', sc.name) as source_cluster,
    jsonb_build_object('id', tc.id, 'name', tc.name) as target_cluster
  from cluster_relationships cr
  join clusters sc on sc.id = cr.source_cluster_id
  join clusters tc on tc.id = cr.target_cluster_id
`;

// GET /cluster-relationships?source_cluster_id=
router.get('/', async (req, res) => {
  const { source_cluster_id } = req.query;
  try {
    const relationships = await withTenant(req.user.tenant_schema, async (client) => {
      const params = [];
      let where = '';
      if (source_cluster_id) { params.push(source_cluster_id); where = 'where cr.source_cluster_id = $1'; }
      const { rows } = await client.query(`${SELECT_JOINED} ${where} order by sc.name, tc.name`, params);
      return rows;
    });
    return ok(res, relationships);
  } catch (err) {
    return fail(res, err.message);
  }
});

// POST /cluster-relationships { source_cluster_id, target_cluster_id, allow_product_requests?, allow_transfers? }
router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  const { source_cluster_id, target_cluster_id, allow_product_requests, allow_transfers } = req.body;
  if (!source_cluster_id || !target_cluster_id) {
    return fail(res, 'source_cluster_id and target_cluster_id are required');
  }
  if (source_cluster_id === target_cluster_id) return fail(res, 'source and target clusters must differ');

  try {
    const relationship = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `insert into cluster_relationships (source_cluster_id, target_cluster_id, allow_product_requests, allow_transfers)
         values ($1, $2, $3, $4) returning *`,
        [
          source_cluster_id,
          target_cluster_id,
          allow_product_requests === undefined ? true : Boolean(allow_product_requests),
          allow_transfers === undefined ? true : Boolean(allow_transfers),
        ]
      );
      return rows[0];
    });
    return ok(res, relationship, 201);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'A relationship between these clusters already exists', 409);
    return fail(res, err.message);
  }
});

// PUT /cluster-relationships/:id { allow_product_requests?, allow_transfers?, is_active? }
router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { allow_product_requests, allow_transfers, is_active } = req.body;
  try {
    const relationship = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `update cluster_relationships set
           allow_product_requests = coalesce($2, allow_product_requests),
           allow_transfers = coalesce($3, allow_transfers),
           is_active = coalesce($4, is_active)
         where id = $1 returning *`,
        [
          req.params.id,
          allow_product_requests === undefined ? null : Boolean(allow_product_requests),
          allow_transfers === undefined ? null : Boolean(allow_transfers),
          is_active === undefined ? null : Boolean(is_active),
        ]
      );
      return rows[0] || null;
    });
    if (!relationship) return fail(res, 'Cluster relationship not found', 404);
    return ok(res, relationship);
  } catch (err) {
    return fail(res, err.message);
  }
});

// DELETE /cluster-relationships/:id
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      await client.query('delete from cluster_relationships where id = $1', [req.params.id]);
    });
    return ok(res, { deleted: true });
  } catch (err) {
    return fail(res, err.message);
  }
});

module.exports = router;
