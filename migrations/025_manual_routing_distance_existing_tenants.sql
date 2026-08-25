-- ============================================================================
-- Hybrid Auto/Manual Routing Distance — EXISTING TENANTS
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself,
--     AFTER 024_manual_routing_distance_template.sql, against the same
--     database. Loops over every row in public.companies: adds the two new
--     columns to that tenant's location_routing_rules/product_request_routes
--     tables, drops the stale 2-output-column next_eligible_location
--     overload, then re-clones next_eligible_location,
--     generate_routing_sequence, create_product_request and
--     reject_product_request from `template`.
--
-- Safe to re-run: the column adds are idempotent (IF NOT EXISTS), the drop
-- is IF EXISTS, and the four functions are always re-cloned via CREATE OR
-- REPLACE. Does not delete or modify any existing row.
-- ============================================================================

do $$
declare
  r record;
  fn record;
  new_body text;
begin
  for r in select schema_name from public.companies loop
    raise notice 'Migrating tenant schema (manual routing distance): %', r.schema_name;

    execute format(
      'alter table %1$I.location_routing_rules add column if not exists distance_km numeric(10,3) constraint location_routing_rules_distance_km_check check (distance_km is null or distance_km >= 0)',
      r.schema_name
    );
    execute format(
      'alter table %1$I.location_routing_rules add column if not exists distance_source text not null default ''auto'' constraint location_routing_rules_distance_source_check check (distance_source in (''auto'', ''manual''))',
      r.schema_name
    );
    execute format(
      'alter table %1$I.product_request_routes add column if not exists distance_source text not null default ''auto'' constraint product_request_routes_distance_source_check check (distance_source in (''auto'', ''manual''))',
      r.schema_name
    );

    execute format('drop function if exists %1$I.next_eligible_location(uuid, uuid[], uuid, numeric)', r.schema_name);

    for fn in
      select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'template'
        and p.proname in ('generate_routing_sequence', 'next_eligible_location', 'create_product_request', 'reject_product_request')
      -- generate_routing_sequence before next_eligible_location (which calls
      -- it), and both before the two request-lifecycle functions that call
      -- next_eligible_location.
      order by case p.proname
        when 'generate_routing_sequence' then 0
        when 'next_eligible_location' then 1
        else 2
      end
    loop
      new_body := replace(fn.def, 'template', r.schema_name);
      execute new_body;
    end loop;

  end loop;
end;
$$;
