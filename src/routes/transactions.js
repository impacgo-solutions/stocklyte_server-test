'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { ok, fail, paginate } = require('../utils/response');

router.use(authenticate, checkSubscription);

const SELECT_JOINED = `
  select t.*,
    jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'image_url', p.image_url) as products,
    case when fl.id is null then null else jsonb_build_object('id', fl.id, 'name', fl.name) end as from_location,
    case when tl.id is null then null else jsonb_build_object('id', tl.id, 'name', tl.name) end as to_location,
    case when u.id is null then null else jsonb_build_object('id', u.id, 'full_name', u.full_name, 'avatar_url', u.avatar_url, 'created_at', u.created_at) end as performed_by_profile
  from stock_transactions t
  join products p on p.id = t.product_id
  left join locations fl on fl.id = t.from_location_id
  left join locations tl on tl.id = t.to_location_id
  left join admin_users u on u.id = t.performed_by
`;

// GET /transactions — paginated, filterable
router.get('/', async (req, res) => {
  const { page = 1, limit = 20, product_id, type, location_id, from_date, to_date } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    const { rows, count } = await withTenant(req.user.tenant_schema, async (client) => {
      const conditions = [];
      const params = [];
      if (product_id) { params.push(product_id); conditions.push(`t.product_id = $${params.length}`); }
      if (type) { params.push(type); conditions.push(`t.transaction_type = $${params.length}`); }
      if (location_id) { params.push(location_id); conditions.push(`(t.from_location_id = $${params.length} or t.to_location_id = $${params.length})`); }
      if (from_date) { params.push(from_date); conditions.push(`t.created_at >= $${params.length}`); }
      if (to_date) { params.push(to_date); conditions.push(`t.created_at <= $${params.length}`); }
      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

      const { rows: countRows } = await client.query(`select count(*)::int as count from stock_transactions t ${where}`, params);
      const count = countRows[0].count;

      const limitParams = [...params, Number(limit), offset];
      const { rows } = await client.query(
        `${SELECT_JOINED} ${where} order by t.created_at desc limit $${limitParams.length - 1} offset $${limitParams.length}`,
        limitParams
      );
      return { rows, count };
    });
    return paginate(res, rows, count, page, limit);
  } catch (err) {
    return fail(res, err.message);
  }
});

// GET /transactions/:id
router.get('/:id', async (req, res) => {
  try {
    const tx = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query(`${SELECT_JOINED} where t.id = $1`, [req.params.id]);
      return rows[0] || null;
    });
    if (!tx) return fail(res, 'Transaction not found', 404);
    return ok(res, tx);
  } catch (err) {
    return fail(res, err.message, 404);
  }
});

module.exports = router;
