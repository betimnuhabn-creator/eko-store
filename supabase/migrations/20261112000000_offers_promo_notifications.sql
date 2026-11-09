-- =====================================================================
-- EKO Store — "Ofertat e Momentit" (scheduled offers) + automatic
-- promotional push notifications
-- File: supabase/migrations/20261112000000_offers_promo_notifications.sql
--
-- * Run AFTER 20261105000000_eko_store_v1.sql and
--   20261110000000_order_cancel_archive.sql, as ONE script in the SQL
--   Editor. One transaction; safe to run more than once.
-- * Nothing is deleted. Historical orders and order lines are not touched.
--   Existing products keep their prices; they are only marked as
--   "already announced" so that no notification is sent for them.
-- * PROMOTIONAL NOTIFICATIONS ARE OFF after this migration
--   (promo_settings.enabled = false) and, once switched on, start in
--   TEST MODE (only accounts marked as promo testers receive them).
--
-- How prices work
--   * products.retail_price / wholesale_price stay the REGULAR prices.
--   * An offer gives products a promotional price between starts_at and
--     ends_at. The current price is calculated live (now()), so offers
--     start and expire exactly on time without any job, and the regular
--     price comes back automatically. Offers never change the product's
--     regular price, so they never produce "price changed" notifications.
--   * list_products() and place_order() use the same calculation:
--     checkout always charges the currently valid server-side price.
--   * Wholesale: optional offer_wholesale_price; a wholesale customer never
--     pays more than the retail offer price. Retail customers never receive
--     wholesale prices (not in listings, not in notifications).
--
-- How promotional notifications work (separate from order notifications)
--   1. Triggers / functions record an EVENT in promo_events:
--        new product published, offer became active, regular price changed.
--   2. Events wait `debounce_minutes`; further edits to the same product's
--      price are merged into the waiting event (one notification, from the
--      first old price to the last new price; nothing if it ends unchanged).
--   3. promo_fanout() turns an event into one notification per customer who
--      opted in (per type), has a push token, is under the daily cap and
--      (in test mode) is a promo tester. Unique (recipient, event) => an
--      event can never notify the same person twice.
--   4. The existing dispatch-notifications Edge Function delivers them
--      (Android channel "promotions", category 'promo').
-- =====================================================================

begin;

set local lock_timeout = '10s';

-- ---------------------------------------------------------------------
-- Pre-flight
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.assert_admin()') is null
     or to_regprocedure('public.admin_archive_order(uuid)') is null
     or to_regclass('public.notifications') is null then
    raise exception 'Run 20261105000000_eko_store_v1.sql and 20261110000000_order_cancel_archive.sql first. Nothing was changed.';
  end if;
end $$;

-- =====================================================================
-- 1. SETTINGS, PREFERENCES, NEW COLUMNS
-- =====================================================================
create table if not exists public.promo_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,          -- master switch (OFF)
  test_only boolean not null default true,         -- only promo testers
  daily_cap integer not null default 3 check (daily_cap between 0 and 50),
  debounce_minutes integer not null default 5 check (debounce_minutes between 0 and 1440),
  functions_url text not null default '',          -- https://<ref>.supabase.co/functions/v1 (scheduler)
  updated_at timestamptz not null default now()
);
insert into public.promo_settings (id) values (true) on conflict (id) do nothing;

-- Opt-in preferences (default OFF) and the tester flag (set by admins only).
alter table public.profiles
  add column if not exists promo_new_products boolean not null default false,
  add column if not exists promo_offers boolean not null default false,
  add column if not exists promo_price_changes boolean not null default false,
  add column if not exists promo_tester boolean not null default false;

-- Products: when the product was announced. Existing products count as
-- already announced: the column is added with a default that PostgreSQL
-- stores once for the existing rows (no UPDATE, so no trigger runs and
-- products.updated_at and every other column stay exactly as they are).
-- The default is removed again so that products created later start
-- unannounced. Running the file again changes nothing here.
alter table public.products add column if not exists announced_at timestamptz default now();
alter table public.products alter column announced_at drop default;

-- Order lines: which offer gave the price (new lines only; old lines stay null).
alter table public.order_items add column if not exists offer_id uuid;

