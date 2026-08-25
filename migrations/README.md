# Cluster-Based Product Request & Rejection Workflow — DB migrations

Run these **manually**, in order, against your database (Supabase SQL editor,
or `psql "$DATABASE_URL"`). Both files are idempotent — safe to re-run if
something fails partway and you re-run after fixing it.

1. `001_cluster_request_workflow_template.sql`
   Updates the `template` schema only. After this, every **newly
   provisioned** tenant (new company created from the Super Admin app, or a
   self-service signup) automatically gets the full feature — no further
   action needed for future tenants.

2. `002_cluster_request_workflow_existing_tenants.sql`
   Run this **after** #1. Loops over every row in `public.companies` and
   brings each existing tenant schema (including `impacgo_demo`, repairing
   its old prototype tables in place) up to the same shape.

Neither script drops or renames any existing table/column, and neither
touches `public.companies`, `public.super_admins`, or `public.tenant_user_index`
— the Super Admin app and its data are untouched.

## Verify after running both

```sql
-- 1. Every tenant now has the new tables
select schema_name from public.companies c
where not exists (
  select 1 from information_schema.tables t
  where t.table_schema = c.schema_name and t.table_name = 'product_requests'
);
-- expect: 0 rows

-- 2. impacgo_demo's prototype rows survived and now point at admin_users
select conname, confrelid::regclass
from pg_constraint
where conrelid = 'impacgo_demo.product_requests'::regclass and contype = 'f';
-- expect product_requests_requested_by_fkey -> impacgo_demo.admin_users (not profiles)

-- 3. New stock columns exist and default to 0
select product_id, quantity, reserved_quantity, in_transit_quantity, damaged_quantity
from impacgo_demo.stock limit 5;

-- 4. template schema has the new functions
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'template' and proname like '%product_request%';
-- expect: create_product_request, reject_product_request, accept_product_request,
--         receive_product_request, cancel_product_request
```

## What you still need to do manually

- Run both `.sql` files (in order) against your real database.
- Nothing else on the DB side — the backend and app code changes (already
  implemented) only assume the shapes these two scripts create.
