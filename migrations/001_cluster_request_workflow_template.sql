-- ============================================================================
-- Cluster-Based Product Request & Rejection Workflow — TEMPLATE schema
-- ============================================================================
-- Run this ONCE against your database (psql, or the Supabase SQL editor),
-- connected with a role that owns the `template` schema.
--
-- Purpose: from this point on, every NEWLY PROVISIONED tenant (via
-- POST /admin/companies from the Super Admin app, or via POST /auth/signup)
-- automatically gets the full feature, because tenantProvisioning.js clones
-- template.* tables/functions/triggers verbatim into the new tenant schema.
--
-- This script does NOT touch any existing tenant schema — run
-- 002_cluster_request_workflow_existing_tenants.sql separately for those
-- (including impacgo_demo, which already has an old, incompatible prototype
-- of product_requests/product_request_routes that 002 will repair in place).
--
-- Entirely additive: no existing template table is dropped, renamed, or has
-- a column removed. Safe to re-run (every statement is idempotent).
-- ============================================================================

-- ── New tables ──────────────────────────────────────────────────────────────

create table if not exists template.clusters (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint clusters_name_key unique (name)
);

create table if not exists template.racks (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references template.locations (id) on delete cascade,
  code        text not null,
  name        text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint racks_location_id_code_key unique (location_id, code)
);

-- Optional, manually-managed rack-level sub-allocation of a location's stock.
-- Deliberately NOT wired into stock_in_lot/stock_out/transfer_stock — those
-- keep operating exactly as they do today, at location granularity. This is
-- an additional, independent breakdown for visibility/reporting.
create table if not exists template.rack_stock (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references template.products (id) on delete cascade,
  rack_id    uuid not null references template.racks (id) on delete cascade,
  quantity   numeric(14, 3) not null default 0,
  updated_at timestamptz not null default now(),
  constraint rack_stock_product_id_rack_id_key unique (product_id, rack_id),
  constraint rack_stock_quantity_check check (quantity >= 0)
);

-- Tenant-configurable escalation priority: for a given source location, the
-- ordered list of eligible target locations to route a rejected request to.
create table if not exists template.location_routing_rules (
  id                  uuid primary key default gen_random_uuid(),
  source_location_id  uuid not null references template.locations (id) on delete cascade,
  target_location_id  uuid not null references template.locations (id) on delete cascade,
  priority             integer not null,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint location_routing_rules_source_priority_key unique (source_location_id, priority),
  constraint location_routing_rules_source_target_key unique (source_location_id, target_location_id),
  constraint location_routing_rules_source_ne_target check (source_location_id <> target_location_id)
);

create table if not exists template.product_requests (
  id                          uuid primary key default gen_random_uuid(),
  product_id                  uuid not null references template.products (id) on delete cascade,
  requested_by                uuid references template.admin_users (id) on delete set null,
  source_location_id          uuid not null references template.locations (id) on delete set null,
  quantity                     numeric(14, 3) not null,
  status                       text not null default 'requested',
  current_target_location_id  uuid references template.locations (id) on delete set null,
  note                         text,
  cancelled_by                 uuid references template.admin_users (id) on delete set null,
  cancelled_reason             text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  resolved_at                  timestamptz,
  constraint product_requests_quantity_check check (quantity > 0),
  constraint product_requests_status_check check (
    status in ('requested', 'assigned', 'accepted', 'rejected', 'escalated', 'fulfilled', 'exhausted', 'cancelled')
  )
);

create table if not exists template.product_request_routes (
  id                   uuid primary key default gen_random_uuid(),
  request_id           uuid not null references template.product_requests (id) on delete cascade,
  sequence_no          integer not null,
  target_location_id   uuid not null references template.locations (id) on delete set null,
  distance_km          numeric(10, 3),
  status               text not null default 'pending',
  decided_by           uuid references template.admin_users (id) on delete set null,
  decision_note        text,
  created_at           timestamptz not null default now(),
  decided_at           timestamptz,
  constraint product_request_routes_request_target_key unique (request_id, target_location_id),
  constraint product_request_routes_request_seq_key unique (request_id, sequence_no),
  constraint product_request_routes_status_check check (status in ('pending', 'accepted', 'rejected'))
);

