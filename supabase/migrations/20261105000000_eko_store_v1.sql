-- =====================================================================
-- EKO Store v1.0 database migration
-- File: supabase/migrations/20261105000000_eko_store_v1.sql
--
-- * Run it as ONE script in the Supabase SQL Editor (or `supabase db push`).
-- * Works on an EMPTY project and on a project where the old v0.2
--   schema.sql was (partly) run. Safe to run more than once.
-- * The whole script is one transaction: if anything fails, nothing changes.
-- * Existing customer/order data is never changed or deleted: the script only
--   adds tables, columns, indexes, functions and policies, and fills NEW
--   columns. Old v0.2 columns are kept (no longer used by the app).
-- * Privileges are changed only on EKO Store's own tables and functions.
--
-- Security model
--   * Every write from the app goes through a SECURITY DEFINER function
--     that checks the caller. Clients have no INSERT/UPDATE/DELETE on any
--     EKO table.
--   * The products table cannot be read through the API at all. Prices come
--     only from list_products(): guests get no price, retail customers the
--     retail price, approved wholesale customers the wholesale price.
-- =====================================================================

begin;

set local lock_timeout = '10s';

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text not null default '',
  role text not null default 'retail',
  created_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists email text not null default '',
  add column if not exists business_name text not null default '',
  add column if not exists business_number text not null default '',
  add column if not exists address text not null default '',
  add column if not exists city text not null default '',
  add column if not exists language text not null default 'sq',
  add column if not exists updated_at timestamptz not null default now();

-- wholesale_status is created here, and ONLY when it is created it is filled
-- from the v0.2 columns (role='wholesale' + wholesale_approved):
--   role 'wholesale' + approved      -> 'approved'  (keeps wholesale prices, as in v0.2)
--   role 'wholesale' + not approved  -> 'pending'   (retail prices until an admin approves)
--   any other role                   -> 'none'      (v0.2 gave them retail prices too)
-- Later runs never touch it again, so admin decisions are never overwritten.
-- The old columns themselves are left unchanged.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'wholesale_status') then
    alter table public.profiles add column wholesale_status text not null default 'none';
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'profiles'
                 and column_name = 'wholesale_approved') then
      execute $q$
        update public.profiles
           set wholesale_status = case when coalesce(wholesale_approved, false) then 'approved' else 'pending' end
         where role = 'wholesale'
      $q$;
    end if;
  end if;
end $$;

-- Fill the NEW email column.
update public.profiles p set email = coalesce(u.email, '')
  from auth.users u where u.id = p.id and p.email = '';

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('retail', 'wholesale', 'admin')) not valid;
alter table public.profiles drop constraint if exists profiles_wholesale_status_check;
alter table public.profiles add constraint profiles_wholesale_status_check
  check (wholesale_status in ('none', 'pending', 'approved', 'rejected'));
alter table public.profiles drop constraint if exists profiles_language_check;
alter table public.profiles add constraint profiles_language_check
  check (language in ('sq', 'en'));

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

-- 'guest' | 'retail' | 'wholesale' | 'admin'
-- Wholesale prices ONLY when an administrator has approved the account.
create or replace function public.price_tier() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select case when role = 'admin' then 'admin'
                 when wholesale_status = 'approved' then 'wholesale'
                 else 'retail' end
       from public.profiles where id = auth.uid()),
    'guest')
$$;

-- ---------------------------------------------------------------------
-- NOTIFICATIONS (in-app list + push/e-mail delivery queue)
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz not null default now()
);

-- Delivery bookkeeping: a notification is "claimed" while being sent and is
-- only marked dispatched after delivery succeeded (or after 5 failed tries).
alter table public.notifications
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_token uuid,
  add column if not exists attempts integer not null default 0,
  add column if not exists last_error text;

create index if not exists notifications_recipient_idx
  on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_undispatched_idx
  on public.notifications (created_at) where dispatched_at is null;

create table if not exists public.push_tokens (
  token text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null default 'android',
  updated_at timestamptz not null default now()
);

