-- =====================================================================
-- EKO Store — WooCommerce (eko-store.com) ⇄ app
-- File: supabase/migrations/20261215000000_woocommerce_sync.sql
--
-- * Products: the WEBSITE is the source. The Edge Function `woo-sync` reads
--   products, variations (each size = one app product), categories, photos,
--   retail price (Regular price), wholesale price (Wholesale Suite) and stock
--   from WooCommerce and writes them here with woo_apply_products().
--   - immediately: WooCommerce webhook "product updated/created/deleted";
--   - every hour: full check (also deactivates products removed from the site);
--   - on demand: PC panel → Produktet → "Sinkronizo me faqen".
-- * Orders: app orders are copied to WooCommerce (Orders) by the same
--   function — only after an administrator switches it on in the panel
--   (woo_settings.orders_enabled, OFF by default). Status changes made in the
--   app panel follow (processing / completed / cancelled).
-- * Retail price 0 on the website (not filled in yet): for those website
--   products a RETAIL customer sees no price and cannot order them; wholesale
--   customers are not affected. Products created in the app are unchanged.
-- * One transaction; safe to run more than once. No existing row is changed
--   (only new nullable columns / tables / functions).
-- =====================================================================

begin;

set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public.best_offer(uuid, text)') is null
     or to_regprocedure('public.promo_functions_url_valid(text)') is null
     or to_regprocedure('public.admin_import_products(jsonb, boolean)') is null then
    raise exception 'Run the earlier EKO Store migrations first (offers, product import). Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Links to WooCommerce
-- ---------------------------------------------------------------------
alter table public.products
  add column if not exists woo_id bigint,            -- WooCommerce product id, or variation id for a size
  add column if not exists woo_parent_id bigint,     -- parent product id when this is a size (variation)
  add column if not exists source text not null default 'app';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_source_check') then
    alter table public.products add constraint products_source_check check (source in ('app', 'woo'));
  end if;
end $$;
create unique index if not exists products_woo_id_key on public.products (woo_id) where woo_id is not null;

alter table public.categories add column if not exists woo_id bigint;
create unique index if not exists categories_woo_id_key on public.categories (woo_id) where woo_id is not null;

alter table public.orders add column if not exists woo_order_id bigint;

create table if not exists public.woo_settings (
  id boolean primary key default true check (id),
  orders_enabled boolean not null default false,     -- copy app orders to WooCommerce (OFF)
  last_sync_at timestamptz,
  last_sync jsonb,
  request_id bigint,                                 -- last scheduler HTTP request (pg_net id)
  updated_at timestamptz not null default now()
);
insert into public.woo_settings (id) values (true) on conflict (id) do nothing;
alter table public.woo_settings enable row level security;
revoke all on public.woo_settings from anon, authenticated;

