-- ============================================================================
-- Bug fix: template.product_requests never actually got upgraded
-- ============================================================================
-- 001's `create table if not exists template.product_requests (...)`
-- silently no-op'd, because `template` already had a legacy prototype
-- version of this table (same root cause fixed for existing tenants in
-- 002 — but that fixup was only applied per-tenant, never to `template`
-- itself). Result: template.product_requests was missing cancelled_by/
-- cancelled_reason and still had the old ('pending','fulfilled','exhausted')
-- status check — which broke brand-new tenant provisioning entirely
-- (POST /admin/companies failed with "column cancelled_by referenced in
-- foreign key constraint does not exist", since createTenantSchema() clones
-- `like template.product_requests including all` then tries to add the
-- cancelled_by FK from tenantProvisioning.js's foreignKeyStatements()).
-- Found via QA testing (PROV-1).
--
-- Idempotent; safe to re-run. No column/table removed, no app-visible shape
-- change beyond what 001/002 already documented as the target shape.
-- ============================================================================

alter table template.product_requests add column if not exists cancelled_by uuid;
alter table template.product_requests add column if not exists cancelled_reason text;

alter table template.product_requests
  drop constraint if exists product_requests_cancelled_by_fkey;
alter table template.product_requests
  add constraint product_requests_cancelled_by_fkey
  foreign key (cancelled_by) references template.admin_users (id) on delete set null;

alter table template.product_requests
  drop constraint if exists product_requests_status_check;
alter table template.product_requests
  add constraint product_requests_status_check
  check (status in ('requested', 'assigned', 'accepted', 'rejected', 'escalated', 'fulfilled', 'exhausted', 'cancelled'));
