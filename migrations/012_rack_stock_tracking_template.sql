-- ============================================================================
-- Rack & Location Management: capacity + movement-consistent rack_stock
-- TEMPLATE schema
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself
--     (Supabase SQL editor or psql), connected with a role that owns the
--     `template` schema. Run 013_..._existing_tenants.sql immediately after.
--
-- Purpose: `racks` and `rack_stock` already exist, but (a) racks have no
-- capacity field, and (b) rack_stock is a purely manual side-table that no
-- real stock-movement function ever touches — so it silently drifts out of
-- sync with reality the moment a normal stock-in/out/transfer/damage action
-- happens. This migration:
--   1. Adds a nullable `capacity` column to `racks` (null = no defined limit;
--      every existing rack keeps working exactly as before).
--   2. Adds nullable `from_rack_id`/`to_rack_id` traceability columns to
--      `stock_transactions`, mirroring the existing from/to_location_id
--      pattern — purely additive, every existing insert is unaffected.
--   3. Rewrites stock_in_lot / stock_out / transfer_stock /
--      report_damaged_stock / restore_damaged_stock to accept an optional
--      rack id (or from/to rack ids for transfer_stock), defaulting to null.
--      Every existing positional call site (stock.js) that doesn't pass a
--      rack behaves byte-for-byte the same as today. When a rack IS passed,
--      the function atomically keeps rack_stock consistent with the
--      location-level stock row in the same transaction: validates the rack
--      belongs to the location given, enforces capacity on anything moving
--      INTO a rack, requires sufficient rack-level quantity on anything
--      moving OUT of a rack (on top of rack_stock's own existing
--      `quantity >= 0` check, which stays as a hard backstop), and blocks
--      new stock arriving at an inactive rack.
--   4. `writeoff_damaged_stock` is intentionally left unchanged — it only
--      adjusts `damaged_quantity`, which was already removed from
--      rack_stock at report-damage time.
--
-- Safe to re-run: column adds are IF NOT EXISTS, functions are CREATE OR
-- REPLACE. Does not modify any existing row.
-- ============================================================================

-- ── New columns ──────────────────────────────────────────────────────────────

alter table template.racks
  add column if not exists capacity numeric constraint racks_capacity_check check (capacity is null or capacity >= 0);

alter table template.stock_transactions
  add column if not exists from_rack_id uuid references template.racks (id) on delete set null,
  add column if not exists to_rack_id   uuid references template.racks (id) on delete set null;

create index if not exists stock_transactions_from_rack_idx on template.stock_transactions (from_rack_id) where from_rack_id is not null;
create index if not exists stock_transactions_to_rack_idx   on template.stock_transactions (to_rack_id)   where to_rack_id   is not null;

-- ── Rewritten functions ───────────────────────────────────────────────────────

create or replace function template.stock_in_lot(
  p_product_id    uuid,
  p_location_id   uuid,
  p_quantity      numeric,
  p_note          text default null,
  p_performed_by  uuid default null,
  p_batch_number  text default null,
  p_supplier_name text default null,
  p_expiry_date   date default null,
  p_rack_id       uuid default null
)
returns json
language plpgsql
security definer
set search_path to 'template', 'public'
as $$
declare
  v_stock_id      uuid;
  v_new_qty       numeric;
  v_rack_location uuid;
  v_rack_active   boolean;
  v_rack_capacity numeric;
  v_rack_total    numeric;
