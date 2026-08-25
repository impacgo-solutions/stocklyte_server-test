-- ============================================================================
-- Rack & Location Management: fix duplicate function overloads
-- TEMPLATE schema
-- ============================================================================
-- ⚠️  NOT applied automatically. Review this file, then run it yourself
--     (Supabase SQL editor or psql), connected with a role that owns the
--     `template` schema. Run 015_..._existing_tenants.sql immediately after.
--
-- Bug this fixes: 012_rack_stock_tracking_template.sql used `create or
-- replace function` to add an optional rack parameter to five functions.
-- Postgres only replaces a function when the parameter list is IDENTICAL —
-- since the new versions have one/two extra parameters, Postgres instead
-- created a SECOND overload alongside the original, for:
--   stock_in_lot, stock_out, transfer_stock, report_damaged_stock,
--   restore_damaged_stock
-- The stale old-signature versions are unused (stock.js already calls the
-- new signatures exclusively) but their mere presence breaks
-- tenantProvisioning.js's `create_company` flow: it clones these functions
-- by name from `template` and asserts exactly one row per name comes back —
-- with two overloads per name it gets more rows than expected and throws
-- "template schema is missing function(s): " on every new tenant signup.
--
-- Fix: explicitly drop the old-signature overload of each of the five
-- functions, by their exact original parameter list, leaving only the new
-- rack-aware version (already the one actually in use). Safe to re-run —
-- `drop function if exists` on an already-dropped signature is a no-op.
-- ============================================================================

drop function if exists template.stock_in_lot(uuid, uuid, numeric, text, uuid, text, text, date);
drop function if exists template.stock_out(uuid, uuid, numeric, text, uuid);
drop function if exists template.transfer_stock(uuid, uuid, uuid, numeric, text, uuid);
drop function if exists template.report_damaged_stock(uuid, uuid, numeric, uuid, text);
drop function if exists template.restore_damaged_stock(uuid, uuid, numeric, uuid, text);
