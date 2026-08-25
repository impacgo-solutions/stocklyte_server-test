-- ============================================================================
-- Hierarchy-Based Approval Routing for Transfer Management — EXISTING TENANTS
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself,
--     AFTER 008_transfer_approval_hierarchy_template.sql, against the same
--     database. Loops over every row in public.companies and brings that
--     tenant's own schema up to the same shape as `template` now has.
--
-- Safe to re-run: column/constraint statements are idempotent (IF NOT EXISTS
-- / DROP..IF EXISTS + re-ADD); the three functions are always re-cloned from
-- `template` via CREATE OR REPLACE, so re-running just re-syncs them to
-- whatever `template` currently has. Does not delete or modify any existing
-- transfer/team-member row.
-- ============================================================================

do $$
declare
  r record;
  fn record;
  new_body text;
begin
  for r in select schema_name from public.companies loop

    raise notice 'Migrating tenant schema (transfer approval hierarchy): %', r.schema_name;

    execute format('alter table %1$I.admin_users add column if not exists reports_to uuid references %1$I.admin_users (id) on delete set null', r.schema_name);

    execute format('alter table %1$I.transfers add column if not exists pending_approver_id uuid references %1$I.admin_users (id) on delete set null', r.schema_name);
    execute format('alter table %1$I.transfers add column if not exists approval_level text', r.schema_name);

    execute format('alter table %1$I.transfers drop constraint if exists transfers_approval_level_check', r.schema_name);
    execute format($f$
      alter table %1$I.transfers add constraint transfers_approval_level_check
        check (approval_level is null or approval_level in ('manager', 'head', 'auto'))
    $f$, r.schema_name);

    -- ── Re-clone the three changed functions from `template` ────────────────
    -- Unlike 002/007 (which guard "if not exists" because those functions
    -- were brand new), these three already exist in every tenant from
    -- migration 007 — CREATE OR REPLACE deliberately overwrites them with
    -- the new hierarchy-aware bodies. ship_transfer/receive_transfer/
    -- cancel_transfer are untouched.
    for fn in
      select p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'template'
        and p.proname in ('submit_transfer', 'approve_transfer', 'reject_transfer')
    loop
      new_body := replace(fn.def, 'template', r.schema_name);
      execute new_body;
    end loop;

  end loop;
end;
$$;
