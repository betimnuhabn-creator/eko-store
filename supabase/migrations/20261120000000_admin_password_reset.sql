-- =====================================================================
-- EKO Store — admin sets a customer's password (PC panel → Klientët → Fjalëkalimi)
-- File: supabase/migrations/20261120000000_admin_password_reset.sql
--
-- * Run AFTER the earlier EKO migrations, as ONE script in the SQL Editor.
--   One transaction; safe to run more than once. Nothing is deleted.
-- * The password itself is set by the Edge Function `admin-set-password`
--   (Supabase Auth Admin API, server only). The database only keeps:
--     - profiles.must_change_password: the customer must choose a new password
--       after logging in with the temporary one;
--     - password_reset_audit: WHO changed WHOSE password WHEN (never the password).
-- * The flag is cleared by the database itself as soon as the customer's
--   password changes again (trigger on auth.users), not by the app.
-- =====================================================================

begin;

set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public.assert_admin()') is null or to_regclass('public.profiles') is null then
    raise exception 'Run the EKO Store v1 migration first. Nothing was changed.';
  end if;
end $$;

-- Existing customers: false (column default stored once, no UPDATE, no trigger).
alter table public.profiles add column if not exists must_change_password boolean not null default false;

create table if not exists public.password_reset_audit (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null,
  admin_email text not null,
  customer_id uuid not null,
  customer_email text not null,
  created_at timestamptz not null default now()
);
create index if not exists password_reset_audit_customer_idx on public.password_reset_audit (customer_id, created_at desc);
alter table public.password_reset_audit enable row level security;
revoke all on public.password_reset_audit from public, anon, authenticated;

-- Called by the Edge Function (service role) AFTER Supabase has changed the
-- password: audit row, "must change password", and the customer's existing
-- sessions are ended (refresh tokens of old logins stop working).
create or replace function public.record_admin_password_change(p_admin uuid, p_customer uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_admin_email text;
  v_customer public.profiles%rowtype;
begin
  select email into v_admin_email from public.profiles where id = p_admin and role = 'admin';
  if v_admin_email is null then raise exception 'ADMIN_ONLY'; end if;
  select * into v_customer from public.profiles where id = p_customer;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_customer.role = 'admin' or p_customer = p_admin then raise exception 'TARGET_NOT_ALLOWED'; end if;

  insert into public.password_reset_audit (admin_id, admin_email, customer_id, customer_email)
  values (p_admin, v_admin_email, p_customer, coalesce(v_customer.email, ''));
  update public.profiles set must_change_password = true where id = p_customer;
  begin
    delete from auth.sessions where user_id = p_customer;
  exception when others then
    null;  -- not permitted on this project: the password change itself still applies
  end;
end $$;

-- The customer chose a new password (any later change of auth.users.encrypted_password).
create or replace function public.clear_must_change_password()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update public.profiles set must_change_password = false where id = new.id and must_change_password;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_password_changed on auth.users;
create trigger on_auth_password_changed
  after update of encrypted_password on auth.users
  for each row execute function public.clear_must_change_password();

revoke all on function public.record_admin_password_change(uuid, uuid) from public, anon, authenticated;
revoke all on function public.clear_must_change_password() from public, anon, authenticated;
grant execute on function public.record_admin_password_change(uuid, uuid) to service_role;

notify pgrst, 'reload schema';

commit;
