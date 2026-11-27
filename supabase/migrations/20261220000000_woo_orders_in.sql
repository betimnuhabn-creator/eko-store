-- =====================================================================
-- EKO Store — orders placed on the WEBSITE (eko-store.com) appear in the app
-- File: supabase/migrations/20261220000000_woo_orders_in.sql
--
-- * WooCommerce webhook "Order created / updated" → Edge Function woo-sync →
--   woo_import_order(): the website order is created in the app (panel →
--   Porositë and Admin → Porositë on the phone, marked "Nga faqja"), the
--   administrators get the usual "new order" notification.
-- * The customer is linked by e-mail: a customer with an app account with the
--   same e-mail sees the order in "Porositë e mia" and gets the status
--   notifications. Otherwise the order has no app customer (like a guest).
-- * Status in both directions: a change in WooCommerce changes the app order
--   (processing → open, completed → delivered, cancelled/refunded/failed →
--   cancelled); a change in the app panel is sent to WooCommerce (as for app
--   orders). No loops: a change that came from WooCommerce is not sent back.
-- * Only orders created/changed after this migration are imported (the
--   hourly check also catches webhooks that did not arrive).
-- * One transaction; safe to run more than once; no existing row is changed.
-- =====================================================================

begin;

set local lock_timeout = '10s';

do $$
begin
  if to_regclass('public.woo_order_jobs') is null or to_regprocedure('public.notify_admins(text, jsonb)') is null then
    raise exception 'Run 20261215000000_woocommerce_sync.sql first. Nothing was changed.';
  end if;
end $$;

alter table public.orders add column if not exists source text not null default 'app';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_source_check') then
    alter table public.orders add constraint orders_source_check check (source in ('app', 'woo'));
  end if;
end $$;
create unique index if not exists orders_woo_order_id_key on public.orders (woo_order_id) where woo_order_id is not null;

alter table public.woo_settings add column if not exists orders_polled_at timestamptz;
update public.woo_settings set orders_polled_at = now() where id and orders_polled_at is null;   -- from now on