-- Internal: queue a notification for one user.
create or replace function public.notify_user(p_user uuid, p_type text, p_data jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (recipient_id, type, data) values (p_user, p_type, p_data)
$$;

-- Internal: queue a notification for every administrator.
create or replace function public.notify_admins(p_type text, p_data jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (recipient_id, type, data)
  select id, p_type, p_data from public.profiles where role = 'admin'
$$;

-- ---------------------------------------------------------------------
-- New user -> profile (+ admin notification)
-- ---------------------------------------------------------------------
create or replace function public.new_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_wants_wholesale boolean := coalesce(v_meta->>'requested_wholesale', 'false') = 'true';
  v_lang text := case when v_meta->>'language' = 'en' then 'en' else 'sq' end;
begin
  -- Role is always 'retail' at sign-up; nothing in the sign-up data can grant
  -- wholesale prices or admin rights.
  insert into public.profiles (id, email, full_name, phone, role, wholesale_status,
                               business_name, business_number, language)
  values (new.id, coalesce(new.email, ''),
          left(coalesce(v_meta->>'full_name', ''), 200),
          left(coalesce(v_meta->>'phone', ''), 50),
          'retail',
          case when v_wants_wholesale then 'pending' else 'none' end,
          left(coalesce(v_meta->>'business_name', ''), 200),
          left(coalesce(v_meta->>'business_number', ''), 50),
          v_lang)
  on conflict (id) do nothing;

  perform public.notify_admins(
    case when v_wants_wholesale then 'wholesale_request' else 'new_customer' end,
    jsonb_build_object('user_id', new.id,
                       'name', coalesce(nullif(v_meta->>'business_name', ''), v_meta->>'full_name', ''),
                       'email', new.email,
                       'phone', coalesce(v_meta->>'phone', '')));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.new_profile();

-- ---------------------------------------------------------------------
-- CATEGORIES
-- ---------------------------------------------------------------------
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name_sq text not null,
  name_en text not null default '',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.categories (name_sq, name_en, sort_order)
select * from (values
  ('Hidrosanitari', 'Plumbing', 10),
  ('Ngrohje', 'Heating', 20),
  ('Pajisje banjoje', 'Bathroom fittings', 30)
) v(name_sq, name_en, sort_order)
where not exists (select 1 from public.categories);

-- ---------------------------------------------------------------------
-- PRODUCTS
-- ---------------------------------------------------------------------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  description text,
  retail_price numeric(12,2) not null check (retail_price >= 0),
  wholesale_price numeric(12,2) not null check (wholesale_price >= 0),
  stock integer not null default 0 check (stock >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.products
  add column if not exists name_en text not null default '',
  add column if not exists description_en text not null default '',
  add column if not exists category_id uuid references public.categories(id) on delete set null,
  add column if not exists unit text not null default 'copë',
  add column if not exists images text[] not null default '{}',
  add column if not exists updated_at timestamptz not null default now();

-- v0.2 had a single image_url column: copy it into the NEW images column.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'products'
               and column_name = 'image_url') then
    execute $q$
      update public.products set images = array[image_url]
       where image_url is not null and image_url <> '' and cardinality(images) = 0
    $q$;
  end if;
end $$;

create index if not exists products_category_idx on public.products (category_id);

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- ORDERS
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid,
  status text not null default 'new',
  total numeric(12,2) not null,
  created_at timestamptz not null default now()
);

alter table public.orders
  add column if not exists price_tier text not null default 'retail',
  add column if not exists item_count integer not null default 0,
  add column if not exists payment_method text not null default 'cash_on_delivery',
  add column if not exists delivery_name text not null default '',
  add column if not exists delivery_phone text not null default '',
  add column if not exists delivery_address text not null default '',
  add column if not exists delivery_city text not null default '',
  add column if not exists customer_note text not null default '',
  add column if not exists admin_note text not null default '',
  add column if not exists updated_at timestamptz not null default now();

-- Human-readable order numbers (#1001, #1002, ...).
-- Existing orders (if any) are numbered by creation date; new orders continue
-- after the highest number. Re-running never renumbers anything.
do $$
declare
  v_max bigint;
  v_seq text;
  v_last bigint;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'orders' and column_name = 'order_number') then
    alter table public.orders add column order_number bigint;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'orders'
               and column_name = 'order_number' and is_identity = 'NO') then
    select coalesce(max(order_number), 1000) into v_max from public.orders;
    with n as (
      select id, v_max + row_number() over (order by created_at, id) as rn
      from public.orders where order_number is null
    )
    update public.orders o set order_number = n.rn from n where n.id = o.id;
    select coalesce(max(order_number), 1000) into v_max from public.orders;
    alter table public.orders alter column order_number set not null;
    execute format(
      'alter table public.orders alter column order_number add generated by default as identity (start with %s)',
      greatest(v_max + 1, 1001));
  end if;

  -- Keep the counter ahead of the highest existing number (never moves back).
  v_seq := pg_get_serial_sequence('public.orders', 'order_number');
  select max(order_number) into v_max from public.orders;
  execute format('select last_value from %s', v_seq) into v_last;
  if v_max is not null and v_max >= v_last then
    perform setval(v_seq, v_max);
  end if;