-- =====================================================================
-- 2. OFFERS
-- =====================================================================
create table if not exists public.offers (
  id uuid primary key default gen_random_uuid(),
  title_sq text not null,
  title_en text not null default '',
  description_sq text not null default '',
  description_en text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default true,
  cancelled_at timestamptz,
  activation_notified_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offers_dates check (ends_at > starts_at)
);
create index if not exists offers_live_idx on public.offers (starts_at, ends_at) where active and cancelled_at is null;

create table if not exists public.offer_items (
  offer_id uuid not null references public.offers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  offer_price numeric(12,2) not null check (offer_price >= 0),
  offer_wholesale_price numeric(12,2) check (offer_wholesale_price >= 0),
  primary key (offer_id, product_id)
);
create index if not exists offer_items_product_idx on public.offer_items (product_id);

drop trigger if exists offers_touch on public.offers;
create trigger offers_touch before update on public.offers
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 3. PROMO EVENTS + NOTIFICATION CATEGORY
-- =====================================================================
create table if not exists public.promo_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('new_product', 'offer', 'price')),
  product_id uuid references public.products(id) on delete set null,
  offer_id uuid references public.offers(id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'suppressed', 'skipped')),
  recipients integer,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);
-- At most one waiting price event per product (later edits merge into it).
create unique index if not exists promo_events_one_pending_price
  on public.promo_events (product_id) where kind = 'price' and status = 'pending';
create index if not exists promo_events_pending_idx on public.promo_events (updated_at) where status = 'pending';

alter table public.notifications
  add column if not exists category text not null default 'order',
  add column if not exists event_id uuid references public.promo_events(id) on delete set null;
alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications add constraint notifications_category_check
  check (category in ('order', 'promo'));
-- An event can notify a person only once.
create unique index if not exists notifications_recipient_event_key
  on public.notifications (recipient_id, event_id) where event_id is not null;
create index if not exists notifications_promo_recent_idx
  on public.notifications (recipient_id, created_at) where category = 'promo';

