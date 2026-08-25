-- ============================================================================
-- Distance-Based Routing: product-availability gating — TEMPLATE schema
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself
--     (Supabase SQL editor or psql), connected with a role that owns the
--     `template` schema. Run 021_..._existing_tenants.sql immediately after.
--
-- Purpose: `locations.latitude/longitude` and `product_request_routes.
-- distance_km` already exist (migrations 001/002) and next_eligible_location()
-- already computes haversine distance as its tier-2 fallback (migration 010).
-- What's missing, per the explicit requirement that only warehouses that can
-- actually FULFILL a request are considered eligible: none of the three
-- tiers ever checked stock availability — a request could be routed (and a
-- human would have to manually reject it) even to a location with zero
-- stock of the product. This migration adds a stock-availability check
-- (available quantity = quantity - reserved_quantity >= the requested
-- quantity) to all three existing tiers, changing nothing else about how
-- they're ordered or filtered:
--   1. Explicit location_routing_rules, tried in priority order (admin's
--      own explicit override — cluster-blind, exactly as today) — now also
--      skips a configured target that can't fulfill the quantity, moving on
--      to the next-priority rule instead of relying on a human to reject it.
--   2. Nearest-by-haversine-distance among cluster-eligible active
--      locations with coordinates — now also requires sufficient stock.
--   3. Oldest-active-location fallback (no coordinates configured at all)
--      — now also requires sufficient stock.
--
-- This IS an intentional behavior change at the boundary: a request can now
-- fail fast (immediately "No eligible destination..." on create, or
-- immediately "exhausted" on the last rejection) when literally no
-- candidate location has enough stock, rather than being assigned to a
-- location a human then has to manually reject for lack of stock. That is
-- exactly what "only warehouses that can fulfill the request are
-- considered" requires.
--
-- Signature changes from (uuid, uuid[]) to (uuid, uuid[], uuid, numeric) —
-- adding p_product_id/p_quantity so the stock check has something to check
-- against. Per the lesson from migrations 014/015: CREATE OR REPLACE with a
-- different parameter list creates a second overload rather than replacing
-- the function, which breaks tenantProvisioning.js's exact-count clone
-- check — so the old 2-arg signature is explicitly DROPped below.
--
-- create_product_request/reject_product_request's OWN signatures are
-- unchanged (still 5 args / 3 args) — only their internal call to
-- next_eligible_location() changes to pass the extra two arguments they
-- already have on hand (p_product_id/p_quantity, or v_req.product_id/
-- v_req.quantity). The JS layer (productRequests.js) calls these two
-- functions exactly as before — no API contract change.
--
-- Safe to re-run: functions are CREATE OR REPLACE, the drop is IF EXISTS.
-- Does not modify any existing row.
-- ============================================================================

create or replace function template.next_eligible_location(
  p_source_location_id uuid,
  p_exclude_location_ids uuid[],
  p_product_id uuid,
  p_quantity numeric
)
returns table (location_id uuid, distance_km numeric)
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_src_lat numeric;
  v_src_lng numeric;
  v_src_cluster_id uuid;
begin
  return query
    select r.target_location_id, null::numeric
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

  select latitude, longitude, cluster_id into v_src_lat, v_src_lng, v_src_cluster_id
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
    select l.id, null::numeric
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

drop function if exists template.next_eligible_location(uuid, uuid[]);

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
  from template.next_eligible_location(p_source_location_id, array[p_source_location_id], p_product_id, p_quantity);

  if v_target is null then
    raise exception 'No eligible destination location currently has enough stock to fulfill this request';
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
  from template.next_eligible_location(v_req.source_location_id, v_tried, v_req.product_id, v_req.quantity);

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
