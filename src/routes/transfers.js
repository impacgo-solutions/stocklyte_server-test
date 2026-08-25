'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { stringify } = require('csv-stringify/sync');
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireMinRole } = require('../middleware/roleCheck');
const idempotency = require('../middleware/idempotency');
const { ok, fail, paginate } = require('../utils/response');
const { notifyTransferEvent } = require('../utils/transferNotifications');
const { scopeLocationId } = require('../utils/reportScope');

router.use(authenticate, checkSubscription);

// ── Authority helpers ───────────────────────────────────────────────────────
// Push-transfer model: the SOURCE warehouse creates/submits/ships; the
// DESTINATION warehouse receives; cancelling is creator-or-admin only.
// Approve/reject is hierarchy-based (see submit_transfer()'s routing logic
// in migrations 008/009): a Staff-created transfer goes to that warehouse's
// Manager, a Manager-created transfer goes to their configured Head if one
// exists (else it auto-approves), and only the specific person it was routed
// to — tracked in transfers.pending_approver_id — may act on it. An admin
// may always do any step regardless of location or routing.

function isAdmin(req) {
  return req.user.role === 'admin';
}

// A transfer request is created/edited/deleted only by a staff member or
// manager of the SOURCE warehouse (or an admin) — the same warehouse-level
// structure the approval hierarchy already uses. Destination-side users
// don't get a say until it's actually shipped to them.
function assertSourceParty(req, sourceLocationId) {
  if (isAdmin(req)) return;
  if (req.user.location_id !== sourceLocationId) {
    throw Object.assign(new Error('Only a staff member or manager of the source warehouse can create or edit this transfer'), { status: 403 });
  }
}

function assertSourceAuthority(req, transfer, verb) {
  if (isAdmin(req)) return;
  if (req.user.location_id !== transfer.source_location_id) {
    throw Object.assign(new Error(`Only the source warehouse (or an admin) can ${verb} this transfer`), { status: 403 });
  }
}

function assertDestinationAuthority(req, transfer, verb) {
  if (isAdmin(req)) return;
  if (req.user.location_id !== transfer.destination_location_id) {
    throw Object.assign(new Error(`Only the destination warehouse (or an admin) can ${verb} this transfer`), { status: 403 });
  }
}

// Cluster Relationship Management: a transfer between two locations in
// different clusters requires an active cluster_relationships row (source's
// cluster -> destination's cluster) with allow_transfers = true. A location
// with no cluster, or the same cluster on both sides, is always eligible —
// this mirrors next_eligible_location()'s own cluster-eligibility rule
// exactly, kept in sync deliberately since both express the same policy.
async function assertClustersCanTransfer(client, sourceLocationId, destinationLocationId) {
  const { rows } = await client.query(
    `select
       (select cluster_id from locations where id = $1) as source_cluster_id,
       (select cluster_id from locations where id = $2) as destination_cluster_id`,
    [sourceLocationId, destinationLocationId]
  );
  const { source_cluster_id, destination_cluster_id } = rows[0] || {};
  if (!source_cluster_id || !destination_cluster_id || source_cluster_id === destination_cluster_id) return;

  const { rows: rel } = await client.query(
    `select 1 from cluster_relationships
     where source_cluster_id = $1 and target_cluster_id = $2 and allow_transfers = true and is_active = true`,
    [source_cluster_id, destination_cluster_id]
  );
  if (rel.length === 0) {
    throw Object.assign(new Error('These warehouses are in clusters that are not configured to exchange transfers'), { status: 403 });
  }
}

// Hierarchy-based approval gate: only the specific person submit_transfer()
// routed this to (transfer.pending_approver_id) — or an admin — may decide
// it. This is what actually prevents a Manager from approving their own
// transfer once they have a configured Head: pending_approver_id is the
// Head's id, not the Manager's, so the Manager fails this check.
function assertIsPendingApprover(req, transfer, verb) {
  if (isAdmin(req)) return;
  if (!transfer.pending_approver_id || req.user.id !== transfer.pending_approver_id) {
    throw Object.assign(new Error(`Only the assigned approver (or an admin) can ${verb} this transfer`), { status: 403 });
  }
}

