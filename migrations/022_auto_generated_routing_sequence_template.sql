-- ============================================================================
-- Auto-Generated Nearest-First Routing Sequence — TEMPLATE schema
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself
--     (Supabase SQL editor or psql), connected with a role that owns the
--     `template` schema. Run 023_..._existing_tenants.sql immediately after.
--
-- Purpose: location_routing_rules today is populated entirely by hand (an
-- admin adding one source->target->priority row at a time via the Routing
-- Rules screen). This migration adds automatic generation of that same
-- table's rows from each location's already-captured latitude/longitude,
-- so an admin never has to manually wire up every warehouse pair:
--
--   1. New function generate_routing_sequence(source) computes the
--      haversine distance from `source` to every OTHER active,
--      coordinate-having, cluster-eligible location (identical
--      eligibility rule next_eligible_location's tier-2 fallback already
--      uses), ranks them nearest-to-farthest, and REPLACES that source's
--      location_routing_rules rows with the freshly ranked set
--      (priority 1 = nearest). This is the existing routing structure —
--      no new table, no schema change.
--
--   2. next_eligible_location() now auto-bootstraps: the first time a
--      source location is used for routing (request creation or
--      escalation) and it has ZERO routing rules configured at all yet,
--      it calls generate_routing_sequence() once, then proceeds exactly
--      as before. A source that already has rules — manually configured
--      or previously auto-generated — is left alone; nothing is silently
--      recomputed out from under an admin's existing configuration.
--      Tiers 2/3 (the pre-existing distance/oldest fallbacks) are
--      unchanged and still apply if the (now-populated) rule set doesn't
--      yield an eligible, stock-sufficient target.
--
--   3. Tier 1 (location_routing_rules) now also computes/returns the real
--      distance_km for whichever target it picks, when both locations
--      have coordinates (previously always null for this tier) — so
--      routing history shows a calculated distance regardless of whether
--      the rule was auto-generated or hand-configured.
--
-- Entirely additive: one new function, and next_eligible_location gains a
-- bootstrap step and a distance calculation on its existing first tier —
-- the three-tier structure, priority-ordering, cluster/stock eligibility,
-- and escalation mechanism are all completely unchanged. Safe to re-run.
-- ============================================================================

-- Replaces `p_source_location_id`'s entire routing-rule row set with a
-- fresh nearest-to-farthest ranking of every eligible target. Returns the
-- generated rows (target_location_id, priority, distance_km) so a caller
-- (the admin-triggered "Recalculate" endpoint) can hand them straight back
-- to the client without a second query.
-- Note: the OUT parameter names below are deliberately NOT
-- target_location_id/priority/distance_km — plpgsql's RETURNS TABLE OUT
-- parameters live in the same namespace as ordinary columns inside the
-- function body, so naming one identically to a real column of
-- location_routing_rules makes any bare reference to that column
-- (e.g. in an INSERT's column list or its RETURNING clause) ambiguous
-- between "the table column" and "the OUT parameter" — Postgres then
-- refuses the whole statement with "column reference ... is ambiguous".
-- CREATE OR REPLACE cannot rename RETURNS TABLE output columns (Postgres
-- treats that as a return-type change) — drop first so re-running this
-- file is safe regardless of which OUT-parameter-name version, if any,
-- is currently installed.
drop function if exists template.generate_routing_sequence(uuid);

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

  -- Can't rank anything without the source's own coordinates — leave
  -- whatever rules (if any) already exist untouched and return nothing.
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
      insert into template.location_routing_rules (source_location_id, target_location_id, priority)
      select p_source_location_id, target_id, row_number() over (order by dist asc)::int
      from ranked
      returning target_location_id, priority
    )
    select i.target_location_id, i.priority, r.dist
    from inserted i
    join ranked r on r.target_id = i.target_location_id
    order by i.priority asc;
end;
$$;

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
  v_has_rules boolean;
begin
  select latitude, longitude, cluster_id into v_src_lat, v_src_lng, v_src_cluster_id
  from template.locations where id = p_source_location_id;

  -- Auto-bootstrap: the first time this source is ever used for routing
  -- and it has no rules configured at all, generate and persist its
  -- nearest-to-farthest sequence automatically. A source that already has
  -- rules (manually configured, or generated by an earlier call/an
  -- explicit recalculate) is never silently overwritten here.
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
        else null::numeric
      end as distance_km
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
