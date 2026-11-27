-- =====================================================================
-- EKO Store — product import from Excel (PC panel → Produktet → Importo)
-- File: supabase/migrations/20261128000000_product_import.sql
--
-- * Run AFTER the earlier EKO migrations (v1, order archive, offers), as ONE
--   script in the SQL Editor. One transaction; safe to run more than once.
--   No table is changed and no data is touched.
-- * admin_import_products(rows, notify): administrators only. Each row is
--   matched by SKU (case-insensitive, so no duplicates): existing → updated,
--   new → created. Each row is processed on its own: a bad row is reported as
--   "rejected" with the reason and never stops the others. At most 200 rows
--   per call (the panel sends groups of 50).
--   Empty cells on an UPDATE keep the current value (e.g. a file with only
--   SKU + prices changes only the prices).
-- * notify = false (default in the panel): the import does not create
--   promotional "new product" / "price changed" notifications. Normal saves
--   in the panel and the app behave exactly as before.
-- =====================================================================

begin;

set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public.admin_save_product(jsonb)') is null
     or to_regprocedure('public.promo_queue_new_product(uuid)') is null
     or to_regprocedure('public.promo_queue_price(uuid, numeric, numeric, numeric, numeric)') is null then
    raise exception 'Run the EKO Store v1 and offers migrations first. Nothing was changed.';
  end if;
end $$;

-- Fast case-insensitive SKU lookup (the existing unique constraint stays as it is).
create index if not exists products_sku_lower_idx on public.products (lower(sku));

-- Same as in the offers migration, plus: inside an import without
-- notifications (eko.promo_suppress = on, set only by admin_import_products
-- for its own transaction) no promotional event is recorded; a product
-- published by such an import counts as already announced.
create or replace function public.products_promo_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('eko.promo_suppress', true), '') = 'on' then
    if new.active and new.announced_at is null then
      update public.products set announced_at = now() where id = new.id;
    end if;
    return null;
  end if;
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

-- p_rows: [{ row, sku, name, name_en, description, description_en, category,
--            unit, retail_price, wholesale_price, stock, active, images: [url…] }]
-- (null / missing = keep the current value on update; images: null = keep)
-- Returns [{ row, sku, status: created|updated|rejected, id?, error? }]
create or replace function public.admin_import_products(p_rows jsonb, p_notify boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  i integer;
  n integer;
  res jsonb := '[]'::jsonb;
  v_sku text;
  v_p public.products%rowtype;
  v_found boolean;
  v_cat uuid;
  v_catname text;
  v_images text[];
  v_retail numeric;
  v_whole numeric;
  v_stock integer;
  v_active boolean;
  v_id uuid;
  v_name text;
begin
  perform public.assert_admin();
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'INVALID_INPUT'; end if;
  n := jsonb_array_length(p_rows);
  if n > 200 then raise exception 'TOO_MANY_ROWS'; end if;
  if not coalesce(p_notify, false) then
    perform set_config('eko.promo_suppress', 'on', true);   -- this transaction only
  end if;

  for i in 0 .. n - 1 loop
    r := p_rows -> i;
    v_sku := left(trim(coalesce(r ->> 'sku', '')), 100);
    begin
      if v_sku = '' then raise exception 'SKU_REQUIRED'; end if;

      v_cat := null;
      v_catname := nullif(trim(coalesce(r ->> 'category', '')), '');
      if v_catname is not null then
        select c.id into v_cat from public.categories c
         where lower(c.name_sq) = lower(v_catname) or lower(c.name_en) = lower(v_catname)
         order by (lower(c.name_sq) = lower(v_catname)) desc limit 1;
        if v_cat is null then raise exception 'CATEGORY_NOT_FOUND'; end if;
      end if;

      v_retail := nullif(r ->> 'retail_price', '')::numeric;
      v_whole := nullif(r ->> 'wholesale_price', '')::numeric;
      if v_retail < 0 or v_whole < 0 or v_retail > 9999999 or v_whole > 9999999 then raise exception 'INVALID_PRICE'; end if;
      v_stock := nullif(r ->> 'stock', '')::integer;
      if v_stock < 0 then raise exception 'INVALID_STOCK'; end if;
      v_active := nullif(r ->> 'active', '')::boolean;

      v_images := null;
      if jsonb_typeof(r -> 'images') = 'array' and jsonb_array_length(r -> 'images') > 0 then
        select array_agg(x) into v_images from jsonb_array_elements_text(r -> 'images') x where x <> '';
        if cardinality(v_images) > 10 then raise exception 'TOO_MANY_IMAGES'; end if;
        -- https only (http just for a local development stack); never javascript:, data: …
        if exists (select 1 from unnest(v_images) u
                    where u !~ '^https://[^\s]+$' and u !~ '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/[^\s]*$') then
          raise exception 'INVALID_IMAGE_URL';
        end if;
      end if;

      v_name := nullif(left(trim(coalesce(r ->> 'name', '')), 200), '');

      select * into v_p from public.products where lower(sku) = lower(v_sku) order by created_at limit 1 for update;
      v_found := found;

      if not v_found then
        if v_name is null then raise exception 'NAME_REQUIRED'; end if;
        if v_retail is null or v_whole is null then raise exception 'PRICE_REQUIRED'; end if;
        insert into public.products (sku, name, name_en, description, description_en, category_id,
          unit, images, retail_price, wholesale_price, stock, active)
        values (v_sku, v_name, left(coalesce(trim(r ->> 'name_en'), ''), 200),
          left(coalesce(r ->> 'description', ''), 5000), left(coalesce(r ->> 'description_en', ''), 5000),
          v_cat, coalesce(nullif(left(trim(coalesce(r ->> 'unit', '')), 30), ''), 'copë'), coalesce(v_images, '{}'),
          v_retail, v_whole, coalesce(v_stock, 0), coalesce(v_active, true))
        returning id into v_id;
        res := res || jsonb_build_object('row', r -> 'row', 'sku', v_sku, 'status', 'created', 'id', v_id);
      else
        update public.products set
          name = coalesce(v_name, name),
          name_en = coalesce(nullif(left(trim(coalesce(r ->> 'name_en', '')), 200), ''), name_en),
          description = coalesce(nullif(left(r ->> 'description', 5000), ''), description),
          description_en = coalesce(nullif(left(r ->> 'description_en', 5000), ''), description_en),
          category_id = coalesce(v_cat, category_id),
          unit = coalesce(nullif(left(trim(coalesce(r ->> 'unit', '')), 30), ''), unit),
          images = coalesce(v_images, images),
          retail_price = coalesce(v_retail, retail_price),
          wholesale_price = coalesce(v_whole, wholesale_price),
          stock = coalesce(v_stock, stock),
          active = coalesce(v_active, active)
        where id = v_p.id;
        res := res || jsonb_build_object('row', r -> 'row', 'sku', v_p.sku, 'status', 'updated', 'id', v_p.id);
      end if;
    exception when others then
      res := res || jsonb_build_object('row', r -> 'row', 'sku', v_sku, 'status', 'rejected',
        'error', case
          when sqlstate = '23505' then 'SKU_EXISTS'
          when sqlstate in ('22P02', '22003') then 'INVALID_NUMBER'
          when sqlerrm ~ '^[A-Z_]+$' then sqlerrm
          else 'ROW_FAILED' end);
    end;
  end loop;
  return res;
end $$;

revoke all on function public.admin_import_products(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.admin_import_products(jsonb, boolean) to authenticated;   -- re-checks is_admin()
revoke all on function public.products_promo_trigger() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