create table if not exists template.product_request_status_history (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references template.product_requests (id) on delete cascade,
  from_status  text,
  to_status    text not null,
  location_id  uuid references template.locations (id) on delete set null,
  performed_by uuid references template.admin_users (id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists product_requests_status_idx on template.product_requests (status);
create index if not exists product_requests_source_location_idx on template.product_requests (source_location_id);
create index if not exists product_requests_current_target_idx on template.product_requests (current_target_location_id);
create index if not exists product_request_routes_request_idx on template.product_request_routes (request_id);
create index if not exists product_request_status_history_request_idx on template.product_request_status_history (request_id);
create index if not exists location_routing_rules_source_idx on template.location_routing_rules (source_location_id);
create index if not exists racks_location_idx on template.racks (location_id);

-- ── New columns on existing template tables (additive only) ────────────────

alter table template.locations
  add column if not exists cluster_id uuid references template.clusters (id) on delete set null;
alter table template.locations
  add column if not exists latitude numeric(9, 6);
alter table template.locations
  add column if not exists longitude numeric(9, 6);

alter table template.stock
  add column if not exists reserved_quantity numeric(14, 3) not null default 0;
alter table template.stock
  add column if not exists in_transit_quantity numeric(14, 3) not null default 0;
alter table template.stock
  add column if not exists damaged_quantity numeric(14, 3) not null default 0;

alter table template.stock
  drop constraint if exists stock_reserved_quantity_check;
alter table template.stock
  add constraint stock_reserved_quantity_check check (reserved_quantity >= 0);
alter table template.stock
  drop constraint if exists stock_in_transit_quantity_check;
alter table template.stock
  add constraint stock_in_transit_quantity_check check (in_transit_quantity >= 0);
alter table template.stock
  drop constraint if exists stock_damaged_quantity_check;
alter table template.stock
  add constraint stock_damaged_quantity_check check (damaged_quantity >= 0);

alter table template.stock_transactions
  add column if not exists related_request_id uuid references template.product_requests (id) on delete set null;
alter table template.stock_transactions
  add column if not exists batch_number character varying(100);
alter table template.stock_transactions
  add column if not exists supplier_name character varying(200);
alter table template.stock_transactions
  add column if not exists expiry_date date;

alter table template.stock_transactions
  drop constraint if exists stock_transactions_transaction_type_check;
alter table template.stock_transactions
  add constraint stock_transactions_transaction_type_check check (
    transaction_type in ('in', 'out', 'transfer', 'adjustment', 'damage', 'damage_writeoff', 'damage_restore')
  );

alter table template.notifications
  add column if not exists related_request_id uuid references template.product_requests (id) on delete set null;
alter table template.notifications
  add column if not exists title text;
alter table template.notifications
  add column if not exists body text;

alter table template.notifications
  drop constraint if exists notifications_type_check;
alter table template.notifications
  add constraint notifications_type_check check (
    type in ('low_stock', 'transfer', 'system', 'product_request')
  );

-- ── Triggers on the new tables (reusing template's existing trigger functions) ──

drop trigger if exists product_requests_updated_at on template.product_requests;
create trigger product_requests_updated_at
  before update on template.product_requests
  for each row execute function template.update_updated_at ();

drop trigger if exists audit_product_requests on template.product_requests;
create trigger audit_product_requests
  after insert or update or delete on template.product_requests
  for each row execute function template.audit_trigger_func ();

drop trigger if exists location_routing_rules_updated_at on template.location_routing_rules;
create trigger location_routing_rules_updated_at
  before update on template.location_routing_rules
  for each row execute function template.update_updated_at ();

drop trigger if exists rack_stock_updated_at on template.rack_stock;
create trigger rack_stock_updated_at
  before update on template.rack_stock
  for each row execute function template.update_updated_at ();

-- ── New functions (all in the `template` schema; cloned per-tenant by name) ─
-- tenantProvisioning.js rewrites `template` -> the tenant schema name in each
-- function body text when cloning, exactly like it already does for
-- stock_in_lot/stock_out/transfer_stock — see utils/tenantProvisioning.js.

-- Picks the next untried eligible target location for a source location:
-- 1) highest-priority (lowest `priority` number) active routing rule not yet
--    tried for this request, else
-- 2) nearest by lat/long distance among active locations not yet tried
--    (excluding the source), else
-- 3) the oldest-created active location not yet tried (deterministic
--    fallback when no coordinates are configured at all).
-- Returns (location_id, distance_km) — distance_km is null unless computed.
create or replace function template.next_eligible_location(
  p_source_location_id uuid,
  p_exclude_location_ids uuid[]
)
returns table (location_id uuid, distance_km numeric)
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_src_lat numeric;
  v_src_lng numeric;
