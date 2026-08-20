-- ── Public Schema Tables ──────────────────────────────────────────────────────

create table if not exists public.companies (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  schema_name              text unique not null,
  created_by               uuid,
  subscription_status      text not null default 'trialing'
                             check (subscription_status in ('trialing','active','expired','cancelled')),
  trial_ends_at            timestamptz default (now() + interval '15 days'),
  trial_expiry_notified_at timestamptz,
  created_at               timestamptz not null default now()
);

create table if not exists public.super_admins (
  id         uuid primary key,
  email      text not null,
  full_name  text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.tenant_user_index (
  user_id     uuid primary key,
  schema_name text not null,
  created_at  timestamptz not null default now()
);

-- ── Template Schema ────────────────────────────────────────────────────────────

create schema if not exists template;

create table if not exists template.locations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  address    text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists template.admin_users (
  id          uuid primary key,
  email       text not null,
  full_name   text,
  phone       text,
  role        text not null default 'admin'
                check (role in ('admin','manager','staff','viewer')),
  location_id uuid,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists template.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

create table if not exists template.products (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  description         text,
  sku                 text unique,
  category_id         uuid,
  unit                text,
  image_url           text,
  low_stock_threshold integer default 10,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists template.stock (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null,
  location_id uuid not null,
  quantity    numeric not null default 0,
  updated_at  timestamptz not null default now(),
  unique (product_id, location_id)
);

create table if not exists template.stock_transactions (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid,
  transaction_type text not null check (transaction_type in ('in','out','transfer')),
  quantity         numeric not null,
  from_location_id uuid,
  to_location_id   uuid,
  performed_by     uuid,
  notes            text,
  created_at       timestamptz not null default now()
);

create table if not exists template.audit_log (
  id           uuid primary key default gen_random_uuid(),
  table_name   text,
  record_id    uuid,
  action       text,
  old_data     jsonb,
  new_data     jsonb,
  performed_by uuid,
  created_at   timestamptz not null default now()
);

create table if not exists template.notifications (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid,
  type               text,
  message            text,
  is_read            boolean not null default false,
  related_product_id uuid,
  created_at         timestamptz not null default now()
);

-- ── Template Foreign Keys ──────────────────────────────────────────────────────

alter table template.admin_users
  add constraint admin_users_location_id_fkey
  foreign key (location_id) references template.locations(id) on delete set null;

alter table template.products
  add constraint products_category_id_fkey
  foreign key (category_id) references template.categories(id) on delete set null;

alter table template.stock
  add constraint stock_product_id_fkey
  foreign key (product_id) references template.products(id) on delete cascade;

alter table template.stock
  add constraint stock_location_id_fkey
  foreign key (location_id) references template.locations(id) on delete cascade;

alter table template.stock_transactions
  add constraint stock_transactions_product_id_fkey
  foreign key (product_id) references template.products(id) on delete cascade;

alter table template.stock_transactions
  add constraint stock_transactions_from_location_id_fkey
  foreign key (from_location_id) references template.locations(id) on delete set null;

alter table template.stock_transactions
  add constraint stock_transactions_to_location_id_fkey
  foreign key (to_location_id) references template.locations(id) on delete set null;

alter table template.stock_transactions
  add constraint stock_transactions_performed_by_fkey
  foreign key (performed_by) references template.admin_users(id) on delete set null;

alter table template.audit_log
  add constraint audit_log_performed_by_fkey
  foreign key (performed_by) references template.admin_users(id) on delete set null;

alter table template.notifications
  add constraint notifications_user_id_fkey
  foreign key (user_id) references template.admin_users(id) on delete cascade;

alter table template.notifications
  add constraint notifications_related_product_id_fkey
  foreign key (related_product_id) references template.products(id) on delete set null;

-- ── Template Functions ─────────────────────────────────────────────────────────

create or replace function template.update_updated_at()
returns trigger
language plpgsql
set search_path to 'template', 'public'
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function template.audit_trigger_func()
returns trigger
language plpgsql
set search_path to 'template', 'public'
as $$
begin
  insert into template.audit_log (table_name, record_id, action, old_data, new_data)
  values (
    tg_table_name,
    coalesce(new.id, old.id),
    tg_op,
    case when tg_op = 'DELETE' or tg_op = 'UPDATE' then to_jsonb(old) else null end,
    case when tg_op = 'INSERT' or tg_op = 'UPDATE' then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

create or replace function template.notify_low_stock()
returns trigger
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_threshold integer;
  v_product_name text;
begin
  select low_stock_threshold, name into v_threshold, v_product_name
  from template.products where id = new.product_id;

  if new.quantity <= coalesce(v_threshold, 10) then
    insert into template.notifications (user_id, type, message, related_product_id)
    select id, 'low_stock',
           'Low stock alert: ' || v_product_name || ' has only ' || new.quantity || ' units left.',
           new.product_id
    from template.admin_users where is_active = true and role = 'admin'
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create or replace function template.stock_in_lot(
  p_product_id  uuid,
  p_location_id uuid,
  p_quantity    numeric,
  p_performed_by uuid,
  p_notes       text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
begin
  insert into template.stock (product_id, location_id, quantity)
  values (p_product_id, p_location_id, p_quantity)
  on conflict (product_id, location_id)
  do update set quantity = template.stock.quantity + excluded.quantity, updated_at = now();

  insert into template.stock_transactions
    (product_id, transaction_type, quantity, to_location_id, performed_by, notes)
  values (p_product_id, 'in', p_quantity, p_location_id, p_performed_by, p_notes);
end;
$$;

create or replace function template.stock_out(
  p_product_id   uuid,
  p_location_id  uuid,
  p_quantity     numeric,
  p_performed_by uuid,
  p_notes        text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_current numeric;
begin
  select quantity into v_current
  from template.stock where product_id = p_product_id and location_id = p_location_id
  for update;

  if v_current is null or v_current < p_quantity then
    raise exception 'Insufficient stock';
  end if;

  update template.stock
  set quantity = quantity - p_quantity, updated_at = now()
  where product_id = p_product_id and location_id = p_location_id;

  insert into template.stock_transactions
    (product_id, transaction_type, quantity, from_location_id, performed_by, notes)
  values (p_product_id, 'out', p_quantity, p_location_id, p_performed_by, p_notes);
end;
$$;

create or replace function template.transfer_stock(
  p_product_id      uuid,
  p_from_location   uuid,
  p_to_location     uuid,
  p_quantity        numeric,
  p_performed_by    uuid,
  p_notes           text default null
)
returns void
language plpgsql
set search_path to 'template', 'public'
as $$
declare
  v_current numeric;
begin
  select quantity into v_current
  from template.stock where product_id = p_product_id and location_id = p_from_location
  for update;

  if v_current is null or v_current < p_quantity then
    raise exception 'Insufficient stock at source location';
  end if;

  update template.stock
  set quantity = quantity - p_quantity, updated_at = now()
  where product_id = p_product_id and location_id = p_from_location;

  insert into template.stock (product_id, location_id, quantity)
  values (p_product_id, p_to_location, p_quantity)
  on conflict (product_id, location_id)
  do update set quantity = template.stock.quantity + excluded.quantity, updated_at = now();

  insert into template.stock_transactions
    (product_id, transaction_type, quantity, from_location_id, to_location_id, performed_by, notes)
  values (p_product_id, 'transfer', p_quantity, p_from_location, p_to_location, p_performed_by, p_notes);
end;
$$;

-- ── Template Triggers ──────────────────────────────────────────────────────────

drop trigger if exists products_updated_at on template.products;
create trigger products_updated_at
  before update on template.products
  for each row execute function template.update_updated_at();

drop trigger if exists stock_updated_at on template.stock;
create trigger stock_updated_at
  before update on template.stock
  for each row execute function template.update_updated_at();

drop trigger if exists audit_products on template.products;
create trigger audit_products
  after insert or update or delete on template.products
  for each row execute function template.audit_trigger_func();

drop trigger if exists audit_stock on template.stock;
create trigger audit_stock
  after insert or update or delete on template.stock
  for each row execute function template.audit_trigger_func();

drop trigger if exists audit_locations on template.locations;
create trigger audit_locations
  after insert or update or delete on template.locations
  for each row execute function template.audit_trigger_func();

drop trigger if exists stock_low_stock_check on template.stock;
create trigger stock_low_stock_check
  after insert or update of quantity on template.stock
  for each row execute function template.notify_low_stock();
