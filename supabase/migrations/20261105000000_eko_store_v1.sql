-- =====================================================================
-- EKO Store v1.0 database
--
-- Safe to run on:
--   * an EMPTY Supabase project, or
--   * a project where the v0.2 `schema.sql` was (partly) run.
-- It upgrades the v0.2 tables in place and keeps existing data.
--
-- Security model
--   * All writes from the app go through SECURITY DEFINER functions (RPCs)
--     that check the caller. Clients have no direct INSERT/UPDATE/DELETE
--     on business tables.
--   * The products table is not readable directly. Prices are only
--     exposed by list_products(): guests get no price, retail customers get
--     the retail price, approved wholesale customers get the wholesale price.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Generic helpers
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
  add column if not exists wholesale_status text not null default 'none',
  add column if not exists business_name text not null default '',
  add column if not exists business_number text not null default '',
  add column if not exists address text not null default '',
  add column if not exists city text not null default '',
  add column if not exists language text not null default 'sq',
  add column if not exists updated_at timestamptz not null default now();

-- v0.2 used role='wholesale' + wholesale_approved. v1 uses
--   role = 'wholesale' only when approved, and wholesale_status for the request.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles'
               and column_name = 'wholesale_approved') then
    update public.profiles set wholesale_status = 'approved'
      where role = 'wholesale' and wholesale_approved;
    update public.profiles set wholesale_status = 'pending', role = 'retail'
      where role = 'wholesale' and not wholesale_approved;
    alter table public.profiles drop column wholesale_approved;
  end if;
end $$;

update public.profiles p set email = coalesce(u.email, '')
  from auth.users u where u.id = p.id and p.email = '';

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('retail', 'wholesale', 'admin'));
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
create or replace function public.price_tier() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'guest')
$$;

-- ---------------------------------------------------------------------
-- NOTIFICATIONS (in-app + push/email dispatch queue)
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
-- New user -> profile (+ admin notifications)
-- ---------------------------------------------------------------------
create or replace function public.new_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_wants_wholesale boolean := coalesce(v_meta->>'requested_wholesale', 'false') = 'true';
  v_lang text := case when v_meta->>'language' = 'en' then 'en' else 'sq' end;
begin
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

-- v0.2 had a single image_url
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'products'
               and column_name = 'image_url') then
    update public.products set images = array[image_url]
      where image_url is not null and image_url <> '' and cardinality(images) = 0;
    alter table public.products drop column image_url;
  end if;
end $$;

update public.products set description = '' where description is null;
alter table public.products alter column description set default '';
alter table public.products alter column description set not null;

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
  add column if not exists order_number bigint generated by default as identity (start with 1001),
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

-- Customers may delete their account; their orders are kept for EKO's records.
alter table public.orders drop constraint if exists orders_customer_id_fkey;
alter table public.orders alter column customer_id drop not null;
alter table public.orders add constraint orders_customer_id_fkey
  foreign key (customer_id) references public.profiles(id) on delete set null;

alter table public.orders drop constraint if exists orders_status_check;
update public.orders set status = 'confirmed' where status = 'accepted';
update public.orders set status = 'delivered' where status = 'completed';
alter table public.orders add constraint orders_status_check
  check (status in ('new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled'));
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method in ('cash_on_delivery', 'bank_transfer'));
alter table public.orders drop constraint if exists orders_price_tier_check;
alter table public.orders add constraint orders_price_tier_check
  check (price_tier in ('retail', 'wholesale'));

create unique index if not exists orders_order_number_key on public.orders (order_number);
create index if not exists orders_customer_idx on public.orders (customer_id, created_at desc);
create index if not exists orders_status_idx on public.orders (status, created_at desc);

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null
);

alter table public.order_items
  add column if not exists product_name text not null default '',
  add column if not exists sku text not null default '',
  add column if not exists unit text not null default '';

-- Keep order history even if a product is deleted later.
alter table public.order_items drop constraint if exists order_items_product_id_fkey;
alter table public.order_items alter column product_id drop not null;
alter table public.order_items add constraint order_items_product_id_fkey
  foreign key (product_id) references public.products(id) on delete set null;

