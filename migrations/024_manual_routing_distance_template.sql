-- ============================================================================
-- Hybrid Auto/Manual Routing Distance — TEMPLATE schema
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself
--     (Supabase SQL editor or psql), connected with a role that owns the
--     `template` schema. Run 025_..._existing_tenants.sql immediately after.
--
-- Purpose: Routing Rules today only ever computes distance from a location's
-- own Latitude/Longitude (migrations 020/022) — a source location with no
-- coordinates configured gets NO distance at all in its routing rules, and
-- an admin has no way to type one in. This migration adds that manual path
-- alongside the existing automatic one, changing nothing about how a
-- location WITH coordinates already behaves:
--
--   1. location_routing_rules gains two nullable/defaulted columns:
--      distance_km (an admin-entered distance, used only when live GPS
--      distance can't be computed for that specific source/target pair)
--      and distance_source ('auto' | 'manual'), so the UI can label which
--      one produced the number on screen. Existing rows default to 'auto'
--      (they were all either hand-added-with-no-distance or generated from
--      coordinates, which is the closest honest label for history).
--
--   2. product_request_routes gains the same distance_source column, so a
--      request's full routing HISTORY — not just the live rules — can show
--      whether each hop's distance was GPS-computed or admin-entered, per
--      the existing per-hop distance_km it already stores.
--
--   3. generate_routing_sequence() now also persists the distance_km it
--      computes into location_routing_rules (previously computed and
--      returned but never stored) and stamps distance_source = 'auto'.
--
--   4. next_eligible_location() gains a third output column,
--      distance_source. Its tier-1 pick (explicit location_routing_rules)
--      now uses the LIVE haversine distance when both the source and that
--      specific target have coordinates (distance_source = 'auto', exactly
--      as before, just now also labelled), and otherwise falls back to
--      that rule's own stored distance_km/distance_source (the admin's
--      manually-entered value) instead of always returning null. Tiers 2
--      and 3 (the coordinate-based fallback and the no-configuration
--      fallback) are genuinely automatic and are labelled 'auto'.
--      Everything else about eligibility/ordering/stock-filtering is
--      unchanged.
--
--   5. create_product_request/reject_product_request now capture and store
--      that per-hop distance_source on the product_request_routes row they
--      insert, alongside the distance_km they already stored. Their own
--      signatures and the rest of their logic are unchanged.
--
-- Per the lesson from migrations 014/015/020/022: CREATE OR REPLACE cannot
-- change a function's return type. next_eligible_location gains an output
-- column, so its old 3-arg-in/2-col-out signature is explicitly DROPped
-- below before being recreated. generate_routing_sequence,
-- create_product_request and reject_product_request keep their existing
-- signatures, so they're safely CREATE OR REPLACE'd in place.
--
-- Entirely additive/backward-compatible: no existing column is dropped or
-- renamed, no existing row's routing behavior changes when both ends of a
-- route already have coordinates. Safe to re-run.
-- ============================================================================

alter table template.location_routing_rules
  add column if not exists distance_km numeric(10, 3)
    constraint location_routing_rules_distance_km_check check (distance_km is null or distance_km >= 0);

alter table template.location_routing_rules
  add column if not exists distance_source text not null default 'auto'
    constraint location_routing_rules_distance_source_check check (distance_source in ('auto', 'manual'));

alter table template.product_request_routes
  add column if not exists distance_source text not null default 'auto'
    constraint product_request_routes_distance_source_check check (distance_source in ('auto', 'manual'));

-- ── generate_routing_sequence: now persists distance_km/'auto' on insert ──
create or replace function template.generate_routing_sequence(
  p_source_location_id uuid
)
returns table (out_target_location_id uuid, out_priority integer, out_distance_km numeric)
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_src_lat numeric;
  v_src_lng numeric;
  v_src_cluster_id uuid;
