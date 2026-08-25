'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole, requireMinRole } = require('../middleware/roleCheck');
const { ok, fail, paginate } = require('../utils/response');
const { scopeLocationId } = require('../utils/reportScope');

router.use(authenticate, checkSubscription);

// A manager/staff member may only create/edit a rack at their own assigned
// warehouse — same convention as stock.js's assertLocationAccess.
function assertLocationAccess(req, locationId) {
  if (req.user.role === 'admin') return;
  if (req.user.location_id !== locationId) {
    throw Object.assign(new Error('You do not have access to this warehouse'), { status: 403 });
  }
}

// GET /racks?location_id=&cluster_id=&q=&status=&page=&limit=
// Paginated/searchable so a warehouse with 1,000+ racks stays fast. A
// manager/staff member is always confined to their own warehouse regardless
// of what location_id/cluster_id they pass (mirrors reports.js's
// buildCurrentStockFilters convention).
router.get('/', async (req, res) => {
  const { q, cluster_id, status, page = 1, limit = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const scopeLoc = scopeLocationId(req);
    const { rows, count } = await withTenant(req.user.tenant_schema, async (client) => {
      const conditions = [];
      const params = [];

      if (scopeLoc) {
        params.push(scopeLoc);
        conditions.push(`r.location_id = $${params.length}`);
      } else if (req.query.location_id) {
        params.push(req.query.location_id);
        conditions.push(`r.location_id = $${params.length}`);
      } else if (cluster_id) {
        params.push(cluster_id);
        conditions.push(`l.cluster_id = $${params.length}`);
      }

      if (q) {
        const safe = q.replace(/[%_]/g, '\\$&');
        params.push(`%${safe}%`);
        conditions.push(`(r.code ILIKE $${params.length} OR r.name ILIKE $${params.length})`);
      }

      if (status === 'inactive') {
        conditions.push(`r.is_active = false`);
      } else if (status === 'active') {
        conditions.push(`r.is_active = true and (r.capacity is null or coalesce(rsum.total_qty, 0) < r.capacity)`);
      } else if (status === 'full') {
        conditions.push(`r.is_active = true and r.capacity is not null and coalesce(rsum.total_qty, 0) >= r.capacity`);
      }

      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
      const joins = `
        join locations l on l.id = r.location_id
        left join clusters cl on cl.id = l.cluster_id
        left join (select rack_id, sum(quantity) as total_qty, count(*)::int as product_count from rack_stock group by rack_id) rsum on rsum.rack_id = r.id
      `;

      const { rows: countRows } = await client.query(`select count(*)::int as count from racks r ${joins} ${where}`, params);
      const count = countRows[0].count;

      const limitParams = [...params, Number(limit), offset];
      const { rows } = await client.query(
        `select r.*,
                jsonb_build_object('id', l.id, 'name', l.name, 'cluster_id', l.cluster_id) as locations,
                cl.name as cluster_name,
                coalesce(rsum.total_qty, 0) as current_quantity,
                coalesce(rsum.product_count, 0) as product_count,
                case when not r.is_active then 'inactive'
                     when r.capacity is not null and coalesce(rsum.total_qty, 0) >= r.capacity then 'full'
                     else 'active' end as status
         from racks r
         ${joins}
         ${where}
         order by l.name asc, r.code asc
         limit $${limitParams.length - 1} offset $${limitParams.length}`,
        limitParams
      );
      return { rows, count };
    });
    return paginate(res, rows, count, page, limit);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  const { location_id, code, name, capacity } = req.body;
  if (!location_id || !code) return fail(res, 'location_id and code are required');
  if (capacity != null && (isNaN(parseFloat(capacity)) || parseFloat(capacity) < 0)) {
    return fail(res, 'capacity must be zero or positive');
  }
  try {
    assertLocationAccess(req, location_id);
    const rack = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        'insert into racks (location_id, code, name, capacity) values ($1, $2, $3, $4) returning *',
        [location_id, code, name || null, capacity != null ? parseFloat(capacity) : null]
      );
      return rows[0];
    });
    return ok(res, rack, 201);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'A rack with this code already exists at this location');
    return fail(res, err.message, err.status || 400);
  }
});

router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { code, name, is_active, capacity } = req.body;
  if (capacity !== undefined && capacity !== null && (isNaN(parseFloat(capacity)) || parseFloat(capacity) < 0)) {
    return fail(res, 'capacity must be zero or positive');
  }
  try {
    const rack = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows: existingRows } = await client.query('select location_id from racks where id = $1', [req.params.id]);
      if (!existingRows[0]) return null;
      assertLocationAccess(req, existingRows[0].location_id);

      // capacity is tri-state (leave unchanged / clear to null / set to a
      // number), so "was it provided at all" travels as its own boolean
      // rather than being inferred from the value.
      const capacityProvided = capacity !== undefined;
      const capacityValue = capacityProvided && capacity !== null && capacity !== '' ? parseFloat(capacity) : null;

      const { rows } = await client.query(
        `update racks set
           code = coalesce($2, code),
           name = coalesce($3, name),
           is_active = coalesce($4, is_active),
           capacity = case when $5 then $6 else capacity end
         where id = $1 returning *`,
        [
          req.params.id,
          code ?? null,
          name ?? null,
          is_active === undefined ? null : (is_active === true || is_active === 'true'),
          capacityProvided,
          capacityValue,
        ]
      );
      return rows[0] || null;
    });
    if (!rack) return fail(res, 'Rack not found', 404);
    return ok(res, rack);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'A rack with this code already exists at this location');
    return fail(res, err.message, err.status || 400);
  }
});

