'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireMinRole } = require('../middleware/roleCheck');
const idempotency = require('../middleware/idempotency');
const { ok, fail, paginate } = require('../utils/response');
const { notifyRequestEvent } = require('../utils/requestNotifications');
const { scopeLocationId } = require('../utils/reportScope');
const { stringify } = require('csv-stringify/sync');

router.use(authenticate, checkSubscription);

// Shared by GET /, /reports/summary and /export/csv so the Product Requests
// report's export always matches whatever's filtered on screen.
function buildRequestFilters(query, alias = 'pr', scopeLoc = null) {
  const { status, product_id, category_id, location_id, cluster_id, from_date, to_date } = query;
  const conditions = [];
  const params = [];
  if (status) { params.push(status); conditions.push(`${alias}.status = $${params.length}`); }
  if (product_id) { params.push(product_id); conditions.push(`${alias}.product_id = $${params.length}`); }
  if (category_id) {
    params.push(category_id);
    conditions.push(`exists (select 1 from products p2 where p2.id = ${alias}.product_id and p2.category_id = $${params.length})`);
  }
  if (location_id) {
    params.push(location_id);
    conditions.push(`(${alias}.source_location_id = $${params.length} or ${alias}.current_target_location_id = $${params.length})`);
  }
  if (cluster_id) {
    params.push(cluster_id);
    conditions.push(`(
      ${alias}.source_location_id in (select id from locations where cluster_id = $${params.length})
      or ${alias}.current_target_location_id in (select id from locations where cluster_id = $${params.length})
    )`);
  }
  if (from_date) { params.push(from_date); conditions.push(`${alias}.created_at >= $${params.length}`); }
  if (to_date) { params.push(to_date); conditions.push(`${alias}.created_at < $${params.length}::date + interval '1 day'`); }
  // A manager/staff member only sees requests where their own warehouse is
  // the source or the (current) target — ANDed on, so it only narrows.
  if (scopeLoc) {
    params.push(scopeLoc);
    conditions.push(`(${alias}.source_location_id = $${params.length} or ${alias}.current_target_location_id = $${params.length})`);
  }
  return { where: conditions.length ? `where ${conditions.join(' and ')}` : '', params };
}

// True when a non-admin's warehouse was (or currently is) a party to this
// request — mirrors buildRequestFilters' own location_id condition so a
// request visible in the scoped list is also viewable via GET /:id.
function requestInScope(scopeLoc, request) {
  if (!scopeLoc) return true;
  return request.source_location_id === scopeLoc || request.current_target_location_id === scopeLoc;
}

const SELECT_JOINED = `
  select pr.*,
    jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'image_url', p.image_url) as products,
    jsonb_build_object('id', sl.id, 'name', sl.name) as source_location,
    case when tl.id is null then null else jsonb_build_object('id', tl.id, 'name', tl.name) end as current_target_location,
    case when u.id is null then null else jsonb_build_object('id', u.id, 'full_name', u.full_name) end as requested_by_profile
  from product_requests pr
  join products p on p.id = pr.product_id
  join locations sl on sl.id = pr.source_location_id
  left join locations tl on tl.id = pr.current_target_location_id
  left join admin_users u on u.id = pr.requested_by
`;

async function loadRequest(client, id) {
  const { rows } = await client.query(`${SELECT_JOINED} where pr.id = $1`, [id]);
  return rows[0] || null;
}

async function loadRoutesAndHistory(client, id) {
  const { rows: routes } = await client.query(
    `select rt.*, jsonb_build_object('id', l.id, 'name', l.name) as target_location,
            case when u.id is null then null else jsonb_build_object('id', u.id, 'full_name', u.full_name) end as decided_by_profile
     from product_request_routes rt
     join locations l on l.id = rt.target_location_id
     left join admin_users u on u.id = rt.decided_by
     where rt.request_id = $1
     order by rt.sequence_no asc`,
    [id]
  );
  const { rows: history } = await client.query(
    `select h.*, case when l.id is null then null else jsonb_build_object('id', l.id, 'name', l.name) end as location,
            case when u.id is null then null else jsonb_build_object('id', u.id, 'full_name', u.full_name) end as performed_by_profile
     from product_request_status_history h
     left join locations l on l.id = h.location_id
     left join admin_users u on u.id = h.performed_by
     where h.request_id = $1
     order by h.created_at asc`,
    [id]
  );
  return { routes, history };
}

