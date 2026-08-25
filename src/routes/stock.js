'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole, requireMinRole } = require('../middleware/roleCheck');
const idempotency = require('../middleware/idempotency');
const { ok, fail } = require('../utils/response');
const { scopeLocationId } = require('../utils/reportScope');

router.use(authenticate, checkSubscription);

// GET /stock
// A manager/staff member is confined to their own warehouse — any
// location_id they pass is ignored in favor of their assigned one, so a
// stray/manipulated filter can't be used to see another warehouse's stock.
router.get('/', async (req, res) => {
  const { product_id } = req.query;
  try {
    const scopeLoc = scopeLocationId(req);
    const location_id = scopeLoc || req.query.location_id;
    const stock = await withTenant(req.user.tenant_schema, async (client) => {
      const conditions = [];
      const params = [];
      if (location_id) { params.push(location_id); conditions.push(`s.location_id = $${params.length}`); }
      if (product_id) { params.push(product_id); conditions.push(`s.product_id = $${params.length}`); }
      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
      const { rows } = await client.query(
        `select s.*,
                jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'image_url', p.image_url, 'low_stock_threshold', p.low_stock_threshold) as products,
                jsonb_build_object('id', l.id, 'name', l.name) as locations
         from stock s
         join products p on p.id = s.product_id
         join locations l on l.id = s.location_id
         ${where}`,
        params
      );
      return rows;
    });
    return ok(res, stock);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /stock/low — below threshold with days-until-stockout forecast
router.get('/low', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const params = [];
      let where = '';
      if (scopeLoc) { params.push(scopeLoc); where = `where s.location_id = $${params.length}`; }
      const { rows: stockData } = await client.query(
        `select s.*,
                jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'low_stock_threshold', p.low_stock_threshold, 'image_url', p.image_url) as products,
                jsonb_build_object('id', l.id, 'name', l.name) as locations
         from stock s
         join products p on p.id = s.product_id
         join locations l on l.id = s.location_id
         ${where}`,
        params
      );

      const low = stockData.filter((s) => {
        const thresh = s.products?.low_stock_threshold || 10;
        return parseFloat(s.quantity) <= thresh;
      });
      if (low.length === 0) return [];

      const productIds = [...new Set(low.map((s) => s.product_id))];
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const movementParams = [productIds, thirtyDaysAgo.toISOString()];
      let movementWhere = "where product_id = any($1) and transaction_type = 'out' and created_at >= $2";
      if (scopeLoc) { movementParams.push(scopeLoc); movementWhere += ` and from_location_id = $${movementParams.length}`; }
      const { rows: movements } = await client.query(
        `select product_id, quantity from stock_transactions ${movementWhere}`,
        movementParams
      );

      const outflowByProduct = {};
      movements.forEach((m) => {
        outflowByProduct[m.product_id] = (outflowByProduct[m.product_id] || 0) + parseFloat(m.quantity);
      });

      return low.map((s) => {
        const totalOut30d = outflowByProduct[s.product_id] || 0;
        const avgDailyOut = totalOut30d / 30;
        const days_remaining = avgDailyOut > 0 ? Math.floor(parseFloat(s.quantity) / avgDailyOut) : null;
        return { ...s, avg_daily_out: avgDailyOut, days_remaining };
      });
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// ─── helpers ────────────────────────────────────────────────────────────────

function round3(n) { return Math.round(n * 1000) / 1000; }

// Warehouse-level access control: the tenant admin can act on any location;
// a manager or staff member is confined to the single location they're
// assigned to (their JWT's location_id) — they can't move stock at a
// warehouse they don't belong to, even though the product catalog itself
// stays tenant-wide (categories/products are intentionally not scoped here).
function assertLocationAccess(req, ...locationIds) {
  if (req.user.role === 'admin') return;
  const allowed = locationIds.filter(Boolean).every((id) => id === req.user.location_id);
  if (!req.user.location_id || !allowed) {
    throw Object.assign(new Error('You do not have access to this warehouse'), { status: 403 });
  }
}

// ─── POST /stock/in ─────────────────────────────────────────────────────────
// Accepts either:
//   a) Multi-lot:  { product_id, location_id, supplier_name?, note?, lots: [{quantity, batch_number?, expiry_date?}, …] }
//   b) Single lot: { product_id, location_id, quantity, batch_number?, supplier_name?, expiry_date?, note? }
router.post('/in', requireMinRole('staff'), idempotency, async (req, res) => {
  const { product_id, quantity, note, batch_number, supplier_name, expiry_date, lots, rack_id } = req.body;
  // A manager/staff member almost always means their own warehouse — default
  // to it when omitted so the client doesn't have to ask them to pick it.
  // Explicit values (including an admin acting elsewhere) still flow through
  // untouched and are still checked by assertLocationAccess below.
  const location_id = req.body.location_id || req.user.location_id;
  if (!product_id || !location_id) return fail(res, 'product_id and location_id are required');

  let resolvedLots;
  if (Array.isArray(lots) && lots.length > 0) {
    resolvedLots = lots.map((l) => ({
      quantity: parseFloat(l.quantity),
      batch_number: l.batch_number || null,
      expiry_date: l.expiry_date || null,
    }));
  } else if (quantity) {
    resolvedLots = [{ quantity: parseFloat(quantity), batch_number: batch_number || null, expiry_date: expiry_date || null }];
  } else {
    return fail(res, 'quantity or lots array is required');
  }

  if (resolvedLots.some((l) => isNaN(l.quantity) || l.quantity <= 0)) {
    return fail(res, 'All lot quantities must be positive numbers');
  }

  const totalQuantity = round3(resolvedLots.reduce((s, l) => s + l.quantity, 0));

  try {
    assertLocationAccess(req, location_id);
    const lastResult = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      let last = null;
      for (const lot of resolvedLots) {
        const { rows } = await client.query(
          `select stock_in_lot($1,$2,$3,$4,$5,$6,$7,$8,$9) as result`,
          [product_id, location_id, lot.quantity, note || null, req.user.id, lot.batch_number, supplier_name || null, lot.expiry_date, rack_id || null]
        );
        last = rows[0].result;
      }
      return last;
    });
    return ok(res, { ...lastResult, total_quantity: totalQuantity, lots_count: resolvedLots.length }, 201);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// ─── POST /stock/out ─────────────────────────────────────────────────────────
router.post('/out', requireMinRole('staff'), idempotency, async (req, res) => {
  const { product_id, quantity, note, rack_id } = req.body;
  const location_id = req.body.location_id || req.user.location_id;
  if (!product_id || !location_id || quantity == null) {
    return fail(res, 'product_id, location_id, quantity required');
  }
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) return fail(res, 'quantity must be a positive number');

  try {
    assertLocationAccess(req, location_id);
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `select stock_out($1,$2,$3,$4,$5,$6) as result`,
        [product_id, location_id, round3(qty), note || null, req.user.id, rack_id || null]
      );
      return rows[0].result;
    });
    return ok(res, result || { product_id, location_id, quantity: qty });
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// ─── POST /stock/transfer ────────────────────────────────────────────────────
// A manager/staff member may initiate a transfer only if their own warehouse
// is one side of it (the source giving stock away, or the destination
// receiving it) — never as a third party moving stock between two other
// warehouses they have no assignment to.
router.post('/transfer', requireMinRole('staff'), idempotency, async (req, res) => {
  const { product_id, to_location_id, quantity, note, from_rack_id, to_rack_id } = req.body;
  // Default the FROM side to the caller's own warehouse — the destination is
  // always a deliberate choice and is never defaulted.
  const from_location_id = req.body.from_location_id || req.user.location_id;
  if (!product_id || !from_location_id || !to_location_id || quantity == null) {
    return fail(res, 'product_id, from_location_id, to_location_id, quantity required');
  }
  if (from_location_id === to_location_id) return fail(res, 'Source and destination must differ');

  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) return fail(res, 'quantity must be a positive number');

  try {
    if (req.user.role !== 'admin') {
      const isParty = req.user.location_id === from_location_id || req.user.location_id === to_location_id;
      if (!isParty) throw Object.assign(new Error('You do not have access to this warehouse'), { status: 403 });
    }
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `select transfer_stock($1,$2,$3,$4,$5,$6,$7,$8) as result`,
        [product_id, from_location_id, to_location_id, round3(qty), note || null, req.user.id, from_rack_id || null, to_rack_id || null]
      );
      return rows[0].result;
    });
    return ok(res, result || { transferred: true, quantity: qty });
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// ─── POST /stock/adjust ──────────────────────────────────────────────────────
router.post('/adjust', requireRole('admin'), async (req, res) => {
  const { product_id, location_id, quantity, note } = req.body;
  if (!product_id || !location_id || quantity === undefined) {
    return fail(res, 'product_id, location_id, quantity required');
  }
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty < 0) return fail(res, 'quantity must be zero or positive');

  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows: existingRows } = await client.query(
        'select id, quantity from stock where product_id = $1 and location_id = $2',
        [product_id, location_id]
      );

      let result;
      if (existingRows[0]) {
        const { rows } = await client.query('update stock set quantity = $2 where id = $1 returning *', [existingRows[0].id, qty]);
        result = rows[0];
      } else {
        const { rows } = await client.query(
          'insert into stock (product_id, location_id, quantity) values ($1,$2,$3) returning *',
          [product_id, location_id, qty]
        );
        result = rows[0];
      }

      await client.query(
        `insert into stock_transactions (product_id, to_location_id, transaction_type, quantity, note, performed_by)
         values ($1,$2,'adjustment',$3,$4,$5)`,
        [product_id, location_id, qty, note || 'Manual adjustment', req.user.id]
      );

      return result;
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message);
  }
});

