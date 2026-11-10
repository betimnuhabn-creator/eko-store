


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."admin_archive_order"("p_order" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.orders%rowtype;
begin
  perform public.assert_admin();
  select * into v from public.orders where id = p_order for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v.status <> 'cancelled' then raise exception 'ONLY_CANCELLED_CAN_BE_ARCHIVED'; end if;
  if v.archived_at is not null then return; end if;
  update public.orders set archived_at = now(), archived_by = auth.uid() where id = p_order;
end $$;


ALTER FUNCTION "public"."admin_archive_order"("p_order" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_cancel_offer"("p_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_admin();
  update public.offers set active = false, cancelled_at = coalesce(cancelled_at, now()) where id = p_id;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;


ALTER FUNCTION "public"."admin_cancel_offer"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_cancel_order"("p_order" "uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.orders%rowtype;
begin
  perform public.assert_admin();
  select * into v from public.orders where id = p_order for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v.archived_at is not null then raise exception 'ORDER_ARCHIVED'; end if;
  if v.status = 'cancelled' then return; end if;
  if v.status in ('delivered', 'completed') then raise exception 'CANNOT_CANCEL_DELIVERED'; end if;
  update public.orders
     set status = 'cancelled',
         admin_note = coalesce(nullif(left(p_note, 1000), ''), admin_note)
   where id = p_order;
  if v.customer_id is not null then
    perform public.notify_user(v.customer_id, 'order_status',
      jsonb_build_object('order_id', v.id, 'order_number', v.order_number, 'status', 'cancelled'));
  end if;
end $$;


ALTER FUNCTION "public"."admin_cancel_order"("p_order" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_category"("p_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_admin();
  delete from public.categories where id = p_id;
end $$;


ALTER FUNCTION "public"."admin_delete_category"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_product"("p_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_admin();
  delete from public.products where id = p_id;
end $$;


ALTER FUNCTION "public"."admin_delete_product"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_get_promo_settings"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare s public.promo_settings%rowtype;
begin
  perform public.assert_admin();
  select * into s from public.promo_settings where id;
  return jsonb_build_object(
    'enabled', s.enabled, 'test_only', s.test_only, 'daily_cap', s.daily_cap,
    'debounce_minutes', s.debounce_minutes, 'functions_url', s.functions_url,
    'dispatch', public.promo_dispatch_status(),
    'testers', (select count(*) from public.profiles where promo_tester),
    'opted_in', (select count(*) from public.profiles
                  where role <> 'admin' and (promo_new_products or promo_offers or promo_price_changes)),
    'pending_events', (select count(*) from public.promo_events where status = 'pending'),
    'events', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select e.id, e.kind, e.status, e.recipients, e.created_at, e.processed_at,
               coalesce(pr.name, o.title_sq) as subject, e.data, e.error
        from public.promo_events e
        left join public.products pr on pr.id = e.product_id
        left join public.offers o on o.id = e.offer_id
        order by e.created_at desc limit 30) x), '[]'::jsonb));
end $$;


