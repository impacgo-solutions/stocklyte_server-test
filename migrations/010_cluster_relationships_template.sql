-- ============================================================================
-- Cluster Relationship Management — TEMPLATE schema
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself
--     (Supabase SQL editor or psql), connected with a role that owns the
--     `template` schema. Run 011_..._existing_tenants.sql immediately after.
--
-- Purpose: lets a tenant configure which clusters may exchange product
-- requests and/or transfers with which other clusters, and makes the
-- nearest-distance escalation fallback (next_eligible_location) respect that
-- configuration. Entirely additive: one new table, and next_eligible_location
-- gets one extra filter condition on its two FALLBACK tiers only — the
-- explicit location_routing_rules tier (an admin's own explicit choice) is
-- completely untouched, so anything already configured there keeps behaving
-- exactly as it does today. Safe to re-run.
-- ============================================================================

-- ── New table ────────────────────────────────────────────────────────────────
-- Directional, same convention as location_routing_rules — add the reverse
-- row explicitly if a relationship should work both ways.

create table if not exists template.cluster_relationships (
  id                      uuid primary key default gen_random_uuid(),
  source_cluster_id       uuid not null references template.clusters (id) on delete cascade,
  target_cluster_id       uuid not null references template.clusters (id) on delete cascade,
  allow_product_requests  boolean not null default true,
  allow_transfers         boolean not null default true,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  constraint cluster_relationships_source_target_key unique (source_cluster_id, target_cluster_id),
  constraint cluster_relationships_source_ne_target check (source_cluster_id <> target_cluster_id)
);

create index if not exists cluster_relationships_source_idx on template.cluster_relationships (source_cluster_id);

-- ── Rewritten function ───────────────────────────────────────────────────────
-- Same three tiers as before (explicit rule -> nearest-by-distance -> oldest
-- active fallback); tiers 2 and 3 now also require the candidate location to
-- be cluster-eligible from the source: no cluster on either side, same
-- cluster, or an active allow_product_requests relationship between them.

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
    order by l.created_at asc
    limit 1;
end;
$$;
