-- ============================================================================
-- Rack & Location Management: capacity + movement-consistent rack_stock
-- EXISTING TENANTS
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself,
--     AFTER 012_rack_stock_tracking_template.sql, against the same
--     database. Loops over every row in public.companies and brings that
--     tenant's own schema up to the same shape as `template` now has.
--
-- Safe to re-run: the column adds are idempotent (IF NOT EXISTS); the five
-- functions are always re-cloned from `template` via CREATE OR REPLACE, so
-- re-running just re-syncs them to whatever `template` currently has. Does
-- not delete or modify any existing row in any tenant schema.
-- ============================================================================

do $$
declare
  r record;
  fn record;
  new_body text;
begin
  for r in select schema_name from public.companies loop

    raise notice 'Migrating tenant schema (rack stock tracking): %', r.schema_name;

    execute format(
      'alter table %1$I.racks add column if not exists capacity numeric constraint racks_capacity_check check (capacity is null or capacity >= 0)',
      r.schema_name
    );

    execute format(
      'alter table %1$I.stock_transactions add column if not exists from_rack_id uuid references %1$I.racks (id) on delete set null',
      r.schema_name
    );
    execute format(
      'alter table %1$I.stock_transactions add column if not exists to_rack_id uuid references %1$I.racks (id) on delete set null',
      r.schema_name
    );

    execute format(
      'create index if not exists stock_transactions_from_rack_idx on %1$I.stock_transactions (from_rack_id) where from_rack_id is not null',
      r.schema_name
    );
    execute format(
      'create index if not exists stock_transactions_to_rack_idx on %1$I.stock_transactions (to_rack_id) where to_rack_id is not null',
      r.schema_name
    );

    -- ── Re-clone the five rewritten functions from `template` ───────────────
    for fn in
      select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'template'
        and p.proname in (
          'stock_in_lot', 'stock_out', 'transfer_stock',
          'report_damaged_stock', 'restore_damaged_stock'
        )
    loop
      new_body := replace(fn.def, 'template', r.schema_name);
      execute new_body;
    end loop;

  end loop;
end;
$$;