// GET /product-requests/reports/summary — registered before /:id so Express
// doesn't swallow the literal path segments "reports"/"export" as :id.
router.get('/reports/summary', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const summary = await withTenant(req.user.tenant_schema, async (client) => {
      const { where, params } = buildRequestFilters(req.query, 'pr', scopeLoc);
      const { rows: statusRows } = await client.query(
        `select pr.status, count(*)::int as count, coalesce(sum(pr.quantity), 0) as quantity
         from product_requests pr ${where} group by pr.status`,
        params
      );
      const by_status = {};
      let total_requests = 0;
      let total_quantity = 0;
      statusRows.forEach((r) => {
        by_status[r.status] = r.count;
        total_requests += r.count;
        total_quantity += parseFloat(r.quantity || 0);
      });
      return { total_requests, total_quantity, by_status };
    });
    return ok(res, summary);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /product-requests/export/csv — same filters as GET /
router.get('/export/csv', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const rows = await withTenant(req.user.tenant_schema, async (client) => {
      const { where, params } = buildRequestFilters(req.query, 'pr', scopeLoc);
      const { rows: data } = await client.query(
        `select pr.status, pr.quantity, pr.note, pr.cancelled_reason, pr.created_at, pr.resolved_at,
                p.name as product_name, p.sku as product_sku,
                sl.name as source_location_name, tl.name as current_target_location_name,
                u.full_name as requested_by_name
         from product_requests pr
         join products p on p.id = pr.product_id
         join locations sl on sl.id = pr.source_location_id
         left join locations tl on tl.id = pr.current_target_location_id
         left join admin_users u on u.id = pr.requested_by
         ${where}
         order by pr.created_at desc`,
        params
      );
      return data;
    });

    const csvRows = rows.map((r) => ({
      Status: r.status,
      Product: r.product_name,
      SKU: r.product_sku,
      Quantity: r.quantity,
      'Source Location': r.source_location_name,
      'Current Target': r.current_target_location_name || '',
      'Requested By': r.requested_by_name || '',
      Note: r.note || '',
      'Cancelled Reason': r.cancelled_reason || '',
      'Created At': r.created_at,
      'Resolved At': r.resolved_at || '',
    }));

    const csv = stringify(csvRows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="product-requests-report-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /product-requests — paginated, filterable
router.get('/', async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    const scopeLoc = scopeLocationId(req);
    const { rows, count } = await withTenant(req.user.tenant_schema, async (client) => {
      const { where, params } = buildRequestFilters(req.query, 'pr', scopeLoc);

      const { rows: countRows } = await client.query(`select count(*)::int as count from product_requests pr ${where}`, params);
      const count = countRows[0].count;

      const limitParams = [...params, Number(limit), offset];
      const { rows } = await client.query(
        `${SELECT_JOINED} ${where} order by pr.created_at desc limit $${limitParams.length - 1} offset $${limitParams.length}`,
        limitParams
      );
      return { rows, count };
    });
    return paginate(res, rows, count, page, limit);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /product-requests/:id
router.get('/:id', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const request = await loadRequest(client, req.params.id);
      if (!request) return null;
      if (!requestInScope(scopeLoc, request)) {
        throw Object.assign(new Error('You do not have access to this warehouse'), { status: 403 });
      }
      const { routes, history } = await loadRoutesAndHistory(client, req.params.id);
      return { ...request, routes, history };
    });
    if (!result) return fail(res, 'Request not found', 404);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 404);
  }
});

// POST /product-requests — D1 creates a request. source_location_id defaults to
// the caller's own location; staff/manager without a location, or requesting on
// behalf of a different location, must pass it explicitly.
router.post('/', requireMinRole('staff'), idempotency, async (req, res) => {
  const { product_id, quantity, note } = req.body;
  const source_location_id = req.body.source_location_id || req.user.location_id;

  if (!product_id || quantity == null) return fail(res, 'product_id and quantity are required');
  if (!source_location_id) return fail(res, 'source_location_id is required (your account has no default location)');
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) return fail(res, 'quantity must be a positive number');

  try {
    const created = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `select create_product_request($1,$2,$3,$4,$5) as id`,
        [product_id, source_location_id, qty, req.user.id, note || null]
      );
      const request = await loadRequest(client, rows[0].id);

      await notifyRequestEvent(client, {
        locationId: request.current_target_location_id,
        title: 'New product request',
        body: `${qty} unit(s) of ${request.products.name} requested from ${request.source_location.name}`,
        requestId: request.id,
        relatedProductId: product_id,
      });

      return request;
    });
    return ok(res, created, 201);
  } catch (err) {
    return fail(res, err.message);
  }
});

