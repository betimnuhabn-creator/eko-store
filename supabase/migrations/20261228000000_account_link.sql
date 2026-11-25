-- =====================================================================
-- EKO Store — one account for the website (WordPress) and the app
-- File: supabase/migrations/20261228000000_account_link.sql
--
-- * Same e-mail + password on eko-store.com and in the app. The two systems
--   keep their own (encrypted) passwords; they are linked at LOGIN time by the
--   Edge Function `account-link`:
--     - app login fails → the website is asked (secret-protected endpoint);
--       right password there → the app account is created / its password updated;
--     - website login fails → the website asks the app the same way and creates
--       / updates the WordPress user.
-- * Wholesale status follows in both directions: approved in the app panel →
--   "Wholesale Customer" on the website; role "Wholesale Customer" set on the
--   website → approved in the app.
-- * Administrator accounts are never linked or changed.
-- * Login attempts through the link are limited (10 per e-mail per 15 minutes).
-- * One transaction; safe to run more than once; no existing row is changed.
-- =====================================================================

begin;

set local lock_timeout = '10s';

do $$
begin
  if to_regclass('public.woo_settings') is null then
    raise exception 'Run the WooCommerce migrations first. Nothing was changed.';
  end if;
end $$;

create table if not exists public.link_attempts (
  id bigserial primary key,
  email text not null,
  at timestamptz not null default now()
);
create index if not exists link_attempts_email_idx on public.link_attempts (lower(email), at);
alter table public.link_attempts enable row level security;
revoke all on public.link_attempts from anon, authenticated;

create table if not exists public.link_jobs (
  id bigserial primary key,
  email text not null,
  wholesale boolean not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists link_jobs_pending_idx on public.link_jobs (status, id) where status = 'pending';
alter table public.link_jobs enable row level security;
revoke all on public.link_jobs from anon, authenticated;

-- Max 10 link logins per e-mail per 15 minutes (counts this attempt).
create or replace function public.link_rate_ok(p_email text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.link_attempts where at < now() - interval '1 day';
  select count(*) into n from public.link_attempts where lower(email) = lower(trim(p_email)) and at > now() - interval '15 minutes';
  if n >= 10 then return false; end if;
  insert into public.link_attempts (email) values (lower(trim(p_email)));
  return true;
end $$;

-- The app account behind an e-mail (null when there is none).
create or replace function public.link_user_info(p_email text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'role', p.role, 'wholesale_status', p.wholesale_status,
                            'full_name', p.full_name, 'phone', p.phone, 'business_name', p.business_name)
    from public.profiles p
   where lower(p.email) = lower(trim(p_email))
   limit 1
$$;

-- Wholesale status coming FROM the website (not sent back there).
create or replace function public.link_set_wholesale(p_user uuid, p_wholesale boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare v public.profiles%rowtype;
begin
  select * into v from public.profiles where id = p_user for update;
  if not found or v.role = 'admin' then return 'skipped'; end if;
  perform set_config('eko.from_link', 'on', true);
  if p_wholesale and v.wholesale_status <> 'approved' then
    update public.profiles set role = 'wholesale', wholesale_status = 'approved' where id = p_user;
    perform public.notify_user(p_user, 'wholesale_approved', '{}'::jsonb);
    return 'approved';
  elsif not p_wholesale and v.wholesale_status = 'approved' then
    update public.profiles set role = 'retail', wholesale_status = 'none' where id = p_user;
    return 'revoked';
  end if;
  return 'unchanged';
end $$;

-- Wholesale approved / revoked in the app → told to the website.
create or replace function public.link_wholesale_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('eko.from_link', true), '') = 'on' or new.role = 'admin' then return null; end if;
  if (new.wholesale_status = 'approved') is distinct from (old.wholesale_status = 'approved') then
    insert into public.link_jobs (email, wholesale) values (new.email, new.wholesale_status = 'approved');
  end if;
  return null;
end $$;
drop trigger if exists profiles_link_wholesale on public.profiles;
create trigger profiles_link_wholesale after update of wholesale_status on public.profiles
  for each row execute function public.link_wholesale_trigger();

create or replace function public.link_claim_jobs(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  with j as (
    select id from public.link_jobs where status = 'pending' and attempts < 5
     order by id limit least(greatest(coalesce(p_limit, 20), 1), 50) for update skip locked
  ), u as (
    update public.link_jobs l set attempts = attempts + 1 from j where l.id = j.id
    returning l.id, l.email, l.wholesale
  )
  select coalesce(jsonb_agg(jsonb_build_object('job_id', id, 'email', email, 'wholesale', wholesale) order by id), '[]'::jsonb)
    into r from u;
  return r;
end $$;

create or replace function public.link_finish_job(p_job bigint, p_error text)
returns void language sql security definer set search_path = '' as $$
  update public.link_jobs
     set status = case when p_error is null then 'sent' when attempts >= 5 then 'failed' else 'pending' end,
         last_error = left(p_error, 300), processed_at = now()
   where id = p_job;
$$;

-- the scheduler also runs when a wholesale change is waiting for the website
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
     and public.woo_full_sync_due() = 'no' then
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
  foreach f in array array['public.link_rate_ok(text)', 'public.link_user_info(text)', 'public.link_set_wholesale(uuid, boolean)',
                           'public.link_wholesale_trigger()', 'public.link_claim_jobs(integer)', 'public.link_finish_job(bigint, text)',
                           'public.woo_dispatch()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function public.link_rate_ok(text) to service_role;
grant execute on function public.link_user_info(text) to service_role;
grant execute on function public.link_set_wholesale(uuid, boolean) to service_role;
grant execute on function public.link_claim_jobs(integer) to service_role;
grant execute on function public.link_finish_job(bigint, text) to service_role;

notify pgrst, 'reload schema';

commit;
