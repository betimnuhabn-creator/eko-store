-- =====================================================================
-- EKO Store — deleting customer accounts (PC panel → Klientët → Fshi klientin,
-- app → Llogaria → Fshi llogarinë time, public page delete-account.html)
-- File: supabase/migrations/20261205000000_account_deletion.sql
--
-- * Run AFTER the earlier EKO migrations, as ONE script in the SQL Editor.
--   One transaction; safe to run more than once. No existing data is changed.
-- * The deletion itself runs on the server in the Edge Function
--   `delete-account` (identity + permission checks, password re-check), which
--   calls delete_customer_account() with the service key. That key never
--   reaches the app or the panel.
-- * What is deleted: the Supabase Auth account (and with it its sessions and
--   refresh tokens), the profile (name, phone, address, business data,
--   preferences), notifications and push tokens.
-- * What is kept: orders and order lines, for accounting. They keep the
--   delivery details written on the order (name, phone, address = the
--   delivery note / invoice data) and are no longer linked to an account
--   (customer_id = null). Nothing in an order is changed besides that link.
-- * account_deletion_audit: WHEN an account was deleted, by whom (self/admin)
--   and how many orders were kept. No name, e-mail or phone of the customer.
-- * delete_my_account() (used by app versions up to 1.3.0) keeps working and
--   goes through the same function, so it is recorded the same way.
-- =====================================================================

begin;

set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public.delete_my_account()') is null
     or to_regclass('public.password_reset_audit') is null then
    raise exception 'Run the earlier EKO Store migrations first (v1 … admin password). Nothing was changed.';
  end if;
end $$;

create table if not exists public.account_deletion_audit (
  id uuid primary key default gen_random_uuid(),
  deleted_user_id uuid not null,              -- the Auth id that no longer exists
  via text not null check (via in ('self', 'admin')),
  admin_id uuid,                              -- set when an administrator deleted it
  orders_kept integer not null default 0,
  open_orders integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.account_deletion_audit enable row level security;
-- No policies: not readable or writable through the API (server and SQL Editor only).
revoke all on public.account_deletion_audit from anon, authenticated;

-- p_user: the account to delete. p_actor: who asks (the same id = the customer
-- themself; otherwise it must be an administrator). Never deletes an administrator.
-- Returns { orders_kept, open_orders }.
create or replace function public.delete_customer_account(p_user uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_actor_role text;
  v_orders integer;
  v_open integer;
begin
  if p_user is null or p_actor is null then raise exception 'INVALID_INPUT'; end if;
  select role into v_role from public.profiles where id = p_user for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_role = 'admin' then raise exception 'TARGET_IS_ADMIN'; end if;
  if p_actor <> p_user then
    select role into v_actor_role from public.profiles where id = p_actor;
    if v_actor_role is distinct from 'admin' then raise exception 'NOT_ALLOWED'; end if;
  end if;

  select count(*), count(*) filter (where status in ('new', 'confirmed', 'preparing', 'shipped', 'accepted'))
    into v_orders, v_open
    from public.orders where customer_id = p_user;

  delete from public.push_tokens where user_id = p_user;               -- no more pushes
  update public.password_reset_audit set customer_email = '' where customer_id = p_user;  -- keep who/when, drop the e-mail
  insert into public.account_deletion_audit (deleted_user_id, via, admin_id, orders_kept, open_orders)
  values (p_user, case when p_actor = p_user then 'self' else 'admin' end,
          case when p_actor = p_user then null else p_actor end, v_orders, v_open);
  -- Auth account → profile (cascade) → notifications (cascade);
  -- orders.customer_id becomes null (orders and their lines stay).
  delete from auth.users where id = p_user;
  return jsonb_build_object('orders_kept', v_orders, 'open_orders', v_open);
end $$;

-- Same behaviour as before for the app (≤ 1.3.0): own account only, never an administrator.
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  if public.is_admin() then raise exception 'ADMIN_CANNOT_DELETE'; end if;
  perform public.delete_customer_account(auth.uid(), auth.uid());
end $$;

revoke all on function public.delete_customer_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_customer_account(uuid, uuid) to service_role;
revoke all on function public.delete_my_account() from public, anon, authenticated;
grant execute on function public.delete_my_account() to authenticated;

notify pgrst, 'reload schema';

commit;
