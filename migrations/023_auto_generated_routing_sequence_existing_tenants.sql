-- ============================================================================
-- Auto-Generated Nearest-First Routing Sequence — EXISTING TENANTS
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself,
--     AFTER 022_auto_generated_routing_sequence_template.sql, against the
--     same database. Loops over every row in public.companies and clones
--     the new generate_routing_sequence() function plus the updated
--     next_eligible_location() from `template` into each tenant schema.
--
-- Safe to re-run: both functions are always re-cloned via CREATE OR
-- REPLACE. Does not touch any existing location_routing_rules row unless
-- a source location has zero rules (the auto-bootstrap case) or an admin
-- explicitly triggers a recalculate.
-- ============================================================================

do $$
declare
  r record;
  fn record;
  new_body text;
begin
  for r in select schema_name from public.companies loop
    raise notice 'Migrating tenant schema (auto-generated routing sequence): %', r.schema_name;

    -- CREATE OR REPLACE cannot rename RETURNS TABLE output columns — drop
    -- first so this is safe to re-run regardless of which OUT-parameter-name
    -- version, if any, is currently installed in this tenant.
    execute format('drop function if exists %1$I.generate_routing_sequence(uuid)', r.schema_name);

    for fn in
      select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'template'
        and p.proname in ('generate_routing_sequence', 'next_eligible_location')
      -- create generate_routing_sequence first — next_eligible_location calls it
      order by case when p.proname = 'generate_routing_sequence' then 0 else 1 end
    loop
      new_body := replace(fn.def, 'template', r.schema_name);
      execute new_body;
    end loop;

  end loop;
end;
$$;