update public.order_items i set product_name = p.name, sku = p.sku, unit = p.unit
  from public.products p where p.id = i.product_id and i.product_name = '';

create index if not exists order_items_order_idx on public.order_items (order_id);

-- =====================================================================
-- ROW LEVEL SECURITY + GRANTS
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.notifications enable row level security;
alter table public.push_tokens enable row level security;

-- Drop v0.2 / earlier policies so this file can be re-run.
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and tablename in ('profiles','categories','products','orders','order_items','notifications','push_tokens')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- Start from zero privileges for API roles, then grant only reads.
revoke all on public.profiles, public.categories, public.products, public.orders,
  public.order_items, public.notifications, public.push_tokens from anon, authenticated;

grant select on public.profiles, public.orders, public.order_items, public.notifications
  to authenticated;
grant select on public.categories to anon, authenticated;
-- products: no direct access at all (use list_products()).
-- push_tokens: no direct access (use register_push_token()).

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy categories_select on public.categories for select to anon, authenticated
  using (active or (select public.is_admin()));
create policy orders_select on public.orders for select to authenticated
  using (customer_id = (select auth.uid()) or (select public.is_admin()));
create policy order_items_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
                 and (o.customer_id = (select auth.uid()) or (select public.is_admin()))));
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()));

-- Live notifications in the app
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
drop function if exists public.list_products();
drop function if exists public.guest_catalog();

-- price: the price THIS caller pays (null for guests).
-- retail_price / wholesale_price / stock: admins only.
create or replace function public.list_products()
returns table (
  id uuid, sku text, name text, name_en text, description text, description_en text,
  category_id uuid, unit text, images text[], in_stock boolean, price numeric,
  retail_price numeric, wholesale_price numeric, stock integer, active boolean,
  created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with t as (select public.price_tier() as tier)
  select p.id, p.sku, p.name, p.name_en, p.description, p.description_en,
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
-- CUSTOMER RPCs
-- =====================================================================
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
  if v.role <> 'retail' then raise exception 'ALREADY_WHOLESALE'; end if;
  if v.wholesale_status = 'pending' then return; end if;
  if coalesce(trim(p_business_name), '') = '' then raise exception 'BUSINESS_NAME_REQUIRED'; end if;
  update public.profiles set wholesale_status = 'pending',
    business_name = left(trim(p_business_name), 200),
    business_number = left(coalesce(trim(p_business_number), ''), 50)
  where id = v.id;
  perform public.notify_admins('wholesale_request',
    jsonb_build_object('user_id', v.id, 'name', trim(p_business_name), 'email', v.email, 'phone', v.phone));
end $$;

-- p_lines:    [{"product_id": "...", "quantity": 2}, ...]
-- p_delivery: {"name","phone","address","city","note","payment_method"}
create or replace function public.place_order(p_lines jsonb, p_delivery jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_tier text;
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
  select * into v_profile from public.profiles where id = v_user;
  if not found then raise exception 'LOGIN_REQUIRED'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array'
     or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 200 then
    raise exception 'INVALID_CART';
  end if;
  if coalesce(trim(p_delivery->>'name'), '') = '' or coalesce(trim(p_delivery->>'phone'), '') = ''
     or coalesce(trim(p_delivery->>'address'), '') = '' or coalesce(trim(p_delivery->>'city'), '') = '' then
    raise exception 'DELIVERY_REQUIRED';
  end if;
  if v_payment not in ('cash_on_delivery', 'bank_transfer') then raise exception 'INVALID_PAYMENT'; end if;

  v_tier := case when v_profile.role = 'wholesale' then 'wholesale' else 'retail' end;

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
    'name', coalesce(nullif(v_profile.business_name, ''), trim(p_delivery->>'name')),
    'tier', v_tier));

  return jsonb_build_object('id', v_order, 'order_number', v_number, 'total', v_total);
end $$;