begin
  select latitude, longitude, cluster_id into v_src_lat, v_src_lng, v_src_cluster_id
  from template.locations where id = p_source_location_id;

  if v_src_lat is null or v_src_lng is null then
    return;
  end if;

  delete from template.location_routing_rules where source_location_id = p_source_location_id;

  return query
    with ranked as (
      select
        l.id as target_id,
        (6371 * acos(least(1, greatest(-1,
          cos(radians(v_src_lat)) * cos(radians(l.latitude)) * cos(radians(l.longitude) - radians(v_src_lng))
          + sin(radians(v_src_lat)) * sin(radians(l.latitude))
        ))))::numeric as dist
      from template.locations l
      where l.is_active = true
        and l.id <> p_source_location_id
        and l.latitude is not null and l.longitude is not null
        and (
          v_src_cluster_id is null
          or l.cluster_id is null
          or l.cluster_id = v_src_cluster_id
          or exists (
            select 1 from template.cluster_relationships cr
            where cr.source_cluster_id = v_src_cluster_id
              and cr.target_cluster_id = l.cluster_id
              and cr.allow_product_requests = true
              and cr.is_active = true
          )
        )
    ),
    inserted as (
      insert into template.location_routing_rules (source_location_id, target_location_id, priority, distance_km, distance_source)
      select p_source_location_id, target_id, row_number() over (order by dist asc)::int, dist, 'auto'
      from ranked
      returning target_location_id, priority
    )
    select i.target_location_id, i.priority, r.dist
    from inserted i
    join ranked r on r.target_id = i.target_location_id
    order by i.priority asc;
end;
$$;

-- ── next_eligible_location: gains distance_source output ─────────────────
drop function if exists template.next_eligible_location(uuid, uuid[], uuid, numeric);

create or replace function template.next_eligible_location(
  p_source_location_id uuid,
  p_exclude_location_ids uuid[],
  p_product_id uuid,
  p_quantity numeric
)
returns table (location_id uuid, distance_km numeric, distance_source text)
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_src_lat numeric;
  v_src_lng numeric;
  v_src_cluster_id uuid;
  v_has_rules boolean;