begin
  if p_rack_id is not null then
    select location_id, is_active, capacity into v_rack_location, v_rack_active, v_rack_capacity
    from racks where id = p_rack_id;

    if v_rack_location is null then
      raise exception 'Rack not found';
    end if;
    if v_rack_location <> p_location_id then
      raise exception 'Rack does not belong to this location';
    end if;
    if not v_rack_active then
      raise exception 'This rack is inactive and cannot receive stock';
    end if;

    if v_rack_capacity is not null then
      select coalesce(sum(quantity), 0) into v_rack_total from rack_stock where rack_id = p_rack_id;
      if v_rack_total + round(p_quantity, 3) > v_rack_capacity then
        raise exception 'This rack''s capacity (%) would be exceeded', v_rack_capacity;
      end if;
    end if;
  end if;

  insert into stock (product_id, location_id, quantity)
  values (p_product_id, p_location_id, round(p_quantity, 3))
  on conflict (product_id, location_id)
  do update set quantity = round(stock.quantity + excluded.quantity, 3)
  returning id, quantity into v_stock_id, v_new_qty;

  if p_rack_id is not null then
    insert into rack_stock (product_id, rack_id, quantity)
    values (p_product_id, p_rack_id, round(p_quantity, 3))
    on conflict (product_id, rack_id)
    do update set quantity = rack_stock.quantity + excluded.quantity, updated_at = now();
  end if;

  insert into stock_transactions (
    product_id, to_location_id, transaction_type, quantity, note, performed_by,
    batch_number, supplier_name, expiry_date, to_rack_id
  ) values (
    p_product_id, p_location_id, 'in', round(p_quantity, 3), p_note, p_performed_by,
    p_batch_number, p_supplier_name, p_expiry_date, p_rack_id
  );

  return json_build_object('id', v_stock_id, 'quantity', v_new_qty);
end;
$$;

create or replace function template.stock_out(
  p_product_id   uuid,
  p_location_id  uuid,
  p_quantity     numeric,
  p_note         text default null,
  p_performed_by uuid default null,
  p_rack_id      uuid default null
)
returns json
language plpgsql
security definer
set search_path to 'template', 'public'
as $$
declare
  v_stock_id      uuid;
  v_current       numeric;
  v_new_qty       numeric;
  v_rack_location uuid;
  v_rack_qty      numeric;
begin
  select id, quantity into v_stock_id, v_current
  from stock
  where product_id = p_product_id and location_id = p_location_id
  for update;

  if not found then
    raise exception 'No stock found for this product/location';
  end if;

  if v_current < p_quantity then
    raise exception 'Insufficient stock. Available: %', round(v_current, 3);
  end if;

  if p_rack_id is not null then
    select location_id into v_rack_location from racks where id = p_rack_id;
    if v_rack_location is null then
      raise exception 'Rack not found';
    end if;
    if v_rack_location <> p_location_id then
      raise exception 'Rack does not belong to this location';
    end if;

    select quantity into v_rack_qty from rack_stock
      where product_id = p_product_id and rack_id = p_rack_id
      for update;

    if v_rack_qty is null or v_rack_qty < p_quantity then
      raise exception 'Insufficient stock in this rack. Available: %', round(coalesce(v_rack_qty, 0), 3);
    end if;

    update rack_stock set quantity = round(v_rack_qty - p_quantity, 3), updated_at = now()
      where product_id = p_product_id and rack_id = p_rack_id;
  end if;

  v_new_qty := round(v_current - p_quantity, 3);

  update stock set quantity = v_new_qty where id = v_stock_id;

  insert into stock_transactions (
    product_id, from_location_id, transaction_type, quantity, note, performed_by, from_rack_id
  ) values (
    p_product_id, p_location_id, 'out', round(p_quantity, 3), p_note, p_performed_by, p_rack_id
  );

  return json_build_object('id', v_stock_id, 'quantity', v_new_qty);
end;
$$;

create or replace function template.transfer_stock(
  p_product_id    uuid,
  p_from_loc      uuid,
  p_to_loc        uuid,
  p_quantity      numeric,
  p_note          text default null,
  p_performed_by  uuid default null,
  p_from_rack_id  uuid default null,
  p_to_rack_id    uuid default null
)
returns json
language plpgsql
security definer
set search_path to 'template', 'public'
as $$
declare
  v_from_stock_id  uuid;
  v_from_current   numeric;
  v_from_new       numeric;
  v_to_stock_id    uuid;
  v_to_new         numeric;
  v_rack_location  uuid;
  v_rack_active    boolean;
  v_rack_capacity  numeric;
  v_rack_qty       numeric;
  v_rack_total     numeric;