// ─── POST /stock/damage — report available stock as damaged ────────────────
router.post('/damage', requireMinRole('staff'), idempotency, async (req, res) => {
  const { product_id, quantity, note, rack_id } = req.body;
  const location_id = req.body.location_id || req.user.location_id;
  if (!product_id || !location_id || quantity == null) {
    return fail(res, 'product_id, location_id, quantity required');
  }
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) return fail(res, 'quantity must be a positive number');

  try {
    assertLocationAccess(req, location_id);
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      await client.query('select report_damaged_stock($1,$2,$3,$4,$5,$6)', [product_id, location_id, round3(qty), req.user.id, note || null, rack_id || null]);
    });
    return ok(res, { reported: true, quantity: qty });
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// ─── POST /stock/damage/restore — damaged stock turns out fine, return to available ──
router.post('/damage/restore', requireMinRole('staff'), idempotency, async (req, res) => {
  const { product_id, quantity, note, rack_id } = req.body;
  const location_id = req.body.location_id || req.user.location_id;
  if (!product_id || !location_id || quantity == null) {
    return fail(res, 'product_id, location_id, quantity required');
  }
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) return fail(res, 'quantity must be a positive number');

  try {
    assertLocationAccess(req, location_id);
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      await client.query('select restore_damaged_stock($1,$2,$3,$4,$5,$6)', [product_id, location_id, round3(qty), req.user.id, note || null, rack_id || null]);
    });
    return ok(res, { restored: true, quantity: qty });
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// ─── POST /stock/damage/writeoff — damaged stock permanently removed ───────
router.post('/damage/writeoff', requireRole('admin'), idempotency, async (req, res) => {
  const { product_id, location_id, quantity, note } = req.body;
  if (!product_id || !location_id || quantity == null) {
    return fail(res, 'product_id, location_id, quantity required');
  }
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) return fail(res, 'quantity must be a positive number');

  try {
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      await client.query('select writeoff_damaged_stock($1,$2,$3,$4,$5)', [product_id, location_id, round3(qty), req.user.id, note || null]);
    });
    return ok(res, { written_off: true, quantity: qty });
  } catch (err) {
    return fail(res, err.message);
  }
});

module.exports = router;