// DELETE /racks/:id — admin only; blocked while products are still assigned
// so an allocation record can never be silently lost.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query('select coalesce(sum(quantity), 0) as total from rack_stock where rack_id = $1', [req.params.id]);
      if (parseFloat(rows[0].total) > 0) {
        throw Object.assign(new Error('This rack still has products assigned to it — unassign them before deleting'), { status: 400 });
      }
      await client.query('delete from racks where id = $1', [req.params.id]);
    });
    return ok(res, { deleted: true });
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /racks/:id/stock?q=&page=&limit= — this rack's per-product
// sub-allocation (the "rack → products" hierarchy view), each row enriched
// with that product's location-level available/reserved/damaged quantities.
router.get('/:id/stock', async (req, res) => {
  const { q, page = 1, limit = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const scopeLoc = scopeLocationId(req);
    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows: rackRows } = await client.query(
        `select r.*, jsonb_build_object('id', l.id, 'name', l.name, 'cluster_id', l.cluster_id) as locations
         from racks r join locations l on l.id = r.location_id where r.id = $1`,
        [req.params.id]
      );
      const rack = rackRows[0];
      if (!rack) return null;
      if (scopeLoc && rack.location_id !== scopeLoc) {
        throw Object.assign(new Error('You do not have access to this warehouse'), { status: 403 });
      }

      const params = [req.params.id];
      let where = 'where rs.rack_id = $1';
      if (q) {
        const safe = q.replace(/[%_]/g, '\\$&');
        params.push(`%${safe}%`);
        where += ` and (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`;
      }

      const { rows: countRows } = await client.query(
        `select count(*)::int as count from rack_stock rs join products p on p.id = rs.product_id ${where}`,
        params
      );
      const count = countRows[0].count;

      const locParam = params.length + 1;
      const limitParams = [...params, rack.location_id, Number(limit), offset];
      const { rows } = await client.query(
        `select rs.*,
                jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'unit', p.unit, 'image_url', p.image_url) as products,
                s.quantity as location_quantity, s.reserved_quantity, s.damaged_quantity, s.in_transit_quantity
         from rack_stock rs
         join products p on p.id = rs.product_id
         left join stock s on s.product_id = rs.product_id and s.location_id = $${locParam}
         ${where}
         order by p.name asc
         limit $${limitParams.length - 1} offset $${limitParams.length}`,
        limitParams
      );

      return { rack, rows, count };
    });
    if (!result) return fail(res, 'Rack not found', 404);
    return ok(res, {
      rack: result.rack,
      products: result.rows,
      meta: { total: result.count, page: Number(page), limit: Number(limit), pages: Math.ceil(result.count / limit) },
    });
  } catch (err) {
    return fail(res, err.message, err.status || 404);
  }
});

// PUT /racks/:id/stock — sets (not increments) this rack's allocation for a
// product. Purely a visibility sub-breakdown of the location's own stock —
// does not touch stock.quantity or stock_in_lot/stock_out/transfer_stock.
// Guards: the rack must be active, the rack's total across all products
// can't exceed its capacity, and this product's total across every rack at
// the location can't exceed what's actually stocked there.
router.put('/:id/stock', requireMinRole('staff'), async (req, res) => {
  const { product_id, quantity } = req.body;
  if (!product_id || quantity == null) return fail(res, 'product_id and quantity are required');
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty < 0) return fail(res, 'quantity must be zero or positive');

  try {
    const scopeLoc = scopeLocationId(req);
    const row = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows: rackRows } = await client.query('select * from racks where id = $1', [req.params.id]);
      const rack = rackRows[0];
      if (!rack) throw Object.assign(new Error('Rack not found'), { status: 404 });
      if (scopeLoc && rack.location_id !== scopeLoc) {
        throw Object.assign(new Error('You do not have access to this warehouse'), { status: 403 });
      }
      if (!rack.is_active) {
        throw Object.assign(new Error('This rack is inactive'), { status: 400 });
      }

      const { rows: stockRows } = await client.query(
        'select quantity from stock where product_id = $1 and location_id = $2',
        [product_id, rack.location_id]
      );
      const locationQty = parseFloat(stockRows[0]?.quantity || 0);

      const { rows: otherRackRows } = await client.query(
        `select coalesce(sum(rs.quantity), 0) as total
         from rack_stock rs join racks r on r.id = rs.rack_id
         where rs.product_id = $1 and r.location_id = $2 and rs.rack_id <> $3`,
        [product_id, rack.location_id, req.params.id]
      );
      const otherRacksTotal = parseFloat(otherRackRows[0].total);

      if (otherRacksTotal + qty > locationQty) {
        throw Object.assign(
          new Error(`Cannot allocate ${qty} of this product — only ${Math.max(0, locationQty - otherRacksTotal)} is unallocated at this location`),
          { status: 400 }
        );
      }

      if (rack.capacity != null) {
        const { rows: capRows } = await client.query(
          'select coalesce(sum(quantity), 0) as total from rack_stock where rack_id = $1 and product_id <> $2',
          [req.params.id, product_id]
        );
        const otherProductsTotal = parseFloat(capRows[0].total);
        if (otherProductsTotal + qty > parseFloat(rack.capacity)) {
          throw Object.assign(new Error(`This rack's capacity (${rack.capacity}) would be exceeded`), { status: 400 });
        }
      }

      const { rows } = await client.query(
        `insert into rack_stock (product_id, rack_id, quantity)
         values ($1, $2, $3)
         on conflict (product_id, rack_id) do update set quantity = excluded.quantity, updated_at = now()
         returning *`,
        [product_id, req.params.id, qty]
      );
      return rows[0];
    });
    return ok(res, row);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

module.exports = router;