ALTER FUNCTION "public"."admin_get_promo_settings"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_offers"() RETURNS TABLE("id" "uuid", "title_sq" "text", "title_en" "text", "description_sq" "text", "description_en" "text", "starts_at" timestamp with time zone, "ends_at" timestamp with time zone, "active" boolean, "cancelled_at" timestamp with time zone, "activation_notified_at" timestamp with time zone, "created_at" timestamp with time zone, "state" "text", "items" "jsonb")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_list_offers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_restore_order"("p_order" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_admin();
  update public.orders set archived_at = null, archived_by = null where id = p_order;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;


ALTER FUNCTION "public"."admin_restore_order"("p_order" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_review_wholesale"("p_user" "uuid", "p_approve" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_review_wholesale"("p_user" "uuid", "p_approve" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_save_category"("p" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_save_category"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_save_offer"("p" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_save_offer"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_save_product"("p" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."admin_save_product"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_offer_active"("p_id" "uuid", "p_active" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_admin();
  if exists (select 1 from public.offers where id = p_id and cancelled_at is not null) then
    raise exception 'OFFER_CANCELLED';
  end if;
  update public.offers set active = p_active where id = p_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  perform public.process_offer_activations();
end $$;


ALTER FUNCTION "public"."admin_set_offer_active"("p_id" "uuid", "p_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_order_status"("p_order" "uuid", "p_status" "text", "p_note" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v public.orders%rowtype;
begin
  perform public.assert_admin();
  if p_status not in ('new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled') then
    raise exception 'INVALID_STATUS';
  end if;
  select * into v from public.orders where id = p_order for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v.archived_at is not null then raise exception 'ORDER_ARCHIVED'; end if;
  update public.orders set status = p_status,
    admin_note = coalesce(left(p_note, 1000), admin_note)
  where id = p_order;
  if v.status <> p_status and v.customer_id is not null then
    perform public.notify_user(v.customer_id, 'order_status',
      jsonb_build_object('order_id', v.id, 'order_number', v.order_number, 'status', p_status));
  end if;
end $$;


ALTER FUNCTION "public"."admin_set_order_status"("p_order" "uuid", "p_status" "text", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_promo_settings"("p" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_admin();
  if p ? 'functions_url' and coalesce(p->>'functions_url', '') <> ''
     and not public.promo_functions_url_valid(rtrim(trim(p->>'functions_url'), '/')) then
    raise exception 'INVALID_FUNCTIONS_URL';
  end if;
  update public.promo_settings set
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    test_only = coalesce((p->>'test_only')::boolean, test_only),
    daily_cap = coalesce((p->>'daily_cap')::integer, daily_cap),
    debounce_minutes = coalesce((p->>'debounce_minutes')::integer, debounce_minutes),
    functions_url = coalesce(rtrim(trim(p->>'functions_url'), '/'), functions_url),
    updated_at = now()
  where id;
end $$;


ALTER FUNCTION "public"."admin_set_promo_settings"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_promo_tester"("p_user" "uuid", "p_tester" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_admin();
  update public.profiles set promo_tester = p_tester where id = p_user;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;


ALTER FUNCTION "public"."admin_set_promo_tester"("p_user" "uuid", "p_tester" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_stats"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_admin();
  return jsonb_build_object(
    'new_orders', (select count(*) from public.orders where status = 'new' and archived_at is null),
    'open_orders', (select count(*) from public.orders
                    where status in ('new','confirmed','preparing','shipped','accepted') and archived_at is null),
    'archived_orders', (select count(*) from public.orders where archived_at is not null),
    'pending_wholesale', (select count(*) from public.profiles where wholesale_status = 'pending'),
    'products', (select count(*) from public.products where active),
    'customers', (select count(*) from public.profiles where role <> 'admin'),
    'sales_30d', (select coalesce(sum(total), 0) from public.orders
                  where status <> 'cancelled' and created_at > now() - interval '30 days'));
end $$;


ALTER FUNCTION "public"."admin_stats"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_admin"() RETURNS "void"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if not public.is_admin() then raise exception 'ADMIN_ONLY'; end if;
end $$;


ALTER FUNCTION "public"."assert_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."best_offer"("p_product" "uuid", "p_tier" "text") RETURNS TABLE("offer_id" "uuid", "offer_price" numeric, "ends_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
  order by 2 asc, o.ends_at asc, o.id asc
  limit 1
$$;


ALTER FUNCTION "public"."best_offer"("p_product" "uuid", "p_tier" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_my_order"("p_order" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."cancel_my_order"("p_order" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_notifications"("p_limit" integer DEFAULT 100) RETURNS TABLE("id" "uuid", "recipient_id" "uuid", "type" "text", "data" "jsonb", "created_at" timestamp with time zone, "attempts" integer, "claim_token" "uuid", "recipient_role" "text", "recipient_email" "text", "recipient_language" "text", "push_tokens" "text"[])
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."claim_notifications"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_my_account"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  if public.is_admin() then raise exception 'ADMIN_CANNOT_DELETE'; end if;
  delete from auth.users where id = auth.uid();
end $$;


ALTER FUNCTION "public"."delete_my_account"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finish_notifications"("p_claim" "uuid", "p_delivered" "uuid"[], "p_failed" "uuid"[], "p_error" "text" DEFAULT NULL::"text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."finish_notifications"("p_claim" "uuid", "p_delivered" "uuid"[], "p_failed" "uuid"[], "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."forget_push_tokens"("p_tokens" "text"[]) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  delete from public.push_tokens where token = any(p_tokens)
$$;


ALTER FUNCTION "public"."forget_push_tokens"("p_tokens" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_offers"() RETURNS TABLE("offer_id" "uuid", "title_sq" "text", "title_en" "text", "description_sq" "text", "description_en" "text", "starts_at" timestamp with time zone, "ends_at" timestamp with time zone, "product_id" "uuid", "sku" "text", "name" "text", "name_en" "text", "images" "text"[], "unit" "text", "in_stock" boolean, "regular_price" numeric, "offer_price" numeric, "discount_percent" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
  -- A product is listed ONCE, under the offer that best_offer() picks for this
  -- customer's tier (guests: retail) and only if it is below the regular price:
  -- exactly the offer and price that list_products() shows and place_order() charges.
  cross join lateral public.best_offer(p.id, case when t.tier = 'wholesale' then 'wholesale' else 'retail' end) b
  where o.active and o.cancelled_at is null and now() >= o.starts_at and now() < o.ends_at
    and o.id = b.offer_id
    and x.offer < x.regular
  order by o.ends_at, o.created_at, p.name
$$;


ALTER FUNCTION "public"."list_offers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_products"() RETURNS TABLE("id" "uuid", "sku" "text", "name" "text", "name_en" "text", "description" "text", "description_en" "text", "category_id" "uuid", "unit" "text", "images" "text"[], "in_stock" boolean, "price" numeric, "retail_price" numeric, "wholesale_price" numeric, "stock" integer, "active" boolean, "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "regular_price" numeric, "offer_price" numeric, "offer_id" "uuid", "offer_ends_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."list_products"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  update public.notifications set read_at = now()
  where recipient_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids))
$$;


ALTER FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."new_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."new_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_admins"("p_type" "text", "p_data" "jsonb") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  insert into public.notifications (recipient_id, type, data)
  select id, p_type, p_data from public.profiles where role = 'admin'
$$;


ALTER FUNCTION "public"."notify_admins"("p_type" "text", "p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_user"("p_user" "uuid", "p_type" "text", "p_data" "jsonb") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  insert into public.notifications (recipient_id, type, data) values (p_user, p_type, p_data)
$$;


ALTER FUNCTION "public"."notify_user"("p_user" "uuid", "p_type" "text", "p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."place_order"("p_lines" "jsonb", "p_delivery" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."place_order"("p_lines" "jsonb", "p_delivery" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."price_tier"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select coalesce(
    (select case when role = 'admin' then 'admin'
                 when wholesale_status = 'approved' then 'wholesale'
                 else 'retail' end
       from public.profiles where id = auth.uid()),
    'guest')
$$;


ALTER FUNCTION "public"."price_tier"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."process_offer_activations"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."process_offer_activations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."products_promo_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."products_promo_trigger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promo_dispatch"() RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare u text; rid bigint;
begin
  select functions_url into u from public.promo_settings where id;
  if not public.promo_functions_url_valid(u) or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, '
       || 'headers := ''{"Content-Type": "application/json"}''::jsonb, timeout_milliseconds := 30000)'
     into rid using u || '/dispatch-notifications';
  update public.promo_settings set dispatch_request_id = rid where id;
  return rid;
end $_$;


ALTER FUNCTION "public"."promo_dispatch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promo_dispatch_status"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare rid bigint; r jsonb;
begin
  select dispatch_request_id into rid from public.promo_settings where id;
  if rid is null then return jsonb_build_object('state', 'not_called'); end if;
  if to_regclass('net._http_response') is null then return jsonb_build_object('state', 'no_pg_net'); end if;
  execute 'select jsonb_build_object(''state'', case when status_code between 200 and 299 then ''ok'' else ''error'' end,
                                      ''status_code'', status_code, ''timed_out'', timed_out,
                                      ''error'', left(coalesce(error_msg, ''''), 200), ''at'', created)
             from net._http_response where id = $1'
     into r using rid;
  return coalesce(r, jsonb_build_object('state', 'pending', 'request_id', rid));
end $_$;


ALTER FUNCTION "public"."promo_dispatch_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promo_fanout"("p_limit" integer DEFAULT 20) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
    -- Each event in its own sub-transaction: an event that cannot be processed
    -- is marked 'failed' (with the reason) and never blocks the others.
    begin
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
    exception when others then
      update public.promo_events set status = 'failed', error = left(sqlerrm, 500), processed_at = now() where id = e.id;
    end;
  end loop;
  return total;
end $$;


ALTER FUNCTION "public"."promo_fanout"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promo_functions_url_valid"("u" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $_$
  select coalesce(u ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1$'
                  or u = 'http://kong:8000/functions/v1', false)
$_$;


ALTER FUNCTION "public"."promo_functions_url_valid"("u" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promo_queue_new_product"("p_product" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.promo_events (kind, product_id, dedupe_key)
  values ('new_product', p_product, 'new_product:' || p_product)
  on conflict (dedupe_key) do nothing;
  update public.products set announced_at = now() where id = p_product and announced_at is null;
end $$;


ALTER FUNCTION "public"."promo_queue_new_product"("p_product" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promo_queue_price"("p_product" "uuid", "r_old" numeric, "r_new" numeric, "w_old" numeric, "w_new" numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."promo_queue_price"("p_product" "uuid", "r_old" numeric, "r_new" numeric, "w_old" numeric, "w_new" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_push_token"("p_token" "text", "p_platform" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  if coalesce(p_token, '') = '' or length(p_token) > 300 then raise exception 'INVALID_TOKEN'; end if;
  insert into public.push_tokens (token, user_id, platform, updated_at)
  values (p_token, auth.uid(), left(coalesce(p_platform, 'android'), 20), now())
  on conflict (token) do update set user_id = excluded.user_id,
    platform = excluded.platform, updated_at = now();
end $$;


ALTER FUNCTION "public"."register_push_token"("p_token" "text", "p_platform" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_wholesale"("p_business_name" "text", "p_business_number" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."request_wholesale"("p_business_name" "text", "p_business_number" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_my_promo_preferences"("p_new_products" boolean, "p_offers" boolean, "p_price_changes" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  update public.profiles
     set promo_new_products = coalesce(p_new_products, promo_new_products),
         promo_offers = coalesce(p_offers, promo_offers),
         promo_price_changes = coalesce(p_price_changes, promo_price_changes)
   where id = auth.uid();
end $$;


ALTER FUNCTION "public"."set_my_promo_preferences"("p_new_products" boolean, "p_offers" boolean, "p_price_changes" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.updated_at := now();
  return new;
end $$;


ALTER FUNCTION "public"."touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unregister_push_token"("p_token" "text") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  delete from public.push_tokens where token = p_token and user_id = auth.uid()
$$;


ALTER FUNCTION "public"."unregister_push_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_my_profile"("p" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."update_my_profile"("p" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name_sq" "text" NOT NULL,
    "name_en" "text" DEFAULT ''::"text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipient_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "read_at" timestamp with time zone,
    "dispatched_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "claimed_at" timestamp with time zone,
    "claim_token" "uuid",
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "category" "text" DEFAULT 'order'::"text" NOT NULL,
    "event_id" "uuid",
    CONSTRAINT "notifications_category_check" CHECK (("category" = ANY (ARRAY['order'::"text", 'promo'::"text"])))
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offer_items" (
    "offer_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "offer_price" numeric(12,2) NOT NULL,
    "offer_wholesale_price" numeric(12,2),
    CONSTRAINT "offer_items_offer_price_check" CHECK (("offer_price" >= (0)::numeric)),
    CONSTRAINT "offer_items_offer_wholesale_price_check" CHECK (("offer_wholesale_price" >= (0)::numeric))
);


ALTER TABLE "public"."offer_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title_sq" "text" NOT NULL,
    "title_en" "text" DEFAULT ''::"text" NOT NULL,
    "description_sq" "text" DEFAULT ''::"text" NOT NULL,
    "description_en" "text" DEFAULT ''::"text" NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "cancelled_at" timestamp with time zone,
    "activation_notified_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "offers_dates" CHECK (("ends_at" > "starts_at"))
);


ALTER TABLE "public"."offers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "quantity" integer NOT NULL,
    "unit_price" numeric(12,2) NOT NULL,
    "product_name" "text" DEFAULT ''::"text" NOT NULL,
    "sku" "text" DEFAULT ''::"text" NOT NULL,
    "unit" "text" DEFAULT ''::"text" NOT NULL,
    "offer_id" "uuid",
    CONSTRAINT "order_items_quantity_check" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "total" numeric(12,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "price_tier" "text" DEFAULT 'retail'::"text" NOT NULL,
    "item_count" integer DEFAULT 0 NOT NULL,
    "payment_method" "text" DEFAULT 'cash_on_delivery'::"text" NOT NULL,
    "delivery_name" "text" DEFAULT ''::"text" NOT NULL,
    "delivery_phone" "text" DEFAULT ''::"text" NOT NULL,
    "delivery_address" "text" DEFAULT ''::"text" NOT NULL,
    "delivery_city" "text" DEFAULT ''::"text" NOT NULL,
    "customer_note" "text" DEFAULT ''::"text" NOT NULL,
    "admin_note" "text" DEFAULT ''::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "order_number" bigint NOT NULL,
    "archived_at" timestamp with time zone,
    "archived_by" "uuid",
    CONSTRAINT "orders_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['cash_on_delivery'::"text", 'bank_transfer'::"text"]))),
    CONSTRAINT "orders_price_tier_check" CHECK (("price_tier" = ANY (ARRAY['retail'::"text", 'wholesale'::"text"]))),
    CONSTRAINT "orders_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'confirmed'::"text", 'preparing'::"text", 'shipped'::"text", 'delivered'::"text", 'cancelled'::"text", 'accepted'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


ALTER TABLE "public"."orders" ALTER COLUMN "order_number" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."orders_order_number_seq"
    START WITH 1001
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sku" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "retail_price" numeric(12,2) NOT NULL,
    "wholesale_price" numeric(12,2) NOT NULL,
    "stock" integer DEFAULT 0 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name_en" "text" DEFAULT ''::"text" NOT NULL,
    "description_en" "text" DEFAULT ''::"text" NOT NULL,
    "category_id" "uuid",
    "unit" "text" DEFAULT 'copë'::"text" NOT NULL,
    "images" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "announced_at" timestamp with time zone,
    CONSTRAINT "products_retail_price_check" CHECK (("retail_price" >= (0)::numeric)),
    CONSTRAINT "products_stock_check" CHECK (("stock" >= 0)),
    CONSTRAINT "products_wholesale_price_check" CHECK (("wholesale_price" >= (0)::numeric))
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text" DEFAULT ''::"text" NOT NULL,
    "phone" "text" DEFAULT ''::"text" NOT NULL,
    "role" "text" DEFAULT 'retail'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email" "text" DEFAULT ''::"text" NOT NULL,
    "business_name" "text" DEFAULT ''::"text" NOT NULL,
    "business_number" "text" DEFAULT ''::"text" NOT NULL,
    "address" "text" DEFAULT ''::"text" NOT NULL,
    "city" "text" DEFAULT ''::"text" NOT NULL,
    "language" "text" DEFAULT 'sq'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "wholesale_status" "text" DEFAULT 'none'::"text" NOT NULL,
    "promo_new_products" boolean DEFAULT false NOT NULL,
    "promo_offers" boolean DEFAULT false NOT NULL,
    "promo_price_changes" boolean DEFAULT false NOT NULL,
    "promo_tester" boolean DEFAULT false NOT NULL,
    CONSTRAINT "profiles_language_check" CHECK (("language" = ANY (ARRAY['sq'::"text", 'en'::"text"]))),
    CONSTRAINT "profiles_wholesale_status_check" CHECK (("wholesale_status" = ANY (ARRAY['none'::"text", 'pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."promo_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "kind" "text" NOT NULL,
    "product_id" "uuid",
    "offer_id" "uuid",
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "recipients" integer,
    "dedupe_key" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "error" "text",
    CONSTRAINT "promo_events_kind_check" CHECK (("kind" = ANY (ARRAY['new_product'::"text", 'offer'::"text", 'price'::"text"]))),
    CONSTRAINT "promo_events_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'suppressed'::"text", 'skipped'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."promo_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."promo_settings" (
    "id" boolean DEFAULT true NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "test_only" boolean DEFAULT true NOT NULL,
    "daily_cap" integer DEFAULT 3 NOT NULL,
    "debounce_minutes" integer DEFAULT 5 NOT NULL,
    "functions_url" "text" DEFAULT ''::"text" NOT NULL,
    "dispatch_request_id" bigint,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "promo_settings_daily_cap_check" CHECK ((("daily_cap" >= 0) AND ("daily_cap" <= 50))),
    CONSTRAINT "promo_settings_debounce_minutes_check" CHECK ((("debounce_minutes" >= 0) AND ("debounce_minutes" <= 1440))),
    CONSTRAINT "promo_settings_id_check" CHECK ("id")
);


ALTER TABLE "public"."promo_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_tokens" (
    "token" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "platform" "text" DEFAULT 'android'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_tokens" OWNER TO "postgres";


ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."offer_items"
    ADD CONSTRAINT "offer_items_pkey" PRIMARY KEY ("offer_id", "product_id");



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."orders"
    ADD CONSTRAINT "orders_archive_only_cancelled" CHECK ((("archived_at" IS NULL) OR ("status" = 'cancelled'::"text"))) NOT VALID;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_sku_key" UNIQUE ("sku");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."profiles"
    ADD CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['retail'::"text", 'wholesale'::"text", 'admin'::"text"]))) NOT VALID;



ALTER TABLE ONLY "public"."promo_events"
    ADD CONSTRAINT "promo_events_dedupe_key_key" UNIQUE ("dedupe_key");



ALTER TABLE ONLY "public"."promo_events"
    ADD CONSTRAINT "promo_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."promo_settings"
    ADD CONSTRAINT "promo_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_tokens"
    ADD CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("token");



CREATE INDEX "notifications_promo_recent_idx" ON "public"."notifications" USING "btree" ("recipient_id", "created_at") WHERE ("category" = 'promo'::"text");



CREATE UNIQUE INDEX "notifications_recipient_event_key" ON "public"."notifications" USING "btree" ("recipient_id", "event_id") WHERE ("event_id" IS NOT NULL);



CREATE INDEX "notifications_recipient_idx" ON "public"."notifications" USING "btree" ("recipient_id", "created_at" DESC);



CREATE INDEX "notifications_undispatched_idx" ON "public"."notifications" USING "btree" ("created_at") WHERE ("dispatched_at" IS NULL);



CREATE INDEX "offer_items_product_idx" ON "public"."offer_items" USING "btree" ("product_id");



CREATE INDEX "offers_live_idx" ON "public"."offers" USING "btree" ("starts_at", "ends_at") WHERE ("active" AND ("cancelled_at" IS NULL));



CREATE INDEX "order_items_order_idx" ON "public"."order_items" USING "btree" ("order_id");



CREATE INDEX "orders_active_idx" ON "public"."orders" USING "btree" ("status", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "orders_archived_idx" ON "public"."orders" USING "btree" ("archived_at" DESC) WHERE ("archived_at" IS NOT NULL);



CREATE INDEX "orders_customer_idx" ON "public"."orders" USING "btree" ("customer_id", "created_at" DESC);



CREATE UNIQUE INDEX "orders_order_number_key" ON "public"."orders" USING "btree" ("order_number");



CREATE INDEX "orders_status_idx" ON "public"."orders" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "products_category_idx" ON "public"."products" USING "btree" ("category_id");



CREATE UNIQUE INDEX "promo_events_one_pending_price" ON "public"."promo_events" USING "btree" ("product_id") WHERE (("kind" = 'price'::"text") AND ("status" = 'pending'::"text"));



CREATE INDEX "promo_events_pending_idx" ON "public"."promo_events" USING "btree" ("updated_at") WHERE ("status" = 'pending'::"text");



CREATE OR REPLACE TRIGGER "offers_touch" BEFORE UPDATE ON "public"."offers" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "orders_touch" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "products_promo" AFTER INSERT OR UPDATE OF "active", "retail_price", "wholesale_price" ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."products_promo_trigger"();



CREATE OR REPLACE TRIGGER "products_touch" BEFORE UPDATE ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "profiles_touch" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."promo_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offer_items"
    ADD CONSTRAINT "offer_items_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offer_items"
    ADD CONSTRAINT "offer_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL NOT VALID;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL NOT VALID;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."promo_events"
    ADD CONSTRAINT "promo_events_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."promo_events"
    ADD CONSTRAINT "promo_events_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."push_tokens"
    ADD CONSTRAINT "push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "categories_select_auth" ON "public"."categories" FOR SELECT TO "authenticated" USING (("active" OR ( SELECT "public"."is_admin"() AS "is_admin")));



CREATE POLICY "categories_select_public" ON "public"."categories" FOR SELECT TO "anon" USING ("active");



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_select" ON "public"."notifications" FOR SELECT TO "authenticated" USING (("recipient_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."offer_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."offers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_items_select" ON "public"."order_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_items"."order_id") AND (("o"."customer_id" = ( SELECT "auth"."uid"() AS "uid")) OR ( SELECT "public"."is_admin"() AS "is_admin"))))));



ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orders_select" ON "public"."orders" FOR SELECT TO "authenticated" USING ((("customer_id" = ( SELECT "auth"."uid"() AS "uid")) OR ( SELECT "public"."is_admin"() AS "is_admin")));



ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_select" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("id" = ( SELECT "auth"."uid"() AS "uid")) OR ( SELECT "public"."is_admin"() AS "is_admin")));



ALTER TABLE "public"."promo_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."promo_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."push_tokens" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."notifications";









GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

















































































































































































REVOKE ALL ON FUNCTION "public"."admin_archive_order"("p_order" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_archive_order"("p_order" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_archive_order"("p_order" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_cancel_offer"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_cancel_offer"("p_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_cancel_offer"("p_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_cancel_order"("p_order" "uuid", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_cancel_order"("p_order" "uuid", "p_note" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_cancel_order"("p_order" "uuid", "p_note" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_delete_category"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_category"("p_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_delete_category"("p_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_delete_product"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_product"("p_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_delete_product"("p_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_get_promo_settings"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_get_promo_settings"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_get_promo_settings"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_list_offers"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_list_offers"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_list_offers"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_restore_order"("p_order" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_restore_order"("p_order" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_restore_order"("p_order" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_review_wholesale"("p_user" "uuid", "p_approve" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_review_wholesale"("p_user" "uuid", "p_approve" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_review_wholesale"("p_user" "uuid", "p_approve" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_save_category"("p" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_save_category"("p" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_save_category"("p" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_save_offer"("p" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_save_offer"("p" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_save_offer"("p" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_save_product"("p" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_save_product"("p" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_save_product"("p" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_set_offer_active"("p_id" "uuid", "p_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_offer_active"("p_id" "uuid", "p_active" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_offer_active"("p_id" "uuid", "p_active" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_set_order_status"("p_order" "uuid", "p_status" "text", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_order_status"("p_order" "uuid", "p_status" "text", "p_note" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_order_status"("p_order" "uuid", "p_status" "text", "p_note" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_set_promo_settings"("p" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_promo_settings"("p" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_promo_settings"("p" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_set_promo_tester"("p_user" "uuid", "p_tester" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_promo_tester"("p_user" "uuid", "p_tester" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_promo_tester"("p_user" "uuid", "p_tester" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_stats"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_stats"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_stats"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."assert_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assert_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."best_offer"("p_product" "uuid", "p_tier" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."best_offer"("p_product" "uuid", "p_tier" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cancel_my_order"("p_order" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_my_order"("p_order" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."cancel_my_order"("p_order" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."claim_notifications"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_notifications"("p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_my_account"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_my_account"() TO "service_role";
GRANT ALL ON FUNCTION "public"."delete_my_account"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."finish_notifications"("p_claim" "uuid", "p_delivered" "uuid"[], "p_failed" "uuid"[], "p_error" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finish_notifications"("p_claim" "uuid", "p_delivered" "uuid"[], "p_failed" "uuid"[], "p_error" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."forget_push_tokens"("p_tokens" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."forget_push_tokens"("p_tokens" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."list_offers"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_offers"() TO "service_role";
GRANT ALL ON FUNCTION "public"."list_offers"() TO "anon";
GRANT ALL ON FUNCTION "public"."list_offers"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."list_products"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_products"() TO "service_role";
GRANT ALL ON FUNCTION "public"."list_products"() TO "anon";
GRANT ALL ON FUNCTION "public"."list_products"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[]) TO "service_role";
GRANT ALL ON FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."new_profile"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."new_profile"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."notify_admins"("p_type" "text", "p_data" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_admins"("p_type" "text", "p_data" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."notify_user"("p_user" "uuid", "p_type" "text", "p_data" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_user"("p_user" "uuid", "p_type" "text", "p_data" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."place_order"("p_lines" "jsonb", "p_delivery" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."place_order"("p_lines" "jsonb", "p_delivery" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."place_order"("p_lines" "jsonb", "p_delivery" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."price_tier"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."price_tier"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."process_offer_activations"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."process_offer_activations"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."products_promo_trigger"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."products_promo_trigger"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."promo_dispatch"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."promo_dispatch"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."promo_dispatch_status"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."promo_dispatch_status"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."promo_fanout"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."promo_fanout"("p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."promo_functions_url_valid"("u" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."promo_functions_url_valid"("u" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."promo_queue_new_product"("p_product" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."promo_queue_new_product"("p_product" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."promo_queue_price"("p_product" "uuid", "r_old" numeric, "r_new" numeric, "w_old" numeric, "w_new" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."promo_queue_price"("p_product" "uuid", "r_old" numeric, "r_new" numeric, "w_old" numeric, "w_new" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."register_push_token"("p_token" "text", "p_platform" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."register_push_token"("p_token" "text", "p_platform" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."register_push_token"("p_token" "text", "p_platform" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."request_wholesale"("p_business_name" "text", "p_business_number" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."request_wholesale"("p_business_name" "text", "p_business_number" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."request_wholesale"("p_business_name" "text", "p_business_number" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_my_promo_preferences"("p_new_products" boolean, "p_offers" boolean, "p_price_changes" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_my_promo_preferences"("p_new_products" boolean, "p_offers" boolean, "p_price_changes" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."set_my_promo_preferences"("p_new_products" boolean, "p_offers" boolean, "p_price_changes" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."touch_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."unregister_push_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."unregister_push_token"("p_token" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."unregister_push_token"("p_token" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."update_my_profile"("p" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_my_profile"("p" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."update_my_profile"("p" "jsonb") TO "authenticated";
























GRANT ALL ON TABLE "public"."categories" TO "service_role";
GRANT SELECT ON TABLE "public"."categories" TO "anon";
GRANT SELECT ON TABLE "public"."categories" TO "authenticated";



GRANT ALL ON TABLE "public"."notifications" TO "service_role";
GRANT SELECT ON TABLE "public"."notifications" TO "authenticated";



GRANT ALL ON TABLE "public"."offer_items" TO "service_role";



GRANT ALL ON TABLE "public"."offers" TO "service_role";



GRANT ALL ON TABLE "public"."order_items" TO "service_role";
GRANT SELECT ON TABLE "public"."order_items" TO "authenticated";



GRANT ALL ON TABLE "public"."orders" TO "service_role";
GRANT SELECT ON TABLE "public"."orders" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."orders_order_number_seq" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."promo_events" TO "service_role";



GRANT ALL ON TABLE "public"."promo_settings" TO "service_role";



GRANT ALL ON TABLE "public"."push_tokens" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































