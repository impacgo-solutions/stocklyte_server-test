'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole, requireMinRole } = require('../middleware/roleCheck');
const { ok, fail, paginate } = require('../utils/response');
const { scopeLocationId } = require('../utils/reportScope');

router.use(authenticate, checkSubscription);

// A manager/staff member may only create/edit a bin under a rack that
// belongs to their own assigned warehouse — same convention as
// racks.js's/stock.js's assertLocationAccess.
function assertLocationAccess(req, locationId) {
  if (req.user.role === 'admin') return;
  if (req.user.location_id !== locationId) {
    throw Object.assign(new Error('You do not have access to this warehouse'), { status: 403 });
  }
}

// GET /bins?rack_id=&q=&status=&page=&limit=
// Paginated/searchable, same shape as GET /racks. A manager/staff member is
// always confined to their own warehouse's racks regardless of what rack_id
// they pass.
router.get('/', async (req, res) => {
  const { rack_id, q, status, page = 1, limit = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const scopeLoc = scopeLocationId(req);
    const { rows, count } = await withTenant(req.user.tenant_schema, async (client) => {
      const conditions = [];
      const params = [];

      if (rack_id) {
        params.push(rack_id);
        conditions.push(`b.rack_id = $${params.length}`);
      }

      if (scopeLoc) {
        params.push(scopeLoc);
        conditions.push(`r.location_id = $${params.length}`);
      }

      if (q) {
        const safe = q.replace(/[%_]/g, '\\$&');
        params.push(`%${safe}%`);
        conditions.push(`(b.code ILIKE $${params.length} OR b.name ILIKE $${params.length})`);
      }

      if (status === 'inactive') {
        conditions.push(`b.is_active = false`);
      } else if (status === 'active') {
        conditions.push(`b.is_active = true and (b.capacity is null or coalesce(bsum.total_qty, 0) < b.capacity)`);
      } else if (status === 'full') {
        conditions.push(`b.is_active = true and b.capacity is not null and coalesce(bsum.total_qty, 0) >= b.capacity`);
      }

      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
      const joins = `
        join racks r on r.id = b.rack_id
        join locations l on l.id = r.location_id
        left join (select bin_id, sum(quantity) as total_qty, count(*)::int as product_count from bin_stock group by bin_id) bsum on bsum.bin_id = b.id
      `;

      const { rows: countRows } = await client.query(`select count(*)::int as count from bins b ${joins} ${where}`, params);
      const count = countRows[0].count;

      const limitParams = [...params, Number(limit), offset];
      const { rows } = await client.query(
        `select b.*,
                jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'location_id', r.location_id) as racks,
                l.name as location_name,
                coalesce(bsum.total_qty, 0) as current_quantity,
                coalesce(bsum.product_count, 0) as product_count,
                case when not b.is_active then 'inactive'
                     when b.capacity is not null and coalesce(bsum.total_qty, 0) >= b.capacity then 'full'
                     else 'active' end as status
         from bins b
         ${joins}
         ${where}
         order by r.code asc, b.code asc
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
  const { rack_id, code, name, capacity } = req.body;
  if (!rack_id || !code) return fail(res, 'rack_id and code are required');
  if (capacity != null && (isNaN(parseFloat(capacity)) || parseFloat(capacity) < 0)) {
    return fail(res, 'capacity must be zero or positive');
  }
  try {
    const bin = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows: rackRows } = await client.query('select location_id, is_active from racks where id = $1', [rack_id]);
      const rack = rackRows[0];
      if (!rack) throw Object.assign(new Error('Rack not found'), { status: 404 });
      assertLocationAccess(req, rack.location_id);
      if (!rack.is_active) {
        throw Object.assign(new Error('Cannot add a bin to an inactive rack'), { status: 400 });
      }

      const { rows } = await client.query(
        'insert into bins (rack_id, code, name, capacity) values ($1, $2, $3, $4) returning *',
        [rack_id, code, name || null, capacity != null ? parseFloat(capacity) : null]
      );
      return rows[0];
    });
    return ok(res, bin, 201);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'A bin with this code already exists in this rack');
    return fail(res, err.message, err.status || 400);
  }
});

router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { code, name, is_active, capacity } = req.body;
  if (capacity !== undefined && capacity !== null && (isNaN(parseFloat(capacity)) || parseFloat(capacity) < 0)) {
    return fail(res, 'capacity must be zero or positive');
  }
  try {
    const bin = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows: existingRows } = await client.query(
        `select b.id, r.location_id from bins b join racks r on r.id = b.rack_id where b.id = $1`,
        [req.params.id]
      );
      if (!existingRows[0]) return null;
      assertLocationAccess(req, existingRows[0].location_id);

      // capacity is tri-state (leave unchanged / clear to null / set to a
      // number), same convention as PUT /racks/:id.
      const capacityProvided = capacity !== undefined;
      const capacityValue = capacityProvided && capacity !== null && capacity !== '' ? parseFloat(capacity) : null;

      const { rows } = await client.query(
        `update bins set
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
    if (!bin) return fail(res, 'Bin not found', 404);
    return ok(res, bin);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'A bin with this code already exists in this rack');
    return fail(res, err.message, err.status || 400);
  }
});

// DELETE /bins/:id — admin only; blocked while products are still assigned
// so an allocation record can never be silently lost.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query('select coalesce(sum(quantity), 0) as total from bin_stock where bin_id = $1', [req.params.id]);
      if (parseFloat(rows[0].total) > 0) {
        throw Object.assign(new Error('This bin still has products assigned to it — unassign them before deleting'), { status: 400 });
      }
      await client.query('delete from bins where id = $1', [req.params.id]);
    });
    return ok(res, { deleted: true });
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /bins/:id/stock?q=&page=&limit= — this bin's per-product
// sub-allocation (the "bin → products" hierarchy view).
router.get('/:id/stock', async (req, res) => {
  const { q, page = 1, limit = 50 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const scopeLoc = scopeLocationId(req);
    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows: binRows } = await client.query(
        `select b.*, jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'location_id', r.location_id) as racks
         from bins b join racks r on r.id = b.rack_id where b.id = $1`,
        [req.params.id]
      );
      const bin = binRows[0];
      if (!bin) return null;
      if (scopeLoc && bin.racks.location_id !== scopeLoc) {
        throw Object.assign(new Error('You do not have access to this warehouse'), { status: 403 });
      }

      const params = [req.params.id];
      let where = 'where bs.bin_id = $1';
      if (q) {
        const safe = q.replace(/[%_]/g, '\\$&');
        params.push(`%${safe}%`);
        where += ` and (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`;
      }

      const { rows: countRows } = await client.query(
        `select count(*)::int as count from bin_stock bs join products p on p.id = bs.product_id ${where}`,
        params
      );
      const count = countRows[0].count;

      const limitParams = [...params, Number(limit), offset];
      const { rows } = await client.query(
        `select bs.*,
                jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'unit', p.unit, 'image_url', p.image_url) as products
         from bin_stock bs
         join products p on p.id = bs.product_id
         ${where}
         order by p.name asc
         limit $${limitParams.length - 1} offset $${limitParams.length}`,
        limitParams
      );

      return { bin, rows, count };
    });
    if (!result) return fail(res, 'Bin not found', 404);
    return ok(res, {
      bin: result.bin,
      products: result.rows,
      meta: { total: result.count, page: Number(page), limit: Number(limit), pages: Math.ceil(result.count / limit) },
    });
  } catch (err) {
    return fail(res, err.message, err.status || 404);
  }
});