create table if not exists public.woo_order_jobs (
  id bigserial primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('create', 'status')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create unique index if not exists woo_order_jobs_create_key on public.woo_order_jobs (order_id) where kind = 'create';
create index if not exists woo_order_jobs_pending_idx on public.woo_order_jobs (status, id) where status = 'pending';
alter table public.woo_order_jobs enable row level security;
revoke all on public.woo_order_jobs from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Prices: a website product without a retail price is not sold at retail
-- ---------------------------------------------------------------------
-- Same columns and behaviour as before; only: tier retail + website product
-- with retail_price 0 → no price (null), like a guest.
create or replace function public.list_products()
returns table (
  id uuid, sku text, name text, name_en text, description text, description_en text,
  category_id uuid, unit text, images text[], in_stock boolean, price numeric,
  retail_price numeric, wholesale_price numeric, stock integer, active boolean,
  created_at timestamptz, updated_at timestamptz,
  regular_price numeric, offer_price numeric, offer_id uuid, offer_ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with t as (select public.price_tier() as tier)
  select p.id, p.sku, p.name, p.name_en, coalesce(p.description, ''), p.description_en,
         p.category_id, p.unit, p.images, p.stock > 0,
         case when t.tier = 'guest' or h.hide then null
              when b.offer_price < r.regular then b.offer_price else r.regular end,
         case when t.tier = 'admin' then p.retail_price end,
         case when t.tier = 'admin' then p.wholesale_price end,
         case when t.tier = 'admin' then p.stock end,
         p.active, p.created_at, p.updated_at,
         case when t.tier = 'guest' or h.hide then null else r.regular end,
         case when t.tier <> 'guest' and not h.hide and b.offer_price < r.regular then b.offer_price end,
         case when not h.hide and b.offer_price < r.regular then b.offer_id end,
         case when not h.hide and b.offer_price < r.regular then b.ends_at end
  from public.products p
  cross join t
  cross join lateral (select case when t.tier = 'wholesale' then p.wholesale_price else p.retail_price end as regular) r
  cross join lateral (select (t.tier = 'retail' and p.source = 'woo' and p.retail_price <= 0) as hide) h
  left join lateral public.best_offer(p.id, case when t.tier = 'wholesale' then 'wholesale' else 'retail' end) b on true
  where p.active or t.tier = 'admin'
  order by p.created_at desc
$$;

-- Same as before + (a) retail customers cannot order a website product that
-- has no retail price yet, (b) the order is queued for WooCommerce when the
-- administrator has switched that on.
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
  v_offer record;
  v_offer_id uuid;
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
    if v_tier = 'retail' and v_p.source = 'woo' and v_p.retail_price <= 0 then
      raise exception 'RETAIL_PRICE_MISSING';
    end if;
    v_price := case when v_tier = 'wholesale' then v_p.wholesale_price else v_p.retail_price end;
    v_offer_id := null;
    select * into v_offer from public.best_offer(v_p.id, v_tier);
    if found and v_offer.offer_price < v_price then
      v_price := v_offer.offer_price;
      v_offer_id := v_offer.offer_id;
    end if;
    -- Stock is NOT reserved: EKO confirms availability after the order arrives.
    insert into public.order_items (order_id, product_id, quantity, unit_price, product_name, sku, unit, offer_id)
    values (v_order, v_p.id, v_line.qty, v_price, v_p.name, v_p.sku, v_p.unit, v_offer_id);
    v_total := v_total + v_line.qty * v_price;
    v_count := v_count + v_line.qty;
  end loop;

  update public.orders set total = v_total, item_count = v_count where id = v_order;

  if (select orders_enabled from public.woo_settings where id) then
    insert into public.woo_order_jobs (order_id, kind) values (v_order, 'create');
  end if;

  perform public.notify_admins('new_order', jsonb_build_object(
    'order_id', v_order, 'order_number', v_number, 'total', v_total,
    'name', coalesce(nullif(v_business, ''), trim(p_delivery->>'name')),
    'tier', v_tier));

  return jsonb_build_object('id', v_order, 'order_number', v_number, 'total', v_total);
end $$;

-- Status changes of an order that was copied to WooCommerce follow it there.
create or replace function public.woo_order_status_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status
     and exists (select 1 from public.woo_order_jobs j where j.order_id = new.id and j.kind = 'create')
     and not exists (select 1 from public.woo_order_jobs j where j.order_id = new.id and j.kind = 'status' and j.status = 'pending') then
    insert into public.woo_order_jobs (order_id, kind) values (new.id, 'status');
  end if;
  return null;
end $$;
drop trigger if exists orders_woo_status on public.orders;
create trigger orders_woo_status after update of status on public.orders
  for each row execute function public.woo_order_status_trigger();

-- ---------------------------------------------------------------------
-- 3. Server functions for the Edge Function (service_role only)
-- ---------------------------------------------------------------------
-- p_items: [{ woo_id, woo_parent_id, sku, name, description, category: {woo_id, name},
--             images: [url], retail_price, wholesale_price, stock, active }]
-- p_full: the list is the WHOLE catalogue → website products not in it are deactivated.
-- p_notify: false → no promotional notifications for these changes (first/full syncs).
create or replace function public.woo_apply_products(p_items jsonb, p_full boolean, p_notify boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  it jsonb;
  v_cat uuid;
  v_cat_woo bigint;
  v_cat_name text;
  v_id uuid;
  v_sku text;
  v_retail numeric;
  v_whole numeric;
  v_images text[];
  v_active boolean;
  v_created integer := 0;
  v_updated integer := 0;
  v_deactivated integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_seen bigint[] := '{}';
begin
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'INVALID_INPUT'; end if;
  if not coalesce(p_notify, false) then
    perform set_config('eko.promo_suppress', 'on', true);   -- this transaction only
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    begin
      if (it->>'woo_id') is null then raise exception 'WOO_ID_REQUIRED'; end if;
      v_seen := v_seen || (it->>'woo_id')::bigint;

      -- category (by WooCommerce id, else by name; created when missing)
      v_cat := null;
      v_cat_woo := nullif(it->'category'->>'woo_id', '')::bigint;
      v_cat_name := nullif(left(trim(coalesce(it->'category'->>'name', '')), 100), '');
      if v_cat_woo is not null then
        select id into v_cat from public.categories where woo_id = v_cat_woo;
      end if;
      if v_cat is null and v_cat_name is not null then
        select id into v_cat from public.categories where lower(name_sq) = lower(v_cat_name) order by woo_id nulls last limit 1;
        if v_cat is not null and v_cat_woo is not null then
          update public.categories set woo_id = v_cat_woo where id = v_cat and woo_id is null;
        end if;
      end if;
      if v_cat is null and v_cat_name is not null then
        insert into public.categories (name_sq, name_en, sort_order, woo_id)
        values (v_cat_name, '', 100, v_cat_woo) returning id into v_cat;
      end if;
      if v_cat is not null and v_cat_name is not null then
        update public.categories set name_sq = v_cat_name where id = v_cat and v_cat_woo is not null and woo_id = v_cat_woo and name_sq <> v_cat_name;
      end if;

      v_retail := greatest(coalesce(nullif(it->>'retail_price', '')::numeric, 0), 0);
      v_whole := nullif(it->>'wholesale_price', '')::numeric;
      if v_whole is null or v_whole <= 0 then v_whole := v_retail; end if;   -- no wholesale price → same as retail
      v_active := coalesce((it->>'active')::boolean, true) and (v_whole > 0 or v_retail > 0);
      select coalesce(array_agg(x), '{}') into v_images
        from (select x from jsonb_array_elements_text(coalesce(it->'images', '[]'::jsonb)) x
               where x ~ '^https://[^\s]+$' limit 10) s;
      v_sku := nullif(left(trim(coalesce(it->>'sku', '')), 100), '');
      if v_sku is null then v_sku := 'WOO-' || (it->>'woo_id'); end if;

      -- the product: by WooCommerce id, else an app product with the same SKU (linked once)
      select id into v_id from public.products where woo_id = (it->>'woo_id')::bigint;
      if v_id is null then
        select id into v_id from public.products where lower(sku) = lower(v_sku) and woo_id is null limit 1;
      end if;
      -- the SKU must stay unique in the app
      if exists (select 1 from public.products where lower(sku) = lower(v_sku) and id is distinct from v_id) then
        v_sku := v_sku || '-W' || (it->>'woo_id');
      end if;

      if v_id is null then
        insert into public.products (sku, name, description, category_id, images, retail_price, wholesale_price,
          stock, active, woo_id, woo_parent_id, source)
        values (v_sku, left(coalesce(nullif(trim(it->>'name'), ''), v_sku), 200), left(coalesce(it->>'description', ''), 5000),
          v_cat, v_images, v_retail, v_whole, greatest(coalesce((it->>'stock')::integer, 0), 0), v_active,
          (it->>'woo_id')::bigint, nullif(it->>'woo_parent_id', '')::bigint, 'woo');
        v_created := v_created + 1;
      else
        update public.products set
          sku = v_sku,
          name = left(coalesce(nullif(trim(it->>'name'), ''), name), 200),
          description = left(coalesce(it->>'description', ''), 5000),
          category_id = coalesce(v_cat, category_id),
          images = v_images,
          retail_price = v_retail,
          wholesale_price = v_whole,
          stock = greatest(coalesce((it->>'stock')::integer, 0), 0),
          active = v_active,
          woo_id = (it->>'woo_id')::bigint,
          woo_parent_id = nullif(it->>'woo_parent_id', '')::bigint,
          source = 'woo'
        where id = v_id
          and (sku, name, coalesce(description, ''), category_id, images, retail_price, wholesale_price, stock, active,
               woo_id, woo_parent_id, source)
              is distinct from
              (v_sku, left(coalesce(nullif(trim(it->>'name'), ''), name), 200), left(coalesce(it->>'description', ''), 5000),
               coalesce(v_cat, category_id), v_images, v_retail, v_whole, greatest(coalesce((it->>'stock')::integer, 0), 0), v_active,
               (it->>'woo_id')::bigint, nullif(it->>'woo_parent_id', '')::bigint, 'woo');
        if found then v_updated := v_updated + 1; end if;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_object('woo_id', it->'woo_id', 'sku', it->'sku',
        'error', case when sqlerrm ~ '^[A-Z_]+$' then sqlerrm else 'ROW_FAILED' end);
    end;
  end loop;

  -- full catalogue: website products that are no longer on the website are hidden (never deleted: orders keep them)
  if coalesce(p_full, false) then
    update public.products set active = false
     where source = 'woo' and active and not (woo_id = any (v_seen));
    get diagnostics v_deactivated = row_count;
  end if;

  return jsonb_build_object('created', v_created, 'updated', v_updated, 'deactivated', v_deactivated,
                            'errors', v_errors, 'received', jsonb_array_length(p_items));
end $$;

-- A website product was deleted / trashed: hide it and its sizes.
create or replace function public.woo_hide_product(p_woo_id bigint)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.products set active = false
   where source = 'woo' and active and (woo_id = p_woo_id or woo_parent_id = p_woo_id);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.woo_record_sync(p_result jsonb)
returns void language sql security definer set search_path = '' as $$
  update public.woo_settings set last_sync_at = now(), last_sync = p_result, updated_at = now() where id;
$$;

-- Is a full sync due? 'first' (never synced: no promotional notifications for
-- the initial catalogue), 'due' (last one ≥ 55 min ago) or 'no'.
-- The keyless scheduler call may only run one per ~hour.
drop function if exists public.woo_full_sync_due();
create function public.woo_full_sync_due()
returns text language sql stable security definer set search_path = '' as $$
  select case when s.last_sync_at is null then 'first'
              when s.last_sync_at < now() - interval '55 minutes' then 'due'
              else 'no' end
    from public.woo_settings s where s.id
$$;

-- Pending order jobs with everything needed to create / update the WooCommerce order.
create or replace function public.woo_claim_order_jobs(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  with j as (
    select id from public.woo_order_jobs
     where status = 'pending' and attempts < 5
     order by id limit least(greatest(coalesce(p_limit, 10), 1), 50)
     for update skip locked
  ), u as (
    update public.woo_order_jobs w set attempts = attempts + 1 from j where w.id = j.id
    returning w.id, w.order_id, w.kind, w.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'job_id', u.id, 'kind', u.kind, 'attempts', u.attempts,
           'order', jsonb_build_object(
             'id', o.id, 'order_number', o.order_number, 'status', o.status, 'total', o.total,
             'price_tier', o.price_tier, 'payment_method', o.payment_method,
             'name', o.delivery_name, 'phone', o.delivery_phone, 'address', o.delivery_address,
             'city', o.delivery_city, 'note', o.customer_note, 'woo_order_id', o.woo_order_id,
             'email', (select email from public.profiles where id = o.customer_id),
             'business_name', (select business_name from public.profiles where id = o.customer_id),
             'items', (select coalesce(jsonb_agg(jsonb_build_object(
                         'name', i.product_name, 'sku', i.sku, 'quantity', i.quantity, 'unit_price', i.unit_price,
                         'woo_id', p.woo_id, 'woo_parent_id', p.woo_parent_id) order by i.id), '[]'::jsonb)
                         from public.order_items i left join public.products p on p.id = i.product_id
                        where i.order_id = o.id))
         ) order by u.id), '[]'::jsonb)
    into r
    from u join public.orders o on o.id = u.order_id;
  return r;
end $$;

create or replace function public.woo_finish_order_job(p_job bigint, p_woo_order_id bigint, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_order uuid;
begin
  update public.woo_order_jobs
     set status = case when p_error is null then 'sent' when attempts >= 5 then 'failed' else 'pending' end,
         last_error = left(p_error, 500),
         processed_at = now()
   where id = p_job
  returning order_id into v_order;
  if p_error is null and p_woo_order_id is not null then
    update public.orders set woo_order_id = p_woo_order_id where id = v_order and woo_order_id is null;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Panel (administrators)
-- ---------------------------------------------------------------------
create or replace function public.admin_woo_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.woo_settings%rowtype;
begin
  perform public.assert_admin();
  select * into s from public.woo_settings where id;
  return jsonb_build_object(
    'orders_enabled', s.orders_enabled,
    'last_sync_at', s.last_sync_at,
    'last_sync', s.last_sync,
    'functions_url_set', public.promo_functions_url_valid((select functions_url from public.promo_settings where id)),
    'products', (select count(*) from public.products where source = 'woo'),
    'products_active', (select count(*) from public.products where source = 'woo' and active),
    'products_no_retail', (select count(*) from public.products where source = 'woo' and active and retail_price <= 0),
    'orders_pending', (select count(*) from public.woo_order_jobs where status = 'pending'),
    'orders_sent', (select count(*) from public.woo_order_jobs where status = 'sent' and kind = 'create'),
    'orders_failed', (select count(*) from public.woo_order_jobs where status = 'failed'),
    'last_order_error', (select last_error from public.woo_order_jobs where last_error is not null order by processed_at desc nulls last limit 1));
end $$;

create or replace function public.admin_woo_set_orders(p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  update public.woo_settings set orders_enabled = coalesce(p_enabled, false), updated_at = now() where id;
end $$;

-- Which app products come from the website (the panel marks them).
create or replace function public.admin_woo_products()
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  return query select id from public.products where source = 'woo';
end $$;

-- Try a failed order again.
create or replace function public.admin_woo_retry_orders()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform public.assert_admin();
  update public.woo_order_jobs set status = 'pending', attempts = 0 where status = 'failed';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 5. Scheduler: every minute → Edge Function woo-sync (orders; full sync hourly)
-- ---------------------------------------------------------------------
-- Same rules as the notifications scheduler: only this project's
-- functions URL (Promo settings → functions_url), empty POST, no key.
create or replace function public.woo_dispatch()
returns bigint language plpgsql security definer set search_path = '' as $$
declare u text; rid bigint;
begin
  select functions_url into u from public.promo_settings where id;
  if not public.promo_functions_url_valid(u) or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return null;
  end if;
  -- nothing to do: no pending order and no full sync due
  if not exists (select 1 from public.woo_order_jobs where status = 'pending') and public.woo_full_sync_due() = 'no' then
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, '
       || 'headers := ''{"Content-Type": "application/json"}''::jsonb, timeout_milliseconds := 60000)'
     into rid using u || '/woo-sync';
  update public.woo_settings set request_id = rid where id;
  return rid;
end $$;

-- ---------------------------------------------------------------------
-- 6. Permissions
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.woo_apply_products(jsonb, boolean, boolean)', 'public.woo_hide_product(bigint)',
    'public.woo_record_sync(jsonb)', 'public.woo_full_sync_due()', 'public.woo_claim_order_jobs(integer)',
    'public.woo_finish_order_job(bigint, bigint, text)', 'public.woo_dispatch()', 'public.woo_order_status_trigger()',
    'public.admin_woo_status()', 'public.admin_woo_set_orders(boolean)', 'public.admin_woo_retry_orders()',
    'public.admin_woo_products()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function public.woo_apply_products(jsonb, boolean, boolean) to service_role;
grant execute on function public.woo_hide_product(bigint) to service_role;
grant execute on function public.woo_record_sync(jsonb) to service_role;
grant execute on function public.woo_full_sync_due() to service_role;
grant execute on function public.woo_claim_order_jobs(integer) to service_role;
grant execute on function public.woo_finish_order_job(bigint, bigint, text) to service_role;
grant execute on function public.admin_woo_status() to authenticated;        -- each re-checks is_admin()
grant execute on function public.admin_woo_set_orders(boolean) to authenticated;
grant execute on function public.admin_woo_retry_orders() to authenticated;
grant execute on function public.admin_woo_products() to authenticated;
grant execute on function public.list_products() to anon, authenticated;
grant execute on function public.place_order(jsonb, jsonb) to authenticated;
revoke all on function public.place_order(jsonb, jsonb) from public, anon;

do $$
begin
  begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net') then
      perform cron.schedule('eko-woo-minutely', '* * * * *', 'select public.woo_dispatch()');
    else
      raise notice 'pg_cron/pg_net not installed: the website sync runs from the webhook and the panel button only.';
    end if;
  exception when others then
    raise notice 'Scheduler not set up (%). Everything else is installed.', sqlerrm;
  end;
end $$;

notify pgrst, 'reload schema';

commit;
