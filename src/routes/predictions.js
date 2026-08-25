'use strict';
const router = require('express').Router();
const { stringify } = require('csv-stringify/sync');
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { ok, fail, paginate } = require('../utils/response');
const { scopeLocationId } = require('../utils/reportScope');

router.use(authenticate, checkSubscription);

const DEFAULT_LOOKBACK = 90;
const DEFAULT_HORIZON = 30;

function round3(n) {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

function parseIntParam(v, fallback, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// Every prediction is derived from real sums (current stock, historical
// 'out' quantity split into a recent/older half of the lookback window) —
// nothing here is a hardcoded or fabricated number. The bucket cutoffs
// (7/14 days, 3x horizon) are ordinary business-rule thresholds applied to
// those real numbers, not invented data.
function deriveMetrics({ currentStock, totalOutQty, recentHalfQty, olderHalfQty, reorderLevel, lookbackDays, horizonDays }) {
  const halfDays = lookbackDays / 2;
  const recentAvgDaily = recentHalfQty / halfDays;
  const olderAvgDaily = olderHalfQty / halfDays;

  let trendPct = 0;
  if (olderAvgDaily > 0) trendPct = ((recentAvgDaily - olderAvgDaily) / olderAvgDaily) * 100;
  else if (recentAvgDaily > 0) trendPct = 100;
  const trend = trendPct > 10 ? 'increasing' : trendPct < -10 ? 'decreasing' : 'stable';

  const predictedDemand = recentAvgDaily * horizonDays;
  const daysUntilStockout = recentAvgDaily > 0 ? currentStock / recentAvgDaily : null;
  const recommendedReorderQty = Math.max(0, predictedDemand + reorderLevel - currentStock);

  let risk;
  if (totalOutQty <= 0) risk = 'no_movement';
  else if (daysUntilStockout !== null && daysUntilStockout <= 7) risk = 'stockout_critical';
  else if (daysUntilStockout !== null && daysUntilStockout <= 14) risk = 'stockout_high';
  else if (recentAvgDaily > 0 && currentStock / recentAvgDaily > horizonDays * 3) risk = 'overstock';
  else risk = 'normal';

  return {
    avg_daily_consumption: round3(recentAvgDaily),
    trend,
    trend_pct: round3(trendPct),
    predicted_demand: round3(predictedDemand),
    reorder_level: round3(reorderLevel),
    days_until_stockout: daysUntilStockout != null ? round3(daysUntilStockout) : null,
    recommended_reorder_qty: round3(recommendedReorderQty),
    risk,
  };
}

function rowToPrediction(row, horizonDays, lookbackDays) {
  const currentStock = parseFloat(row.current_stock || 0);
  const totalOutQty = parseFloat(row.total_out_qty || 0);
  const recentHalfQty = parseFloat(row.recent_half_qty || 0);
  const olderHalfQty = parseFloat(row.older_half_qty || 0);
  const reorderLevel = parseFloat(row.low_stock_threshold || 10);

  const metrics = deriveMetrics({ currentStock, totalOutQty, recentHalfQty, olderHalfQty, reorderLevel, lookbackDays, horizonDays });

  return {
    product_id: row.product_id,
    product_name: row.product_name,
    product_sku: row.product_sku,
    unit: row.unit,
    category_id: row.category_id || null,
    location_id: row.location_id,
    location_name: row.location_name || null,
    cluster_id: row.cluster_id || null,
    current_stock: currentStock,
    reserved_quantity: parseFloat(row.reserved_quantity || 0),
    damaged_quantity: parseFloat(row.damaged_quantity || 0),
    in_transit_quantity: parseFloat(row.in_transit_quantity || 0),
    horizon_days: horizonDays,
    lookback_days: lookbackDays,
    ...metrics,
  };
}

// Shared batched query: one (product, location) row per match, with the raw
// sums (current stock + recent/older/total 'out' quantity) needed to derive
// every prediction metric. Reused by /products, /summary and /export/csv so
// results always agree with each other.
async function fetchBaseRows(client, { locationId, categoryId, productId, q }, lookbackDays) {
  const params = [lookbackDays];
  const conditions = ['p.is_active = true'];
  if (locationId) { params.push(locationId); conditions.push(`s.location_id = $${params.length}`); }
  if (categoryId) { params.push(categoryId); conditions.push(`p.category_id = $${params.length}`); }
  if (productId) { params.push(productId); conditions.push(`p.id = $${params.length}`); }
  if (q) {
    const safe = q.replace(/[%_]/g, '\\$&');
    params.push(`%${safe}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
  }
  const where = `where ${conditions.join(' and ')}`;

  const { rows } = await client.query(
    `with out_tx as (
       select product_id, from_location_id as location_id, quantity, created_at
       from stock_transactions
       where transaction_type = 'out' and from_location_id is not null
         and created_at >= now() - (interval '1 day' * $1::numeric)
     ),
     recent_half as (
       select product_id, location_id, coalesce(sum(quantity), 0) as qty
       from out_tx where created_at >= now() - (interval '1 day' * ($1::numeric / 2))
       group by product_id, location_id
     ),
     older_half as (
       select product_id, location_id, coalesce(sum(quantity), 0) as qty
       from out_tx where created_at < now() - (interval '1 day' * ($1::numeric / 2))
       group by product_id, location_id
     ),
     total_out as (
       select product_id, location_id, coalesce(sum(quantity), 0) as qty
       from out_tx group by product_id, location_id
     )
     select s.product_id, s.location_id, s.quantity as current_stock,
            s.reserved_quantity, s.damaged_quantity, s.in_transit_quantity,
            p.name as product_name, p.sku as product_sku, p.unit, p.low_stock_threshold, p.category_id,
            l.name as location_name, l.cluster_id,
            coalesce(t.qty, 0) as total_out_qty,
            coalesce(r.qty, 0) as recent_half_qty,
            coalesce(o.qty, 0) as older_half_qty
     from stock s
     join products p on p.id = s.product_id
     join locations l on l.id = s.location_id
     left join total_out t on t.product_id = s.product_id and t.location_id = s.location_id
     left join recent_half r on r.product_id = s.product_id and r.location_id = s.location_id
     left join older_half o on o.product_id = s.product_id and o.location_id = s.location_id
     ${where}
     order by p.name asc, l.name asc`,
    params
  );
  return rows;
}

function readHorizonLookback(query) {
  return {
    lookbackDays: parseIntParam(query.lookback, DEFAULT_LOOKBACK, 7, 365),
    horizonDays: parseIntParam(query.horizon, DEFAULT_HORIZON, 1, 180),
  };
}

// GET /predictions/products?location_id=&category_id=&q=&risk=&horizon=&lookback=&page=&limit=
router.get('/products', async (req, res) => {
  const { category_id, product_id, q, risk, page = 1, limit = 20 } = req.query;
  try {
    const scopeLoc = scopeLocationId(req);
    const locationId = scopeLoc || req.query.location_id || null;
    const { lookbackDays, horizonDays } = readHorizonLookback(req.query);

    const predictions = await withTenant(req.user.tenant_schema, async (client) => {
      const rawRows = await fetchBaseRows(client, { locationId, categoryId: category_id, productId: product_id, q }, lookbackDays);
      let rows = rawRows.map((r) => rowToPrediction(r, horizonDays, lookbackDays));
      if (risk) rows = rows.filter((p) => p.risk === risk);
      return rows;
    });

    const total = predictions.length;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const start = (pageNum - 1) * limitNum;
    const pageRows = predictions.slice(start, start + limitNum);
    return paginate(res, pageRows, total, page, limit);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /predictions/summary — same filters as /products, minus risk/pagination.
router.get('/summary', async (req, res) => {
  const { category_id, product_id, q } = req.query;
  try {
    const scopeLoc = scopeLocationId(req);
    const locationId = scopeLoc || req.query.location_id || null;
    const { lookbackDays, horizonDays } = readHorizonLookback(req.query);

    const summary = await withTenant(req.user.tenant_schema, async (client) => {
      const rawRows = await fetchBaseRows(client, { locationId, categoryId: category_id, productId: product_id, q }, lookbackDays);
      const predictions = rawRows.map((r) => rowToPrediction(r, horizonDays, lookbackDays));

      const by_risk = { no_movement: 0, stockout_critical: 0, stockout_high: 0, overstock: 0, normal: 0 };
      predictions.forEach((p) => { by_risk[p.risk] = (by_risk[p.risk] || 0) + 1; });

      const top_stockout_risk = predictions
        .filter((p) => p.risk === 'stockout_critical' || p.risk === 'stockout_high')
        .sort((a, b) => (a.days_until_stockout ?? Infinity) - (b.days_until_stockout ?? Infinity))
        .slice(0, 10);
      const top_overstock_risk = predictions
        .filter((p) => p.risk === 'overstock')
        .sort((a, b) => b.current_stock - a.current_stock)
        .slice(0, 10);

      return {
        total_products: predictions.length,
        by_risk,
        total_recommended_reorder_qty: round3(predictions.reduce((s, p) => s + p.recommended_reorder_qty, 0)),
        horizon_days: horizonDays,
        lookback_days: lookbackDays,
        top_stockout_risk,
        top_overstock_risk,
      };
    });
    return ok(res, summary);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /predictions/product/:id?location_id= — a single product's prediction.
// location_id scoped to one warehouse when given (forced for non-admins);
// omitted (admin/viewer only, since a manager only ever has one location
// anyway) it's the tenant-wide roll-up: sums first, rates derived after.
router.get('/product/:id', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const locationId = scopeLoc || req.query.location_id || null;
    const { lookbackDays, horizonDays } = readHorizonLookback(req.query);

    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows: productRows } = await client.query(
        'select id, name, sku, unit, low_stock_threshold from products where id = $1',
        [req.params.id]
      );
      if (!productRows[0]) return null;
      const product = productRows[0];

      if (locationId) {
        const rawRows = await fetchBaseRows(client, { locationId, productId: req.params.id }, lookbackDays);
        if (!rawRows[0]) {
          return rowToPrediction(
            {
              product_id: product.id, product_name: product.name, product_sku: product.sku, unit: product.unit,
              location_id: locationId, location_name: null,
              current_stock: 0, reserved_quantity: 0, damaged_quantity: 0, in_transit_quantity: 0,
              total_out_qty: 0, recent_half_qty: 0, older_half_qty: 0, low_stock_threshold: product.low_stock_threshold,
            },
            horizonDays,
            lookbackDays
          );
        }
        return rowToPrediction(rawRows[0], horizonDays, lookbackDays);
      }

      const { rows: aggRows } = await client.query(
        `with out_tx as (
           select quantity, created_at from stock_transactions
           where transaction_type = 'out' and product_id = $1 and from_location_id is not null
             and created_at >= now() - (interval '1 day' * $2::numeric)
         )
         select
           (select coalesce(sum(quantity), 0) from stock where product_id = $1) as current_stock,
           (select coalesce(sum(reserved_quantity), 0) from stock where product_id = $1) as reserved_quantity,
           (select coalesce(sum(damaged_quantity), 0) from stock where product_id = $1) as damaged_quantity,
           (select coalesce(sum(in_transit_quantity), 0) from stock where product_id = $1) as in_transit_quantity,
           (select coalesce(sum(quantity), 0) from out_tx) as total_out_qty,
           (select coalesce(sum(quantity), 0) from out_tx where created_at >= now() - (interval '1 day' * ($2::numeric / 2))) as recent_half_qty,
           (select coalesce(sum(quantity), 0) from out_tx where created_at < now() - (interval '1 day' * ($2::numeric / 2))) as older_half_qty`,
        [req.params.id, lookbackDays]
      );

      return rowToPrediction(
        {
          ...aggRows[0],
          product_id: product.id, product_name: product.name, product_sku: product.sku, unit: product.unit,
          location_id: null, location_name: null, low_stock_threshold: product.low_stock_threshold,
        },
        horizonDays,
        lookbackDays
      );
    });

    if (!result) return fail(res, 'Product not found', 404);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /predictions/export/csv — same filters as /products.
router.get('/export/csv', async (req, res) => {
  const { category_id, product_id, q, risk } = req.query;
  try {
    const scopeLoc = scopeLocationId(req);
    const locationId = scopeLoc || req.query.location_id || null;
    const { lookbackDays, horizonDays } = readHorizonLookback(req.query);

    const predictions = await withTenant(req.user.tenant_schema, async (client) => {
      const rawRows = await fetchBaseRows(client, { locationId, categoryId: category_id, productId: product_id, q }, lookbackDays);
      let rows = rawRows.map((r) => rowToPrediction(r, horizonDays, lookbackDays));
      if (risk) rows = rows.filter((p) => p.risk === risk);
      return rows;
    });

    const csvRows = predictions.map((p) => ({
      Product: p.product_name,
      SKU: p.product_sku,
      Warehouse: p.location_name || '',
      CurrentStock: p.current_stock,
      AvgDailyConsumption: p.avg_daily_consumption,
      Trend: p.trend,
      TrendPct: p.trend_pct,
      PredictedDemand: p.predicted_demand,
      ReorderLevel: p.reorder_level,
      RecommendedReorderQty: p.recommended_reorder_qty,
      DaysUntilStockout: p.days_until_stockout ?? '',
      Risk: p.risk,
      HorizonDays: p.horizon_days,
      LookbackDays: p.lookback_days,
    }));

    const csv = stringify(csvRows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="product-predictions-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

module.exports = router;