begin
  select id, quantity into v_from_stock_id, v_from_current
  from stock
  where product_id = p_product_id and location_id = p_from_loc
  for update;

  if not found then
    raise exception 'No stock found at source location for this product';
  end if;

  if v_from_current < p_quantity then
    raise exception 'Insufficient stock. Available: %', round(v_from_current, 3);
  end if;

  if p_from_rack_id is not null then
    select location_id into v_rack_location from racks where id = p_from_rack_id;
    if v_rack_location is null then
      raise exception 'Source rack not found';
    end if;
    if v_rack_location <> p_from_loc then
      raise exception 'Source rack does not belong to the source location';
    end if;

    select quantity into v_rack_qty from rack_stock
      where product_id = p_product_id and rack_id = p_from_rack_id
      for update;

    if v_rack_qty is null or v_rack_qty < p_quantity then
      raise exception 'Insufficient stock in source rack. Available: %', round(coalesce(v_rack_qty, 0), 3);
    end if;
  end if;

  if p_to_rack_id is not null then
    select location_id, is_active, capacity into v_rack_location, v_rack_active, v_rack_capacity
    from racks where id = p_to_rack_id;
    if v_rack_location is null then
      raise exception 'Destination rack not found';
    end if;
    if v_rack_location <> p_to_loc then
      raise exception 'Destination rack does not belong to the destination location';
    end if;
    if not v_rack_active then
      raise exception 'The destination rack is inactive and cannot receive stock';
    end if;

    if v_rack_capacity is not null then
      select coalesce(sum(quantity), 0) into v_rack_total from rack_stock where rack_id = p_to_rack_id;
      if v_rack_total + round(p_quantity, 3) > v_rack_capacity then
        raise exception 'Destination rack''s capacity (%) would be exceeded', v_rack_capacity;
      end if;
    end if;
  end if;

  v_from_new := round(v_from_current - p_quantity, 3);
  update stock set quantity = v_from_new where id = v_from_stock_id;

  if p_from_rack_id is not null then
    update rack_stock set quantity = round(v_rack_qty - p_quantity, 3), updated_at = now()
      where product_id = p_product_id and rack_id = p_from_rack_id;
  end if;

  insert into stock (product_id, location_id, quantity)
  values (p_product_id, p_to_loc, round(p_quantity, 3))
  on conflict (product_id, location_id)
  do update set quantity = round(stock.quantity + excluded.quantity, 3)
  returning id, quantity into v_to_stock_id, v_to_new;

  if p_to_rack_id is not null then
    insert into rack_stock (product_id, rack_id, quantity)
    values (p_product_id, p_to_rack_id, round(p_quantity, 3))
    on conflict (product_id, rack_id)
    do update set quantity = rack_stock.quantity + excluded.quantity, updated_at = now();
  end if;

  insert into stock_transactions (
    product_id, from_location_id, transaction_type, quantity, note, performed_by, from_rack_id
  ) values (
    p_product_id, p_from_loc, 'transfer', round(p_quantity, 3), p_note, p_performed_by, p_from_rack_id
  );

  insert into stock_transactions (
    product_id, to_location_id, transaction_type, quantity, note, performed_by, to_rack_id
  ) values (
    p_product_id, p_to_loc, 'transfer', round(p_quantity, 3), p_note, p_performed_by, p_to_rack_id
  );

  return json_build_object(
    'from_stock_id',  v_from_stock_id,
    'to_stock_id',    v_to_stock_id,
    'quantity',       round(p_quantity, 3),
    'from_remaining', v_from_new,
    'to_new_total',   v_to_new
  );
