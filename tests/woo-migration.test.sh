#!/usr/bin/env bash
# Verifies 20261215000000_woocommerce_sync.sql the way the SQL Editor runs it
# (whole file as ONE query, role postgres), on the LOCAL stack only.
#   bash tests/woo-migration.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=postgres PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
MIG=supabase/migrations/20261215000000_woocommerce_sync.sql
pass=0; fail=0
q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { local got; got=$(q "$2" 2>&1 | tr -d '\n') || true; [[ "$got" == "$3" ]] && ok "$1" || bad "$1 — expected [$3] got [$got]"; }
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; }
as_user() { q "begin; select set_config('request.jwt.claims','{\"sub\":\"$1\",\"role\":\"authenticated\"}',true) is null; set local role authenticated; $2; commit;" | sed -n 2p; }
w=$(mktemp -d); mkdir -p "$w/supabase/migrations"; cp supabase/config.toml "$w/supabase/"
npx supabase db reset --workdir "$w" >/dev/null 2>&1; rm -rf "$w"

echo "A. Without the earlier migrations the script refuses"
for f in supabase/migrations/2026110500*.sql; do run_editor "$f"; done
if run_editor "$MIG" 2>/dev/null; then bad "ran too early"; else ok "refused, nothing changed"; fi
expect "no woo table created" "select count(*) from pg_class where relname in ('woo_settings','woo_order_jobs')" "0"

echo "B. Production-like database with data"
for f in supabase/migrations/2026111000*.sql supabase/migrations/2026111200*.sql supabase/migrations/2026112000*.sql \
         supabase/migrations/2026112800*.sql supabase/migrations/2026120500*.sql supabase/migrations/2026121000*.sql; do run_editor "$f"; done
U=00000000-0000-0000-0000-00000000000
q "insert into auth.users (id,email,aud,role,raw_user_meta_data) values
 ('${U}1','admin@x.com','authenticated','authenticated','{}'), ('${U}2','retail@x.com','authenticated','authenticated','{}'),
 ('${U}3','ws@x.com','authenticated','authenticated','{}');
update public.profiles set role='admin' where id='${U}1';
update public.profiles set wholesale_status='approved', business_name='B' where id='${U}3';
insert into public.products (sku,name,retail_price,wholesale_price,stock) values ('P1','Rubinet',100,70,5), ('P2','Lavaman',0,50,1);
insert into public.orders (customer_id,status,total,item_count,delivery_name,delivery_phone,delivery_address,delivery_city) values ('${U}2','new',100,1,'K','1','A','C');" >/dev/null
snap() { q "select md5(string_agg(t,'|' order by t)) from (
  select row(id,email,role,wholesale_status,updated_at)::text t from public.profiles union all
  select row(id,sku,name,retail_price,wholesale_price,stock,active,images,category_id,updated_at)::text from public.products union all
  select row(id,status,total,updated_at)::text from public.orders union all
  select row(id,name_sq,sort_order)::text from public.categories) s"; }
prices() { echo "$(as_user "${U}2" "select string_agg(sku||'='||coalesce(price::text,'-'),',' order by sku) from public.list_products()")|$(as_user "${U}3" "select string_agg(sku||'='||coalesce(price::text,'-'),',' order by sku) from public.list_products()")"; }
before=$(snap); prices_before=$(prices)

echo "C. Migration twice"
run_editor "$MIG" && ok "run 1" || bad "run 1"
run_editor "$MIG" && ok "run 2 (idempotent)" || bad "run 2"
[[ "$(snap)" == "$before" ]] && ok "existing profiles, products, orders, categories identical" || bad "existing data changed"
expect "existing products are app products (source app, no WooCommerce id)" "select count(*) filter (where source='app' and woo_id is null)||'/'||count(*) from public.products" "2/2"
[[ "$(prices)" == "$prices_before" ]] && ok "app products: prices for retail and wholesale customers unchanged ($prices_before)" || bad "prices changed: $(prices) vs $prices_before"
expect "orders switched OFF by default" "select orders_enabled::text from public.woo_settings" "false"
expect "service-only functions" "select string_agg(has_function_privilege('authenticated', p.oid, 'execute')::text, ',') from pg_proc p where proname in ('woo_apply_products','woo_claim_order_jobs','woo_finish_order_job','woo_hide_product','woo_dispatch')" "false,false,false,false,false"
expect "woo tables: RLS on, no API access" "select string_agg(relrowsecurity::text||has_table_privilege('authenticated', oid, 'select')::text, ',') from pg_class where relname in ('woo_settings','woo_order_jobs')" "truefalse,truefalse"

