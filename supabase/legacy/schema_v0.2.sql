-- Run in Supabase SQL Editor. Do not expose service_role keys in the app.
create extension if not exists pgcrypto;
create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, full_name text not null default '', phone text not null default '', role text not null default 'retail' check(role in ('retail','wholesale','admin')), wholesale_approved boolean not null default false, created_at timestamptz not null default now());
create table public.products (id uuid primary key default gen_random_uuid(), sku text not null unique, name text not null, description text, image_url text, retail_price numeric(12,2) not null check(retail_price>=0), wholesale_price numeric(12,2) not null check(wholesale_price>=0), stock integer not null default 0 check(stock>=0), active boolean not null default true, created_at timestamptz not null default now());
create table public.orders (id uuid primary key default gen_random_uuid(), customer_id uuid not null references auth.users(id), status text not null default 'new' check(status in ('new','accepted','preparing','completed','cancelled')), total numeric(12,2) not null, created_at timestamptz not null default now());
create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade, product_id uuid not null references public.products(id), quantity integer not null check(quantity>0), unit_price numeric(12,2) not null);
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.profiles where id=auth.uid() and role='admin')$$;
create or replace function public.new_profile() returns trigger language plpgsql security definer set search_path='' as $$begin insert into public.profiles(id,full_name,phone,role,wholesale_approved) values(new.id,coalesce(new.raw_user_meta_data->>'full_name',''),coalesce(new.raw_user_meta_data->>'phone',''),case when new.raw_user_meta_data->>'requested_wholesale'='true' then 'wholesale' else 'retail' end,false);return new;end$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.new_profile();
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
create policy profile_read on public.profiles for select to authenticated using(id=auth.uid() or public.is_admin());
create policy profile_admin_update on public.profiles for update to authenticated using(public.is_admin()) with check(public.is_admin());
-- Customers cannot read wholesale_price directly. Only expose a view with role-specific price.
revoke all on public.products from anon,authenticated;
create policy products_admin_all on public.products for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy products_read on public.products for select to authenticated using(active or public.is_admin());
-- Explicit column grants prevent non-approved users reading wholesale_price through select('*').
grant select(id,sku,name,description,image_url,retail_price,stock,active,created_at) on public.products to authenticated;
grant insert,update,delete on public.products to authenticated;
-- IMPORTANT: column grants alone cannot condition by user; use the secure RPC below and revoke table select.
revoke select on public.products from authenticated;
create or replace function public.list_products() returns table(id uuid,sku text,name text,description text,image_url text,retail_price numeric,wholesale_price numeric,stock integer,active boolean,created_at timestamptz) language sql stable security definer set search_path='' as $$select p.id,p.sku,p.name,p.description,p.image_url,p.retail_price,case when exists(select 1 from public.profiles q where q.id=auth.uid() and (q.role='admin' or (q.role='wholesale' and q.wholesale_approved))) then p.wholesale_price else null end,p.stock,p.active,p.created_at from public.products p where p.active or public.is_admin() order by p.created_at desc$$;
revoke all on function public.list_products() from public;
grant execute on function public.list_products() to authenticated;
create policy orders_read on public.orders for select to authenticated using(customer_id=auth.uid() or public.is_admin());
create policy items_read on public.order_items for select to authenticated using(exists(select 1 from public.orders o where o.id=order_id and (o.customer_id=auth.uid() or public.is_admin())));
create policy orders_admin_update on public.orders for update to authenticated using(public.is_admin()) with check(public.is_admin());
create or replace function public.place_order(p_lines jsonb) returns uuid language plpgsql security definer set search_path='' as $$declare v_user uuid:=auth.uid();v_order uuid;v_total numeric:=0;v_item jsonb;v_p public.products%rowtype;v_qty integer;v_price numeric;v_wholesale boolean;begin if v_user is null then raise exception 'Login required';end if;if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 or jsonb_array_length(p_lines)>100 then raise exception 'Invalid cart';end if;select (role='admin' or (role='wholesale' and wholesale_approved)) into v_wholesale from public.profiles where id=v_user;insert into public.orders(customer_id,total) values(v_user,0) returning id into v_order;for v_item in select * from jsonb_array_elements(p_lines) loop v_qty:=(v_item->>'quantity')::integer;if v_qty is null or v_qty<1 then raise exception 'Invalid quantity';end if;select * into v_p from public.products where id=(v_item->>'product_id')::uuid and active for update;if not found then raise exception 'Product unavailable';end if;v_price:=case when v_wholesale then v_p.wholesale_price else v_p.retail_price end;-- Stock is not decremented automatically; EKO confirms availability after order.insert into public.order_items(order_id,product_id,quantity,unit_price) values(v_order,v_p.id,v_qty,v_price);v_total:=v_total+v_qty*v_price;end loop;update public.orders set total=v_total where id=v_order;return v_order;end$$;
revoke all on function public.place_order(jsonb) from public;
grant execute on function public.place_order(jsonb) to authenticated;
-- After signup, promote YOUR account manually in SQL editor:
-- update public.profiles set role='admin',wholesale_approved=true where id=(select id from auth.users where email='YOUR_EMAIL');
-- Approve wholesale accounts as admin:
-- update public.profiles set wholesale_approved=true where id='CUSTOMER_UUID';


-- Public catalog without prices (for guests). Only the app RPC exposes prices after login.
create or replace function public.guest_catalog() returns table(id uuid,sku text,name text,description text,image_url text,in_stock boolean) language sql stable security definer set search_path='' as $$select id,sku,name,description,image_url,(stock>0) from public.products where active order by created_at desc$$;
revoke all on function public.guest_catalog() from public;
grant execute on function public.guest_catalog() to anon,authenticated;
-- Profile details are private; administrators can approve wholesale accounts.
-- Phone push notifications require server-side push token registration and delivery configuration.
