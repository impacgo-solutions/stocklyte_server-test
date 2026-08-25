-- ============================================================================
-- Category Status (Active/Inactive) — TEMPLATE schema
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself
--     (Supabase SQL editor or psql), connected with a role that owns the
--     `template` schema. Run 019_..._existing_tenants.sql immediately after.
--
-- Purpose: `categories` has no active/inactive concept today, so a retired
-- category can't be hidden from new product assignment without deleting it
-- (which is blocked anyway while products still reference it). Adds a single
-- nullable-free `is_active boolean default true` column — every existing
-- category row becomes active, unaffected in every other way.
--
-- Entirely additive. Safe to re-run (IF NOT EXISTS).
-- ============================================================================

alter table template.categories
  add column if not exists is_active boolean not null default true;
