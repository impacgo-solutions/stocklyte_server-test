'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole } = require('../middleware/roleCheck');
const { fail, paginate } = require('../utils/response');

router.use(authenticate, checkSubscription, requireRole('admin'));

// GET /audit — paginated, admin only
router.get('/', async (req, res) => {
  const { page = 1, limit = 20, action, table_name, from_date, to_date } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    const { count, enrichedRows } = await withTenant(req.user.tenant_schema, async (client) => {
      const conditions = [];
      const params = [];
      if (action) { params.push(action); conditions.push(`action = $${params.length}`); }
      if (table_name) { params.push(table_name); conditions.push(`table_name = $${params.length}`); }
      if (from_date) { params.push(from_date); conditions.push(`created_at >= $${params.length}`); }
      if (to_date) { params.push(to_date); conditions.push(`created_at <= $${params.length}`); }
      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

      const { rows: countRows } = await client.query(`select count(*)::int as count from audit_log ${where}`, params);
      const count = countRows[0].count;

      const limitParams = [...params, Number(limit), offset];
      const { rows } = await client.query(
        `select a.*, jsonb_build_object('id', u.id, 'full_name', u.full_name, 'avatar_url', u.avatar_url, 'role', u.role) as performed_by_profile
         from audit_log a
         left join admin_users u on u.id = a.performed_by
         ${where}
         order by a.created_at desc
         limit $${limitParams.length - 1} offset $${limitParams.length}`,
        limitParams
      );

      // Enrich stock entries with product and location names (IDs are not useful to users)
      const stockEntries = rows.filter((e) => e.table_name === 'stock');
      let enrichedRows = rows;
      if (stockEntries.length > 0) {
        const productIds = [...new Set(stockEntries.flatMap((e) => [e.new_data?.product_id, e.old_data?.product_id].filter(Boolean)))];
        const locationIds = [...new Set(stockEntries.flatMap((e) => [e.new_data?.location_id, e.old_data?.location_id].filter(Boolean)))];

        const [{ rows: products }, { rows: locations }] = await Promise.all([
          productIds.length > 0 ? client.query('select id, name, sku from products where id = any($1)', [productIds]) : { rows: [] },
          locationIds.length > 0 ? client.query('select id, name from locations where id = any($1)', [locationIds]) : { rows: [] },
        ]);
        const productMap = Object.fromEntries(products.map((p) => [p.id, p]));
        const locationMap = Object.fromEntries(locations.map((l) => [l.id, l]));

        enrichedRows = rows.map((e) => {
          if (e.table_name !== 'stock') return e;
          const productId = e.new_data?.product_id || e.old_data?.product_id;
          const locationId = e.new_data?.location_id || e.old_data?.location_id;
          return {
            ...e,
            resolved_product: productId ? productMap[productId] || null : null,
            resolved_location: locationId ? locationMap[locationId] || null : null,
          };
        });
      }

      return { rows, count, enrichedRows };
    });

    return paginate(res, enrichedRows, count, page, limit);
  } catch (err) {
    return fail(res, err.message);
  }
});

module.exports = router;