begin
  return query
    select r.target_location_id, null::numeric
    from template.location_routing_rules r
    join template.locations l on l.id = r.target_location_id
    where r.source_location_id = p_source_location_id
      and r.is_active = true
      and l.is_active = true
      and not (r.target_location_id = any (p_exclude_location_ids))
    order by r.priority asc
    limit 1;

  if found then
    return;
  end if;

  select latitude, longitude into v_src_lat, v_src_lng
  from template.locations where id = p_source_location_id;

  if v_src_lat is not null and v_src_lng is not null then
    return query
      select l.id,
        (6371 * acos(least(1, greatest(-1,
          cos(radians(v_src_lat)) * cos(radians(l.latitude)) * cos(radians(l.longitude) - radians(v_src_lng))
          + sin(radians(v_src_lat)) * sin(radians(l.latitude))
        ))))::numeric as distance_km
      from template.locations l
      where l.is_active = true
        and l.id <> p_source_location_id
        and l.latitude is not null and l.longitude is not null
        and not (l.id = any (p_exclude_location_ids))
      order by distance_km asc
      limit 1;

    if found then
      return;
    end if;
  end if;

  return query
    select l.id, null::numeric
    from template.locations l
    where l.is_active = true
      and l.id <> p_source_location_id
      and not (l.id = any (p_exclude_location_ids))
    order by l.created_at asc
    limit 1;
end;
$$;

-- Creates a request and auto-assigns it to the first eligible target.
create or replace function template.create_product_request(
  p_product_id uuid,
  p_source_location_id uuid,
  p_quantity numeric,
  p_requested_by uuid,
  p_note text default null
)
returns uuid
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_request_id uuid;
  v_target uuid;
  v_distance numeric;
begin
  select location_id, distance_km into v_target, v_distance
  from template.next_eligible_location(p_source_location_id, array[p_source_location_id]);

  if v_target is null then
    raise exception 'No eligible destination locations are configured for this source location';
  end if;

  insert into template.product_requests
    (product_id, requested_by, source_location_id, quantity, status, current_target_location_id, note)
  values
    (p_product_id, p_requested_by, p_source_location_id, p_quantity, 'assigned', v_target, p_note)
  returning id into v_request_id;

  insert into template.product_request_routes (request_id, sequence_no, target_location_id, distance_km, status)
  values (v_request_id, 1, v_target, v_distance, 'pending');

  insert into template.product_request_status_history (request_id, from_status, to_status, location_id, performed_by, note)
  values (v_request_id, null, 'requested', p_source_location_id, p_requested_by, p_note);

  insert into template.product_request_status_history (request_id, from_status, to_status, location_id, performed_by)
  values (v_request_id, 'requested', 'assigned', v_target, p_requested_by);

  insert into template.stock (product_id, location_id, reserved_quantity)
  values (p_product_id, v_target, p_quantity)
  on conflict (product_id, location_id) do update
    set reserved_quantity = template.stock.reserved_quantity + excluded.reserved_quantity;

  return v_request_id;
end;
$$;

-- D2 rejects: releases D2's reservation, then finds the next eligible target
-- and re-assigns (escalates), or marks the request exhausted if none remain.
create or replace function template.reject_product_request(
  p_request_id uuid,
  p_decided_by uuid,
  p_note text default null
)
returns text
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_req record;
  v_route record;
  v_next_target uuid;
  v_next_distance numeric;
  v_tried uuid[];
