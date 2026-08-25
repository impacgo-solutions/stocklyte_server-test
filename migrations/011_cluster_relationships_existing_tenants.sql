-- ============================================================================
-- Cluster Relationship Management — EXISTING TENANTS
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself,
--     AFTER 010_cluster_relationships_template.sql, against the same
--     database. Loops over every row in public.companies and brings that
--     tenant's own schema up to the same shape as `template` now has.
--
-- Safe to re-run: the table statement is idempotent (IF NOT EXISTS); the
-- function is always re-cloned from `template` via CREATE OR REPLACE, so
-- re-running just re-syncs it to whatever `template` currently has. Does
-- not delete or modify any existing row in any tenant schema.
-- ============================================================================

do $$
declare
  r record;
  fn record;
  new_body text;
begin
  for r in select schema_name from public.companies loop

    raise notice 'Migrating tenant schema (cluster relationships): %', r.schema_name;

    execute format($f$
      create table if not exists %1$I.cluster_relationships (
        id                      uuid primary key default gen_random_uuid(),
        source_cluster_id       uuid not null references %1$I.clusters (id) on delete cascade,
        target_cluster_id       uuid not null references %1$I.clusters (id) on delete cascade,
        allow_product_requests  boolean not null default true,
        allow_transfers         boolean not null default true,
        is_active               boolean not null default true,
        created_at              timestamptz not null default now(),
        constraint cluster_relationships_source_target_key unique (source_cluster_id, target_cluster_id),
        constraint cluster_relationships_source_ne_target check (source_cluster_id <> target_cluster_id)
      )
    $f$, r.schema_name);

    execute format('create index if not exists cluster_relationships_source_idx on %1$I.cluster_relationships (source_cluster_id)', r.schema_name);

    -- ── Re-clone next_eligible_location from `template` ─────────────────────
    for fn in
      select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'template'
        and p.proname = 'next_eligible_location'
    loop
      new_body := replace(fn.def, 'template', r.schema_name);
      execute new_body;
    end loop;

  end loop;
end;
$$;