// ── Shared query pieces ─────────────────────────────────────────────────────

const SELECT_HEADER = `
  select t.*,
    jsonb_build_object('id', sl.id, 'name', sl.name) as source_location,
    jsonb_build_object('id', dl.id, 'name', dl.name) as destination_location,
    case when ru.id is null then null else jsonb_build_object('id', ru.id, 'full_name', ru.full_name) end as requested_by_profile,
    case when au.id is null then null else jsonb_build_object('id', au.id, 'full_name', au.full_name) end as approved_by_profile,
    case when su.id is null then null else jsonb_build_object('id', su.id, 'full_name', su.full_name) end as shipped_by_profile,
    case when rcu.id is null then null else jsonb_build_object('id', rcu.id, 'full_name', rcu.full_name) end as received_by_profile,
    case when pau.id is null then null else jsonb_build_object('id', pau.id, 'full_name', pau.full_name) end as pending_approver_profile,
    (select count(*)::int from transfer_items ti where ti.transfer_id = t.id) as item_count,
    (select coalesce(sum(quantity), 0) from transfer_items ti where ti.transfer_id = t.id) as total_quantity
  from transfers t
  join locations sl on sl.id = t.source_location_id
  join locations dl on dl.id = t.destination_location_id
  left join admin_users ru on ru.id = t.requested_by
  left join admin_users au on au.id = t.approved_by
  left join admin_users su on su.id = t.shipped_by
  left join admin_users rcu on rcu.id = t.received_by
  left join admin_users pau on pau.id = t.pending_approver_id
`;

async function loadTransfer(client, id) {
  const { rows } = await client.query(`${SELECT_HEADER} where t.id = $1`, [id]);
  return rows[0] || null;
}

async function loadItemsAndHistory(client, id) {
  const { rows: items } = await client.query(
    `select ti.*, jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'unit', p.unit, 'image_url', p.image_url) as products
     from transfer_items ti join products p on p.id = ti.product_id
     where ti.transfer_id = $1 order by ti.created_at asc`,
    [id]
  );
  const { rows: history } = await client.query(
    `select h.*, case when u.id is null then null else jsonb_build_object('id', u.id, 'full_name', u.full_name) end as performed_by_profile
     from transfer_status_history h left join admin_users u on u.id = h.performed_by
     where h.transfer_id = $1 order by h.created_at asc`,
    [id]
  );
  return { items, history };
}

// status / location / cluster / product / date-range / reference-number filters,
// shared by the list, summary and CSV export endpoints so exported rows always
// match what's on screen.
function buildTransferFilters(query, scopeLoc = null, viewerId = null) {
  const { status, location_id, cluster_id, product_id, from_date, to_date, q } = query;
  const conditions = [];
  const params = [];

  if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }

  if (location_id) {
    params.push(location_id);
    conditions.push(`(t.source_location_id = $${params.length} or t.destination_location_id = $${params.length})`);
  }

  if (cluster_id) {
    params.push(cluster_id);
    conditions.push(`(
      t.source_location_id in (select id from locations where cluster_id = $${params.length})
      or t.destination_location_id in (select id from locations where cluster_id = $${params.length})
    )`);
  }

  if (product_id) {
    params.push(product_id);
    conditions.push(`exists (select 1 from transfer_items ti2 where ti2.transfer_id = t.id and ti2.product_id = $${params.length})`);
  }

  if (from_date) { params.push(from_date); conditions.push(`t.transfer_date >= $${params.length}`); }
  if (to_date) { params.push(to_date); conditions.push(`t.transfer_date <= $${params.length}`); }

  if (q) { params.push(`%${q}%`); conditions.push(`t.transfer_number ilike $${params.length}`); }

  // A manager/staff member only sees transfers where their own warehouse is
  // the source or destination — ANDed on, so it only narrows — with one
  // deliberate exception: a transfer currently routed to THEM for a
  // hierarchy-based approval decision (transfers.pending_approver_id, see
  // submit_transfer()) always stays visible even if it's between two other
  // warehouses, since a configured Head can sit above managers at other
  // locations and needs to see what's awaiting their own decision.
  if (scopeLoc) {
    params.push(scopeLoc);
    const locParam = params.length;
    params.push(viewerId);
    const viewerParam = params.length;
    conditions.push(`(t.source_location_id = $${locParam} or t.destination_location_id = $${locParam} or t.pending_approver_id = $${viewerParam})`);
  }

  return { where: conditions.length ? `where ${conditions.join(' and ')}` : '', params };
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('At least one line item is required'), { status: 400 });
  }
  const seen = new Set();
  for (const it of items) {
    if (!it.product_id || it.quantity == null) {
      throw Object.assign(new Error('Each item requires product_id and quantity'), { status: 400 });
    }
    const qty = parseFloat(it.quantity);
    if (isNaN(qty) || qty <= 0) {
      throw Object.assign(new Error('Each item quantity must be a positive number'), { status: 400 });
    }
    if (seen.has(it.product_id)) {
      throw Object.assign(new Error('Duplicate product in line items — combine into a single line'), { status: 400 });
    }
    seen.add(it.product_id);
  }
}

