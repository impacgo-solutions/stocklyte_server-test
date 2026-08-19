'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole, requireMinRole } = require('../middleware/roleCheck');
const idempotency = require('../middleware/idempotency');
const { ok, fail } = require('../utils/response');

router.use(authenticate, checkSubscription);

// GET /stock
router.get('/', async (req, res) => {
  const { location_id, product_id } = req.query;
  try {
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
    return fail(res, err.message);
  }
});

// GET /stock/low — below threshold with days-until-stockout forecast
router.get('/low', async (req, res) => {
  try {
    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows: stockData } = await client.query(
        `select s.*,
                jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'low_stock_threshold', p.low_stock_threshold, 'image_url', p.image_url) as products,
                jsonb_build_object('id', l.id, 'name', l.name) as locations
         from stock s
         join products p on p.id = s.product_id
         join locations l on l.id = s.location_id`
      );

      const low = stockData.filter((s) => {
        const thresh = s.products?.low_stock_threshold || 10;
        return parseFloat(s.quantity) <= thresh;
      });
      if (low.length === 0) return [];

      const productIds = [...new Set(low.map((s) => s.product_id))];
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const { rows: movements } = await client.query(
        `select product_id, quantity from stock_transactions
         where product_id = any($1) and transaction_type = 'out' and created_at >= $2`,
        [productIds, thirtyDaysAgo.toISOString()]
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
    return fail(res, err.message);
  }
});

// ─── helpers ────────────────────────────────────────────────────────────────

function round3(n) { return Math.round(n * 1000) / 1000; }

// ─── POST /stock/in ─────────────────────────────────────────────────────────
// Accepts either:
//   a) Multi-lot:  { product_id, location_id, supplier_name?, note?, lots: [{quantity, batch_number?, expiry_date?}, …] }
//   b) Single lot: { product_id, location_id, quantity, batch_number?, supplier_name?, expiry_date?, note? }
router.post('/in', requireMinRole('staff'), idempotency, async (req, res) => {
  const { product_id, location_id, quantity, note, batch_number, supplier_name, expiry_date, lots } = req.body;
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
    const lastResult = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      let last = null;
      for (const lot of resolvedLots) {
        const { rows } = await client.query(
          `select stock_in_lot($1,$2,$3,$4,$5,$6,$7,$8) as result`,
          [product_id, location_id, lot.quantity, note || null, req.user.id, lot.batch_number, supplier_name || null, lot.expiry_date]
        );
        last = rows[0].result;
      }
      return last;
    });
    return ok(res, { ...lastResult, total_quantity: totalQuantity, lots_count: resolvedLots.length }, 201);
  } catch (err) {
    return fail(res, err.message);
  }
});

// ─── POST /stock/out ─────────────────────────────────────────────────────────
router.post('/out', requireMinRole('staff'), idempotency, async (req, res) => {
  const { product_id, location_id, quantity, note } = req.body;
  if (!product_id || !location_id || quantity == null) {
    return fail(res, 'product_id, location_id, quantity required');
  }
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) return fail(res, 'quantity must be a positive number');

  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `select stock_out($1,$2,$3,$4,$5) as result`,
        [product_id, location_id, round3(qty), note || null, req.user.id]
      );
      return rows[0].result;
    });
    return ok(res, result || { product_id, location_id, quantity: qty });
  } catch (err) {
    return fail(res, err.message);
  }
});

// ─── POST /stock/transfer ────────────────────────────────────────────────────
router.post('/transfer', requireMinRole('staff'), idempotency, async (req, res) => {
  const { product_id, from_location_id, to_location_id, quantity, note } = req.body;
  if (!product_id || !from_location_id || !to_location_id || quantity == null) {
    return fail(res, 'product_id, from_location_id, to_location_id, quantity required');
  }
  if (from_location_id === to_location_id) return fail(res, 'Source and destination must differ');

  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) return fail(res, 'quantity must be a positive number');

  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `select transfer_stock($1,$2,$3,$4,$5,$6) as result`,
        [product_id, from_location_id, to_location_id, round3(qty), note || null, req.user.id]
      );
      return rows[0].result;
    });
    return ok(res, result || { transferred: true, quantity: qty });
  } catch (err) {
    return fail(res, err.message);
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

module.exports = router;
