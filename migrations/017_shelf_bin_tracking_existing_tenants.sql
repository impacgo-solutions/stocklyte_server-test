-- ============================================================================
-- Shelf/Bin Storage Tracking — EXISTING TENANTS
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself,
--     AFTER 016_shelf_bin_tracking_template.sql, against the same database.
--     Loops over every row in public.companies and brings that tenant's own
--     schema up to the same shape as `template` now has.
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / DROP..IF
-- EXISTS + re-ADD). Does not delete or modify any existing row.
-- ============================================================================

do $$
declare
  r record;
begin
  for r in select schema_name from public.companies loop

    raise notice 'Migrating tenant schema (shelf/bin tracking): %', r.schema_name;

    execute format($f$
      create table if not exists %1$I.bins (
        id          uuid primary key default gen_random_uuid(),
        rack_id     uuid not null references %1$I.racks (id) on delete cascade,
        code        text not null,
        name        text,
        is_active   boolean not null default true,
        capacity    numeric constraint bins_capacity_check check (capacity is null or capacity >= 0),
        created_at  timestamptz not null default now(),
        constraint bins_rack_id_code_key unique (rack_id, code)
      )
    $f$, r.schema_name);

    execute format($f$
      create table if not exists %1$I.bin_stock (
        id           uuid primary key default gen_random_uuid(),
        product_id   uuid not null references %1$I.products (id) on delete cascade,
        bin_id       uuid not null references %1$I.bins (id) on delete cascade,
        quantity     numeric(14, 3) not null default 0 constraint bin_stock_quantity_check check (quantity >= 0),
        updated_at   timestamptz not null default now(),
        constraint bin_stock_product_id_bin_id_key unique (product_id, bin_id)
      )
    $f$, r.schema_name);

    execute format('create index if not exists bins_rack_idx on %1$I.bins (rack_id)', r.schema_name);
    execute format('create index if not exists bin_stock_bin_idx on %1$I.bin_stock (bin_id)', r.schema_name);

    execute format('drop trigger if exists bin_stock_updated_at on %1$I.bin_stock', r.schema_name);
    execute format('create trigger bin_stock_updated_at before update on %1$I.bin_stock for each row execute function %1$I.update_updated_at ()', r.schema_name);

  end loop;
end;
$$;