begin
  select latitude, longitude, cluster_id into v_src_lat, v_src_lng, v_src_cluster_id
  from template.locations where id = p_source_location_id;

  -- Auto-bootstrap unchanged: only runs when this source has zero rules
  -- (and only actually generates anything if the source has coordinates —
  -- generate_routing_sequence() is a no-op otherwise, leaving the door
  -- open for the admin to configure rules manually).
  select exists(select 1 from template.location_routing_rules where source_location_id = p_source_location_id) into v_has_rules;
  if not v_has_rules then
    perform template.generate_routing_sequence(p_source_location_id);
  end if;

  return query
    select r.target_location_id,
      case when v_src_lat is not null and v_src_lng is not null and l.latitude is not null and l.longitude is not null
        then (6371 * acos(least(1, greatest(-1,
          cos(radians(v_src_lat)) * cos(radians(l.latitude)) * cos(radians(l.longitude) - radians(v_src_lng))
          + sin(radians(v_src_lat)) * sin(radians(l.latitude))
        ))))::numeric
        else r.distance_km
      end as distance_km,
      case when v_src_lat is not null and v_src_lng is not null and l.latitude is not null and l.longitude is not null
        then 'auto'
        else coalesce(r.distance_source, 'manual')
      end as distance_source
    from template.location_routing_rules r
    join template.locations l on l.id = r.target_location_id
    where r.source_location_id = p_source_location_id
      and r.is_active = true
      and l.is_active = true
      and not (r.target_location_id = any (p_exclude_location_ids))
      and exists (
        select 1 from template.stock s
        where s.product_id = p_product_id and s.location_id = r.target_location_id
          and coalesce(s.quantity - s.reserved_quantity, 0) >= p_quantity
      )
    order by r.priority asc
    limit 1;

  if found then
    return;
  end if;

  if v_src_lat is not null and v_src_lng is not null then
    return query
      select l.id,
        (6371 * acos(least(1, greatest(-1,
          cos(radians(v_src_lat)) * cos(radians(l.latitude)) * cos(radians(l.longitude) - radians(v_src_lng))
          + sin(radians(v_src_lat)) * sin(radians(l.latitude))
        ))))::numeric as distance_km,
        'auto'::text as distance_source
      from template.locations l
      where l.is_active = true
        and l.id <> p_source_location_id
        and l.latitude is not null and l.longitude is not null
        and not (l.id = any (p_exclude_location_ids))
        and (
          v_src_cluster_id is null
          or l.cluster_id is null
          or l.cluster_id = v_src_cluster_id
          or exists (
            select 1 from template.cluster_relationships cr
            where cr.source_cluster_id = v_src_cluster_id
              and cr.target_cluster_id = l.cluster_id
              and cr.allow_product_requests = true
              and cr.is_active = true
          )
        )
        and exists (
          select 1 from template.stock s
          where s.product_id = p_product_id and s.location_id = l.id
            and coalesce(s.quantity - s.reserved_quantity, 0) >= p_quantity
        )
      order by distance_km asc
      limit 1;

    if found then
      return;
    end if;
  end if;

  return query
    select l.id, null::numeric, 'auto'::text
    from template.locations l
    where l.is_active = true
      and l.id <> p_source_location_id
      and not (l.id = any (p_exclude_location_ids))
      and (
        v_src_cluster_id is null
        or l.cluster_id is null
        or l.cluster_id = v_src_cluster_id
        or exists (
          select 1 from template.cluster_relationships cr
          where cr.source_cluster_id = v_src_cluster_id
            and cr.target_cluster_id = l.cluster_id
            and cr.allow_product_requests = true
            and cr.is_active = true
        )
      )
      and exists (
        select 1 from template.stock s
        where s.product_id = p_product_id and s.location_id = l.id
          and coalesce(s.quantity - s.reserved_quantity, 0) >= p_quantity
      )
    order by l.created_at asc
    limit 1;
end;
$$;

-- ── create_product_request: stores distance_source on the first hop ──────
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
  v_distance_source text;
begin
  select location_id, distance_km, distance_source into v_target, v_distance, v_distance_source
  from template.next_eligible_location(p_source_location_id, array[p_source_location_id], p_product_id, p_quantity);

  if v_target is null then
    raise exception 'No eligible destination location currently has enough stock to fulfill this request';
  end if;

  insert into template.product_requests
    (product_id, requested_by, source_location_id, quantity, status, current_target_location_id, note)
  values
    (p_product_id, p_requested_by, p_source_location_id, p_quantity, 'assigned', v_target, p_note)
  returning id into v_request_id;

  insert into template.product_request_routes (request_id, sequence_no, target_location_id, distance_km, distance_source, status)
  values (v_request_id, 1, v_target, v_distance, coalesce(v_distance_source, 'auto'), 'pending');

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

-- ── reject_product_request: stores distance_source on the escalated hop ──
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
  v_next_distance_source text;
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

  select location_id, distance_km, distance_source into v_next_target, v_next_distance, v_next_distance_source
  from template.next_eligible_location(v_req.source_location_id, v_tried, v_req.product_id, v_req.quantity);

  if v_next_target is null then
    update template.product_requests
      set status = 'exhausted', current_target_location_id = null, updated_at = now(), resolved_at = now()
      where id = p_request_id;

    insert into template.product_request_status_history (request_id, from_status, to_status, performed_by)
    values (p_request_id, 'rejected', 'exhausted', p_decided_by);

    return 'exhausted';
  end if;

  insert into template.product_request_routes (request_id, sequence_no, target_location_id, distance_km, distance_source, status)
  values (
    p_request_id,
    (select coalesce(max(sequence_no), 0) + 1 from template.product_request_routes where request_id = p_request_id),
    v_next_target, v_next_distance, coalesce(v_next_distance_source, 'auto'), 'pending'
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
