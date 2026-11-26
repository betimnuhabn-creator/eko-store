-- =====================================================================
-- EKO Store — prices changed in the app go to the website too
-- File: supabase/migrations/20261230000000_woo_price_push.sql
--
-- * An administrator changes the retail / wholesale price of a product that
--   comes from eko-store.com ("Nga faqja") — in the Android app, the PC panel
--   or with the Excel import — → the new price is written to WooCommerce
--   (Regular price / Wholesale Suite "Wholesale Customer" price) by the Edge
--   Function `woo-sync` within about a minute.
-- * Until the website has the new price, the website sync does not put the
--   old price back in the app.
-- * Only the changed price is sent (retail, wholesale or both). Name, photos,
--   stock and the rest still come from the website only.
-- * Prices coming FROM the website are never sent back (no loop).
-- * One transaction; safe to run more than once; no existing row is changed.
-- =====================================================================

begin;

set local lock_timeout = '10s';

do $$
begin
  if to_regclass('public.link_jobs') is null then
    raise exception 'Run the WooCommerce and account-link migrations first. Nothing was changed.';
  end if;
end $$;

create table if not exists public.woo_price_jobs (
  id bigserial primary key,
  product_id uuid not null references public.products (id) on delete cascade,
  retail boolean not null default false,          -- send the retail price
  wholesale boolean not null default false,       -- send the wholesale price
  rev integer not null default 1,                 -- +1 at every new change while waiting
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create unique index if not exists woo_price_jobs_one_pending on public.woo_price_jobs (product_id) where status = 'pending';
alter table public.woo_price_jobs enable row level security;
revoke all on public.woo_price_jobs from anon, authenticated;

-- BEFORE: while an app price is waiting to reach the website, an update that is
-- not made by an administrator (= the website sync) keeps the app price.
create or replace function public.woo_price_keep_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare j public.woo_price_jobs%rowtype;
begin
  if old.source <> 'woo' or public.is_admin() then return new; end if;
  select * into j from public.woo_price_jobs where product_id = old.id and status = 'pending';
  if found then
    if j.retail then new.retail_price := old.retail_price; end if;
    if j.wholesale then new.wholesale_price := old.wholesale_price; end if;
  end if;
  return new;
end $$;
drop trigger if exists products_woo_price_keep on public.products;
create trigger products_woo_price_keep before update of retail_price, wholesale_price on public.products
  for each row execute function public.woo_price_keep_trigger();

-- AFTER: an administrator changed the price of a website product → job for the website.
create or replace function public.woo_price_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r boolean; w boolean;
begin
  if new.source <> 'woo' or new.woo_id is null or not public.is_admin() then return null; end if;
  r := new.retail_price is distinct from old.retail_price;
  w := new.wholesale_price is distinct from old.wholesale_price;
  if not (r or w) then return null; end if;
  insert into public.woo_price_jobs as j (product_id, retail, wholesale)
  values (new.id, r, w)
  on conflict (product_id) where status = 'pending'
  do update set retail = j.retail or excluded.retail, wholesale = j.wholesale or excluded.wholesale,
                rev = j.rev + 1, attempts = 0, last_error = null;
  return null;
end $$;
drop trigger if exists products_woo_price on public.products;
create trigger products_woo_price after update of retail_price, wholesale_price on public.products
  for each row execute function public.woo_price_trigger();

-- woo-sync: the waiting jobs with the CURRENT app prices.
create or replace function public.woo_claim_price_jobs(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  with j as (
    select id from public.woo_price_jobs where status = 'pending' and attempts < 5
     order by id limit least(greatest(coalesce(p_limit, 20), 1), 50) for update skip locked
  ), u as (
    update public.woo_price_jobs x set attempts = attempts + 1 from j where x.id = j.id
    returning x.id, x.product_id, x.retail, x.wholesale, x.rev
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'job_id', u.id, 'rev', u.rev, 'retail', u.retail, 'wholesale', u.wholesale,
           'woo_id', p.woo_id, 'woo_parent_id', p.woo_parent_id,
           'retail_price', p.retail_price, 'wholesale_price', p.wholesale_price) order by u.id), '[]'::jsonb)
    into r
    from u join public.products p on p.id = u.product_id;
  return r;
end $$;

-- Done (p_error null) — unless the price was changed again meanwhile: then it is sent once more.
create or replace function public.woo_finish_price_job(p_job bigint, p_rev integer, p_error text)
returns void language sql security definer set search_path = '' as $$
  update public.woo_price_jobs
     set status = case when p_error is null and rev = p_rev then 'sent'
                       when p_error is null then 'pending'
                       when attempts >= 5 then 'failed' else 'pending' end,
         last_error = left(p_error, 300), processed_at = now()
   where id = p_job;
$$;

-- the scheduler also runs when a price is waiting for the website
create or replace function public.woo_dispatch()
returns bigint language plpgsql security definer set search_path = '' as $$
declare u text; rid bigint;
begin
  select functions_url into u from public.promo_settings where id;
  if not public.promo_functions_url_valid(u) or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return null;
  end if;
  if not exists (select 1 from public.woo_order_jobs where status = 'pending')
     and not exists (select 1 from public.link_jobs where status = 'pending')
     and not exists (select 1 from public.woo_price_jobs where status = 'pending')
     and public.woo_full_sync_due() = 'no' then
    return null;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, '
       || 'headers := ''{"Content-Type": "application/json"}''::jsonb, timeout_milliseconds := 60000)'
     into rid using u || '/woo-sync';
  update public.woo_settings set request_id = rid where id;
  return rid;
end $$;

-- the panel also shows prices waiting for / refused by the website
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
    'last_order_error', (select last_error from public.woo_order_jobs where last_error is not null order by processed_at desc nulls last limit 1),
    'prices_pending', (select count(*) from public.woo_price_jobs where status = 'pending'),
    'prices_failed', (select count(*) from public.woo_price_jobs where status = 'failed'
                        and processed_at > now() - interval '7 days'),
    'last_price_error', (select last_error from public.woo_price_jobs where status = 'failed'
                           order by processed_at desc nulls last limit 1));
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.woo_price_keep_trigger()', 'public.woo_price_trigger()',
                           'public.woo_claim_price_jobs(integer)', 'public.woo_finish_price_job(bigint, integer, text)',
                           'public.woo_dispatch()', 'public.admin_woo_status()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function public.woo_claim_price_jobs(integer) to service_role;
grant execute on function public.woo_finish_price_job(bigint, integer, text) to service_role;
grant execute on function public.admin_woo_status() to authenticated;

notify pgrst, 'reload schema';

commit;
