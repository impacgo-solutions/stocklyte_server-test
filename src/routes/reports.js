'use strict';
const router = require('express').Router();
const { stringify } = require('csv-stringify/sync');
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { ok, fail } = require('../utils/response');
const { buildTransactionFilters } = require('./transactions');
const { scopeLocationId } = require('../utils/reportScope');

router.use(authenticate, checkSubscription);

// Converts a UTC ISO string to a local YYYY-MM-DD date string using the
// client's timezone offset (in minutes east of UTC, e.g. IST = 330).
function toLocalDate(isoStr, tzOffsetMinutes) {
  const offset = Number(tzOffsetMinutes) || 0;
  const ms = new Date(isoStr).getTime() + offset * 60000;
  return new Date(ms).toISOString().slice(0, 10);
}

// GET /reports/summary
// A manager/staff member gets the exact same shape, computed only from
// their own assigned warehouse rather than the whole tenant.
router.get('/summary', async (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  try {
    const scopeLoc = scopeLocationId(req);
    const summary = await withTenant(req.user.tenant_schema, async (client) => {
      const txLocWhere = scopeLoc ? 'and (t.from_location_id = $2 or t.to_location_id = $2)' : '';
      const txLocParams = scopeLoc ? [monthStart, scopeLoc] : [monthStart];

      const [
        { rows: totalProductsRows },
        { rows: stockRows },
        { rows: lowRows },
        { rows: locationRows },
        { rows: recentTx },
        { rows: monthlyMovements },
      ] = await Promise.all([
        scopeLoc
          ? client.query(`select count(distinct p.id)::int as count from products p join stock s on s.product_id = p.id where p.is_active = true and s.location_id = $1`, [scopeLoc])
          : client.query(`select count(*)::int as count from products where is_active = true`),
        scopeLoc
          ? client.query(`select quantity from stock where location_id = $1`, [scopeLoc])
          : client.query(`select quantity from stock`),
        scopeLoc
          ? client.query(`select s.quantity, p.low_stock_threshold from stock s join products p on p.id = s.product_id where s.location_id = $1`, [scopeLoc])
          : client.query(`select s.quantity, p.low_stock_threshold from stock s join products p on p.id = s.product_id`),
        scopeLoc
          ? client.query(`select count(*)::int as count from locations where is_active = true and id = $1`, [scopeLoc])
          : client.query(`select count(*)::int as count from locations where is_active = true`),
        client.query(`
          select t.*,
            jsonb_build_object('name', p.name, 'sku', p.sku) as products,
            case when fl.id is null then null else jsonb_build_object('name', fl.name) end as from_location,
            case when tl.id is null then null else jsonb_build_object('name', tl.name) end as to_location
          from stock_transactions t
          join products p on p.id = t.product_id
          left join locations fl on fl.id = t.from_location_id
          left join locations tl on tl.id = t.to_location_id
          ${scopeLoc ? 'where t.from_location_id = $1 or t.to_location_id = $1' : ''}
          order by t.created_at desc limit 10
        `, scopeLoc ? [scopeLoc] : []),
        client.query(`select transaction_type, quantity from stock_transactions t where t.created_at >= $1 ${txLocWhere}`, txLocParams),
      ]);

      const totalStock = stockRows.reduce((s, r) => s + parseFloat(r.quantity || 0), 0);
      const lowStockCount = lowRows.filter((r) => parseFloat(r.quantity || 0) <= (r.low_stock_threshold || 10)).length;
      const stockInMonth = monthlyMovements.filter((t) => t.transaction_type === 'in').reduce((s, t) => s + parseFloat(t.quantity || 0), 0);
      const stockOutMonth = monthlyMovements.filter((t) => t.transaction_type === 'out').reduce((s, t) => s + parseFloat(t.quantity || 0), 0);

      return {
        total_products: totalProductsRows[0].count,
        total_stock: totalStock,
        low_stock_count: lowStockCount,
        location_count: locationRows[0].count,
        stock_in_month: stockInMonth,
        stock_out_month: stockOutMonth,
        recent_transactions: recentTx,
      };
    });
    return ok(res, summary);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /reports/stock-movement?from=&to=&tz=330
router.get('/stock-movement', async (req, res) => {
  const { from_date, to_date, tz } = req.query;
  try {
    const scopeLoc = scopeLocationId(req);
    const grouped = await withTenant(req.user.tenant_schema, async (client) => {
      const conditions = [];
      const params = [];
      if (from_date) { params.push(from_date); conditions.push(`created_at >= $${params.length}`); }
      // to_date is a bare YYYY-MM-DD from the client; casting it straight to timestamptz means
      // midnight UTC, which excludes every transaction from that day itself. Use an exclusive
      // upper bound on the *next* day instead so "today" is fully included.
      if (to_date) { params.push(to_date); conditions.push(`created_at < $${params.length}::date + interval '1 day'`); }
      if (scopeLoc) { params.push(scopeLoc); conditions.push(`(from_location_id = $${params.length} or to_location_id = $${params.length})`); }
      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
      const { rows: data } = await client.query(
        `select created_at, transaction_type, quantity from stock_transactions ${where} order by created_at`,
        params
      );

      const grouped = {};
      data.forEach((tx) => {
        const day = toLocalDate(tx.created_at, tz);
        if (!grouped[day]) grouped[day] = { date: day, in: 0, out: 0, transfer: 0, adjustment: 0 };
        grouped[day][tx.transaction_type] += parseFloat(tx.quantity || 0);
      });
      return Object.values(grouped);
    });
    return ok(res, grouped);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /reports/by-location
router.get('/by-location', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows: data } = await client.query(`
        select s.quantity, l.id as location_id, l.name as location_name
        from stock s join locations l on l.id = s.location_id
        ${scopeLoc ? 'where s.location_id = $1' : ''}
      `, scopeLoc ? [scopeLoc] : []);
      const grouped = {};
      data.forEach((s) => {
        const loc = s.location_name || 'Unknown';
        grouped[loc] = (grouped[loc] || 0) + parseFloat(s.quantity || 0);
      });
      return Object.entries(grouped).map(([location, total_stock]) => ({ location, total_stock }));
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /reports/by-category
// For a manager/staff member, both the stock sum and the product_count are
// scoped to products actually stocked at their own warehouse.
router.get('/by-category', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows: data } = await client.query(`
        select p.id as product_id, c.name as category_name, c.color as category_color,
               coalesce((select sum(s.quantity) from stock s where s.product_id = p.id ${scopeLoc ? 'and s.location_id = $1' : ''}), 0) as total_stock
        from products p
        left join categories c on c.id = p.category_id
        where p.is_active = true
        ${scopeLoc ? 'and exists (select 1 from stock ws where ws.product_id = p.id and ws.location_id = $1)' : ''}
      `, scopeLoc ? [scopeLoc] : []);
      const grouped = {};
      data.forEach((p) => {
        const cat = p.category_name || 'Uncategorized';
        const color = p.category_color || '#14B8A6';
        if (!grouped[cat]) grouped[cat] = { category: cat, color, total_stock: 0, product_count: 0 };
        grouped[cat].total_stock += parseFloat(p.total_stock || 0);
        grouped[cat].product_count++;
      });
      return Object.values(grouped);
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /reports/expiry-alerts?days=90
router.get('/expiry-alerts', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + days);
  const todayStr = new Date().toISOString().split('T')[0];
  const targetStr = targetDate.toISOString().split('T')[0];

  try {
    const scopeLoc = scopeLocationId(req);
    const result = await withTenant(req.user.tenant_schema, async (client) => {
      // expiry_date lives on stock_transactions (multi-lot fields), not stock
      const params = [targetStr];
      let locWhere = '';
      if (scopeLoc) { params.push(scopeLoc); locWhere = `and t.to_location_id = $${params.length}`; }
      const { rows: data } = await client.query(
        `select t.*,
                jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'image_url', p.image_url) as products,
                case when l.id is null then null else jsonb_build_object('id', l.id, 'name', l.name) end as to_location
         from stock_transactions t
         join products p on p.id = t.product_id
         left join locations l on l.id = t.to_location_id
         where t.transaction_type = 'in' and t.expiry_date is not null and t.expiry_date <= $1 and t.quantity > 0 ${locWhere}`,
        params
      );

      const mapped = data.map((s) => {
        const diffMs = new Date(s.expiry_date) - new Date(todayStr);
        const days_until_expiry = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        return {
          ...s,
          locations: s.to_location, // Flutter model expects 'locations' key
          quantity: parseFloat(s.quantity || 0),
          days_until_expiry,
          is_expired: days_until_expiry < 0,
        };
      });
      mapped.sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date));
      return mapped;
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /reports/export/csv?from_date=&to_date=&type=&location_id=&product_id=&category_id=&performed_by=
// Same filters as GET /transactions (and thus Stock Activity / Damaged
// Products reports) — the export always matches whatever's filtered on screen.
router.get('/export/csv', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const rows = await withTenant(req.user.tenant_schema, async (client) => {
      const { where, params } = buildTransactionFilters(req.query, 't', scopeLoc);
      const { rows: data } = await client.query(
        `select t.id, t.transaction_type, t.quantity, t.note, t.created_at,
                p.name as product_name, p.sku as product_sku,
                fl.name as from_location_name, tl.name as to_location_name,
                u.full_name as performed_by_name
         from stock_transactions t
         join products p on p.id = t.product_id
         left join locations fl on fl.id = t.from_location_id
         left join locations tl on tl.id = t.to_location_id
         left join admin_users u on u.id = t.performed_by
         ${where}
         order by t.created_at desc`,
        params
      );
      return data;
    });

    const csvRows = rows.map((t) => ({
      ID: t.id,
      Type: t.transaction_type,
      Product: t.product_name || '',
      SKU: t.product_sku || '',
      Quantity: t.quantity,
      From: t.from_location_name || '',
      To: t.to_location_name || '',
      Note: t.note || '',
      PerformedBy: t.performed_by_name || '',
      Date: t.created_at,
    }));

    const csv = stringify(csvRows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="vaultiq-report-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// Shared by /current-stock and its CSV export. `status` computes the same
// classification the Product model's isLowStock/isOutOfStock already use,
// just evaluated per-warehouse (a product's threshold check against ITS
// quantity at that one location) rather than summed tenant-wide.
//
// A manager/staff member's own warehouse always overrides whatever
// location_id/cluster_id they passed (or didn't) — they can only ever see
// their assigned warehouse's current stock, never another one's.
function buildCurrentStockFilters(query, scopeLoc = null) {
  const { location_id, cluster_id, category_id, product_id, status } = query;
  const conditions = [];
  const params = [];
  if (scopeLoc) {
    params.push(scopeLoc);
    conditions.push(`s.location_id = $${params.length}`);
  } else {
    if (location_id) { params.push(location_id); conditions.push(`s.location_id = $${params.length}`); }
    if (cluster_id) { params.push(cluster_id); conditions.push(`l.cluster_id = $${params.length}`); }
  }
  if (category_id) { params.push(category_id); conditions.push(`p.category_id = $${params.length}`); }
  if (product_id) { params.push(product_id); conditions.push(`s.product_id = $${params.length}`); }
  if (status === 'out_of_stock') conditions.push(`s.quantity <= 0`);
  else if (status === 'low_stock') conditions.push(`s.quantity > 0 and s.quantity <= p.low_stock_threshold`);
  else if (status === 'in_stock') conditions.push(`s.quantity > p.low_stock_threshold`);
  return { where: conditions.length ? `where ${conditions.join(' and ')}` : '', params };
}

// GET /reports/current-stock?location_id=&cluster_id=&category_id=&product_id=&status=
router.get('/current-stock', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const rows = await withTenant(req.user.tenant_schema, async (client) => {
      const { where, params } = buildCurrentStockFilters(req.query, scopeLoc);
      const { rows } = await client.query(
        `select s.*,
                jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'unit', p.unit, 'low_stock_threshold', p.low_stock_threshold, 'image_url', p.image_url, 'category_id', p.category_id) as products,
                c.name as category_name, c.color as category_color,
                jsonb_build_object('id', l.id, 'name', l.name, 'cluster_id', l.cluster_id) as locations,
                cl.name as cluster_name,
                case when s.quantity <= 0 then 'out_of_stock'
                     when s.quantity <= p.low_stock_threshold then 'low_stock'
                     else 'in_stock' end as stock_status
         from stock s
         join products p on p.id = s.product_id
         join locations l on l.id = s.location_id
         left join categories c on c.id = p.category_id
         left join clusters cl on cl.id = l.cluster_id
         ${where}
         order by p.name asc, l.name asc`,
        params
      );
      return rows;
    });
    return ok(res, rows);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /reports/current-stock/export/csv — same filters as /current-stock
router.get('/current-stock/export/csv', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const rows = await withTenant(req.user.tenant_schema, async (client) => {
      const { where, params } = buildCurrentStockFilters(req.query, scopeLoc);
      const { rows } = await client.query(
        `select p.name as product_name, p.sku as product_sku, c.name as category_name,
                l.name as location_name, s.quantity, s.reserved_quantity, s.in_transit_quantity, s.damaged_quantity,
                p.low_stock_threshold,
                case when s.quantity <= 0 then 'Out of Stock'
                     when s.quantity <= p.low_stock_threshold then 'Low Stock'
                     else 'In Stock' end as stock_status
         from stock s
         join products p on p.id = s.product_id
         join locations l on l.id = s.location_id
         left join categories c on c.id = p.category_id
         ${where}
         order by p.name asc, l.name asc`,
        params
      );
      return rows;
    });

    const csvRows = rows.map((r) => ({
      Product: r.product_name,
      SKU: r.product_sku,
      Category: r.category_name || '',
      Warehouse: r.location_name,
      Quantity: r.quantity,
      Reserved: r.reserved_quantity,
      InTransit: r.in_transit_quantity,
      Damaged: r.damaged_quantity,
      Threshold: r.low_stock_threshold,
      Status: r.stock_status,
    }));

    const csv = stringify(csvRows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="current-stock-report-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /reports/product/:id?period=7d|30d|90d|all
// A manager/staff member gets this same per-product report scoped to just
// their own warehouse's stock and transaction history.
router.get('/product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { period = '30d', tz } = req.query;
    const scopeLoc = scopeLocationId(req);

    let fromDate = null;
    if (period !== 'all') {
      const days = parseInt(period) || 30;
      const from = new Date();
      from.setDate(from.getDate() - days);
      fromDate = from.toISOString().split('T')[0];
    }

    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows: productRows } = await client.query(
        `select p.id, p.name, p.sku, p.unit, p.image_url, p.low_stock_threshold,
                c.name as category_name, c.color as category_color
         from products p left join categories c on c.id = p.category_id
         where p.id = $1`,
        [id]
      );
      if (!productRows[0]) return null;
      const product = productRows[0];

      const stockParams = [id];
      let stockWhere = 'where s.product_id = $1';
      if (scopeLoc) { stockParams.push(scopeLoc); stockWhere += ` and s.location_id = $${stockParams.length}`; }
      const { rows: stockData } = await client.query(
        `select s.quantity, s.location_id, l.id as loc_id, l.name as loc_name
         from stock s join locations l on l.id = s.location_id
         ${stockWhere}`,
        stockParams
      );

      const txParams = [id];
      let txWhere = 'where t.product_id = $1';
      if (fromDate) { txParams.push(fromDate); txWhere += ` and t.created_at >= $${txParams.length}`; }
      if (scopeLoc) { txParams.push(scopeLoc); txWhere += ` and (t.from_location_id = $${txParams.length} or t.to_location_id = $${txParams.length})`; }
      const { rows: transactions } = await client.query(
        `select t.id, t.transaction_type, t.quantity, t.note, t.created_at,
                case when fl.id is null then null else jsonb_build_object('id', fl.id, 'name', fl.name) end as from_location,
                case when tl.id is null then null else jsonb_build_object('id', tl.id, 'name', tl.name) end as to_location,
                u.full_name as performed_by_name
         from stock_transactions t
         left join locations fl on fl.id = t.from_location_id
         left join locations tl on tl.id = t.to_location_id
         left join admin_users u on u.id = t.performed_by
         ${txWhere}
         order by t.created_at desc`,
        txParams
      );

      let totalIn = 0, totalOut = 0, totalTransfer = 0, totalAdjustment = 0;
      const dailyMap = {};
      for (const tx of transactions) {
        const day = toLocalDate(tx.created_at, tz);
        if (!dailyMap[day]) dailyMap[day] = { date: day, stock_in: 0, stock_out: 0 };
        const qty = parseFloat(tx.quantity || 0);
        switch (tx.transaction_type) {
          case 'in': totalIn += qty; dailyMap[day].stock_in += qty; break;
          case 'out': totalOut += qty; dailyMap[day].stock_out += qty; break;
          case 'transfer': totalTransfer += qty; break;
          case 'adjustment': totalAdjustment += qty; break;
        }
      }

      const timeline = [];
      if (fromDate) {
        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);
        for (let d = new Date(fromDate + 'T00:00:00Z'); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
          const dateStr = d.toISOString().split('T')[0];
          timeline.push(dailyMap[dateStr] || { date: dateStr, stock_in: 0, stock_out: 0 });
        }
      } else {
        Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date)).forEach((d) => timeline.push(d));
      }

      const byLocation = stockData
        .map((s) => ({ location_id: s.location_id, location_name: s.loc_name || 'Unknown', quantity: parseFloat(s.quantity || 0) }))
        .sort((a, b) => b.quantity - a.quantity);

      const currentStock = byLocation.reduce((sum, l) => sum + l.quantity, 0);
      const threshold = product.low_stock_threshold || 10;

      return {
        product: {
          id: product.id,
          name: product.name,
          sku: product.sku,
          unit: product.unit,
          image_url: product.image_url,
          low_stock_threshold: threshold,
          category_name: product.category_name || null,
          category_color: product.category_color || '#14B8A6',
        },
        summary: {
          current_stock: currentStock,
          low_stock_threshold: threshold,
          is_low_stock: currentStock <= threshold,
          total_in: totalIn,
          total_out: totalOut,
          total_transfer: totalTransfer,
          total_adjustment: totalAdjustment,
          net_movement: totalIn - totalOut,
          transaction_count: transactions.length,
        },
        by_location: byLocation,
        timeline,
        transactions: transactions.slice(0, 50).map((tx) => ({
          id: tx.id,
          transaction_type: tx.transaction_type,
          quantity: tx.quantity,
          note: tx.note || null,
          created_at: tx.created_at,
          from_location: tx.from_location,
          to_location: tx.to_location,
          performed_by: tx.performed_by_name || null,
        })),
      };
    });

    if (!result) return fail(res, 'Product not found', 404);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// Rounds to 3 decimal places to avoid floating-point drift from repeated +/-
// (stock quantities are numeric(14,3) in Postgres).
function round3(n) {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

// GET /reports/inventory-movement?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD&product_id=<optional>
// Per-product Opening/Stock In/Stock Out/Closing for a custom date range, computed by
// replaying the stock_transactions ledger chronologically per (product, location) and
// summing across locations. 'adjustment' rows store an absolute new quantity (not a
// delta) and 'transfer' rows are written once per location touched, so both are handled
// as location-scoped balance updates rather than naive sums — this keeps
// opening + stock_in - stock_out === closing true even when adjustments occur mid-range.
router.get('/inventory-movement', async (req, res) => {
  try {
    const { from_date, to_date, product_id } = req.query;
    if (!from_date || !to_date) return fail(res, 'from_date and to_date are required', 400);

    const fromTime = new Date(`${from_date}T00:00:00.000Z`).getTime();
    const toTime = new Date(`${to_date}T23:59:59.999Z`).getTime();
    if (Number.isNaN(fromTime) || Number.isNaN(toTime)) return fail(res, 'Invalid from_date/to_date', 400);

    const scopeLoc = scopeLocationId(req);

    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const params = [];
      let where = 'where is_active = true';
      if (product_id) { params.push(product_id); where += ` and id = $${params.length}`; }
      const { rows: products } = await client.query(`select id, sku, name, unit from products ${where} order by name`, params);
      if (!products.length) return { from_date, to_date, rows: [] };

      const productIds = products.map((p) => p.id);

      const txParams = [productIds, new Date(toTime).toISOString()];
      let txWhere = 'where product_id = any($1) and created_at <= $2';
      if (scopeLoc) { txParams.push(scopeLoc); txWhere += ` and (from_location_id = $${txParams.length} or to_location_id = $${txParams.length})`; }

      const stockParams = [productIds];
      let stockWhere = 'where product_id = any($1)';
      if (scopeLoc) { stockParams.push(scopeLoc); stockWhere += ` and location_id = $${stockParams.length}`; }

      const [{ rows: transactions }, { rows: stockRows }] = await Promise.all([
        client.query(
          `select product_id, from_location_id, to_location_id, transaction_type, quantity, created_at
           from stock_transactions
           ${txWhere}
           order by created_at asc`,
          txParams
        ),
        client.query(`select product_id, quantity from stock ${stockWhere}`, stockParams),
      ]);

      const txByProduct = new Map();
      for (const tx of transactions) {
        if (!txByProduct.has(tx.product_id)) txByProduct.set(tx.product_id, []);
        txByProduct.get(tx.product_id).push(tx);
      }

      const currentStockByProduct = new Map();
      for (const s of stockRows) {
        currentStockByProduct.set(s.product_id, (currentStockByProduct.get(s.product_id) || 0) + parseFloat(s.quantity || 0));
      }

      const rows = products.map((product) => {
        const txs = txByProduct.get(product.id) || [];

        if (!txs.length) {
          const current = round3(currentStockByProduct.get(product.id) || 0);
          return { item_code: product.sku, name: product.name, unit: product.unit, opening: current, stock_in: 0, stock_out: 0, closing: current };
        }

        const locationIds = new Set();
        txs.forEach((t) => {
          if (t.from_location_id) locationIds.add(t.from_location_id);
          if (t.to_location_id) locationIds.add(t.to_location_id);
        });

        let opening = 0, stockIn = 0, stockOut = 0, closing = 0;

        for (const locId of locationIds) {
          const locTxs = txs.filter((t) => t.from_location_id === locId || t.to_location_id === locId);
          let balance = 0;
          let locOpening = 0;
          let openingCaptured = false;

          for (const tx of locTxs) {
            const txTime = new Date(tx.created_at).getTime();
            if (!openingCaptured && txTime >= fromTime) {
              locOpening = balance;
              openingCaptured = true;
            }

            const qty = parseFloat(tx.quantity || 0);
            const before = balance;
            let after = before;
            switch (tx.transaction_type) {
              case 'in':
                if (tx.to_location_id === locId) after = before + qty;
                break;
              case 'out':
                if (tx.from_location_id === locId) after = before - qty;
                break;
              case 'transfer':
                if (tx.to_location_id === locId) after = before + qty;
                else if (tx.from_location_id === locId) after = before - qty;
                break;
              case 'adjustment':
                if (tx.to_location_id === locId) after = qty;
                break;
            }
            balance = after;

            if (txTime >= fromTime && txTime <= toTime) {
              const delta = after - before;
              if (delta > 0) stockIn += delta;
              else if (delta < 0) stockOut += -delta;
            }
          }

          if (!openingCaptured) locOpening = balance;
          opening += locOpening;
          closing += balance;
        }

        return {
          item_code: product.sku,
          name: product.name,
          unit: product.unit,
          opening: round3(opening),
          stock_in: round3(stockIn),
          stock_out: round3(stockOut),
          closing: round3(closing),
        };
      });

      return { from_date, to_date, rows };
    });

    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

module.exports = router;