-- =====================================================================
-- 4. PRICES: best live offer, list_products, place_order
-- =====================================================================
-- Best live offer price of a product for a tier ('retail' | 'wholesale').
create or replace function public.best_offer(p_product uuid, p_tier text)
returns table (offer_id uuid, offer_price numeric, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id,
         case when p_tier = 'wholesale'
              then least(coalesce(oi.offer_wholesale_price, pr.wholesale_price), oi.offer_price)
              else oi.offer_price end,
         o.ends_at
  from public.offer_items oi
  join public.offers o on o.id = oi.offer_id
  join public.products pr on pr.id = oi.product_id
  where oi.product_id = p_product
    and o.active and o.cancelled_at is null
    and now() >= o.starts_at and now() < o.ends_at
  order by 2 asc, o.ends_at asc
  limit 1
$$;

drop function if exists public.list_products();
-- Same columns as v1 (in the same order) + regular_price, offer_price,
-- offer_id, offer_ends_at. `price` is now the CURRENT price (offer included).
create function public.list_products()
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
         case when t.tier = 'guest' then null
              when b.offer_price < r.regular then b.offer_price else r.regular end,
         case when t.tier = 'admin' then p.retail_price end,
         case when t.tier = 'admin' then p.wholesale_price end,
         case when t.tier = 'admin' then p.stock end,
         p.active, p.created_at, p.updated_at,
         case when t.tier = 'guest' then null else r.regular end,
         case when t.tier <> 'guest' and b.offer_price < r.regular then b.offer_price end,
         case when b.offer_price < r.regular then b.offer_id end,
         case when b.offer_price < r.regular then b.ends_at end
  from public.products p
  cross join t
  cross join lateral (select case when t.tier = 'wholesale' then p.wholesale_price else p.retail_price end as regular) r
  left join lateral public.best_offer(p.id, case when t.tier = 'wholesale' then 'wholesale' else 'retail' end) b on true
  where p.active or t.tier = 'admin'
  order by p.created_at desc
$$;

-- Same as before, except the unit price is the currently valid price
-- (offer included) and the line remembers the offer.
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

  perform public.notify_admins('new_order', jsonb_build_object(
    'order_id', v_order, 'order_number', v_number, 'total', v_total,
    'name', coalesce(nullif(v_business, ''), trim(p_delivery->>'name')),
    'tier', v_tier));

  return jsonb_build_object('id', v_order, 'order_number', v_number, 'total', v_total);
end $$;

-- Live offers for the customer "Ofertat e Momentit" screen (one row per
-- offered product). Prices only for logged-in users and only for their tier.
create or replace function public.list_offers()
returns table (
  offer_id uuid, title_sq text, title_en text, description_sq text, description_en text,
  starts_at timestamptz, ends_at timestamptz,
  product_id uuid, sku text, name text, name_en text, images text[], unit text, in_stock boolean,
  regular_price numeric, offer_price numeric, discount_percent integer)
language sql stable security definer set search_path = '' as $$
  with t as (select public.price_tier() as tier)
  select o.id, o.title_sq, o.title_en, o.description_sq, o.description_en, o.starts_at, o.ends_at,
         p.id, p.sku, p.name, p.name_en, p.images, p.unit, p.stock > 0,
         case when t.tier = 'guest' then null else x.regular end,
         case when t.tier = 'guest' then null else x.offer end,
         case when t.tier = 'guest' or x.regular <= 0 then null
              else round(100 * (x.regular - x.offer) / x.regular)::integer end
  from public.offers o
  join public.offer_items oi on oi.offer_id = o.id
  join public.products p on p.id = oi.product_id and p.active
  cross join t
  cross join lateral (
    select case when t.tier = 'wholesale' then p.wholesale_price else p.retail_price end as regular,
           case when t.tier = 'wholesale'
                then least(coalesce(oi.offer_wholesale_price, p.wholesale_price), oi.offer_price)
                else oi.offer_price end as offer) x
  where o.active and o.cancelled_at is null and now() >= o.starts_at and now() < o.ends_at
    and (t.tier = 'guest' or x.offer < x.regular)
  order by o.ends_at, o.created_at, p.name
$$;

-- =====================================================================
-- 5. EVENT RECORDING (internal)
-- =====================================================================
create or replace function public.promo_queue_new_product(p_product uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.promo_events (kind, product_id, dedupe_key)
  values ('new_product', p_product, 'new_product:' || p_product)
  on conflict (dedupe_key) do nothing;
  update public.products set announced_at = now() where id = p_product and announced_at is null;
end $$;

create or replace function public.promo_queue_price(p_product uuid, r_old numeric, r_new numeric, w_old numeric, w_new numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.promo_events%rowtype;
begin
  select * into e from public.promo_events
   where product_id = p_product and kind = 'price' and status = 'pending' for update;
  if found then
    -- Merge: keep the first old prices, take the latest new prices.
    update public.promo_events
       set data = data || jsonb_build_object('retail_new', r_new, 'wholesale_new', w_new),
           status = case when (data->>'retail_old')::numeric = r_new
                          and (data->>'wholesale_old')::numeric = w_new then 'skipped' else 'pending' end,
           processed_at = case when (data->>'retail_old')::numeric = r_new
                                and (data->>'wholesale_old')::numeric = w_new then now() end,
           updated_at = now()
     where id = e.id;
  else
    insert into public.promo_events (kind, product_id, data)
    values ('price', p_product, jsonb_build_object('retail_old', r_old, 'retail_new', r_new,
                                                   'wholesale_old', w_old, 'wholesale_new', w_new));
  end if;
end $$;

-- Products are written only by admin_save_product (PC panel and Android
-- admin both use it), so this trigger covers both admin interfaces.
create or replace function public.products_promo_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.active then perform public.promo_queue_new_product(new.id); end if;
    return null;
  end if;
  if new.active and new.announced_at is null then
    perform public.promo_queue_new_product(new.id);           -- first publication
  elsif new.active and old.active
        and (new.retail_price <> old.retail_price or new.wholesale_price <> old.wholesale_price) then
    perform public.promo_queue_price(new.id, old.retail_price, new.retail_price, old.wholesale_price, new.wholesale_price);
  end if;
  return null;
end $$;

drop trigger if exists products_promo on public.products;
create trigger products_promo after insert or update of active, retail_price, wholesale_price on public.products
  for each row execute function public.products_promo_trigger();

-- Offers that have become live get ONE "offer" event, ever (dedupe_key).
-- Called every minute by the scheduler, by the Edge Function and after
-- admins save/activate an offer.
create or replace function public.process_offer_activations()
returns integer language plpgsql security definer set search_path = '' as $$
declare o record; n integer := 0;
begin
  for o in
    select * from public.offers f
     where f.active and f.cancelled_at is null and f.activation_notified_at is null
       and now() >= f.starts_at and now() < f.ends_at
       and exists (select 1 from public.offer_items i where i.offer_id = f.id)
     for update skip locked
  loop
    insert into public.promo_events (kind, offer_id, dedupe_key)
    values ('offer', o.id, 'offer:' || o.id)
    on conflict (dedupe_key) do nothing;
    update public.offers set activation_notified_at = now() where id = o.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- =====================================================================
-- 6. FAN-OUT (service role / scheduler only)
-- =====================================================================
create or replace function public.promo_fanout(p_limit integer default 20)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  s public.promo_settings%rowtype;
  e public.promo_events%rowtype;
  n integer;
  total integer := 0;
begin
  select * into s from public.promo_settings where id;
  for e in
    select * from public.promo_events
     where status = 'pending' and updated_at <= now() - make_interval(mins => s.debounce_minutes)
     order by created_at
     limit greatest(least(p_limit, 200), 1)
     for update skip locked
  loop
    if not s.enabled then
      update public.promo_events set status = 'suppressed', processed_at = now() where id = e.id;
      continue;
    end if;
    -- The thing announced must still be live.
    if (e.kind in ('new_product', 'price') and not exists (select 1 from public.products where id = e.product_id and active))
       or (e.kind = 'offer' and not exists (select 1 from public.offers o where o.id = e.offer_id and o.active
                                             and o.cancelled_at is null and now() >= o.starts_at and now() < o.ends_at)) then
      update public.promo_events set status = 'skipped', processed_at = now() where id = e.id;
      continue;
    end if;

    insert into public.notifications (recipient_id, type, data, category, event_id)
    select r.id, r.type, r.data, 'promo', e.id
    from (
      select p.id,
             case e.kind when 'new_product' then 'promo_new_product'
                         when 'offer' then 'promo_offer'
                         else case when x.new_p < x.old_p then 'promo_price_down' else 'promo_price_up' end end as type,
             case e.kind
               when 'new_product' then jsonb_build_object('product_id', pr.id, 'name', pr.name, 'name_en', pr.name_en)
               when 'offer' then jsonb_build_object('offer_id', ofr.id, 'title', ofr.title_sq, 'title_en', ofr.title_en)
               -- Only the recipient's OWN tier prices: retail customers never see wholesale prices.
               else jsonb_build_object('product_id', pr.id, 'name', pr.name, 'name_en', pr.name_en,
                                       'old', x.old_p, 'new', x.new_p) end as data,
             x.old_p, x.new_p
      from public.profiles p
      cross join lateral (select case when p.role <> 'admin' and p.wholesale_status = 'approved'
                                      then 'wholesale' else 'retail' end as tier) tt
      cross join lateral (
        select case when tt.tier = 'wholesale' then (e.data->>'wholesale_old')::numeric else (e.data->>'retail_old')::numeric end as old_p,
               case when tt.tier = 'wholesale' then (e.data->>'wholesale_new')::numeric else (e.data->>'retail_new')::numeric end as new_p) x
      left join public.products pr on pr.id = e.product_id
      left join public.offers ofr on ofr.id = e.offer_id
      where (p.role <> 'admin' or p.promo_tester)
        and (not s.test_only or p.promo_tester)
        and case e.kind when 'new_product' then p.promo_new_products
                        when 'offer' then p.promo_offers
                        else p.promo_price_changes end
        and exists (select 1 from public.push_tokens t where t.user_id = p.id)
        and (select count(*) from public.notifications nn
              where nn.recipient_id = p.id and nn.category = 'promo'
                and nn.created_at > now() - interval '24 hours') < s.daily_cap
        and (e.kind <> 'price' or x.new_p is distinct from x.old_p)
    ) r
    on conflict (recipient_id, event_id) where event_id is not null do nothing;
    get diagnostics n = row_count;

    update public.promo_events set status = 'sent', recipients = n, processed_at = now() where id = e.id;
    total := total + n;
  end loop;
  return total;
end $$;

-- =====================================================================
-- 7. CUSTOMER + ADMIN FUNCTIONS
-- =====================================================================
create or replace function public.set_my_promo_preferences(p_new_products boolean, p_offers boolean, p_price_changes boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  update public.profiles
     set promo_new_products = coalesce(p_new_products, promo_new_products),
         promo_offers = coalesce(p_offers, promo_offers),
         promo_price_changes = coalesce(p_price_changes, promo_price_changes)
   where id = auth.uid();
end $$;

-- Offers with their computed state, for both admin interfaces.
create or replace function public.admin_list_offers()
returns table (id uuid, title_sq text, title_en text, description_sq text, description_en text,
               starts_at timestamptz, ends_at timestamptz, active boolean, cancelled_at timestamptz,
               activation_notified_at timestamptz, created_at timestamptz, state text, items jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  return query
  select o.id, o.title_sq, o.title_en, o.description_sq, o.description_en, o.starts_at, o.ends_at,
         o.active, o.cancelled_at, o.activation_notified_at, o.created_at,
         case when o.cancelled_at is not null then 'cancelled'
              when not o.active then 'inactive'
              when now() < o.starts_at then 'scheduled'
              when now() >= o.ends_at then 'expired'
              else 'live' end,
         coalesce((select jsonb_agg(jsonb_build_object(
                    'product_id', p.id, 'sku', p.sku, 'name', p.name, 'images', p.images,
                    'retail_price', p.retail_price, 'wholesale_price', p.wholesale_price,
                    'offer_price', i.offer_price, 'offer_wholesale_price', i.offer_wholesale_price) order by p.name)
                   from public.offer_items i join public.products p on p.id = i.product_id
                   where i.offer_id = o.id), '[]'::jsonb)
  from public.offers o
  order by o.cancelled_at nulls first, o.starts_at desc;
end $$;

-- Create (no id) or update an offer with its products and prices.
-- p: {id?, title_sq, title_en, description_sq, description_en, starts_at, ends_at, active,
--     items: [{product_id, offer_price, offer_wholesale_price?}]}
create or replace function public.admin_save_offer(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  it jsonb;
  v_pr public.products%rowtype;
  v_op numeric;
  v_ow numeric;
begin
  perform public.assert_admin();
  v_id := nullif(p->>'id', '')::uuid;
  if coalesce(trim(p->>'title_sq'), '') = '' then raise exception 'OFFER_TITLE_REQUIRED'; end if;
  v_start := nullif(p->>'starts_at', '')::timestamptz;
  v_end := nullif(p->>'ends_at', '')::timestamptz;
  if v_start is null or v_end is null or v_end <= v_start then raise exception 'INVALID_OFFER_DATES'; end if;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'OFFER_ITEMS_REQUIRED';
  end if;
  if jsonb_array_length(p->'items') > 500 then raise exception 'OFFER_ITEMS_REQUIRED'; end if;

  if v_id is null then
    insert into public.offers (title_sq, title_en, description_sq, description_en, starts_at, ends_at, active, created_by)
    values (left(trim(p->>'title_sq'), 200), left(coalesce(trim(p->>'title_en'), ''), 200),
            left(coalesce(p->>'description_sq', ''), 2000), left(coalesce(p->>'description_en', ''), 2000),
            v_start, v_end, coalesce((p->>'active')::boolean, true), auth.uid())
    returning id into v_id;
  else
    if exists (select 1 from public.offers where id = v_id and cancelled_at is not null) then
      raise exception 'OFFER_CANCELLED';
    end if;
    update public.offers
       set title_sq = left(trim(p->>'title_sq'), 200), title_en = left(coalesce(trim(p->>'title_en'), ''), 200),
           description_sq = left(coalesce(p->>'description_sq', ''), 2000),
           description_en = left(coalesce(p->>'description_en', ''), 2000),
           starts_at = v_start, ends_at = v_end, active = coalesce((p->>'active')::boolean, active)
     where id = v_id;
    if not found then raise exception 'NOT_FOUND'; end if;
  end if;

  delete from public.offer_items where offer_id = v_id;
  for it in select * from jsonb_array_elements(p->'items') loop
    select * into v_pr from public.products where id = nullif(it->>'product_id', '')::uuid;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    v_op := nullif(it->>'offer_price', '')::numeric;
    v_ow := nullif(it->>'offer_wholesale_price', '')::numeric;
    -- A promotional price must be lower than the regular price.
    if v_op is null or v_op < 0 or v_op >= v_pr.retail_price then
      raise exception 'INVALID_OFFER_PRICE %', v_pr.sku;
    end if;
    if v_ow is not null and (v_ow < 0 or v_ow >= v_pr.wholesale_price) then
      raise exception 'INVALID_OFFER_PRICE %', v_pr.sku;
    end if;
    insert into public.offer_items (offer_id, product_id, offer_price, offer_wholesale_price)
    values (v_id, v_pr.id, v_op, v_ow)
    on conflict (offer_id, product_id) do update
      set offer_price = excluded.offer_price, offer_wholesale_price = excluded.offer_wholesale_price;
  end loop;

  perform public.process_offer_activations();
  return v_id;
end $$;

create or replace function public.admin_set_offer_active(p_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  if exists (select 1 from public.offers where id = p_id and cancelled_at is not null) then
    raise exception 'OFFER_CANCELLED';
  end if;
  update public.offers set active = p_active where id = p_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  perform public.process_offer_activations();
end $$;

-- Cancelling is final (the offer stays in the database for the record).
create or replace function public.admin_cancel_offer(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  update public.offers set active = false, cancelled_at = coalesce(cancelled_at, now()) where id = p_id;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

create or replace function public.admin_get_promo_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.promo_settings%rowtype;
begin
  perform public.assert_admin();
  select * into s from public.promo_settings where id;
  return jsonb_build_object(
    'enabled', s.enabled, 'test_only', s.test_only, 'daily_cap', s.daily_cap,
    'debounce_minutes', s.debounce_minutes, 'functions_url', s.functions_url,
    'testers', (select count(*) from public.profiles where promo_tester),
    'opted_in', (select count(*) from public.profiles
                  where role <> 'admin' and (promo_new_products or promo_offers or promo_price_changes)),
    'pending_events', (select count(*) from public.promo_events where status = 'pending'),
    'events', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select e.id, e.kind, e.status, e.recipients, e.created_at, e.processed_at,
               coalesce(pr.name, o.title_sq) as subject, e.data
        from public.promo_events e
        left join public.products pr on pr.id = e.product_id
        left join public.offers o on o.id = e.offer_id
        order by e.created_at desc limit 30) x), '[]'::jsonb));
end $$;

create or replace function public.admin_set_promo_settings(p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  if p ? 'functions_url' and coalesce(p->>'functions_url', '') <> ''
     and (p->>'functions_url') !~ '^https://[a-z0-9-]+\.supabase\.co/functions/v1/?$' then
    raise exception 'INVALID_FUNCTIONS_URL';
  end if;
  update public.promo_settings set
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    test_only = coalesce((p->>'test_only')::boolean, test_only),
    daily_cap = coalesce((p->>'daily_cap')::integer, daily_cap),
    debounce_minutes = coalesce((p->>'debounce_minutes')::integer, debounce_minutes),
    functions_url = coalesce(rtrim(p->>'functions_url', '/'), functions_url),
    updated_at = now()
  where id;
end $$;

create or replace function public.admin_set_promo_tester(p_user uuid, p_tester boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  update public.profiles set promo_tester = p_tester where id = p_user;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

-- =====================================================================
-- 8. SECURITY: RLS and privileges for the new objects only
-- =====================================================================
alter table public.offers enable row level security;
alter table public.offer_items enable row level security;
alter table public.promo_events enable row level security;
alter table public.promo_settings enable row level security;
revoke all on public.offers, public.offer_items, public.promo_events, public.promo_settings
  from public, anon, authenticated;
-- No direct API access to offers/events/settings: customers use list_offers(),
-- admins use the admin_* functions above.

do $$
declare f text;
begin
  foreach f in array array[
    'public.best_offer(uuid, text)', 'public.list_products()', 'public.place_order(jsonb, jsonb)',
    'public.list_offers()', 'public.promo_queue_new_product(uuid)',
    'public.promo_queue_price(uuid, numeric, numeric, numeric, numeric)', 'public.products_promo_trigger()',
    'public.process_offer_activations()', 'public.promo_fanout(integer)',
    'public.set_my_promo_preferences(boolean, boolean, boolean)', 'public.admin_list_offers()',
    'public.admin_save_offer(jsonb)', 'public.admin_set_offer_active(uuid, boolean)',
    'public.admin_cancel_offer(uuid)', 'public.admin_get_promo_settings()',
    'public.admin_set_promo_settings(jsonb)', 'public.admin_set_promo_tester(uuid, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function public.list_products() to anon, authenticated;
grant execute on function public.list_offers() to anon, authenticated;
grant execute on function public.place_order(jsonb, jsonb) to authenticated;
grant execute on function public.set_my_promo_preferences(boolean, boolean, boolean) to authenticated;
grant execute on function public.admin_list_offers() to authenticated;
grant execute on function public.admin_save_offer(jsonb) to authenticated;
grant execute on function public.admin_set_offer_active(uuid, boolean) to authenticated;
grant execute on function public.admin_cancel_offer(uuid) to authenticated;
grant execute on function public.admin_get_promo_settings() to authenticated;
grant execute on function public.admin_set_promo_settings(jsonb) to authenticated;
grant execute on function public.admin_set_promo_tester(uuid, boolean) to authenticated;
grant execute on function public.process_offer_activations() to service_role;
grant execute on function public.promo_fanout(integer) to service_role;

-- =====================================================================
-- 9. SCHEDULER (pg_cron, if available): every minute
--    * record offers that just became live and fan out waiting events
--    * call the Edge Function to deliver (needs promo_settings.functions_url)
-- =====================================================================
-- Optional: if pg_cron / pg_net cannot be enabled here, the rest of the
-- migration still succeeds (offers start/expire on time anyway; activation
-- notifications are then recorded whenever the Edge Function runs).
do $$
begin
  begin
    if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
      create extension if not exists pg_cron;               -- always installs into pg_catalog / schema "cron"
      perform cron.schedule('eko-promo-minutely', '* * * * *',
        'select public.process_offer_activations(), public.promo_fanout(20)');
      if exists (select 1 from pg_available_extensions where name = 'pg_net') then
        create extension if not exists pg_net with schema extensions;   -- not in "public"
        -- Does nothing until an admin saves functions_url (validated by
        -- admin_set_promo_settings: https://<ref>.supabase.co/functions/v1).
        -- The request carries no key: dispatch-notifications takes no input and
        -- only delivers what the database has already queued.
        perform cron.schedule('eko-dispatch-minutely', '* * * * *',
          $c$select net.http_post(url := s.functions_url || '/dispatch-notifications',
                                  body := '{}'::jsonb,
                                  headers := '{"Content-Type": "application/json"}'::jsonb,
                                  timeout_milliseconds := 30000)
             from public.promo_settings s where s.id and s.functions_url ~ '^https?://'$c$);
      end if;
      -- Keep the scheduler's own run log small (only the eko-* jobs' entries,
      -- older than 7 days; no business data).
      perform cron.schedule('eko-cron-log-cleanup', '17 3 * * *',
        $c$delete from cron.job_run_details
            where end_time < now() - interval '7 days'
              and jobid in (select jobid from cron.job where jobname like 'eko-%')$c$);
    else
      raise notice 'pg_cron not available: offers still start/expire on time; activation notifications are recorded when the Edge Function runs.';
    end if;
  exception when others then
    raise notice 'Scheduler not set up (%). Everything else is installed. Enable pg_cron and pg_net in Database > Extensions and run this file again.', sqlerrm;
  end;
end $$;

notify pgrst, 'reload schema';

commit;
