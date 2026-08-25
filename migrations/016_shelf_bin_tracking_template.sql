-- ============================================================================
-- Shelf/Bin Storage Tracking — TEMPLATE schema
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself
--     (Supabase SQL editor or psql), connected with a role that owns the
--     `template` schema. Run 017_..._existing_tenants.sql immediately after.
--
-- Purpose: adds one storage level below `racks` (Warehouse/Location → Rack →
-- Shelf/Bin), following the exact same shape and rules already proven by
-- racks/rack_stock:
--   - `bins` is a child of a single rack (rack_id, cascade delete), with an
--     optional nullable `capacity` (null = no defined limit) and `is_active`.
--   - `bin_stock` is a product↔bin allocation row, deliberately NOT wired
--     into stock_in_lot/stock_out/transfer_stock — same "manual, additive
--     sub-allocation for visibility/assignment" design rack_stock originally
--     had before migration 012, set only via the new PUT /bins/:id/stock
--     endpoint (mirroring PUT /racks/:id/stock exactly, including its
--     capacity/over-allocation guards). This keeps the change low-risk: it
--     does not touch any of the core stock-movement functions.
--
-- Entirely additive: no existing template table is dropped, renamed, or has
-- a column removed. Safe to re-run (every statement is idempotent).
-- ============================================================================

create table if not exists template.bins (
  id          uuid primary key default gen_random_uuid(),
  rack_id     uuid not null references template.racks (id) on delete cascade,
  code        text not null,
  name        text,
  is_active   boolean not null default true,
  capacity    numeric constraint bins_capacity_check check (capacity is null or capacity >= 0),
  created_at  timestamptz not null default now(),
  constraint bins_rack_id_code_key unique (rack_id, code)
);

create table if not exists template.bin_stock (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references template.products (id) on delete cascade,
  bin_id       uuid not null references template.bins (id) on delete cascade,
  quantity     numeric(14, 3) not null default 0 constraint bin_stock_quantity_check check (quantity >= 0),
  updated_at   timestamptz not null default now(),
  constraint bin_stock_product_id_bin_id_key unique (product_id, bin_id)
);

create index if not exists bins_rack_idx on template.bins (rack_id);
create index if not exists bin_stock_bin_idx on template.bin_stock (bin_id);

drop trigger if exists bin_stock_updated_at on template.bin_stock;
create trigger bin_stock_updated_at
  before update on template.bin_stock
  for each row execute function template.update_updated_at ();
