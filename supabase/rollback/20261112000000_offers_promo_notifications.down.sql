-- =====================================================================
-- EKO Store — ROLLBACK of 20261112000000_offers_promo_notifications.sql
--
-- Restores the database API and schema to EXACTLY the state after
--   20261105000000_eko_store_v1.sql + 20261110000000_order_cancel_archive.sql
-- (the state APK 1.2.0 and the PC panel already handle: offers and promo
-- settings show "migration required"; everything else works as before).
--
-- * Pre-existing data is NOT touched: products, prices, customers, orders,
--   archived orders, order lines and notifications keep every row and value.
-- * Orders placed while the migration was active stay (with their prices).
-- * Data that only exists because of the migration (offers, offer products,
--   promo settings/events, customers' promo opt-ins, which offer priced an
--   order line, notification category) is first COPIED into the private
--   schema eko_rollback_backup (not reachable through the API), then removed.
-- * Undelivered promotional notifications are marked as handled (not deleted)
--   and the scheduler jobs are removed: nothing is sent after the rollback.
-- * One transaction; safe to run more than once; does nothing harmful if the
--   offers migration was never applied.
-- * The extensions pg_cron / pg_net are left installed (harmless, no jobs).
-- =====================================================================

begin;

set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public.assert_admin()') is null
     or to_regprocedure('public.admin_archive_order(uuid)') is null then
    raise exception 'This is not an EKO Store database with the v1 + order-archive migrations. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Stop: no promotional notification can be sent from now on
-- ---------------------------------------------------------------------
do $$
declare j record;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'notifications' and column_name = 'category') then
    update public.notifications
       set dispatched_at = now(), claimed_at = null, claim_token = null
     where category = 'promo' and dispatched_at is null;
  end if;
  if to_regclass('cron.job') is not null then
    for j in select jobname from cron.job
              where jobname in ('eko-promo-minutely', 'eko-dispatch-minutely', 'eko-cron-log-cleanup') loop
      perform cron.unschedule(j.jobname);
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Keep a private copy of everything the rollback removes
-- ---------------------------------------------------------------------
create schema if not exists eko_rollback_backup;
revoke all on schema eko_rollback_backup from public, anon, authenticated;

do $$
declare
  sfx text := to_char(clock_timestamp(), 'YYYYMMDD_HH24MISS');
  t text;
  col_exists boolean;
begin
  foreach t in array array['offers', 'offer_items', 'promo_events', 'promo_settings'] loop
    if to_regclass('public.' || t) is not null then
      execute format('create table eko_rollback_backup.%I as table public.%I', t || '_' || sfx, t);
    end if;
  end loop;

  select exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'profiles' and column_name = 'promo_new_products') into col_exists;
  if col_exists then
    execute format('create table eko_rollback_backup.%I as
      select id, promo_new_products, promo_offers, promo_price_changes, promo_tester from public.profiles
       where promo_new_products or promo_offers or promo_price_changes or promo_tester', 'profiles_promo_' || sfx);
  end if;

  select exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'order_items' and column_name = 'offer_id') into col_exists;
  if col_exists then
    execute format('create table eko_rollback_backup.%I as
      select id, order_id, product_id, offer_id from public.order_items where offer_id is not null', 'order_items_offer_' || sfx);
  end if;

  select exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'notifications' and column_name = 'category') into col_exists;
  if col_exists then
    execute format('create table eko_rollback_backup.%I as
      select id, category, event_id from public.notifications where category <> ''order'' or event_id is not null',
      'notifications_promo_' || sfx);
  end if;

  select exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'products' and column_name = 'announced_at') into col_exists;
  if col_exists then
    execute format('create table eko_rollback_backup.%I as select id, announced_at from public.products', 'products_announced_' || sfx);
  end if;

  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'eko_rollback_backup' and c.relkind = 'r' loop
    execute format('revoke all on eko_rollback_backup.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Previous versions of list_products() and place_order() (v1, verbatim)
-- ---------------------------------------------------------------------
drop function if exists public.list_products();

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

revoke all on function public.list_products() from public, anon, authenticated;
revoke all on function public.place_order(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.list_products() to anon, authenticated;
grant execute on function public.place_order(jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Remove the offers / promotion objects
-- ---------------------------------------------------------------------
drop trigger if exists products_promo on public.products;

drop function if exists public.list_offers();
drop function if exists public.best_offer(uuid, text);
drop function if exists public.promo_queue_new_product(uuid);
drop function if exists public.promo_queue_price(uuid, numeric, numeric, numeric, numeric);
drop function if exists public.products_promo_trigger();
drop function if exists public.process_offer_activations();
drop function if exists public.promo_fanout(integer);
drop function if exists public.promo_dispatch();
drop function if exists public.promo_dispatch_status();
drop function if exists public.set_my_promo_preferences(boolean, boolean, boolean);
drop function if exists public.admin_list_offers();
drop function if exists public.admin_save_offer(jsonb);
drop function if exists public.admin_set_offer_active(uuid, boolean);
drop function if exists public.admin_cancel_offer(uuid);
drop function if exists public.admin_get_promo_settings();
drop function if exists public.admin_set_promo_settings(jsonb);
drop function if exists public.admin_set_promo_tester(uuid, boolean);
drop function if exists public.promo_functions_url_valid(text);

-- Columns added by the migration (their content was copied in step 2).
alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications drop column if exists event_id;
alter table public.notifications drop column if exists category;
alter table public.order_items drop column if exists offer_id;
alter table public.products drop column if exists announced_at;
alter table public.profiles
  drop column if exists promo_new_products,
  drop column if exists promo_offers,
  drop column if exists promo_price_changes,
  drop column if exists promo_tester;

-- Tables added by the migration (copied in step 2).
drop table if exists public.offer_items;
drop table if exists public.promo_events;
drop table if exists public.offers;
drop table if exists public.promo_settings;

notify pgrst, 'reload schema';

commit;