echo "D. Behaviour"
q "select public.woo_apply_products('[{\"woo_id\":10,\"sku\":\"P1\",\"name\":\"Rubinet (web)\",\"retail_price\":0,\"wholesale_price\":65,\"stock\":999,\"active\":true,\"category\":{\"woo_id\":5,\"name\":\"Instalime\"},\"images\":[\"https://x.test/a.jpg\",\"javascript:alert(1)\"]}]'::jsonb, false, false)" >/dev/null
expect "existing app product with the same SKU linked to the website (not duplicated)" "select count(*)||'/'||max(source)||'/'||max(woo_id)||'/'||max(name)||'/'||max(cardinality(images)) from public.products where sku='P1'" "1/woo/10/Rubinet (web)/1"
PID=$(q "select id from public.products where sku='P1'")
expect "category created from the website" "select name_sq||'/'||woo_id from public.categories where woo_id=5" "Instalime/5"
r=$(as_user "${U}2" "select coalesce(price::text,'-') from public.list_products() where sku='P1'"); [[ "$r" == "-" ]] && ok "retail: website product without retail price → no price" || bad "retail sees [$r]"
r=$(as_user "${U}3" "select price::text from public.list_products() where sku='P1'"); [[ "$r" == "65.00" ]] && ok "wholesale: wholesale price (65)" || bad "wholesale sees [$r]"
r=$(as_user "${U}2" "select coalesce(price::text,'-') from public.list_products() where sku='P2'"); [[ "$r" == "0.00" ]] && ok "app product with retail 0 keeps the old behaviour" || bad "P2 retail [$r]"
err=$(as_user "${U}2" "select public.place_order(jsonb_build_array(jsonb_build_object('product_id','$PID','quantity',1)), '{\"name\":\"a\",\"phone\":\"1\",\"address\":\"b\",\"city\":\"c\"}')" 2>&1 || true)
[[ "$err" == *RETAIL_PRICE_MISSING* ]] && ok "retail cannot order it (RETAIL_PRICE_MISSING)" || bad "retail order: [$err]"
as_user "${U}3" "select public.place_order(jsonb_build_array(jsonb_build_object('product_id','$PID','quantity',2)), '{\"name\":\"a\",\"phone\":\"1\",\"address\":\"b\",\"city\":\"c\"}')" >/dev/null
expect "wholesale order works; not queued while orders are OFF" "select (select count(*) from public.woo_order_jobs)||'/'||(select total from public.orders order by created_at desc limit 1)" "0/130.00"
q "update public.woo_settings set orders_enabled = true" >/dev/null
as_user "${U}3" "select public.place_order(jsonb_build_array(jsonb_build_object('product_id','$PID','quantity',1)), '{\"name\":\"a\",\"phone\":\"1\",\"address\":\"b\",\"city\":\"c\"}')" >/dev/null
expect "orders ON → queued for WooCommerce" "select kind||'/'||status from public.woo_order_jobs" "create/pending"
q "update public.orders set status='confirmed' where id=(select order_id from public.woo_order_jobs limit 1)" >/dev/null
expect "status change → status job" "select count(*) from public.woo_order_jobs where kind='status'" "1"
expect "scheduler does nothing without the functions address" "select coalesce(public.woo_dispatch()::text,'null')" "null"
q "select public.woo_apply_products('[{\"woo_id\":11,\"sku\":\"W2\",\"name\":\"X\",\"retail_price\":1,\"wholesale_price\":1}]'::jsonb, true, false)" >/dev/null
expect "full list without a website product → it is hidden (kept for orders)" "select active::text from public.products where woo_id=10" "false"

echo "E. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
