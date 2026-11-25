-- =====================================================================
-- EKO Store — website orders: administrators are notified when an order is
-- CANCELLED on the website (WooCommerce → Orders → Cancelled / Refunded / Failed),
-- with the same "Porosia #… u anulua" notification as a cancellation in the app.
-- File: supabase/migrations/20261222000000_woo_order_cancel_notify.sql
-- Only woo_import_order() changes; one transaction; safe to run more than once.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.woo_import_order(jsonb)') is null then
    raise exception 'Run 20261220000000_woo_orders_in.sql first. Nothing was changed.';
  end if;
end $$;

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
    if v_new = 'cancelled' then   -- cancelled on the website: the administrators are told, as when a customer cancels in the app
      perform public.notify_admins('order_cancelled', jsonb_build_object(
        'order_id', v.id, 'order_number', v.order_number, 'name', v.delivery_name, 'source', 'woo'));
    end if;
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

revoke all on function public.woo_import_order(jsonb) from public, anon, authenticated;
grant execute on function public.woo_import_order(jsonb) to service_role;

commit;