end $$;

create unique index if not exists orders_order_number_key on public.orders (order_number);

-- Orders reference the customer's profile. Deleting an account keeps the
-- order (customer_id becomes null). NOT VALID: existing rows are not re-checked.
alter table public.orders drop constraint if exists orders_customer_id_fkey;
alter table public.orders alter column customer_id drop not null;
alter table public.orders add constraint orders_customer_id_fkey
  foreign key (customer_id) references public.profiles(id) on delete set null not valid;

-- 'accepted' and 'completed' are v0.2 statuses, kept valid so old orders stay untouched.
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled',
                    'accepted', 'completed'));
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method in ('cash_on_delivery', 'bank_transfer'));
alter table public.orders drop constraint if exists orders_price_tier_check;
alter table public.orders add constraint orders_price_tier_check
  check (price_tier in ('retail', 'wholesale'));

create index if not exists orders_customer_idx on public.orders (customer_id, created_at desc);
create index if not exists orders_status_idx on public.orders (status, created_at desc);

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null
);

alter table public.order_items
  add column if not exists product_name text not null default '',
  add column if not exists sku text not null default '',
  add column if not exists unit text not null default '';

-- Order lines keep their own copy of name/SKU, so deleting a product later
-- never breaks order history.
alter table public.order_items drop constraint if exists order_items_product_id_fkey;
alter table public.order_items alter column product_id drop not null;
alter table public.order_items add constraint order_items_product_id_fkey
  foreign key (product_id) references public.products(id) on delete set null not valid;

-- Fill the NEW snapshot columns for existing order lines.
update public.order_items i set product_name = p.name, sku = p.sku, unit = p.unit
  from public.products p where p.id = i.product_id and i.product_name = '';

create index if not exists order_items_order_idx on public.order_items (order_id);

-- =====================================================================
-- ROW LEVEL SECURITY + TABLE PRIVILEGES (EKO tables only)
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.notifications enable row level security;
alter table public.push_tokens enable row level security;

-- Remove old policies on EKO tables (v0.2 or earlier runs), then recreate.
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and tablename in ('profiles','categories','products','orders','order_items','notifications','push_tokens')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- API roles: read-only, and only where a policy allows it.
revoke all on public.profiles, public.categories, public.products, public.orders,
  public.order_items, public.notifications, public.push_tokens from public, anon, authenticated;

grant select on public.categories to anon, authenticated;
grant select on public.profiles, public.orders, public.order_items, public.notifications to authenticated;
-- The order-number counter is never used directly by the API.
do $$
declare v_seq text := pg_get_serial_sequence('public.orders', 'order_number');
begin
  execute format('revoke all on sequence %s from public, anon, authenticated', v_seq);
end $$;
-- products:    NO access (prices only via list_products()).
-- push_tokens: NO access (register_push_token()).

create policy categories_select_public on public.categories for select to anon
  using (active);
create policy categories_select_auth on public.categories for select to authenticated
  using (active or (select public.is_admin()));
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy orders_select on public.orders for select to authenticated
  using (customer_id = (select auth.uid()) or (select public.is_admin()));
create policy order_items_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
                 and (o.customer_id = (select auth.uid()) or (select public.is_admin()))));
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()));

