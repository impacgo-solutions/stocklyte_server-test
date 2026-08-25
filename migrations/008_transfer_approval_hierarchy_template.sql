-- ============================================================================
-- Hierarchy-Based Approval Routing for Transfer Management — TEMPLATE schema
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself
--     (Supabase SQL editor or psql), connected with a role that owns the
--     `template` schema. Run 009_..._existing_tenants.sql immediately after.
--
-- Purpose: replaces the destination-based approval model with a
-- source-warehouse chain-of-command model:
--   - Staff-created transfer -> routed to that warehouse's Manager.
--   - Manager-created transfer -> routed to their configured Head
--     (admin_users.reports_to) if one exists, else auto-approved and shipped
--     immediately (no one above them to ask).
--   - Admin-created transfer -> always auto-approved and shipped immediately.
--
-- Entirely additive: no existing column is dropped/narrowed, no existing row
-- is touched, the already-shipped ship_transfer/receive_transfer/
-- cancel_transfer functions are NOT modified. Safe to re-run.
-- ============================================================================

-- ── New columns ──────────────────────────────────────────────────────────────

-- Self-referencing reporting line: who this person's approver/senior is, if
-- anyone. Null means "nobody above them" (e.g. a Manager with no Head).
alter table template.admin_users
  add column if not exists reports_to uuid references template.admin_users (id) on delete set null;

-- Exactly who a transfer is currently routed to for a decision (so
-- approve/reject can be locked to that specific person, not a whole
-- location), and at what level that approval was required/applied.
alter table template.transfers
  add column if not exists pending_approver_id uuid references template.admin_users (id) on delete set null;
alter table template.transfers
  add column if not exists approval_level text;

alter table template.transfers
  drop constraint if exists transfers_approval_level_check;
alter table template.transfers
  add constraint transfers_approval_level_check
  check (approval_level is null or approval_level in ('manager', 'head', 'auto'));

-- ── Rewritten functions ──────────────────────────────────────────────────────

