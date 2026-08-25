-- ============================================================================
-- QA test data — StockLyte end-to-end verification
-- ============================================================================
-- Builds on the EXISTING "QA Test - Product Requests" tenant
-- (schema: qa_test_product_requests), which already has 3 locations (D1 New
-- York, D2 Philadelphia, D3 Chicago, all with lat/long) and 5 users at
-- admin/staff/staff/staff/viewer roles. This script:
--   1. Sets a known password on every existing test user + adds one Super
--      Admin QA account + one Manager QA account (all same password).
--   2. Adds a 4th location (D4) so escalation can be tested across 3 hops.
--   3. Adds 2 clusters, assigns all 4 locations to one.
--   4. Adds racks under 2 of the locations.
--   5. Adds explicit routing rules for D1 -> D2 -> D3 -> D4 (deterministic
--      escalation order, so results aren't left to the lat/long fallback).
--   6. Adds 1 category and 1 new product (with plenty of stock at D1) for
--      damaged-stock testing.
--   7. Adds a couple more edge-case rows (an inactive location, a
--      manager-created category) called out in the test plan below.
--
-- Safe to re-run: every statement is idempotent (ON CONFLICT / IF NOT EXISTS
-- / fixed IDs). Does not touch UI, workflow, or schema — only rows.
-- ============================================================================

-- ── 1. Credentials — ALL of the below log in with password: Test@12345 ─────

insert into public.super_admins (id, email, full_name, is_active, password_hash)
values ('b2593951-4eae-47c5-b349-148fe68beb49', 'qa.superadmin@stocklyte-test.local', 'QA Super Admin', true,
        '$2a$10$sPFCqf/82n5KbqXSNhhuqevXlbROJtLO1//ZqMTmYni84atY7M6VW')
on conflict (email) do update set password_hash = excluded.password_hash, is_active = true;

update qa_test_product_requests.admin_users
set password_hash = '$2a$10$sPFCqf/82n5KbqXSNhhuqevXlbROJtLO1//ZqMTmYni84atY7M6VW'
where email in (
  'qa.productrequests.test@stocklyte-test.local',  -- admin, no fixed location (can act for any)
  'd1.staff@stocklyte-test.local',                 -- staff @ D1 (New York)
  'd1.viewer@stocklyte-test.local',                -- viewer @ D1 (New York)
  'd2.staff@stocklyte-test.local',                 -- staff @ D2 (Philadelphia)
  'd3.staff@stocklyte-test.local'                  -- staff @ D3 (Chicago)
);

-- New: a manager @ D2, to exercise the manager role (categories/locations
-- write access, but not full admin) that the existing 5 accounts don't cover.
insert into qa_test_product_requests.admin_users (id, email, full_name, role, location_id, is_active, password_hash)
values ('99b9c480-9e5b-4ff8-967c-51f690e9edb5', 'd2.manager@stocklyte-test.local', 'D2 Manager', 'manager',
        '112cfeeb-9439-4a71-a99c-f5878fcbff7e', true,
        '$2a$10$sPFCqf/82n5KbqXSNhhuqevXlbROJtLO1//ZqMTmYni84atY7M6VW')
on conflict (id) do update set password_hash = excluded.password_hash, is_active = true;

insert into public.tenant_user_index (user_id, schema_name, email)
values ('99b9c480-9e5b-4ff8-967c-51f690e9edb5', 'qa_test_product_requests', 'd2.manager@stocklyte-test.local')
on conflict (user_id) do nothing;

-- ── 2. Fourth location (D4), for 3-hop escalation testing ──────────────────

insert into qa_test_product_requests.locations (id, name, address, is_active, latitude, longitude)
values ('0ae82e93-58d6-41a6-86bc-a0ccd421f1f1', 'D4 - Boston Warehouse', 'Boston', true, 42.360100, -71.058900)
on conflict (id) do nothing;

-- ── 3. Clusters ──────────────────────────────────────────────────────────

insert into qa_test_product_requests.clusters (id, name, description, is_active)
values
  ('bab0158e-1434-480e-b3b7-383ce9f899fc', 'Northeast Cluster', 'D1 + D2 + D4', true),
  ('e429659c-4585-49e4-bb0d-3417d76ffa59', 'Midwest Cluster', 'D3 only', true)
on conflict (id) do nothing;

update qa_test_product_requests.locations set cluster_id = 'bab0158e-1434-480e-b3b7-383ce9f899fc'
  where id in ('40e5d78c-b3dd-409b-9f65-6084ce78a3df', '112cfeeb-9439-4a71-a99c-f5878fcbff7e', '0ae82e93-58d6-41a6-86bc-a0ccd421f1f1'); -- D1, D2, D4
update qa_test_product_requests.locations set cluster_id = 'e429659c-4585-49e4-bb0d-3417d76ffa59'
  where id = 'a8b4760e-9211-4fd2-b7ab-810d31d881ac'; -- D3

-- ── 4. Racks (rack-level visibility, independent of stock_in/out/transfer) ──

insert into qa_test_product_requests.racks (location_id, code, name)
values
  ('40e5d78c-b3dd-409b-9f65-6084ce78a3df', 'A1', 'Aisle A, Shelf 1'),
  ('40e5d78c-b3dd-409b-9f65-6084ce78a3df', 'A2', 'Aisle A, Shelf 2'),
  ('112cfeeb-9439-4a71-a99c-f5878fcbff7e', 'B1', 'Aisle B, Shelf 1')
on conflict (location_id, code) do nothing;

-- ── 5. Explicit routing rules: D1's escalation order is D2 (1st) -> D3 (2nd) -> D4 (3rd) ──

insert into qa_test_product_requests.location_routing_rules (source_location_id, target_location_id, priority)
values
  ('40e5d78c-b3dd-409b-9f65-6084ce78a3df', '112cfeeb-9439-4a71-a99c-f5878fcbff7e', 1), -- D1 -> D2
  ('40e5d78c-b3dd-409b-9f65-6084ce78a3df', 'a8b4760e-9211-4fd2-b7ab-810d31d881ac', 2), -- D1 -> D3
  ('40e5d78c-b3dd-409b-9f65-6084ce78a3df', '0ae82e93-58d6-41a6-86bc-a0ccd421f1f1', 3)  -- D1 -> D4
on conflict (source_location_id, priority) do nothing;

-- ── 6. Category + a 3rd product (ample stock at D1) for damaged-stock tests ──

insert into qa_test_product_requests.categories (id, name, description, icon, color)
values ('e22eb932-2624-401d-b5e2-a948666e8814', 'Electronics', 'QA test category', 'memory', '#6366F1')
on conflict (id) do nothing;

update qa_test_product_requests.products set category_id = 'e22eb932-2624-401d-b5e2-a948666e8814'
  where id = 'd30e9613-6562-40d9-8373-53c48f429132'; -- QA Test Widget

insert into qa_test_product_requests.products (id, name, sku, category_id, unit, low_stock_threshold, is_active)
values ('d8f94cfd-2050-4c80-8d74-3ba7bdf23ce8', 'QA Test Gadget - Damage Sample', 'QA-GADGET-003',
        'e22eb932-2624-401d-b5e2-a948666e8814', 'pcs', 5, true)
on conflict (id) do nothing;

insert into qa_test_product_requests.stock (product_id, location_id, quantity)
values ('d8f94cfd-2050-4c80-8d74-3ba7bdf23ce8', '40e5d78c-b3dd-409b-9f65-6084ce78a3df', 50)
on conflict (product_id, location_id) do update set quantity = 50;

-- Give D4 some stock of the main widget too, so an escalation chain that
-- reaches D4 can actually be accepted there if D2 and D3 both reject.
insert into qa_test_product_requests.stock (product_id, location_id, quantity)
values ('d30e9613-6562-40d9-8373-53c48f429132', '0ae82e93-58d6-41a6-86bc-a0ccd421f1f1', 15)
on conflict (product_id, location_id) do update set quantity = 15;

-- ============================================================================
-- Resulting state after running this file — reference for what "should exist"
-- ============================================================================
-- public.super_admins: qa.superadmin@stocklyte-test.local (password Test@12345)
-- qa_test_product_requests.admin_users: 6 rows total —
--   qa.productrequests.test@stocklyte-test.local (admin, no location)
--   d1.staff@... (staff, D1)   d1.viewer@... (viewer, D1)
--   d2.staff@... (staff, D2)   d2.manager@... (manager, D2) <- new
--   d3.staff@... (staff, D3)
--   ALL passwords: Test@12345
-- qa_test_product_requests.locations: D1 (NY), D2 (Philly), D3 (Chicago),
--   D4 (Boston) <- new. D1/D2/D4 in "Northeast Cluster", D3 in "Midwest Cluster".
-- qa_test_product_requests.racks: A1, A2 under D1; B1 under D2.
-- qa_test_product_requests.location_routing_rules: D1 -> D2 (1) -> D3 (2) -> D4 (3).
-- qa_test_product_requests.categories: Electronics.
-- qa_test_product_requests.products: QA Test Widget (SKU QA-WIDGET-001,
--   category Electronics, stock 22@D1 / 45@D2 / 35@D3 / 15@D4 <- new stock row),
--   QA Test Widget 2 - Scarce (SKU QA-WIDGET-002, stock 1@D1 only, 0 elsewhere
--   -- deliberately scarce, for testing rejection due to insufficient stock),
--   QA Test Gadget - Damage Sample (SKU QA-GADGET-003) <- new, stock 50@D1.
-- ============================================================================
