-- ============================================================================
-- Rack & Location Management: fix duplicate function overloads
-- EXISTING TENANTS
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself,
--     AFTER 014_rack_stock_tracking_fix_overloads_template.sql, against the
--     same database. Loops over every row in public.companies and drops the
--     same stale old-signature overloads there too (013 cloned both
--     overloads into every existing tenant schema the same way).
--
-- Safe to re-run: `drop function if exists` on an already-dropped signature
-- is a no-op. Does not touch any data.
-- ============================================================================

do $$
declare
  r record;
begin
  for r in select schema_name from public.companies loop
    raise notice 'Fixing duplicate rack-tracking overloads in: %', r.schema_name;

    execute format('drop function if exists %1$I.stock_in_lot(uuid, uuid, numeric, text, uuid, text, text, date)', r.schema_name);
    execute format('drop function if exists %1$I.stock_out(uuid, uuid, numeric, text, uuid)', r.schema_name);
    execute format('drop function if exists %1$I.transfer_stock(uuid, uuid, uuid, numeric, text, uuid)', r.schema_name);
    execute format('drop function if exists %1$I.report_damaged_stock(uuid, uuid, numeric, uuid, text)', r.schema_name);
    execute format('drop function if exists %1$I.restore_damaged_stock(uuid, uuid, numeric, uuid, text)', r.schema_name);
  end loop;
end;
$$;
