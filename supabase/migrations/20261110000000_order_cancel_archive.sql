-- =====================================================================
-- EKO Store — admin order cancel / archive / restore
-- File: supabase/migrations/20261110000000_order_cancel_archive.sql
--
-- * Run AFTER 20261105000000_eko_store_v1.sql, as ONE script in the SQL
--   Editor (or `supabase db push`). Safe to run more than once.
-- * One transaction: if anything fails, nothing changes.
-- * Nothing is deleted. Archiving only sets archived_at / archived_by;
--   the order and its lines stay in the database and in the customer's
--   order history. Restoring clears those two columns again.
-- * Only administrators: every function checks is_admin() itself, and
--   clients still have no direct write access to the orders table.
-- =====================================================================

begin;

set local lock_timeout = '10s';

-- ---------------------------------------------------------------------
-- New columns (existing rows: not archived)
-- ---------------------------------------------------------------------
alter table public.orders
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid;

-- archived_by is deliberately NOT a foreign key to profiles: a second
-- orders->profiles relationship would make the existing `profiles(...)`
-- embeds used by the Android app ambiguous (PostgREST error PGRST201).
alter table public.orders drop constraint if exists orders_archived_by_fkey;

-- Only cancelled orders can be archived.
alter table public.orders drop constraint if exists orders_archive_only_cancelled;
alter table public.orders add constraint orders_archive_only_cancelled
  check (archived_at is null or status = 'cancelled') not valid;

create index if not exists orders_active_idx on public.orders (status, created_at desc) where archived_at is null;
create index if not exists orders_archived_idx on public.orders (archived_at desc) where archived_at is not null;

-- ---------------------------------------------------------------------
-- Cancel (admin). Delivered/completed orders cannot be cancelled.
-- The customer is notified exactly like any other status change.
-- ---------------------------------------------------------------------
create or replace function public.admin_cancel_order(p_order uuid, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
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

-- ---------------------------------------------------------------------
-- Archive (admin). Only cancelled orders. Hides them from the active list.
-- ---------------------------------------------------------------------
create or replace function public.admin_archive_order(p_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.orders%rowtype;
begin
  perform public.assert_admin();
  select * into v from public.orders where id = p_order for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v.status <> 'cancelled' then raise exception 'ONLY_CANCELLED_CAN_BE_ARCHIVED'; end if;
  if v.archived_at is not null then return; end if;
  update public.orders set archived_at = now(), archived_by = auth.uid() where id = p_order;
end $$;

-- ---------------------------------------------------------------------
-- Restore (admin). Back to the active list; status stays 'cancelled'.
-- ---------------------------------------------------------------------
create or replace function public.admin_restore_order(p_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin();
  update public.orders set archived_at = null, archived_by = null where id = p_order;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Status changes are not allowed on an archived order (restore it first).
-- Same function as in v1, plus the archived check.
-- ---------------------------------------------------------------------
create or replace function public.admin_set_order_status(p_order uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
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

-- Dashboard counters: archived orders are not "open" (they are cancelled anyway).
create or replace function public.admin_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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

-- ---------------------------------------------------------------------
-- Privileges: only these functions, only for logged-in users (each one
-- refuses non-admins). Guests get nothing.
-- ---------------------------------------------------------------------
revoke all on function public.admin_cancel_order(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_archive_order(uuid) from public, anon, authenticated;
revoke all on function public.admin_restore_order(uuid) from public, anon, authenticated;
revoke all on function public.admin_set_order_status(uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_stats() from public, anon, authenticated;

grant execute on function public.admin_cancel_order(uuid, text) to authenticated;
grant execute on function public.admin_archive_order(uuid) to authenticated;
grant execute on function public.admin_restore_order(uuid) to authenticated;
grant execute on function public.admin_set_order_status(uuid, text, text) to authenticated;
grant execute on function public.admin_stats() to authenticated;

-- RLS on public.orders is unchanged: customers still read only their own
-- orders (archived ones included, as part of their history); admins read all.
-- No INSERT/UPDATE/DELETE privilege exists for API roles on orders.

commit;
