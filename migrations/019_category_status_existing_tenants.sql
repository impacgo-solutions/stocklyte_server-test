-- ============================================================================
-- Category Status (Active/Inactive) — EXISTING TENANTS
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself,
--     AFTER 018_category_status_template.sql, against the same database.
--     Loops over every row in public.companies and brings that tenant's own
--     schema up to the same shape as `template` now has.
--
-- Safe to re-run: idempotent (IF NOT EXISTS). Does not modify any existing
-- row's other columns; every existing category becomes is_active = true.
-- ============================================================================

do $$
declare
  r record;
begin
  for r in select schema_name from public.companies loop
    raise notice 'Migrating tenant schema (category status): %', r.schema_name;
    execute format('alter table %1$I.categories add column if not exists is_active boolean not null default true', r.schema_name);
  end loop;
end;
$$;