// ── Reports (registered before /:id so Express doesn't swallow the literal
//    path segments "reports"/"export" as the :id param) ────────────────────

// GET /transfers/reports/summary
router.get('/reports/summary', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const summary = await withTenant(req.user.tenant_schema, async (client) => {
      const { where, params } = buildTransferFilters(req.query, scopeLoc, req.user.id);
      const { rows: statusRows } = await client.query(
        `select t.status, count(*)::int as count from transfers t ${where} group by t.status`,
        params
      );
      const { rows: totalsRows } = await client.query(
        `select count(distinct t.id)::int as total_transfers,
                coalesce(sum(ti.quantity), 0) as total_quantity,
                count(ti.id)::int as total_line_items
         from transfers t
         left join transfer_items ti on ti.transfer_id = t.id
         ${where}`,
        params
      );
      const by_status = {};
      statusRows.forEach((r) => { by_status[r.status] = r.count; });
      return {
        total_transfers: totalsRows[0].total_transfers,
        total_quantity: parseFloat(totalsRows[0].total_quantity || 0),
        total_line_items: totalsRows[0].total_line_items,
        by_status,
      };
    });
    return ok(res, summary);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /transfers/export/csv — one row per line item, same filters as the list/summary
router.get('/export/csv', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const rows = await withTenant(req.user.tenant_schema, async (client) => {
      const { where, params } = buildTransferFilters(req.query, scopeLoc, req.user.id);
      const { rows: data } = await client.query(
        `select t.transfer_number, t.status, t.transfer_date, t.reason, t.approval_level,
                sl.name as source_name, dl.name as destination_name,
                p.name as product_name, p.sku as product_sku, ti.quantity,
                ru.full_name as requested_by_name, au.full_name as approved_by_name,
                su.full_name as shipped_by_name, rcu.full_name as received_by_name,
                ru2.full_name as rejected_by_name,
                t.created_at
         from transfers t
         join locations sl on sl.id = t.source_location_id
         join locations dl on dl.id = t.destination_location_id
         join transfer_items ti on ti.transfer_id = t.id
         join products p on p.id = ti.product_id
         left join admin_users ru on ru.id = t.requested_by
         left join admin_users au on au.id = t.approved_by
         left join admin_users su on su.id = t.shipped_by
         left join admin_users rcu on rcu.id = t.received_by
         left join admin_users ru2 on ru2.id = t.rejected_by
         ${where}
         order by t.created_at desc, p.name asc`,
        params
      );
      return data;
    });

    const csvRows = rows.map((r) => ({
      'Transfer Number': r.transfer_number,
      Status: r.status,
      'Approval Level': r.approval_level || '',
      'Transfer Date': r.transfer_date,
      Source: r.source_name,
      Destination: r.destination_name,
      Product: r.product_name,
      SKU: r.product_sku,
      Quantity: r.quantity,
      Reason: r.reason || '',
      'Requested By': r.requested_by_name || '',
      'Approved By': r.approved_by_name || '',
      'Rejected By': r.rejected_by_name || '',
      'Shipped By': r.shipped_by_name || '',
      'Received By': r.received_by_name || '',
      'Created At': r.created_at,
    }));

    const csv = stringify(csvRows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="transfer-report-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// ── CRUD + history ───────────────────────────────────────────────────────────

// GET /transfers — paginated, filterable. This is the Transfer History feed.
router.get('/', async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const scopeLoc = scopeLocationId(req);
    const { rows, count } = await withTenant(req.user.tenant_schema, async (client) => {
      const { where, params } = buildTransferFilters(req.query, scopeLoc, req.user.id);
      const { rows: countRows } = await client.query(`select count(*)::int as count from transfers t ${where}`, params);
      const count = countRows[0].count;

      const limitParams = [...params, Number(limit), offset];
      const { rows } = await client.query(
        `${SELECT_HEADER} ${where} order by t.created_at desc limit $${limitParams.length - 1} offset $${limitParams.length}`,
        limitParams
      );
      return { rows, count };
    });
    return paginate(res, rows, count, page, limit);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// GET /transfers/:id
router.get('/:id', async (req, res) => {
  try {
    const scopeLoc = scopeLocationId(req);
    const result = await withTenant(req.user.tenant_schema, async (client) => {
      const transfer = await loadTransfer(client, req.params.id);
      if (!transfer) return null;
      // Same exception as buildTransferFilters(): the person it's routed to
      // for a hierarchy approval decision can always see it.
      if (
        scopeLoc &&
        transfer.source_location_id !== scopeLoc &&
        transfer.destination_location_id !== scopeLoc &&
        transfer.pending_approver_id !== req.user.id
      ) {
        throw Object.assign(new Error('You do not have access to this warehouse'), { status: 403 });
      }
      const { items, history } = await loadItemsAndHistory(client, req.params.id);
      return { ...transfer, items, history };
    });
    if (!result) return fail(res, 'Transfer not found', 404);
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 404);
  }
});

// POST /transfers — creates a Draft (header + line items, one transaction).
router.post('/', requireMinRole('staff'), idempotency, async (req, res) => {
  const { destination_location_id, transfer_date, reason, note, items } = req.body;
  // A staff member or manager creating a transfer almost always means their
  // own warehouse as the source — default to it when omitted (same idiom as
  // product-requests' source_location_id default). Destination is always a
  // deliberate choice and is never defaulted.
  const source_location_id = req.body.source_location_id || req.user.location_id;

  if (!source_location_id || !destination_location_id) {
    return fail(res, 'source_location_id and destination_location_id are required');
  }
  if (source_location_id === destination_location_id) return fail(res, 'Source and destination must differ');
  if (!reason || !reason.trim()) return fail(res, 'reason is required');

  try {
    validateItems(items);
    assertSourceParty(req, source_location_id);

    const transferId = uuidv4();
    const transferNumber = 'TRF-' + transferId.replace(/-/g, '').slice(0, 8).toUpperCase();

    const created = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      await assertClustersCanTransfer(client, source_location_id, destination_location_id);

      await client.query(
        `insert into transfers (id, transfer_number, source_location_id, destination_location_id, transfer_date, reason, note, requested_by)
         values ($1, $2, $3, $4, coalesce($5, current_date), $6, $7, $8)`,
        [transferId, transferNumber, source_location_id, destination_location_id, transfer_date || null, reason.trim(), note || null, req.user.id]
      );

      for (const it of items) {
        await client.query(
          `insert into transfer_items (transfer_id, product_id, quantity, note) values ($1, $2, $3, $4)`,
          [transferId, it.product_id, parseFloat(it.quantity), it.note || null]
        );
      }

      await client.query(
        `insert into transfer_status_history (transfer_id, from_status, to_status, performed_by) values ($1, null, 'draft', $2)`,
        [transferId, req.user.id]
      );

      const transfer = await loadTransfer(client, transferId);
      const { items: savedItems, history } = await loadItemsAndHistory(client, transferId);
      return { ...transfer, items: savedItems, history };
    });

    return ok(res, created, 201);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// PUT /transfers/:id — edits a Draft (header fields + full item replacement).
router.put('/:id', requireMinRole('staff'), async (req, res) => {
  const { source_location_id, destination_location_id, transfer_date, reason, note, items } = req.body;
  try {
    const updated = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const existing = await loadTransfer(client, req.params.id);
      if (!existing) throw Object.assign(new Error('Transfer not found'), { status: 404 });
      if (existing.status !== 'draft') throw Object.assign(new Error('Only a draft transfer can be edited'), { status: 400 });
      assertSourceParty(req, existing.source_location_id);

      const newSource = source_location_id || existing.source_location_id;
      const newDest = destination_location_id || existing.destination_location_id;
      if (newSource === newDest) throw Object.assign(new Error('Source and destination must differ'), { status: 400 });
      if (newSource !== existing.source_location_id) assertSourceParty(req, newSource);
      await assertClustersCanTransfer(client, newSource, newDest);

      await client.query(
        `update transfers set
           source_location_id = $2, destination_location_id = $3,
           transfer_date = coalesce($4, transfer_date), reason = coalesce($5, reason),
           note = $6, updated_at = now()
         where id = $1`,
        [req.params.id, newSource, newDest, transfer_date || null, reason ? reason.trim() : null, note === undefined ? existing.note : note]
      );

      if (items !== undefined) {
        validateItems(items);
        await client.query('delete from transfer_items where transfer_id = $1', [req.params.id]);
        for (const it of items) {
          await client.query(
            `insert into transfer_items (transfer_id, product_id, quantity, note) values ($1, $2, $3, $4)`,
            [req.params.id, it.product_id, parseFloat(it.quantity), it.note || null]
          );
        }
      }

      const transfer = await loadTransfer(client, req.params.id);
      const { items: savedItems, history } = await loadItemsAndHistory(client, req.params.id);
      return { ...transfer, items: savedItems, history };
    });
    return ok(res, updated);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// DELETE /transfers/:id — deletes a Draft only.
router.delete('/:id', requireMinRole('staff'), async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const existing = await loadTransfer(client, req.params.id);
      if (!existing) throw Object.assign(new Error('Transfer not found'), { status: 404 });
      if (existing.status !== 'draft') throw Object.assign(new Error('Only a draft transfer can be deleted'), { status: 400 });
      assertSourceParty(req, existing.source_location_id);
      await client.query('delete from transfers where id = $1', [req.params.id]);
    });
    return ok(res, { deleted: true });
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// ── Workflow actions ─────────────────────────────────────────────────────────

// POST /transfers/:id/submit — Draft -> Requested. Source's call.
router.post('/:id/submit', requireMinRole('staff'), idempotency, async (req, res) => {
  const { note } = req.body;
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadTransfer(client, req.params.id);
      if (!before) throw Object.assign(new Error('Transfer not found'), { status: 404 });
      assertSourceAuthority(req, before, 'submit');

      await client.query('select submit_transfer($1, $2, $3)', [req.params.id, req.user.id, note || null]);
      const after = await loadTransfer(client, req.params.id);

      // submit_transfer() routes hierarchy-based: notify whoever the outcome
      // actually concerns rather than blanket-notifying a whole location.
      if (after.status === 'requested' && after.pending_approver_id) {
        await notifyTransferEvent(client, {
          userId: after.pending_approver_id,
          title: 'Transfer awaiting your approval',
          body: `Transfer ${after.transfer_number} from ${after.source_location.name} to ${after.destination_location.name} needs your decision`,
        });
      } else if (after.status === 'in_transit') {
        await notifyTransferEvent(client, {
          locationId: after.destination_location_id,
          title: 'Transfer ready to receive',
          body: `Transfer ${after.transfer_number} from ${after.source_location.name} was auto-approved and is ready to be received (no senior approver configured)`,
        });
      }

      const { items, history } = await loadItemsAndHistory(client, req.params.id);
      return { ...after, items, history };
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// POST /transfers/:id/approve — Requested -> Approved -> In Transit, in one
// step. Only the person submit_transfer() routed this to (or an admin) may
// decide it — the source warehouse's own Manager/Head. Their approval IS the
// go-ahead to send the stock, so shipping happens immediately as part of
// approving rather than waiting on a second manual "Ship" click; the
// destination is then notified to decide whether to accept or reject the
// incoming delivery. approve_transfer()/ship_transfer() are unchanged — this
// route just chains them in the same transaction (atomic: if ship_transfer's
// stock re-check fails, the whole approval rolls back to 'requested' so the
// approver sees a clear error instead of a stuck half-approved transfer).
router.post('/:id/approve', requireMinRole('staff'), idempotency, async (req, res) => {
  const { note } = req.body;
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadTransfer(client, req.params.id);
      if (!before) throw Object.assign(new Error('Transfer not found'), { status: 404 });
      assertIsPendingApprover(req, before, 'approve');

      await client.query('select approve_transfer($1, $2, $3)', [req.params.id, req.user.id, note || null]);
      await client.query('select ship_transfer($1, $2, $3)', [req.params.id, req.user.id, note || null]);
      const after = await loadTransfer(client, req.params.id);

      await notifyTransferEvent(client, {
        locationId: after.source_location_id,
        title: 'Transfer approved',
        body: `Transfer ${after.transfer_number} was approved by ${after.approved_by_profile?.full_name || 'the source warehouse'} and has shipped to ${after.destination_location.name}`,
      });
      await notifyTransferEvent(client, {
        locationId: after.destination_location_id,
        title: 'Transfer ready to receive',
        body: `Transfer ${after.transfer_number} from ${after.source_location.name} has been approved and shipped — Accept or Reject it`,
      });

      const { items, history } = await loadItemsAndHistory(client, req.params.id);
      return { ...after, items, history };
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// POST /transfers/:id/reject — Requested -> Rejected. Only the assigned approver.
router.post('/:id/reject', requireMinRole('staff'), idempotency, async (req, res) => {
  const { reason } = req.body;
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadTransfer(client, req.params.id);
      if (!before) throw Object.assign(new Error('Transfer not found'), { status: 404 });
      assertIsPendingApprover(req, before, 'reject');

      await client.query('select reject_transfer($1, $2, $3)', [req.params.id, req.user.id, reason || null]);
      const after = await loadTransfer(client, req.params.id);

      await notifyTransferEvent(client, {
        locationId: after.source_location_id,
        title: 'Transfer rejected',
        body: `${after.destination_location.name} rejected transfer ${after.transfer_number}`,
      });

      const { items, history } = await loadItemsAndHistory(client, req.params.id);
      return { ...after, items, history };
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// POST /transfers/:id/ship — Approved -> In Transit. Source's call. This is
// the point stock actually leaves the source, so the destination is notified
// right here that the transfer is ready to be received.
router.post('/:id/ship', requireMinRole('staff'), idempotency, async (req, res) => {
  const { note } = req.body;
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadTransfer(client, req.params.id);
      if (!before) throw Object.assign(new Error('Transfer not found'), { status: 404 });
      assertSourceAuthority(req, before, 'ship');

      await client.query('select ship_transfer($1, $2, $3)', [req.params.id, req.user.id, note || null]);
      const after = await loadTransfer(client, req.params.id);

      await notifyTransferEvent(client, {
        locationId: after.destination_location_id,
        title: 'Transfer ready to receive',
        body: `Transfer ${after.transfer_number} from ${after.source_location.name} is in transit and ready to be received`,
      });

      const { items, history } = await loadItemsAndHistory(client, req.params.id);
      return { ...after, items, history };
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// POST /transfers/:id/receive — In Transit -> Received. Destination's call.
router.post('/:id/receive', requireMinRole('staff'), idempotency, async (req, res) => {
  const { note } = req.body;
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadTransfer(client, req.params.id);
      if (!before) throw Object.assign(new Error('Transfer not found'), { status: 404 });
      assertDestinationAuthority(req, before, 'confirm receipt of');

      await client.query('select receive_transfer($1, $2, $3)', [req.params.id, req.user.id, note || null]);
      const after = await loadTransfer(client, req.params.id);

      await notifyTransferEvent(client, {
        locationId: after.source_location_id,
        title: 'Transfer received',
        body: `${after.destination_location.name} confirmed receipt of transfer ${after.transfer_number}`,
      });

      const { items, history } = await loadItemsAndHistory(client, req.params.id);
      return { ...after, items, history };
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// POST /transfers/:id/reject-delivery — In Transit -> Rejected. Destination's
// call: the shipment already arrived (or is en route) but the destination
// declines it — e.g. wrong items, damaged goods, no longer needed. Reverses
// the in-transit stock back to the source; the destination's real `quantity`
// is never touched, so nothing is incorrectly added to destination inventory.
// Implemented as plain transaction logic rather than a new stored function —
// every column/table this touches already exists, so this needed no schema
// change at all (see the accompanying message for why).
router.post('/:id/reject-delivery', requireMinRole('staff'), idempotency, async (req, res) => {
  const { reason } = req.body;
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadTransfer(client, req.params.id);
      if (!before) throw Object.assign(new Error('Transfer not found'), { status: 404 });
      if (before.status !== 'in_transit') {
        throw Object.assign(new Error(`Transfer is not in transit (current status: ${before.status})`), { status: 400 });
      }
      assertDestinationAuthority(req, before, 'reject the delivery of');

      const { rows: items } = await client.query('select * from transfer_items where transfer_id = $1', [req.params.id]);
      for (const item of items) {
        await client.query(
          `update stock set in_transit_quantity = greatest(0, in_transit_quantity - $1)
           where product_id = $2 and location_id = $3`,
          [item.quantity, item.product_id, before.destination_location_id]
        );
        await client.query(
          `update stock set quantity = quantity + $1 where product_id = $2 and location_id = $3`,
          [item.quantity, item.product_id, before.source_location_id]
        );
        await client.query(
          `insert into stock_transactions (product_id, from_location_id, to_location_id, transaction_type, quantity, note, performed_by, related_transfer_id)
           values ($1, $2, $3, 'transfer', $4, $5, $6, $7)`,
          [
            item.product_id, before.destination_location_id, before.source_location_id, item.quantity,
            `Transfer ${before.transfer_number} rejected on delivery — stock returned to ${before.source_location.name}`,
            req.user.id, req.params.id,
          ]
        );
      }

      await client.query(
        `update transfers set status = 'rejected', rejected_by = $2, rejected_reason = $3,
                rejected_at = now(), updated_at = now(), resolved_at = now()
         where id = $1`,
        [req.params.id, req.user.id, reason || null]
      );
      await client.query(
        `insert into transfer_status_history (transfer_id, from_status, to_status, performed_by, note)
         values ($1, 'in_transit', 'rejected', $2, $3)`,
        [req.params.id, req.user.id, reason || null]
      );

      const after = await loadTransfer(client, req.params.id);

      await notifyTransferEvent(client, {
        locationId: after.source_location_id,
        title: 'Delivery rejected',
        body: `${after.destination_location.name} rejected delivery of transfer ${after.transfer_number} — stock has been returned`,
      });

      const { items: savedItems, history } = await loadItemsAndHistory(client, req.params.id);
      return { ...after, items: savedItems, history };
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

// POST /transfers/:id/cancel — Draft/Requested/Approved -> Cancelled. Requester or admin only.
router.post('/:id/cancel', requireMinRole('staff'), idempotency, async (req, res) => {
  const { reason } = req.body;
  try {
    const result = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const before = await loadTransfer(client, req.params.id);
      if (!before) throw Object.assign(new Error('Transfer not found'), { status: 404 });
      if (!isAdmin(req) && before.requested_by !== req.user.id) {
        throw Object.assign(new Error('Only the requester (or an admin) can cancel this transfer'), { status: 403 });
      }

      await client.query('select cancel_transfer($1, $2, $3)', [req.params.id, req.user.id, reason || null]);
      const after = await loadTransfer(client, req.params.id);

      if (before.status !== 'draft') {
        await notifyTransferEvent(client, {
          locationId: after.destination_location_id,
          title: 'Transfer cancelled',
          body: `Transfer ${after.transfer_number} from ${after.source_location.name} was cancelled`,
        });
      }

      const { items, history } = await loadItemsAndHistory(client, req.params.id);
      return { ...after, items, history };
    });
    return ok(res, result);
  } catch (err) {
    return fail(res, err.message, err.status || 400);
  }
});

module.exports = router;