// Shared authorization: only an admin, or someone based at the request's
// currently-relevant location, may decide it.
function assertLocationAuthority(req, request, locationField) {
  if (req.user.role === 'admin') return true;
  if (req.user.location_id && req.user.location_id === request[locationField]) return true;
  return false;
}

// POST /product-requests/:id/accept — current target ships stock to the source.
router.post('/:id/accept', requireMinRole('staff'), idempotency, async (req, res) => {
  const { note } = req.body;
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadRequest(client, req.params.id);
      if (!before) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (!assertLocationAuthority(req, before, 'current_target_location_id')) {
        throw Object.assign(new Error('Only the receiving location (or an admin) can accept this request'), { status: 403 });
      }

      await client.query('select accept_product_request($1,$2,$3)', [req.params.id, req.user.id, note || null]);
      const after = await loadRequest(client, req.params.id);

      await notifyRequestEvent(client, {
        locationId: after.source_location_id,
        title: 'Product request accepted',
        body: `${after.current_target_location?.name || 'A location'} accepted your request for ${after.products.name} — stock is in transit`,
        requestId: after.id,
        relatedProductId: after.product_id,
      });

      return after;
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// POST /product-requests/:id/reject — auto-escalates to the next eligible location.
router.post('/:id/reject', requireMinRole('staff'), idempotency, async (req, res) => {
  const { note } = req.body;
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadRequest(client, req.params.id);
      if (!before) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (!assertLocationAuthority(req, before, 'current_target_location_id')) {
        throw Object.assign(new Error('Only the receiving location (or an admin) can reject this request'), { status: 403 });
      }

      const { rows } = await client.query('select reject_product_request($1,$2,$3) as outcome', [req.params.id, req.user.id, note || null]);
      const outcome = rows[0].outcome;
      const after = await loadRequest(client, req.params.id);

      if (outcome === 'escalated') {
        await notifyRequestEvent(client, {
          locationId: after.current_target_location_id,
          title: 'Product request escalated to you',
          body: `${before.current_target_location?.name || 'A location'} could not fulfil a request for ${after.products.name} — it has been routed to you`,
          requestId: after.id,
          relatedProductId: after.product_id,
        });
        await notifyRequestEvent(client, {
          locationId: after.source_location_id,
          title: 'Product request escalated',
          body: `${before.current_target_location?.name || 'A location'} rejected your request for ${after.products.name}; escalated to the next eligible location`,
          requestId: after.id,
          relatedProductId: after.product_id,
        });
      } else {
        await notifyRequestEvent(client, {
          locationId: after.source_location_id,
          title: 'Product request exhausted',
          body: `No eligible location could fulfil your request for ${after.products.name}`,
          requestId: after.id,
          relatedProductId: after.product_id,
        });
      }

      return after;
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// POST /product-requests/:id/receive — source confirms physical receipt.
router.post('/:id/receive', requireMinRole('staff'), idempotency, async (req, res) => {
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadRequest(client, req.params.id);
      if (!before) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (!assertLocationAuthority(req, before, 'source_location_id')) {
        throw Object.assign(new Error('Only the requesting location (or an admin) can confirm receipt'), { status: 403 });
      }

      await client.query('select receive_product_request($1,$2)', [req.params.id, req.user.id]);
      return await loadRequest(client, req.params.id);
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// POST /product-requests/:id/cancel — requester or admin only.
router.post('/:id/cancel', requireMinRole('staff'), idempotency, async (req, res) => {
  const { reason } = req.body;
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadRequest(client, req.params.id);
      if (!before) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (req.user.role !== 'admin' && before.requested_by !== req.user.id) {
        throw Object.assign(new Error('Only the requester (or an admin) can cancel this request'), { status: 403 });
      }

      await client.query('select cancel_product_request($1,$2,$3)', [req.params.id, req.user.id, reason || null]);
      const after = await loadRequest(client, req.params.id);

      if (before.current_target_location_id) {
        await notifyRequestEvent(client, {
          locationId: before.current_target_location_id,
          title: 'Product request cancelled',
          body: `The request for ${after.products.name} from ${after.source_location.name} was cancelled`,
          requestId: after.id,
          relatedProductId: after.product_id,
        });
      }

      return after;
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

module.exports = router;
