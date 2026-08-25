-- ============================================================================
-- Transfer Management & Transfer Reports Workflow — TEMPLATE schema
-- ============================================================================
-- Run this ONCE against your database (psql, or the Supabase SQL editor),
-- connected with a role that owns the `template` schema.
--
-- Purpose: from this point on, every NEWLY PROVISIONED tenant automatically
-- gets the full feature, because tenantProvisioning.js clones template.*
-- tables/functions/triggers verbatim into the new tenant schema (TABLES,
-- FUNCTION_NAMES and triggerStatements()/foreignKeyStatements() in
-- utils/tenantProvisioning.js have been updated to include the new names).
--
-- This script does NOT touch any existing tenant schema — run
-- 007_transfer_management_existing_tenants.sql separately for those.
--
-- Entirely additive: no existing template table is dropped, renamed, or has
-- a column removed. Safe to re-run (every statement is idempotent).
-- ============================================================================

-- ── New tables ──────────────────────────────────────────────────────────────

create table if not exists template.transfers (
  id                       uuid primary key,
  transfer_number          text not null,
  source_location_id       uuid not null references template.locations (id) on delete restrict,
  destination_location_id  uuid not null references template.locations (id) on delete restrict,
  status                   text not null default 'draft',
  transfer_date            date not null default current_date,
  reason                   text not null,
  note                     text,
  requested_by             uuid references template.admin_users (id) on delete set null,
  approved_by              uuid references template.admin_users (id) on delete set null,
  approved_at              timestamptz,
  shipped_by               uuid references template.admin_users (id) on delete set null,
  shipped_at               timestamptz,
  received_by              uuid references template.admin_users (id) on delete set null,
  received_at              timestamptz,
  rejected_by              uuid references template.admin_users (id) on delete set null,
  rejected_reason          text,
  rejected_at              timestamptz,
  cancelled_by             uuid references template.admin_users (id) on delete set null,
  cancelled_reason         text,
  cancelled_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  resolved_at              timestamptz,
  constraint transfers_transfer_number_key unique (transfer_number),
  constraint transfers_source_ne_destination check (source_location_id <> destination_location_id),
  constraint transfers_status_check check (
    status in ('draft', 'requested', 'approved', 'in_transit', 'received', 'rejected', 'cancelled')
  )
);

create table if not exists template.transfer_items (
  id           uuid primary key default gen_random_uuid(),
  transfer_id  uuid not null references template.transfers (id) on delete cascade,
  product_id   uuid not null references template.products (id) on delete cascade,
  quantity     numeric(14, 3) not null,
  note         text,
  created_at   timestamptz not null default now(),
  constraint transfer_items_transfer_id_product_id_key unique (transfer_id, product_id),
  constraint transfer_items_quantity_check check (quantity > 0)
);

