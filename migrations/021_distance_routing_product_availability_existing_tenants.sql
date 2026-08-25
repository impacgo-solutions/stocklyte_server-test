-- ============================================================================
-- Distance-Based Routing: product-availability gating — EXISTING TENANTS
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself,
--     AFTER 020_distance_routing_product_availability_template.sql, against
--     the same database. Loops over every row in public.companies, drops
--     the stale 2-arg next_eligible_location overload (mirroring migrations
--     014/015's fix), then re-clones next_eligible_location,
--     create_product_request, and reject_product_request from `template`.
--
-- Safe to re-run: the drop is IF EXISTS; the three functions are always
-- re-cloned via CREATE OR REPLACE. Does not touch any data.
-- ============================================================================

do $$
declare
  r record;
  fn record;
  new_body text;
begin
  for r in select schema_name from public.companies loop
    raise notice 'Migrating tenant schema (distance routing / product availability): %', r.schema_name;

    execute format('drop function if exists %1$I.next_eligible_location(uuid, uuid[])', r.schema_name);

    for fn in
      select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'template'
        and p.proname in ('next_eligible_location', 'create_product_request', 'reject_product_request')
    loop
      new_body := replace(fn.def, 'template', r.schema_name);
      execute new_body;
    end loop;

  end loop;
end;
$$;