begin
  select * into v_req from template.product_requests where id = p_request_id for update;
  if v_req is null then
    raise exception 'Request not found';
  end if;
  if v_req.status not in ('assigned') then
    raise exception 'Request is not awaiting a decision (current status: %)', v_req.status;
  end if;

  select * into v_route from template.product_request_routes
    where request_id = p_request_id and target_location_id = v_req.current_target_location_id and status = 'pending'
    for update;
  if v_route is null then
    raise exception 'No pending decision found for this request';
  end if;

  update template.product_request_routes
    set status = 'rejected', decided_by = p_decided_by, decision_note = p_note, decided_at = now()
    where id = v_route.id;

  update template.stock
    set reserved_quantity = greatest(0, reserved_quantity - v_req.quantity)
    where product_id = v_req.product_id and location_id = v_req.current_target_location_id;

  insert into template.product_request_status_history (request_id, from_status, to_status, location_id, performed_by, note)
  values (p_request_id, 'assigned', 'rejected', v_req.current_target_location_id, p_decided_by, p_note);

  select array_agg(target_location_id) into v_tried from template.product_request_routes where request_id = p_request_id;
  v_tried := v_tried || v_req.source_location_id;

  select location_id, distance_km into v_next_target, v_next_distance
  from template.next_eligible_location(v_req.source_location_id, v_tried);

  if v_next_target is null then
    update template.product_requests
      set status = 'exhausted', current_target_location_id = null, updated_at = now(), resolved_at = now()
      where id = p_request_id;

    insert into template.product_request_status_history (request_id, from_status, to_status, performed_by)
    values (p_request_id, 'rejected', 'exhausted', p_decided_by);

    return 'exhausted';
  end if;

  insert into template.product_request_routes (request_id, sequence_no, target_location_id, distance_km, status)
  values (
    p_request_id,
    (select coalesce(max(sequence_no), 0) + 1 from template.product_request_routes where request_id = p_request_id),
    v_next_target, v_next_distance, 'pending'
  );

  update template.product_requests
    set status = 'assigned', current_target_location_id = v_next_target, updated_at = now()
    where id = p_request_id;

  insert into template.product_request_status_history (request_id, from_status, to_status, location_id, performed_by)
  values (p_request_id, 'rejected', 'escalated', v_next_target, p_decided_by);

  insert into template.product_request_status_history (request_id, from_status, to_status, location_id, performed_by)
  values (p_request_id, 'escalated', 'assigned', v_next_target, p_decided_by);

  insert into template.stock (product_id, location_id, reserved_quantity)
  values (v_req.product_id, v_next_target, v_req.quantity)
  on conflict (product_id, location_id) do update
    set reserved_quantity = template.stock.reserved_quantity + excluded.reserved_quantity;

  return 'escalated';
end;
$$;