-- App status for a WooCommerce status, given the current app status
-- (null = no change: the app keeps its more detailed status).
create or replace function public.woo_status_to_app(p_current text, p_woo text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_woo in ('pending', 'on-hold', 'processing') then
      case when p_current in ('new', 'confirmed', 'preparing', 'shipped', 'accepted') then null else 'new' end
    when p_woo = 'completed' then
      case when p_current in ('delivered', 'completed') then null else 'delivered' end
    when p_woo in ('cancelled', 'refunded', 'failed') then
      case when p_current = 'cancelled' then null else 'cancelled' end
    else null end
$$;

-- p: { woo_order_id, app_order_number?, status, created_at, email, name, phone,
--      address, city, note, payment_method, total,
--      lines: [{ woo_product_id, woo_variation_id, name, sku, quantity, unit_price }] }
-- app_order_number set = a copy of an app order → only its status is taken over.
create or replace function public.woo_import_order(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.orders%rowtype;
  v_new text;
  v_customer uuid;
  v_tier text := 'retail';
  v_order uuid;
  v_number bigint;
  v_total numeric := 0;
  v_count integer := 0;
  v_lines numeric := 0;
  l jsonb;
  v_pid uuid;
  v_qty integer;
  v_price numeric;
  v_woo bigint := nullif(p->>'woo_order_id', '')::bigint;
  v_status text := coalesce(p->>'status', '');
begin
  if v_woo is null then raise exception 'INVALID_INPUT'; end if;
  perform set_config('eko.from_woo', 'on', true);   -- this transaction: do not send the change back

  -- an order already in the app (website order imported before, or an app order copied to the website)
  if nullif(p->>'app_order_number', '') is not null then
    select * into v from public.orders where order_number = (p->>'app_order_number')::bigint and source = 'app' for update;
  else
    select * into v from public.orders where woo_order_id = v_woo for update;
  end if;
  if found then
    v_new := public.woo_status_to_app(v.status, v_status);
    if v_new is null or v.archived_at is not null then return jsonb_build_object('action', 'unchanged', 'order_id', v.id); end if;
    update public.orders set status = v_new where id = v.id;
    if v.customer_id is not null then
      perform public.notify_user(v.customer_id, 'order_status',
        jsonb_build_object('order_id', v.id, 'order_number', v.order_number, 'status', v_new));
    end if;
    return jsonb_build_object('action', 'status', 'order_id', v.id, 'status', v_new);
  end if;
  if nullif(p->>'app_order_number', '') is not null then
    return jsonb_build_object('action', 'unknown_app_order');
  end if;

  -- a NEW website order (drafts, failed and cancelled ones are not imported)
  if v_status not in ('pending', 'on-hold', 'processing', 'completed') then
    return jsonb_build_object('action', 'skipped', 'status', v_status);
  end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') = 0 then
    return jsonb_build_object('action', 'skipped', 'reason', 'no_lines');
  end if;

  select id, case when wholesale_status = 'approved' then 'wholesale' else 'retail' end
    into v_customer, v_tier
    from public.profiles
   where role <> 'admin' and lower(email) = lower(nullif(trim(p->>'email'), ''))
   limit 1;
  v_tier := coalesce(v_tier, 'retail');

  insert into public.orders (customer_id, status, total, item_count, price_tier, payment_method,
    delivery_name, delivery_phone, delivery_address, delivery_city, customer_note, source, woo_order_id, created_at)
  values (v_customer, case when v_status = 'completed' then 'delivered' else 'new' end, 0, 0, v_tier,
    case when p->>'payment_method' = 'bacs' then 'bank_transfer' else 'cash_on_delivery' end,
    left(coalesce(nullif(trim(p->>'name'), ''), '—'), 200), left(coalesce(nullif(trim(p->>'phone'), ''), '—'), 50),
    left(coalesce(nullif(trim(p->>'address'), ''), '—'), 500), left(coalesce(nullif(trim(p->>'city'), ''), '—'), 100),
    left(concat_ws(E'\n', 'Porosi nga faqja eko-store.com #' || v_woo, nullif(trim(p->>'note'), '')), 1000),
    'woo', v_woo, coalesce(nullif(p->>'created_at', '')::timestamptz, now()))
  returning id, order_number into v_order, v_number;

  for l in select * from jsonb_array_elements(p->'lines') loop
    v_qty := greatest(coalesce((l->>'quantity')::integer, 1), 1);
    v_price := round(coalesce((l->>'unit_price')::numeric, 0), 2);
    v_pid := null;
    if coalesce(nullif(l->>'woo_variation_id', '')::bigint, 0) > 0 then
      select id into v_pid from public.products where woo_id = (l->>'woo_variation_id')::bigint;
    end if;
    if v_pid is null and coalesce(nullif(l->>'woo_product_id', '')::bigint, 0) > 0 then
      select id into v_pid from public.products where woo_id = (l->>'woo_product_id')::bigint;
    end if;
    insert into public.order_items (order_id, product_id, quantity, unit_price, product_name, sku, unit)
    values (v_order, v_pid, v_qty, v_price, left(coalesce(nullif(l->>'name', ''), '—'), 300),
            left(coalesce(l->>'sku', ''), 100), coalesce((select unit from public.products where id = v_pid), 'copë'));
    v_lines := v_lines + v_qty * v_price;
    v_count := v_count + v_qty;
  end loop;

  -- shipping, fees or coupons: one line so that the order total matches the website
  v_total := round(coalesce(nullif(p->>'total', '')::numeric, v_lines), 2);
  if abs(v_total - v_lines) >= 0.01 then
    insert into public.order_items (order_id, product_id, quantity, unit_price, product_name, sku, unit)
    values (v_order, null, 1, v_total - v_lines,
            case when v_total > v_lines then 'Transport / tarifa (faqja)' else 'Zbritje (faqja)' end, '', '');
  end if;
  update public.orders set total = v_total, item_count = v_count where id = v_order;

  perform public.notify_admins('new_order', jsonb_build_object(
    'order_id', v_order, 'order_number', v_number, 'total', v_total,
    'name', coalesce(nullif(trim(p->>'name'), ''), 'eko-store.com'), 'tier', v_tier, 'source', 'woo'));
  return jsonb_build_object('action', 'created', 'order_id', v_order, 'order_number', v_number);
end $$;

-- When to look for website orders again (hourly check).
create or replace function public.woo_orders_polled(p_at timestamptz)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare prev timestamptz;
begin
  select orders_polled_at into prev from public.woo_settings where id;
  if p_at is not null then update public.woo_settings set orders_polled_at = p_at where id; end if;
  return prev;
end $$;

-- Status changes made in the app follow the website copy — for app orders
-- copied to the website AND for website orders; never for a change that
-- itself came from the website.
create or replace function public.woo_order_status_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('eko.from_woo', true), '') = 'on' then return null; end if;
  if new.status is distinct from old.status
     and (exists (select 1 from public.woo_order_jobs j where j.order_id = new.id and j.kind = 'create')
          or (new.source = 'woo' and new.woo_order_id is not null))
     and not exists (select 1 from public.woo_order_jobs j where j.order_id = new.id and j.kind = 'status' and j.status = 'pending') then
    insert into public.woo_order_jobs (order_id, kind) values (new.id, 'status');
  end if;
  return null;
end $$;

-- the scheduler also runs when the hourly order check is due
create or replace function public.woo_dispatch()
returns bigint language plpgsql security definer set search_path = '' as $$
declare u text; rid bigint;
begin
  select functions_url into u from public.promo_settings where id;
  if not public.promo_functions_url_valid(u) or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return null;
  end if;
  if not exists (select 1 from public.woo_order_jobs where status = 'pending') and public.woo_full_sync_due() = 'no' then
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, '
       || 'headers := ''{"Content-Type": "application/json"}''::jsonb, timeout_milliseconds := 60000)'
     into rid using u || '/woo-sync';
  update public.woo_settings set request_id = rid where id;
  return rid;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.woo_import_order(jsonb)', 'public.woo_orders_polled(timestamptz)',
                           'public.woo_order_status_trigger()', 'public.woo_dispatch()', 'public.woo_status_to_app(text, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function public.woo_import_order(jsonb) to service_role;
grant execute on function public.woo_orders_polled(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
