-- Run this once on the database to migrate from Supabase Auth to local password auth.

-- 1. Add email column to tenant_user_index for email-based login lookup
alter table public.tenant_user_index
  add column if not exists email text;

create unique index if not exists tenant_user_index_email_idx
  on public.tenant_user_index (email);

-- 2. Add password_hash to super_admins
alter table public.super_admins
  add column if not exists password_hash text;

-- 3. Add password_hash to template admin_users (for new tenants)
alter table template.admin_users
  add column if not exists password_hash text;

-- 4. Add password_hash to all existing tenant schemas' admin_users
do $$
declare
  r record;
begin
  for r in select schema_name from public.companies loop
    execute format(
      'alter table %I.admin_users add column if not exists password_hash text',
      r.schema_name
    );
    -- Drop auth.users FK if it exists
    execute format(
      'alter table %I.admin_users drop constraint if exists admin_users_id_fkey',
      r.schema_name
    );
  end loop;
end;
$$;

-- 5. Drop auth.users FK from template schema
alter table template.admin_users
  drop constraint if exists admin_users_id_fkey;