create table if not exists template.transfer_status_history (
  id           uuid primary key default gen_random_uuid(),
  transfer_id  uuid not null references template.transfers (id) on delete cascade,
  from_status  text,
  to_status    text not null,
  performed_by uuid references template.admin_users (id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists transfers_status_idx on template.transfers (status);
create index if not exists transfers_source_location_id_idx on template.transfers (source_location_id);
create index if not exists transfers_destination_location_id_idx on template.transfers (destination_location_id);
create index if not exists transfer_items_transfer_id_idx on template.transfer_items (transfer_id);
create index if not exists transfer_status_history_transfer_id_idx on template.transfer_status_history (transfer_id);

-- ── New column on an existing template table (additive only) ───────────────

alter table template.stock_transactions
  add column if not exists related_transfer_id uuid references template.transfers (id) on delete set null;

-- ── Triggers on the new header table (reusing template's existing trigger functions) ──

drop trigger if exists transfers_updated_at on template.transfers;
create trigger transfers_updated_at
  before update on template.transfers
  for each row execute function template.update_updated_at ();

drop trigger if exists audit_transfers on template.transfers;
create trigger audit_transfers
  after insert or update or delete on template.transfers
  for each row execute function template.audit_trigger_func ();

-- ── New functions (all in the `template` schema; cloned per-tenant by name) ─
-- tenantProvisioning.js rewrites `template` -> the tenant schema name in each
-- function body text when cloning, exactly like it already does for
-- create_product_request/accept_product_request/... — see utils/tenantProvisioning.js.

-- Draft -> Requested. Validates every line item has enough available stock at
-- the source location (the whole transfer fails together if any line is
-- short — no partial submission), then places an informational reservation
-- hold on each item (same convention create_product_request already uses:
-- reserved_quantity is a parallel earmark, not subtracted from `quantity`).
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
end;
$$;

-- Requested -> Approved. Authorization checkpoint only — no stock movement.
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
    set status = 'approved', approved_by = p_performed_by, approved_at = now(), updated_at = now()
    where id = p_transfer_id;

  insert into template.transfer_status_history (transfer_id, from_status, to_status, performed_by, note)
  values (p_transfer_id, 'requested', 'approved', p_performed_by, p_note);
end;
$$;

-- Requested -> Rejected. Releases the source reservation placed at submit time.
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
        rejected_at = now(), updated_at = now(), resolved_at = now()
    where id = p_transfer_id;

  insert into template.transfer_status_history (transfer_id, from_status, to_status, performed_by, note)
  values (p_transfer_id, 'requested', 'rejected', p_performed_by, p_reason);
end;
$$;

-- Approved -> In Transit. The actual, auditable stock movement: re-checks
-- source availability (stock may have moved since submit), then per item
-- decrements source quantity+reservation and increments destination
-- in-transit, writing one stock_transactions row per item.
create or replace function template.ship_transfer(
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
begin
  select * into v_transfer from template.transfers where id = p_transfer_id for update;
  if v_transfer is null then
    raise exception 'Transfer not found';
  end if;
  if v_transfer.status <> 'approved' then
    raise exception 'Transfer is not approved yet (current status: %)', v_transfer.status;
  end if;

  for v_item in select * from template.transfer_items where transfer_id = p_transfer_id loop
    select quantity into v_available from template.stock
      where product_id = v_item.product_id and location_id = v_transfer.source_location_id
      for update;

    if v_available is null or v_available < v_item.quantity then
      raise exception 'Insufficient available stock at the source location to ship one or more products';
    end if;
  end loop;

  for v_item in select * from template.transfer_items where transfer_id = p_transfer_id loop
    update template.stock
      set quantity = quantity - v_item.quantity,
          reserved_quantity = greatest(0, reserved_quantity - v_item.quantity)
      where product_id = v_item.product_id and location_id = v_transfer.source_location_id;

    insert into template.stock (product_id, location_id, in_transit_quantity)
    values (v_item.product_id, v_transfer.destination_location_id, v_item.quantity)
    on conflict (product_id, location_id) do update
      set in_transit_quantity = template.stock.in_transit_quantity + excluded.in_transit_quantity;

    insert into template.stock_transactions
      (product_id, from_location_id, to_location_id, transaction_type, quantity, note, performed_by, related_transfer_id)
    values
      (v_item.product_id, v_transfer.source_location_id, v_transfer.destination_location_id, 'transfer', v_item.quantity,
       coalesce(p_note, 'Transfer ' || v_transfer.transfer_number || ' — in transit'), p_performed_by, p_transfer_id);
  end loop;

  update template.transfers
    set status = 'in_transit', shipped_by = p_performed_by, shipped_at = now(), updated_at = now()
    where id = p_transfer_id;

  insert into template.transfer_status_history (transfer_id, from_status, to_status, performed_by, note)
  values (p_transfer_id, 'approved', 'in_transit', p_performed_by, p_note);
end;
$$;

-- In Transit -> Received. Destination confirms physical receipt.
create or replace function template.receive_transfer(
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
begin
  select * into v_transfer from template.transfers where id = p_transfer_id for update;
  if v_transfer is null then
    raise exception 'Transfer not found';
  end if;
  if v_transfer.status <> 'in_transit' then
    raise exception 'Transfer has not been shipped yet (current status: %)', v_transfer.status;
  end if;

  for v_item in select * from template.transfer_items where transfer_id = p_transfer_id loop
    update template.stock
      set quantity = quantity + v_item.quantity,
          in_transit_quantity = greatest(0, in_transit_quantity - v_item.quantity)
      where product_id = v_item.product_id and location_id = v_transfer.destination_location_id;
  end loop;

  update template.transfers
    set status = 'received', received_by = p_performed_by, received_at = now(),
        updated_at = now(), resolved_at = now()
    where id = p_transfer_id;

  insert into template.transfer_status_history (transfer_id, from_status, to_status, performed_by, note)
  values (p_transfer_id, 'in_transit', 'received', p_performed_by, p_note);
end;
$$;

-- Draft/Requested/Approved -> Cancelled (never after shipped — physically
-- dispatched stock can't be cleanly cancelled). Releases the source
-- reservation if one was placed (requested/approved).
create or replace function template.cancel_transfer(
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
  if v_transfer.status not in ('draft', 'requested', 'approved') then
    raise exception 'Transfer can no longer be cancelled (current status: %)', v_transfer.status;
  end if;

  if v_transfer.status in ('requested', 'approved') then
    for v_item in select * from template.transfer_items where transfer_id = p_transfer_id loop
      update template.stock
        set reserved_quantity = greatest(0, reserved_quantity - v_item.quantity)
        where product_id = v_item.product_id and location_id = v_transfer.source_location_id;
    end loop;
  end if;

  update template.transfers
    set status = 'cancelled', cancelled_by = p_performed_by, cancelled_reason = p_reason,
        cancelled_at = now(), updated_at = now(), resolved_at = now()
    where id = p_transfer_id;

  insert into template.transfer_status_history (transfer_id, from_status, to_status, performed_by, note)
  values (p_transfer_id, v_transfer.status, 'cancelled', p_performed_by, p_reason);
end;
$$;
