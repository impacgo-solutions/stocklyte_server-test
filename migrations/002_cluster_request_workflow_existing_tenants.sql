-- ============================================================================
-- Cluster-Based Product Request & Rejection Workflow — EXISTING TENANTS
-- ============================================================================
-- Run this ONCE, AFTER 001_cluster_request_workflow_template.sql, against the
-- same database. It loops over every row in public.companies and brings that
-- tenant's own schema up to the same shape as `template` now has.
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / DROP..IF
-- EXISTS + re-ADD). This also repairs impacgo_demo's existing prototype
-- product_requests/product_request_routes tables in place (wrong FK target,
-- narrower status list) WITHOUT deleting any existing row — it only adds
-- columns/widens constraints/fixes FK targets on tables that already exist.
-- ============================================================================

do $$
declare
  r record;
  fn record;
  new_body text;
begin
  for r in select schema_name from public.companies loop

    raise notice 'Migrating tenant schema: %', r.schema_name;

    -- ── New tables (no-op if a tenant — i.e. impacgo_demo — already has them) ──

    execute format($f$
      create table if not exists %1$I.clusters (
        id          uuid primary key default gen_random_uuid(),
        name        text not null,
        description text,
        is_active   boolean not null default true,
        created_at  timestamptz not null default now(),
        constraint clusters_name_key unique (name)
      )
    $f$, r.schema_name);

    execute format($f$
      create table if not exists %1$I.racks (
        id          uuid primary key default gen_random_uuid(),
        location_id uuid not null references %1$I.locations (id) on delete cascade,
        code        text not null,
        name        text,
        is_active   boolean not null default true,
        created_at  timestamptz not null default now(),
        constraint racks_location_id_code_key unique (location_id, code)
      )
    $f$, r.schema_name);

    execute format($f$
      create table if not exists %1$I.rack_stock (
        id         uuid primary key default gen_random_uuid(),
        product_id uuid not null references %1$I.products (id) on delete cascade,
        rack_id    uuid not null references %1$I.racks (id) on delete cascade,
        quantity   numeric(14, 3) not null default 0,
        updated_at timestamptz not null default now(),
        constraint rack_stock_product_id_rack_id_key unique (product_id, rack_id),
        constraint rack_stock_quantity_check check (quantity >= 0)
      )
    $f$, r.schema_name);

    execute format($f$
      create table if not exists %1$I.location_routing_rules (
        id                  uuid primary key default gen_random_uuid(),
        source_location_id  uuid not null references %1$I.locations (id) on delete cascade,
        target_location_id  uuid not null references %1$I.locations (id) on delete cascade,
        priority             integer not null,
        is_active            boolean not null default true,
        created_at           timestamptz not null default now(),
        updated_at           timestamptz not null default now(),
        constraint location_routing_rules_source_priority_key unique (source_location_id, priority),
        constraint location_routing_rules_source_target_key unique (source_location_id, target_location_id),
        constraint location_routing_rules_source_ne_target check (source_location_id <> target_location_id)
      )
    $f$, r.schema_name);

    execute format($f$
      create table if not exists %1$I.product_requests (
        id                          uuid primary key default gen_random_uuid(),
        product_id                  uuid not null references %1$I.products (id) on delete cascade,
        requested_by                uuid references %1$I.admin_users (id) on delete set null,
        source_location_id          uuid not null references %1$I.locations (id) on delete set null,
        quantity                     numeric(14, 3) not null,
        status                       text not null default 'requested',
        current_target_location_id  uuid references %1$I.locations (id) on delete set null,
        note                         text,
        cancelled_by                 uuid references %1$I.admin_users (id) on delete set null,
        cancelled_reason             text,
        created_at                   timestamptz not null default now(),
        updated_at                   timestamptz not null default now(),
        resolved_at                  timestamptz,
        constraint product_requests_quantity_check check (quantity > 0)
      )
    $f$, r.schema_name);

    execute format($f$
      create table if not exists %1$I.product_request_routes (
        id                   uuid primary key default gen_random_uuid(),
        request_id           uuid not null references %1$I.product_requests (id) on delete cascade,
        sequence_no          integer not null,
        target_location_id   uuid not null references %1$I.locations (id) on delete set null,
        distance_km          numeric(10, 3),
        status               text not null default 'pending',
        decided_by           uuid references %1$I.admin_users (id) on delete set null,
        decision_note        text,
        created_at           timestamptz not null default now(),
        decided_at           timestamptz,
        constraint product_request_routes_request_target_key unique (request_id, target_location_id),
        constraint product_request_routes_request_seq_key unique (request_id, sequence_no)
      )
    $f$, r.schema_name);

    execute format($f$
      create table if not exists %1$I.product_request_status_history (
        id           uuid primary key default gen_random_uuid(),
        request_id   uuid not null references %1$I.product_requests (id) on delete cascade,
        from_status  text,
        to_status    text not null,
        location_id  uuid references %1$I.locations (id) on delete set null,
        performed_by uuid references %1$I.admin_users (id) on delete set null,
        note         text,
        created_at   timestamptz not null default now()
      )
    $f$, r.schema_name);

    execute format('create index if not exists product_requests_status_idx on %1$I.product_requests (status)', r.schema_name);
    execute format('create index if not exists product_requests_source_location_idx on %1$I.product_requests (source_location_id)', r.schema_name);
    execute format('create index if not exists product_requests_current_target_idx on %1$I.product_requests (current_target_location_id)', r.schema_name);
    execute format('create index if not exists product_request_routes_request_idx on %1$I.product_request_routes (request_id)', r.schema_name);
    execute format('create index if not exists product_request_status_history_request_idx on %1$I.product_request_status_history (request_id)', r.schema_name);
    execute format('create index if not exists location_routing_rules_source_idx on %1$I.location_routing_rules (source_location_id)', r.schema_name);
    execute format('create index if not exists racks_location_idx on %1$I.racks (location_id)', r.schema_name);

    -- ── Columns that may be missing even where the table already existed ──

    execute format('alter table %1$I.product_requests add column if not exists cancelled_by uuid', r.schema_name);
    execute format('alter table %1$I.product_requests add column if not exists cancelled_reason text', r.schema_name);

    execute format('alter table %1$I.locations add column if not exists cluster_id uuid references %1$I.clusters (id) on delete set null', r.schema_name);
    execute format('alter table %1$I.locations add column if not exists latitude numeric(9, 6)', r.schema_name);
    execute format('alter table %1$I.locations add column if not exists longitude numeric(9, 6)', r.schema_name);

    execute format('alter table %1$I.stock add column if not exists reserved_quantity numeric(14, 3) not null default 0', r.schema_name);
    execute format('alter table %1$I.stock add column if not exists in_transit_quantity numeric(14, 3) not null default 0', r.schema_name);
    execute format('alter table %1$I.stock add column if not exists damaged_quantity numeric(14, 3) not null default 0', r.schema_name);

    execute format('alter table %1$I.stock drop constraint if exists stock_reserved_quantity_check', r.schema_name);
    execute format('alter table %1$I.stock add constraint stock_reserved_quantity_check check (reserved_quantity >= 0)', r.schema_name);
    execute format('alter table %1$I.stock drop constraint if exists stock_in_transit_quantity_check', r.schema_name);
    execute format('alter table %1$I.stock add constraint stock_in_transit_quantity_check check (in_transit_quantity >= 0)', r.schema_name);
    execute format('alter table %1$I.stock drop constraint if exists stock_damaged_quantity_check', r.schema_name);
    execute format('alter table %1$I.stock add constraint stock_damaged_quantity_check check (damaged_quantity >= 0)', r.schema_name);

    execute format('alter table %1$I.stock_transactions add column if not exists related_request_id uuid references %1$I.product_requests (id) on delete set null', r.schema_name);
    execute format('alter table %1$I.stock_transactions add column if not exists batch_number character varying(100)', r.schema_name);
    execute format('alter table %1$I.stock_transactions add column if not exists supplier_name character varying(200)', r.schema_name);
    execute format('alter table %1$I.stock_transactions add column if not exists expiry_date date', r.schema_name);

    execute format('alter table %1$I.stock_transactions drop constraint if exists stock_transactions_transaction_type_check', r.schema_name);
    execute format($f$
      alter table %1$I.stock_transactions add constraint stock_transactions_transaction_type_check
        check (transaction_type in ('in', 'out', 'transfer', 'adjustment', 'damage', 'damage_writeoff', 'damage_restore'))
    $f$, r.schema_name);

    execute format('alter table %1$I.notifications add column if not exists related_request_id uuid references %1$I.product_requests (id) on delete set null', r.schema_name);
    execute format('alter table %1$I.notifications add column if not exists title text', r.schema_name);
    execute format('alter table %1$I.notifications add column if not exists body text', r.schema_name);

    execute format('alter table %1$I.notifications drop constraint if exists notifications_type_check', r.schema_name);
    execute format($f$
      alter table %1$I.notifications add constraint notifications_type_check
        check (type in ('low_stock', 'transfer', 'system', 'product_request'))
    $f$, r.schema_name);

    -- ── Fix pre-existing prototype defects (impacgo_demo) / set the right
    --    status vocabulary on every tenant ────────────────────────────────

    execute format('alter table %1$I.product_requests drop constraint if exists product_requests_status_check', r.schema_name);
    execute format($f$
      alter table %1$I.product_requests add constraint product_requests_status_check
        check (status in ('requested', 'assigned', 'accepted', 'rejected', 'escalated', 'fulfilled', 'exhausted', 'cancelled'))
    $f$, r.schema_name);

    execute format('alter table %1$I.product_request_routes drop constraint if exists product_request_routes_status_check', r.schema_name);
    execute format($f$
      alter table %1$I.product_request_routes add constraint product_request_routes_status_check
        check (status in ('pending', 'accepted', 'rejected'))
    $f$, r.schema_name);

    -- requested_by / decided_by were left pointing at the old public.profiles
    -- table in the impacgo_demo prototype — repoint at this tenant's own
    -- admin_users. Harmless no-op on a freshly-created table (constraint
    -- already targets admin_users from the CREATE TABLE above, so it's
    -- immediately re-dropped and re-added identically).
    execute format('alter table %1$I.product_requests drop constraint if exists product_requests_requested_by_fkey', r.schema_name);
    execute format('alter table %1$I.product_requests add constraint product_requests_requested_by_fkey foreign key (requested_by) references %1$I.admin_users (id) on delete set null', r.schema_name);

    execute format('alter table %1$I.product_request_routes drop constraint if exists product_request_routes_decided_by_fkey', r.schema_name);
    execute format('alter table %1$I.product_request_routes add constraint product_request_routes_decided_by_fkey foreign key (decided_by) references %1$I.admin_users (id) on delete set null', r.schema_name);

    -- ── Clone the new functions from `template`, rewritten to this schema ──
    -- (identical technique to utils/tenantProvisioning.js's createTenantSchema)
    --
    -- Also included here: the base trigger functions every *properly*
    -- provisioned tenant already has (update_updated_at, audit_trigger_func,
    -- notify_low_stock, stock_in_lot, stock_out, transfer_stock). They are
    -- only cloned into a tenant that is missing them entirely — e.g. a
    -- manually created schema (such as a "_test" tenant) that never went
    -- through full app provisioning. A tenant that already has its own copy
    -- of a function (which is every normal tenant, for the base six) is left
    -- completely untouched — this never overwrites an existing function.

    for fn in
      select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'template'
        and p.proname in (
          'update_updated_at', 'audit_trigger_func', 'notify_low_stock',
          'stock_in_lot', 'stock_out', 'transfer_stock',
          'next_eligible_location', 'create_product_request', 'reject_product_request',
          'accept_product_request', 'receive_product_request', 'cancel_product_request',
          'report_damaged_stock', 'restore_damaged_stock', 'writeoff_damaged_stock'
        )
    loop
      if not exists (
        select 1 from pg_proc p2
        join pg_namespace n2 on n2.oid = p2.pronamespace
        where n2.nspname = r.schema_name and p2.proname = fn.proname
      ) then
        new_body := replace(fn.def, 'template', r.schema_name);
        execute new_body;
      end if;
    end loop;

    -- ── Triggers on the new tables ───────────────────────────────────────

    execute format('drop trigger if exists product_requests_updated_at on %1$I.product_requests', r.schema_name);
    execute format('create trigger product_requests_updated_at before update on %1$I.product_requests for each row execute function %1$I.update_updated_at ()', r.schema_name);

    execute format('drop trigger if exists audit_product_requests on %1$I.product_requests', r.schema_name);
    execute format('create trigger audit_product_requests after insert or update or delete on %1$I.product_requests for each row execute function %1$I.audit_trigger_func ()', r.schema_name);

    execute format('drop trigger if exists location_routing_rules_updated_at on %1$I.location_routing_rules', r.schema_name);
    execute format('create trigger location_routing_rules_updated_at before update on %1$I.location_routing_rules for each row execute function %1$I.update_updated_at ()', r.schema_name);

    execute format('drop trigger if exists rack_stock_updated_at on %1$I.rack_stock', r.schema_name);
    execute format('create trigger rack_stock_updated_at before update on %1$I.rack_stock for each row execute function %1$I.update_updated_at ()', r.schema_name);

  end loop;
end;
$$;
