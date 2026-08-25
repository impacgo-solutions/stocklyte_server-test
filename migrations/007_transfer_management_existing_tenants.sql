-- ============================================================================
-- Transfer Management & Transfer Reports Workflow — EXISTING TENANTS
-- ============================================================================
-- Run this ONCE, AFTER 006_transfer_management_template.sql, against the
-- same database. It loops over every row in public.companies and brings that
-- tenant's own schema up to the same shape as `template` now has.
--
-- Safe to re-run: table/column/index/trigger statements are idempotent
-- (IF NOT EXISTS / DROP..IF EXISTS + re-ADD). The six new functions are
-- always re-cloned via CREATE OR REPLACE (never guarded by "if not exists on
-- pg_proc" like 002 does for the older feature set) because these six names
-- cannot collide with any pre-existing, possibly-customized tenant function —
-- this is a brand-new capability no tenant has ever had — so always
-- refreshing from `template` is strictly safer while this feature is new.
--
-- Does not delete or modify any existing row in any tenant schema.
-- ============================================================================

do $$
declare
  r record;
  fn record;
  new_body text;
begin
  for r in select schema_name from public.companies loop

    raise notice 'Migrating tenant schema (transfer management): %', r.schema_name;

    -- ── New tables ──────────────────────────────────────────────────────────

    execute format($f$
      create table if not exists %1$I.transfers (
        id                       uuid primary key,
        transfer_number          text not null,
        source_location_id       uuid not null references %1$I.locations (id) on delete restrict,
        destination_location_id  uuid not null references %1$I.locations (id) on delete restrict,
        status                   text not null default 'draft',
        transfer_date            date not null default current_date,
        reason                   text not null,
        note                     text,
        requested_by             uuid references %1$I.admin_users (id) on delete set null,
        approved_by              uuid references %1$I.admin_users (id) on delete set null,
        approved_at              timestamptz,
        shipped_by               uuid references %1$I.admin_users (id) on delete set null,
        shipped_at               timestamptz,
        received_by              uuid references %1$I.admin_users (id) on delete set null,
        received_at              timestamptz,
        rejected_by              uuid references %1$I.admin_users (id) on delete set null,
        rejected_reason          text,
        rejected_at              timestamptz,
        cancelled_by             uuid references %1$I.admin_users (id) on delete set null,
        cancelled_reason         text,
        cancelled_at             timestamptz,
        created_at               timestamptz not null default now(),
        updated_at               timestamptz not null default now(),
        resolved_at              timestamptz,
        constraint transfers_transfer_number_key unique (transfer_number),
        constraint transfers_source_ne_destination check (source_location_id <> destination_location_id),
        constraint transfers_status_check check (
          status in ('draft', 'requested', 'approved', 'in_transit', 'received', 'rejected', 'cancelled')
        )
      )
    $f$, r.schema_name);

    execute format($f$
      create table if not exists %1$I.transfer_items (
        id           uuid primary key default gen_random_uuid(),
        transfer_id  uuid not null references %1$I.transfers (id) on delete cascade,
        product_id   uuid not null references %1$I.products (id) on delete cascade,
        quantity     numeric(14, 3) not null,
        note         text,
        created_at   timestamptz not null default now(),
        constraint transfer_items_transfer_id_product_id_key unique (transfer_id, product_id),
        constraint transfer_items_quantity_check check (quantity > 0)
      )
    $f$, r.schema_name);

    execute format($f$
      create table if not exists %1$I.transfer_status_history (
        id           uuid primary key default gen_random_uuid(),
        transfer_id  uuid not null references %1$I.transfers (id) on delete cascade,
        from_status  text,
        to_status    text not null,
        performed_by uuid references %1$I.admin_users (id) on delete set null,
        note         text,
        created_at   timestamptz not null default now()
      )
    $f$, r.schema_name);

    execute format('create index if not exists transfers_status_idx on %1$I.transfers (status)', r.schema_name);
    execute format('create index if not exists transfers_source_location_id_idx on %1$I.transfers (source_location_id)', r.schema_name);
    execute format('create index if not exists transfers_destination_location_id_idx on %1$I.transfers (destination_location_id)', r.schema_name);
    execute format('create index if not exists transfer_items_transfer_id_idx on %1$I.transfer_items (transfer_id)', r.schema_name);
    execute format('create index if not exists transfer_status_history_transfer_id_idx on %1$I.transfer_status_history (transfer_id)', r.schema_name);

    -- ── New column on an existing table (additive only) ────────────────────

    execute format('alter table %1$I.stock_transactions add column if not exists related_transfer_id uuid references %1$I.transfers (id) on delete set null', r.schema_name);

    -- ── Triggers on the new header table ────────────────────────────────────

    execute format('drop trigger if exists transfers_updated_at on %1$I.transfers', r.schema_name);
    execute format('create trigger transfers_updated_at before update on %1$I.transfers for each row execute function %1$I.update_updated_at ()', r.schema_name);

    execute format('drop trigger if exists audit_transfers on %1$I.transfers', r.schema_name);
    execute format('create trigger audit_transfers after insert or update or delete on %1$I.transfers for each row execute function %1$I.audit_trigger_func ()', r.schema_name);

    -- ── Clone the six new functions from `template`, rewritten to this schema ──

    for fn in
      select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'template'
        and p.proname in (
          'submit_transfer', 'approve_transfer', 'reject_transfer',
          'ship_transfer', 'receive_transfer', 'cancel_transfer'
        )
    loop
      new_body := replace(fn.def, 'template', r.schema_name);
      execute new_body;
    end loop;

  end loop;
end;
$$;