// PUT /bins/:id/stock — sets (not increments) this bin's allocation for a
// product. Purely a visibility/placement sub-breakdown of the parent rack's
// own allocation — does not touch stock.quantity, rack_stock, or
// stock_in_lot/stock_out/transfer_stock. Guards mirror PUT /racks/:id/stock:
// the bin must be active, the bin's total across all products can't exceed
// its own capacity, and this product's total across every bin in the same
// rack can't exceed what's actually allocated to that rack.
router.put('/:id/stock', requireMinRole('staff'), async (req, res) => {
  const { product_id, quantity } = req.body;
  if (!product_id || quantity == null) return fail(res, 'product_id and quantity are required');
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty < 0) return fail(res, 'quantity must be zero or positive');

  try {
    const scopeLoc = scopeLocationId(req);
    const row = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows: binRows } = await client.query(
        `select b.*, r.location_id from bins b join racks r on r.id = b.rack_id where b.id = $1`,
        [req.params.id]
      );
      const bin = binRows[0];
      if (!bin) throw Object.assign(new Error('Bin not found'), { status: 404 });
      if (scopeLoc && bin.location_id !== scopeLoc) {
        throw Object.assign(new Error('You do not have access to this warehouse'), { status: 403 });
      }
      if (!bin.is_active) {
        throw Object.assign(new Error('This bin is inactive'), { status: 400 });
      }

      const { rows: rackStockRows } = await client.query(
        'select quantity from rack_stock where product_id = $1 and rack_id = $2',
        [product_id, bin.rack_id]
      );
      const rackQty = parseFloat(rackStockRows[0]?.quantity || 0);

      const { rows: otherBinRows } = await client.query(
        `select coalesce(sum(bs.quantity), 0) as total
         from bin_stock bs join bins b on b.id = bs.bin_id
         where bs.product_id = $1 and b.rack_id = $2 and bs.bin_id <> $3`,
        [product_id, bin.rack_id, req.params.id]
      );
      const otherBinsTotal = parseFloat(otherBinRows[0].total);

      if (otherBinsTotal + qty > rackQty) {
        throw Object.assign(
          new Error(`Cannot allocate ${qty} of this product — only ${Math.max(0, rackQty - otherBinsTotal)} is unallocated in this rack`),
          { status: 400 }
        );
      }

      if (bin.capacity != null) {
        const { rows: capRows } = await client.query(
          'select coalesce(sum(quantity), 0) as total from bin_stock where bin_id = $1 and product_id <> $2',
          [req.params.id, product_id]
        );
        const otherProductsTotal = parseFloat(capRows[0].total);
        if (otherProductsTotal + qty > parseFloat(bin.capacity)) {
          throw Object.assign(new Error(`This bin's capacity (${bin.capacity}) would be exceeded`), { status: 400 });
        }
      }

      const { rows } = await client.query(
        `insert into bin_stock (product_id, bin_id, quantity)
         values ($1, $2, $3)
         on conflict (product_id, bin_id) do update set quantity = excluded.quantity, updated_at = now()
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