-- Draft -> Requested, now with hierarchy-based routing computed at submission
-- time (not at creation time — reflects whatever the hierarchy is *right
-- now*). Stock validation/reservation logic is unchanged from before.
create or replace function template.submit_transfer(
  p_transfer_id uuid,
  p_performed_by uuid,
  p_note text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_transfer record;
  v_item record;
  v_available numeric;
  v_submitter_role text;
  v_submitter_reports_to uuid;
  v_warehouse_manager_id uuid;
begin
  select * into v_transfer from template.transfers where id = p_transfer_id for update;
  if v_transfer is null then
    raise exception 'Transfer not found';
  end if;
  if v_transfer.status <> 'draft' then
    raise exception 'Transfer is not a draft (current status: %)', v_transfer.status;
  end if;

  if not exists (select 1 from template.transfer_items where transfer_id = p_transfer_id) then
    raise exception 'Cannot submit a transfer with no line items';
  end if;

  for v_item in select * from template.transfer_items where transfer_id = p_transfer_id loop
    select quantity into v_available from template.stock
      where product_id = v_item.product_id and location_id = v_transfer.source_location_id
      for update;

    if v_available is null or v_available < v_item.quantity then
      raise exception 'Insufficient available stock at the source location for one or more products';
    end if;
  end loop;

  for v_item in select * from template.transfer_items where transfer_id = p_transfer_id loop
    update template.stock
      set reserved_quantity = reserved_quantity + v_item.quantity
      where product_id = v_item.product_id and location_id = v_transfer.source_location_id;
  end loop;

  update template.transfers
    set status = 'requested', updated_at = now()
    where id = p_transfer_id;

  insert into template.transfer_status_history (transfer_id, from_status, to_status, performed_by, note)
  values (p_transfer_id, 'draft', 'requested', p_performed_by, p_note);

  -- ── Hierarchy-based approval routing ────────────────────────────────────
  -- Rooted at the SOURCE warehouse's own chain of command, regardless of who
  -- physically submitted it. The route layer's assertSourceAuthority already
  -- guarantees a non-admin caller here is based at the source warehouse, so
  -- this function trusts that and doesn't re-check location.
  select role, reports_to into v_submitter_role, v_submitter_reports_to
  from template.admin_users where id = p_performed_by;

  select id into v_warehouse_manager_id
  from template.admin_users
  where role = 'manager' and location_id = v_transfer.source_location_id and is_active = true
  order by created_at asc
  limit 1;

  if v_submitter_role = 'admin' then
    update template.transfers set approval_level = 'auto' where id = p_transfer_id;
    perform template.approve_transfer(p_transfer_id, p_performed_by, coalesce(p_note, 'Auto-approved — submitted by tenant admin'));
    perform template.ship_transfer(p_transfer_id, p_performed_by, coalesce(p_note, 'Auto-approved and shipped — submitted by tenant admin'));

  elsif v_submitter_role = 'manager' then
    if v_submitter_reports_to is not null then
      update template.transfers
        set pending_approver_id = v_submitter_reports_to, approval_level = 'head'
        where id = p_transfer_id;
    else
      update template.transfers set approval_level = 'auto' where id = p_transfer_id;
      perform template.approve_transfer(p_transfer_id, p_performed_by, coalesce(p_note, 'Auto-approved — no senior approver configured'));
      perform template.ship_transfer(p_transfer_id, p_performed_by, coalesce(p_note, 'Auto-approved and shipped — no senior approver configured'));
    end if;

  else
    -- Staff (or anyone else who isn't the warehouse's own manager/an admin).
    if v_warehouse_manager_id is null then
      raise exception 'No manager is configured for the source warehouse — an admin must assign one before this transfer can be submitted';
    end if;
    update template.transfers
      set pending_approver_id = v_warehouse_manager_id, approval_level = 'manager'
      where id = p_transfer_id;
  end if;
end;
$$;

-- Requested -> Approved. Same as before, plus clearing pending_approver_id
-- now that a decision has been made.
create or replace function template.approve_transfer(
  p_transfer_id uuid,
  p_performed_by uuid,
  p_note text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_transfer record;
begin
  select * into v_transfer from template.transfers where id = p_transfer_id for update;
  if v_transfer is null then
    raise exception 'Transfer not found';
  end if;
  if v_transfer.status <> 'requested' then
    raise exception 'Transfer is not awaiting approval (current status: %)', v_transfer.status;
  end if;

  update template.transfers
    set status = 'approved', approved_by = p_performed_by, approved_at = now(),
        pending_approver_id = null, updated_at = now()
    where id = p_transfer_id;

  insert into template.transfer_status_history (transfer_id, from_status, to_status, performed_by, note)
  values (p_transfer_id, 'requested', 'approved', p_performed_by, p_note);
end;
$$;

-- Requested -> Rejected. Same as before (inventory `quantity` is never
-- touched by submit/reject — only the reservation hold is released, so
-- rejecting genuinely leaves real stock untouched), plus clearing
-- pending_approver_id.
create or replace function template.reject_transfer(
  p_transfer_id uuid,
  p_performed_by uuid,
  p_reason text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_transfer record;
  v_item record;
begin
  select * into v_transfer from template.transfers where id = p_transfer_id for update;
  if v_transfer is null then
    raise exception 'Transfer not found';
  end if;
  if v_transfer.status <> 'requested' then
    raise exception 'Transfer is not awaiting a decision (current status: %)', v_transfer.status;
  end if;

  for v_item in select * from template.transfer_items where transfer_id = p_transfer_id loop
    update template.stock
      set reserved_quantity = greatest(0, reserved_quantity - v_item.quantity)
      where product_id = v_item.product_id and location_id = v_transfer.source_location_id;
  end loop;

  update template.transfers
    set status = 'rejected', rejected_by = p_performed_by, rejected_reason = p_reason,
        rejected_at = now(), pending_approver_id = null, updated_at = now(), resolved_at = now()
    where id = p_transfer_id;

  insert into template.transfer_status_history (transfer_id, from_status, to_status, performed_by, note)
  values (p_transfer_id, 'requested', 'rejected', p_performed_by, p_reason);
end;
$$;