create or replace function public.cancel_my_order(p_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.orders%rowtype;
begin
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

-- Google Play requires in-app account deletion. Orders are kept (customer_id -> null).
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  if public.is_admin() then raise exception 'ADMIN_CANNOT_DELETE'; end if;
  delete from auth.users where id = auth.uid();
end $$;

-- =====================================================================
-- ADMIN RPCs
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
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_images text[];
begin
  perform public.assert_admin();
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

-- Products are hard-deleted; past orders keep their own name/SKU/price copy.
create or replace function public.admin_delete_product(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  delete from public.products where id = p_id;
end $$;

create or replace function public.admin_save_category(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid;
begin
  perform public.assert_admin();
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

-- Dashboard counters for the admin home screen.
create or replace function public.admin_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  return jsonb_build_object(
    'new_orders', (select count(*) from public.orders where status = 'new'),
    'open_orders', (select count(*) from public.orders where status in ('new','confirmed','preparing','shipped')),
    'pending_wholesale', (select count(*) from public.profiles where wholesale_status = 'pending'),
    'products', (select count(*) from public.products where active),
    'customers', (select count(*) from public.profiles where role <> 'admin'),
    'sales_30d', (select coalesce(sum(total), 0) from public.orders
                  where status <> 'cancelled' and created_at > now() - interval '30 days'));
end $$;

-- =====================================================================
-- Notification dispatch (used by the Edge Function with the service role)
-- =====================================================================
create or replace function public.claim_notifications(p_limit integer default 100)
returns table (id uuid, recipient_id uuid, type text, data jsonb, created_at timestamptz,
               recipient_role text, recipient_email text, recipient_language text, push_tokens text[])
language sql security definer set search_path = '' as $$
  with c as (
    select n.id from public.notifications n
    where n.dispatched_at is null and n.created_at > now() - interval '2 days'
    order by n.created_at
    limit greatest(least(p_limit, 500), 1)
    for update skip locked
  ), u as (
    update public.notifications n set dispatched_at = now()
    from c where n.id = c.id
    returning n.*
  )
  select u.id, u.recipient_id, u.type, u.data, u.created_at, p.role, p.email, p.language,
         coalesce((select array_agg(t.token) from public.push_tokens t where t.user_id = u.recipient_id), '{}')
  from u join public.profiles p on p.id = u.recipient_id
$$;

create or replace function public.forget_push_tokens(p_tokens text[])
returns void language sql security definer set search_path = '' as $$
  delete from public.push_tokens where token = any(p_tokens)
$$;

-- =====================================================================
-- FUNCTION PRIVILEGES
-- Supabase grants EXECUTE to anon/authenticated by default: lock down
-- everything, then open only the RPCs the app calls.
-- =====================================================================
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

grant execute on function public.list_products() to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.price_tier() to authenticated;
grant execute on function public.update_my_profile(jsonb) to authenticated;
grant execute on function public.request_wholesale(text, text) to authenticated;
grant execute on function public.place_order(jsonb, jsonb) to authenticated;
grant execute on function public.cancel_my_order(uuid) to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
grant execute on function public.register_push_token(text, text) to authenticated;
grant execute on function public.unregister_push_token(text) to authenticated;
grant execute on function public.delete_my_account() to authenticated;
grant execute on function public.admin_save_product(jsonb) to authenticated;
grant execute on function public.admin_delete_product(uuid) to authenticated;
grant execute on function public.admin_save_category(jsonb) to authenticated;
grant execute on function public.admin_delete_category(uuid) to authenticated;
grant execute on function public.admin_review_wholesale(uuid, boolean) to authenticated;
grant execute on function public.admin_set_order_status(uuid, text, text) to authenticated;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.claim_notifications(integer) to service_role;
grant execute on function public.forget_push_tokens(text[]) to service_role;

-- RLS policies call these helpers as the querying role.
grant execute on function public.is_admin() to anon;

-- =====================================================================
-- STORAGE: product photos (public read, admin write)
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
  with check (bucket_id = 'product-images' and public.is_admin());
create policy "product images admin update" on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.is_admin());
create policy "product images admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.is_admin());
create policy "product images admin select" on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

-- =====================================================================
-- First administrator (run once, after registering in the app):
--   update public.profiles set role = 'admin', wholesale_status = 'none'
--   where email = 'YOUR_EMAIL';
-- =====================================================================