end;
$$;

create or replace function template.report_damaged_stock(
  p_product_id   uuid,
  p_location_id  uuid,
  p_quantity     numeric,
  p_performed_by uuid,
  p_note         text default null,
  p_rack_id      uuid default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_available     numeric;
  v_rack_location uuid;
  v_rack_qty      numeric;
begin
  select quantity into v_available from template.stock
    where product_id = p_product_id and location_id = p_location_id for update;

  if v_available is null or v_available < p_quantity then
    raise exception 'Insufficient available stock to report as damaged';
  end if;

  if p_rack_id is not null then
    select location_id into v_rack_location from template.racks where id = p_rack_id;
    if v_rack_location is null then
      raise exception 'Rack not found';
    end if;
    if v_rack_location <> p_location_id then
      raise exception 'Rack does not belong to this location';
    end if;

    select quantity into v_rack_qty from template.rack_stock
      where product_id = p_product_id and rack_id = p_rack_id for update;

    if v_rack_qty is null or v_rack_qty < p_quantity then
      raise exception 'Insufficient stock in this rack to report as damaged. Available: %', round(coalesce(v_rack_qty, 0), 3);
    end if;

    update template.rack_stock set quantity = quantity - p_quantity, updated_at = now()
      where product_id = p_product_id and rack_id = p_rack_id;
  end if;

  update template.stock
    set quantity = quantity - p_quantity, damaged_quantity = damaged_quantity + p_quantity
    where product_id = p_product_id and location_id = p_location_id;

  insert into template.stock_transactions (product_id, from_location_id, transaction_type, quantity, note, performed_by, from_rack_id)
  values (p_product_id, p_location_id, 'damage', p_quantity, p_note, p_performed_by, p_rack_id);
end;
$$;

create or replace function template.restore_damaged_stock(
  p_product_id   uuid,
  p_location_id  uuid,
  p_quantity     numeric,
  p_performed_by uuid,
  p_note         text default null,
  p_rack_id      uuid default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_damaged       numeric;
  v_rack_location uuid;
  v_rack_active   boolean;
  v_rack_capacity numeric;
  v_rack_total    numeric;
begin
  select damaged_quantity into v_damaged from template.stock
    where product_id = p_product_id and location_id = p_location_id for update;

  if v_damaged is null or v_damaged < p_quantity then
    raise exception 'Insufficient damaged stock to restore';
  end if;

  if p_rack_id is not null then
    select location_id, is_active, capacity into v_rack_location, v_rack_active, v_rack_capacity
    from template.racks where id = p_rack_id;
    if v_rack_location is null then
      raise exception 'Rack not found';
    end if;
    if v_rack_location <> p_location_id then
      raise exception 'Rack does not belong to this location';
    end if;
    if not v_rack_active then
      raise exception 'This rack is inactive and cannot receive stock';
    end if;

    if v_rack_capacity is not null then
      select coalesce(sum(quantity), 0) into v_rack_total from template.rack_stock where rack_id = p_rack_id;
      if v_rack_total + p_quantity > v_rack_capacity then
        raise exception 'This rack''s capacity (%) would be exceeded', v_rack_capacity;
      end if;
    end if;

    insert into template.rack_stock (product_id, rack_id, quantity)
    values (p_product_id, p_rack_id, p_quantity)
    on conflict (product_id, rack_id)
    do update set quantity = template.rack_stock.quantity + excluded.quantity, updated_at = now();
  end if;

  update template.stock
    set quantity = quantity + p_quantity, damaged_quantity = damaged_quantity - p_quantity
    where product_id = p_product_id and location_id = p_location_id;

  insert into template.stock_transactions (product_id, to_location_id, transaction_type, quantity, note, performed_by, to_rack_id)
  values (p_product_id, p_location_id, 'damage_restore', p_quantity, p_note, p_performed_by, p_rack_id);
end;
$$;
