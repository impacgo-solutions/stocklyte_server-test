'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { ok, fail, paginate } = require('../utils/response');
const { scopeLocationId } = require('../utils/reportScope');

router.use(authenticate, checkSubscription);

const SELECT_JOINED = `
  select t.*,
    jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'image_url', p.image_url) as products,
    case when fl.id is null then null else jsonb_build_object('id', fl.id, 'name', fl.name) end as from_location,
    case when tl.id is null then null else jsonb_build_object('id', tl.id, 'name', tl.name) end as to_location,
    case when fr.id is null then null else jsonb_build_object('id', fr.id, 'code', fr.code, 'name', fr.name) end as from_rack,
    case when tr.id is null then null else jsonb_build_object('id', tr.id, 'code', tr.code, 'name', tr.name) end as to_rack,
    case when u.id is null then null else jsonb_build_object('id', u.id, 'full_name', u.full_name, 'avatar_url', u.avatar_url, 'created_at', u.created_at) end as performed_by_profile
  from stock_transactions t
  join products p on p.id = t.product_id
  left join locations fl on fl.id = t.from_location_id
  left join locations tl on tl.id = t.to_location_id
  left join racks fr on fr.id = t.from_rack_id
  left join racks tr on tr.id = t.to_rack_id
  left join admin_users u on u.id = t.performed_by
`;

// Shared by GET / and reports.js's /export/csv so exports always match the
// filtered list. `type` accepts either one value or a comma-separated list
// (e.g. "damage,damage_restore,damage_writeoff" for the Damaged Products
// report) — existing single-type callers are unaffected.
function buildTransactionFilters(query, alias = 't', scopeLoc = null) {
  const { product_id, category_id, type, location_id, rack_id, performed_by, from_date, to_date } = query;
  const conditions = [];
  const params = [];
  if (product_id) { params.push(product_id); conditions.push(`${alias}.product_id = $${params.length}`); }
  if (category_id) {
    params.push(category_id);
    conditions.push(`exists (select 1 from products p2 where p2.id = ${alias}.product_id and p2.category_id = $${params.length})`);
  }
  if (type) {
    const types = String(type).split(',').map((s) => s.trim()).filter(Boolean);
    params.push(types);
    conditions.push(`${alias}.transaction_type = any($${params.length})`);
  }
  if (location_id) { params.push(location_id); conditions.push(`(${alias}.from_location_id = $${params.length} or ${alias}.to_location_id = $${params.length})`); }
  if (rack_id) { params.push(rack_id); conditions.push(`(${alias}.from_rack_id = $${params.length} or ${alias}.to_rack_id = $${params.length})`); }
  if (performed_by) { params.push(performed_by); conditions.push(`${alias}.performed_by = $${params.length}`); }
  if (from_date) { params.push(from_date); conditions.push(`${alias}.created_at >= $${params.length}`); }
  if (to_date) { params.push(to_date); conditions.push(`${alias}.created_at < $${params.length}::date + interval '1 day'`); }
  // A manager/staff member is confined to their own warehouse regardless of
  // what location_id (if any) they passed above — this is ANDed on, so it
  // can only narrow the result, never widen it.
  if (scopeLoc) { params.push(scopeLoc); conditions.push(`(${alias}.from_location_id = $${params.length} or ${alias}.to_location_id = $${params.length})`); }
  return { where: conditions.length ? `where ${conditions.join(' and ')}` : '', params };
}

// GET /transactions — paginated, filterable
router.get('/', async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    const scopeLoc = scopeLocationId(req);
    const { rows, count } = await withTenant(req.user.tenant_schema, async (client) => {
      const { where, params } = buildTransactionFilters(req.query, 't', scopeLoc);

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
    return fail(res, err.message, err.status || 400);
  }
});

// GET /transactions/:id
router.get('/:id', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const tx = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query(`${SELECT_JOINED} where t.id = $1`, [req.params.id]);
      return rows[0] || null;
    });
    if (!tx) return fail(res, 'Transaction not found', 404);
    if (scopeLoc && tx.from_location_id !== scopeLoc && tx.to_location_id !== scopeLoc) {
      return fail(res, 'You do not have access to this warehouse', 403);
    }
    return ok(res, tx);
  } catch (err) {
    return fail(res, err.message, err.status || 404);
  }
});

module.exports = router;
module.exports.buildTransactionFilters = buildTransactionFilters;