-- Live notifications in the app.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- =====================================================================
-- CATALOG
-- =====================================================================
-- Replace v0.2 functions (their signatures changed).
drop function if exists public.list_products();
drop function if exists public.guest_catalog();
drop function if exists public.place_order(jsonb);

-- price: the price THIS caller pays (null for guests).
-- retail_price / wholesale_price / stock: administrators only.
create or replace function public.list_products()
returns table (
  id uuid, sku text, name text, name_en text, description text, description_en text,
  category_id uuid, unit text, images text[], in_stock boolean, price numeric,
  retail_price numeric, wholesale_price numeric, stock integer, active boolean,
  created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with t as (select public.price_tier() as tier)
  select p.id, p.sku, p.name, p.name_en, coalesce(p.description, ''), p.description_en,
         p.category_id, p.unit, p.images, p.stock > 0,
         case t.tier when 'guest' then null
                     when 'wholesale' then p.wholesale_price
                     else p.retail_price end,
         case when t.tier = 'admin' then p.retail_price end,
         case when t.tier = 'admin' then p.wholesale_price end,
         case when t.tier = 'admin' then p.stock end,
         p.active, p.created_at, p.updated_at
  from public.products p, t
  where p.active or t.tier = 'admin'
  order by p.created_at desc
$$;

-- =====================================================================
-- CUSTOMER FUNCTIONS
-- =====================================================================
-- Only these fields can be changed by the customer (never role/status).
create or replace function public.update_my_profile(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  update public.profiles set
    full_name       = left(coalesce(p->>'full_name', full_name), 200),
    phone           = left(coalesce(p->>'phone', phone), 50),
    address         = left(coalesce(p->>'address', address), 500),
    city            = left(coalesce(p->>'city', city), 100),
    business_name   = left(coalesce(p->>'business_name', business_name), 200),
    business_number = left(coalesce(p->>'business_number', business_number), 50),
    language        = case when p->>'language' in ('sq','en') then p->>'language' else language end
  where id = auth.uid();
end $$;

create or replace function public.request_wholesale(p_business_name text, p_business_number text)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.profiles%rowtype;
begin
  select * into v from public.profiles where id = auth.uid() for update;
  if not found then raise exception 'LOGIN_REQUIRED'; end if;
  if v.role = 'admin' or v.wholesale_status = 'approved' then raise exception 'ALREADY_WHOLESALE'; end if;
  if v.wholesale_status = 'pending' then return; end if;
  if coalesce(trim(p_business_name), '') = '' then raise exception 'BUSINESS_NAME_REQUIRED'; end if;
  update public.profiles set wholesale_status = 'pending',
    business_name = left(trim(p_business_name), 200),
    business_number = left(coalesce(trim(p_business_number), ''), 50)
  where id = v.id;
  perform public.notify_admins('wholesale_request',
    jsonb_build_object('user_id', v.id, 'name', trim(p_business_name), 'email', v.email, 'phone', v.phone));
end $$;

-- p_lines:    [{"product_id": "...", "quantity": 2}, ...]   (prices from the app are ignored)
-- p_delivery: {"name","phone","address","city","note","payment_method"}
create or replace function public.place_order(p_lines jsonb, p_delivery jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_tier text;
  v_business text;
  v_order uuid;
  v_number bigint;
  v_total numeric := 0;
  v_count integer := 0;
  v_line record;
  v_p public.products%rowtype;
  v_price numeric;
  v_payment text := coalesce(p_delivery->>'payment_method', 'cash_on_delivery');
begin
  if v_user is null then raise exception 'LOGIN_REQUIRED'; end if;
  v_tier := public.price_tier();
  if v_tier = 'guest' then raise exception 'LOGIN_REQUIRED'; end if;
  v_tier := case when v_tier = 'wholesale' then 'wholesale' else 'retail' end;
  select business_name into v_business from public.profiles where id = v_user;

  if jsonb_typeof(p_lines) is distinct from 'array'
     or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 200 then
    raise exception 'INVALID_CART';
  end if;
  if coalesce(trim(p_delivery->>'name'), '') = '' or coalesce(trim(p_delivery->>'phone'), '') = ''
     or coalesce(trim(p_delivery->>'address'), '') = '' or coalesce(trim(p_delivery->>'city'), '') = '' then
    raise exception 'DELIVERY_REQUIRED';
  end if;
  if v_payment not in ('cash_on_delivery', 'bank_transfer') then raise exception 'INVALID_PAYMENT'; end if;

  insert into public.orders (customer_id, total, price_tier, payment_method,
    delivery_name, delivery_phone, delivery_address, delivery_city, customer_note)
  values (v_user, 0, v_tier, v_payment,
    left(trim(p_delivery->>'name'), 200), left(trim(p_delivery->>'phone'), 50),
    left(trim(p_delivery->>'address'), 500), left(trim(p_delivery->>'city'), 100),
    left(coalesce(trim(p_delivery->>'note'), ''), 1000))
  returning id, order_number into v_order, v_number;

  -- Merge duplicate product lines, validate quantities.
  for v_line in
    select (e->>'product_id')::uuid as product_id, sum((e->>'quantity')::integer) as qty
    from jsonb_array_elements(p_lines) e
    group by 1
  loop
    if v_line.qty is null or v_line.qty < 1 or v_line.qty > 100000 then
      raise exception 'INVALID_QUANTITY';
    end if;
    select * into v_p from public.products where id = v_line.product_id and active;
    if not found then raise exception 'PRODUCT_UNAVAILABLE'; end if;
    v_price := case when v_tier = 'wholesale' then v_p.wholesale_price else v_p.retail_price end;
    -- Stock is NOT reserved: EKO confirms availability after the order arrives.
    insert into public.order_items (order_id, product_id, quantity, unit_price, product_name, sku, unit)
    values (v_order, v_p.id, v_line.qty, v_price, v_p.name, v_p.sku, v_p.unit);
    v_total := v_total + v_line.qty * v_price;
    v_count := v_count + v_line.qty;
  end loop;

  update public.orders set total = v_total, item_count = v_count where id = v_order;

  perform public.notify_admins('new_order', jsonb_build_object(
    'order_id', v_order, 'order_number', v_number, 'total', v_total,
    'name', coalesce(nullif(v_business, ''), trim(p_delivery->>'name')),
    'tier', v_tier));

  return jsonb_build_object('id', v_order, 'order_number', v_number, 'total', v_total);
end $$;

create or replace function public.cancel_my_order(p_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.orders%rowtype;
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  select * into v from public.orders where id = p_order and customer_id = auth.uid() for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v.status <> 'new' then raise exception 'CANNOT_CANCEL'; end if;
  update public.orders set status = 'cancelled' where id = p_order;
  perform public.notify_admins('order_cancelled',
    jsonb_build_object('order_id', v.id, 'order_number', v.order_number, 'name', v.delivery_name));
end $$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void language sql security definer set search_path = '' as $$
  update public.notifications set read_at = now()
  where recipient_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids))
$$;

create or replace function public.register_push_token(p_token text, p_platform text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  if coalesce(p_token, '') = '' or length(p_token) > 300 then raise exception 'INVALID_TOKEN'; end if;
  insert into public.push_tokens (token, user_id, platform, updated_at)
  values (p_token, auth.uid(), left(coalesce(p_platform, 'android'), 20), now())
  on conflict (token) do update set user_id = excluded.user_id,
    platform = excluded.platform, updated_at = now();
end $$;

create or replace function public.unregister_push_token(p_token text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_tokens where token = p_token and user_id = auth.uid()
$$;

-- Google Play requires in-app account deletion. The customer's orders are kept
-- for EKO's records (customer_id becomes null).
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  if public.is_admin() then raise exception 'ADMIN_CANNOT_DELETE'; end if;
  delete from auth.users where id = auth.uid();
end $$;

-- =====================================================================
-- ADMIN FUNCTIONS (each one checks is_admin() first)
-- =====================================================================
create or replace function public.assert_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
end $$;

-- Create (p->>'id' null) or update a product. Returns the product id.
create or replace function public.admin_save_product(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_images text[];
begin
  perform public.assert_admin();
  v_id := nullif(p->>'id', '')::uuid;
  if coalesce(trim(p->>'sku'), '') = '' or coalesce(trim(p->>'name'), '') = '' then
    raise exception 'SKU_AND_NAME_REQUIRED';
  end if;
  if (p->>'retail_price') is null or (p->>'wholesale_price') is null
     or (p->>'retail_price')::numeric < 0 or (p->>'wholesale_price')::numeric < 0 then
    raise exception 'INVALID_PRICE';
  end if;
  select coalesce(array_agg(x), '{}') into v_images
    from jsonb_array_elements_text(coalesce(p->'images', '[]'::jsonb)) x where x <> '';
  if cardinality(v_images) > 10 then raise exception 'TOO_MANY_IMAGES'; end if;

  if v_id is null then
    insert into public.products (sku, name, name_en, description, description_en, category_id,
      unit, images, retail_price, wholesale_price, stock, active)
    values (trim(p->>'sku'), trim(p->>'name'), coalesce(trim(p->>'name_en'), ''),
      coalesce(p->>'description', ''), coalesce(p->>'description_en', ''),
      nullif(p->>'category_id', '')::uuid, coalesce(nullif(trim(p->>'unit'), ''), 'copë'), v_images,
      (p->>'retail_price')::numeric, (p->>'wholesale_price')::numeric,
      greatest(coalesce((p->>'stock')::integer, 0), 0), coalesce((p->>'active')::boolean, true))
    returning id into v_id;
  else
    update public.products set sku = trim(p->>'sku'), name = trim(p->>'name'),
      name_en = coalesce(trim(p->>'name_en'), ''),
      description = coalesce(p->>'description', ''), description_en = coalesce(p->>'description_en', ''),
      category_id = nullif(p->>'category_id', '')::uuid,
      unit = coalesce(nullif(trim(p->>'unit'), ''), 'copë'), images = v_images,
      retail_price = (p->>'retail_price')::numeric, wholesale_price = (p->>'wholesale_price')::numeric,
      stock = greatest(coalesce((p->>'stock')::integer, 0), 0),
      active = coalesce((p->>'active')::boolean, true)
    where id = v_id;
    if not found then raise exception 'NOT_FOUND'; end if;
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'SKU_EXISTS';
end $$;

-- Past orders keep their own name/SKU/price copy.
create or replace function public.admin_delete_product(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  delete from public.products where id = p_id;
end $$;

create or replace function public.admin_save_category(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.assert_admin();
  v_id := nullif(p->>'id', '')::uuid;
  if coalesce(trim(p->>'name_sq'), '') = '' then raise exception 'NAME_REQUIRED'; end if;
  if v_id is null then
    insert into public.categories (name_sq, name_en, sort_order, active)
    values (trim(p->>'name_sq'), coalesce(trim(p->>'name_en'), ''),
            coalesce((p->>'sort_order')::integer, 0), coalesce((p->>'active')::boolean, true))
    returning id into v_id;
  else
    update public.categories set name_sq = trim(p->>'name_sq'),
      name_en = coalesce(trim(p->>'name_en'), ''),
      sort_order = coalesce((p->>'sort_order')::integer, 0),
      active = coalesce((p->>'active')::boolean, true)
    where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.admin_delete_category(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  delete from public.categories where id = p_id;
end $$;

-- Approve (true) or reject/revoke (false) a wholesale account.
create or replace function public.admin_review_wholesale(p_user uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.profiles%rowtype;
begin
  perform public.assert_admin();
  select * into v from public.profiles where id = p_user for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v.role = 'admin' then raise exception 'CANNOT_CHANGE_ADMIN'; end if;
  if p_approve then
    update public.profiles set role = 'wholesale', wholesale_status = 'approved' where id = p_user;
    perform public.notify_user(p_user, 'wholesale_approved', '{}'::jsonb);
  else
    update public.profiles set role = 'retail',
      wholesale_status = case when v.wholesale_status = 'none' then 'none' else 'rejected' end
    where id = p_user;
    if v.wholesale_status in ('pending', 'approved') then
      perform public.notify_user(p_user, 'wholesale_rejected', '{}'::jsonb);
    end if;
  end if;
end $$;

create or replace function public.admin_set_order_status(p_order uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.orders%rowtype;
begin
  perform public.assert_admin();
  if p_status not in ('new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled') then
    raise exception 'INVALID_STATUS';
  end if;
  select * into v from public.orders where id = p_order for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  update public.orders set status = p_status,
    admin_note = coalesce(left(p_note, 1000), admin_note)
  where id = p_order;
  if v.status <> p_status and v.customer_id is not null then
    perform public.notify_user(v.customer_id, 'order_status',
      jsonb_build_object('order_id', v.id, 'order_number', v.order_number, 'status', p_status));
  end if;
end $$;

create or replace function public.admin_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  return jsonb_build_object(
    'new_orders', (select count(*) from public.orders where status = 'new'),
    'open_orders', (select count(*) from public.orders
                    where status in ('new','confirmed','preparing','shipped','accepted')),
    'pending_wholesale', (select count(*) from public.profiles where wholesale_status = 'pending'),
    'products', (select count(*) from public.products where active),
    'customers', (select count(*) from public.profiles where role <> 'admin'),
    'sales_30d', (select coalesce(sum(total), 0) from public.orders
                  where status <> 'cancelled' and created_at > now() - interval '30 days'));
end $$;

-- =====================================================================
-- NOTIFICATION DELIVERY (only for the Edge Function, via service_role)
--
-- 1. claim_notifications() leases up to N undelivered notifications for
--    5 minutes and stamps them with a NEW claim_token (attempts + 1).
--    Nothing is marked delivered yet.
-- 2. The worker sends push/e-mail.
-- 3. finish_notifications(claim_token, delivered, failed) marks the delivered
--    ones dispatched and releases the failed ones for a retry. It only touches
--    rows that STILL carry that claim_token: a stale worker whose lease expired
--    and was re-claimed by another worker cannot acknowledge anything.
--    An id listed as both delivered and failed counts as failed.
--    After 5 failed attempts a notification is given up (dispatched_at set,
--    last_error kept). Returns the number of rows updated.
-- If a worker crashes, its lease expires and the notifications are retried.
-- In-app notifications are always visible, independent of delivery.
-- =====================================================================
drop function if exists public.claim_notifications(integer);
drop function if exists public.finish_notifications(uuid[], uuid[], text);
drop function if exists public.finish_notifications(uuid, uuid[], uuid[], text);

create function public.claim_notifications(p_limit integer default 100)
returns table (id uuid, recipient_id uuid, type text, data jsonb, created_at timestamptz,
               attempts integer, claim_token uuid, recipient_role text, recipient_email text,
               recipient_language text, push_tokens text[])
language sql security definer set search_path = '' as $$
  with tok as materialized (
    select gen_random_uuid() as t
  ), c as (
    select n.id from public.notifications n
    where n.dispatched_at is null
      and n.created_at > now() - interval '2 days'
      and (n.claimed_at is null or n.claimed_at < now() - interval '5 minutes')
    order by n.created_at
    limit greatest(least(p_limit, 500), 1)
    for update skip locked
  ), u as (
    update public.notifications n
       set claimed_at = now(), claim_token = (select t from tok), attempts = n.attempts + 1
    from c where n.id = c.id
    returning n.*
  )
  select u.id, u.recipient_id, u.type, u.data, u.created_at, u.attempts, u.claim_token,
         p.role, p.email, p.language,
         coalesce((select array_agg(t.token) from public.push_tokens t where t.user_id = u.recipient_id), '{}')
  from u join public.profiles p on p.id = u.recipient_id
$$;

create function public.finish_notifications(p_claim uuid, p_delivered uuid[], p_failed uuid[],
                                            p_error text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_done integer;
  v_failed integer;
begin
  if p_claim is null then return 0; end if;

  update public.notifications
     set dispatched_at = now(), claimed_at = null, claim_token = null, last_error = null
   where claim_token = p_claim
     and dispatched_at is null
     and id = any(coalesce(p_delivered, '{}'))
     and not (id = any(coalesce(p_failed, '{}')));
  get diagnostics v_done = row_count;

  update public.notifications
     set claimed_at = null, claim_token = null,
         last_error = left(coalesce(p_error, 'delivery failed'), 500),
         dispatched_at = case when attempts >= 5 then now() else null end
   where claim_token = p_claim
     and dispatched_at is null
     and id = any(coalesce(p_failed, '{}'));
  get diagnostics v_failed = row_count;

  return v_done + v_failed;
end $$;

create or replace function public.forget_push_tokens(p_tokens text[])
returns void language sql security definer set search_path = '' as $$
  delete from public.push_tokens where token = any(p_tokens)
$$;

-- =====================================================================
-- FUNCTION PRIVILEGES — EKO Store functions ONLY.
-- Supabase gives anon/authenticated EXECUTE on new functions by default;
-- remove that from every EKO function, then grant exactly what the app needs.
-- Functions that are not part of EKO Store are not touched.
-- =====================================================================
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.touch_updated_at()', 'public.is_admin()', 'public.price_tier()',
    'public.notify_user(uuid, text, jsonb)', 'public.notify_admins(text, jsonb)',
    'public.new_profile()', 'public.list_products()',
    'public.update_my_profile(jsonb)', 'public.request_wholesale(text, text)',
    'public.place_order(jsonb, jsonb)', 'public.cancel_my_order(uuid)',
    'public.mark_notifications_read(uuid[])', 'public.register_push_token(text, text)',
    'public.unregister_push_token(text)', 'public.delete_my_account()',
    'public.assert_admin()', 'public.admin_save_product(jsonb)', 'public.admin_delete_product(uuid)',
    'public.admin_save_category(jsonb)', 'public.admin_delete_category(uuid)',
    'public.admin_review_wholesale(uuid, boolean)', 'public.admin_set_order_status(uuid, text, text)',
    'public.admin_stats()', 'public.claim_notifications(integer)',
    'public.finish_notifications(uuid, uuid[], uuid[], text)', 'public.forget_push_tokens(text[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- Guests (anon): catalog without prices.
grant execute on function public.list_products() to anon, authenticated;
-- Logged-in users. is_admin() is used inside RLS policies, so it must be executable.
grant execute on function public.is_admin() to authenticated;
grant execute on function public.update_my_profile(jsonb) to authenticated;
grant execute on function public.request_wholesale(text, text) to authenticated;
grant execute on function public.place_order(jsonb, jsonb) to authenticated;
grant execute on function public.cancel_my_order(uuid) to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
grant execute on function public.register_push_token(text, text) to authenticated;
grant execute on function public.unregister_push_token(text) to authenticated;
grant execute on function public.delete_my_account() to authenticated;
-- Admin functions: callable by logged-in users, but each refuses non-admins.
grant execute on function public.admin_save_product(jsonb) to authenticated;
grant execute on function public.admin_delete_product(uuid) to authenticated;
grant execute on function public.admin_save_category(jsonb) to authenticated;
grant execute on function public.admin_delete_category(uuid) to authenticated;
grant execute on function public.admin_review_wholesale(uuid, boolean) to authenticated;
grant execute on function public.admin_set_order_status(uuid, text, text) to authenticated;
grant execute on function public.admin_stats() to authenticated;
-- Server side only (Edge Function).
grant execute on function public.claim_notifications(integer) to service_role;
grant execute on function public.finish_notifications(uuid, uuid[], uuid[], text) to service_role;
grant execute on function public.forget_push_tokens(text[]) to service_role;

-- =====================================================================
-- STORAGE: product photos (anyone can view, only admins can change)
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "product images admin insert" on storage.objects;
drop policy if exists "product images admin update" on storage.objects;
drop policy if exists "product images admin delete" on storage.objects;
drop policy if exists "product images admin select" on storage.objects;
create policy "product images admin insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and (select public.is_admin()));
create policy "product images admin update" on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin()))
  with check (bucket_id = 'product-images' and (select public.is_admin()));
create policy "product images admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin()));
create policy "product images admin select" on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and (select public.is_admin()));

commit;

-- =====================================================================
-- First administrator (run ONCE, separately, after registering in the app):
--   update public.profiles set role = 'admin' where email = 'YOUR_EMAIL';
-- =====================================================================