-- D2 accepts: ships from D2 (accepting/target location) to D1 (source) —
-- D2's available stock decrements, D1's in-transit stock increments.
create or replace function template.accept_product_request(
  p_request_id uuid,
  p_decided_by uuid,
  p_note text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_req record;
  v_route record;
  v_available numeric;
begin
  select * into v_req from template.product_requests where id = p_request_id for update;
  if v_req is null then
    raise exception 'Request not found';
  end if;
  if v_req.status <> 'assigned' then
    raise exception 'Request is not awaiting a decision (current status: %)', v_req.status;
  end if;

  select * into v_route from template.product_request_routes
    where request_id = p_request_id and target_location_id = v_req.current_target_location_id and status = 'pending'
    for update;
  if v_route is null then
    raise exception 'No pending decision found for this request';
  end if;

  select quantity into v_available from template.stock
    where product_id = v_req.product_id and location_id = v_req.current_target_location_id
    for update;

  if v_available is null or v_available < v_req.quantity then
    raise exception 'Insufficient available stock at the accepting location to fulfil this request';
  end if;

  update template.stock
    set quantity = quantity - v_req.quantity,
        reserved_quantity = greatest(0, reserved_quantity - v_req.quantity)
    where product_id = v_req.product_id and location_id = v_req.current_target_location_id;

  insert into template.stock (product_id, location_id, in_transit_quantity)
  values (v_req.product_id, v_req.source_location_id, v_req.quantity)
  on conflict (product_id, location_id) do update
    set in_transit_quantity = template.stock.in_transit_quantity + excluded.in_transit_quantity;

  insert into template.stock_transactions
    (product_id, from_location_id, to_location_id, transaction_type, quantity, note, performed_by, related_request_id)
  values
    (v_req.product_id, v_req.current_target_location_id, v_req.source_location_id, 'transfer', v_req.quantity,
     coalesce(p_note, 'Product request fulfilment — in transit'), p_decided_by, p_request_id);

  update template.product_request_routes
    set status = 'accepted', decided_by = p_decided_by, decision_note = p_note, decided_at = now()
    where id = v_route.id;

  update template.product_requests
    set status = 'accepted', updated_at = now()
    where id = p_request_id;

  insert into template.product_request_status_history (request_id, from_status, to_status, location_id, performed_by, note)
  values (p_request_id, 'assigned', 'accepted', v_req.current_target_location_id, p_decided_by, p_note);
end;
$$;

-- D1 confirms physical receipt of an accepted request — moves the in-transit
-- stock at the source location into available, and marks the request fulfilled.
create or replace function template.receive_product_request(
  p_request_id uuid,
  p_received_by uuid
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_req record;
begin
  select * into v_req from template.product_requests where id = p_request_id for update;
  if v_req is null then
    raise exception 'Request not found';
  end if;
  if v_req.status <> 'accepted' then
    raise exception 'Request has not been accepted yet (current status: %)', v_req.status;
  end if;

  update template.stock
    set quantity = quantity + v_req.quantity,
        in_transit_quantity = greatest(0, in_transit_quantity - v_req.quantity)
    where product_id = v_req.product_id and location_id = v_req.source_location_id;

  update template.product_requests
    set status = 'fulfilled', updated_at = now(), resolved_at = now()
    where id = p_request_id;

  insert into template.product_request_status_history (request_id, from_status, to_status, location_id, performed_by)
  values (p_request_id, 'accepted', 'fulfilled', v_req.source_location_id, p_received_by);
end;
$$;

-- Requester (or admin) cancels a request that hasn't reached a terminal state.
create or replace function template.cancel_product_request(
  p_request_id uuid,
  p_cancelled_by uuid,
  p_reason text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_req record;
begin
  select * into v_req from template.product_requests where id = p_request_id for update;
  if v_req is null then
    raise exception 'Request not found';
  end if;
  if v_req.status in ('fulfilled', 'exhausted', 'cancelled') then
    raise exception 'Request is already finalized (status: %)', v_req.status;
  end if;

  if v_req.status = 'assigned' and v_req.current_target_location_id is not null then
    update template.stock
      set reserved_quantity = greatest(0, reserved_quantity - v_req.quantity)
      where product_id = v_req.product_id and location_id = v_req.current_target_location_id;

    update template.product_request_routes
      set status = 'rejected', decided_by = p_cancelled_by, decision_note = coalesce(p_reason, 'Cancelled by requester'), decided_at = now()
      where request_id = p_request_id and target_location_id = v_req.current_target_location_id and status = 'pending';
  end if;

  update template.product_requests
    set status = 'cancelled', cancelled_by = p_cancelled_by, cancelled_reason = p_reason,
        updated_at = now(), resolved_at = now()
    where id = p_request_id;

  insert into template.product_request_status_history (request_id, from_status, to_status, performed_by, note)
  values (p_request_id, v_req.status, 'cancelled', p_cancelled_by, p_reason);
end;
$$;

-- ── Damaged-stock lifecycle (independent of the request workflow) ──────────

create or replace function template.report_damaged_stock(
  p_product_id uuid,
  p_location_id uuid,
  p_quantity numeric,
  p_performed_by uuid,
  p_note text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_available numeric;
begin
  select quantity into v_available from template.stock
    where product_id = p_product_id and location_id = p_location_id for update;

  if v_available is null or v_available < p_quantity then
    raise exception 'Insufficient available stock to report as damaged';
  end if;

  update template.stock
    set quantity = quantity - p_quantity, damaged_quantity = damaged_quantity + p_quantity
    where product_id = p_product_id and location_id = p_location_id;

  insert into template.stock_transactions (product_id, from_location_id, transaction_type, quantity, note, performed_by)
  values (p_product_id, p_location_id, 'damage', p_quantity, p_note, p_performed_by);
end;
$$;

create or replace function template.restore_damaged_stock(
  p_product_id uuid,
  p_location_id uuid,
  p_quantity numeric,
  p_performed_by uuid,
  p_note text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_damaged numeric;
begin
  select damaged_quantity into v_damaged from template.stock
    where product_id = p_product_id and location_id = p_location_id for update;

  if v_damaged is null or v_damaged < p_quantity then
    raise exception 'Insufficient damaged stock to restore';
  end if;

  update template.stock
    set quantity = quantity + p_quantity, damaged_quantity = damaged_quantity - p_quantity
    where product_id = p_product_id and location_id = p_location_id;

  insert into template.stock_transactions (product_id, to_location_id, transaction_type, quantity, note, performed_by)
  values (p_product_id, p_location_id, 'damage_restore', p_quantity, p_note, p_performed_by);
end;
$$;

create or replace function template.writeoff_damaged_stock(
  p_product_id uuid,
  p_location_id uuid,
  p_quantity numeric,
  p_performed_by uuid,
  p_note text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_damaged numeric;
begin
  select damaged_quantity into v_damaged from template.stock
    where product_id = p_product_id and location_id = p_location_id for update;

  if v_damaged is null or v_damaged < p_quantity then
    raise exception 'Insufficient damaged stock to write off';
  end if;

  update template.stock
    set damaged_quantity = damaged_quantity - p_quantity
    where product_id = p_product_id and location_id = p_location_id;

  insert into template.stock_transactions (product_id, from_location_id, transaction_type, quantity, note, performed_by)
  values (p_product_id, p_location_id, 'damage_writeoff', p_quantity, p_note, p_performed_by);
end;
$$;
