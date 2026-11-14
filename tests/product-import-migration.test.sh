#!/usr/bin/env bash
# Verifies 20261128000000_product_import.sql the way the SQL Editor runs it
# (whole file as ONE query, role postgres), on the LOCAL stack only.
#   bash tests/product-import-migration.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=postgres PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
MIG=supabase/migrations/20261128000000_product_import.sql
pass=0; fail=0
q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { local got; got=$(q "$2" 2>&1 | tr -d '\n') || true; [[ "$got" == "$3" ]] && ok "$1" || bad "$1 — expected [$3] got [$got]"; }
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; }
w=$(mktemp -d); mkdir -p "$w/supabase/migrations"; cp supabase/config.toml "$w/supabase/"
npx supabase db reset --workdir "$w" >/dev/null 2>&1; rm -rf "$w"

echo "A. Without the earlier migrations the script refuses and changes nothing"
if run_editor "$MIG" 2>/dev/null; then bad "ran on an empty database"; else ok "refused (Run the EKO Store v1 and offers migrations first)"; fi

echo "B. Production-like database (all earlier migrations) with data"
for f in supabase/migrations/2026110500*.sql supabase/migrations/2026111000*.sql supabase/migrations/2026111200*.sql supabase/migrations/2026112000*.sql; do run_editor "$f"; done
U=00000000-0000-0000-0000-00000000000
q "insert into auth.users (id,email,aud,role,raw_user_meta_data) values
 ('${U}1','admin@x.com','authenticated','authenticated','{\"full_name\":\"Admin\"}'),
 ('${U}2','klient@x.com','authenticated','authenticated','{\"full_name\":\"Klient\"}');
update public.profiles set role='admin' where id='${U}1';
insert into public.categories (name_sq,name_en) values ('Ngrohje','Heating');
insert into public.products (sku,name,retail_price,wholesale_price,stock,images) values
 ('P1','Rubinet',100,70,5,'{https://x.supabase.co/storage/v1/object/public/product-images/p1.jpg}'),
 ('P2','Lavaman',200,150,2,'{}');
insert into public.orders (customer_id,status,total,item_count,delivery_name,delivery_phone,delivery_address,delivery_city) values ('${U}2','new',100,1,'K','1','A','C');" >/dev/null
snap() { q "select md5(string_agg(t,'|' order by t)) from (
  select row(id,email)::text t from auth.users union all
  select row(id,role,wholesale_status,updated_at)::text from public.profiles union all
  select row(id,status,total,updated_at)::text from public.orders union all
  select row(id,sku,name,retail_price,wholesale_price,stock,images,active,announced_at,updated_at)::text from public.products union all
  select row(id,kind,product_id)::text from public.promo_events) s"; }
before=$(snap)

echo "C. Migration twice"
run_editor "$MIG" && ok "run 1" || bad "run 1"
run_editor "$MIG" && ok "run 2 (idempotent)" || bad "run 2"
[[ "$(snap)" == "$before" ]] && ok "existing users, profiles, orders, products, promo events identical" || bad "existing data changed"
expect "SKU index created once" "select count(*) from pg_indexes where indexname='products_sku_lower_idx'" "1"
expect "only authenticated may execute (and anon may not)" "select has_function_privilege('authenticated','public.admin_import_products(jsonb,boolean)','execute')::text||'/'||has_function_privilege('anon','public.admin_import_products(jsonb,boolean)','execute')::text" "true/false"
expect "security definer + empty search_path" "select prosecdef::text||'/'||array_to_string(proconfig,',') from pg_proc where proname='admin_import_products'" "true/search_path=\"\""

echo "D. Normal saves still create promotional events (behaviour unchanged)"
q "update public.products set retail_price = 90 where sku='P1'" >/dev/null
expect "price change outside an import → 1 price event" "select count(*) from public.promo_events where kind='price'" "1"
q "insert into public.products (sku,name,retail_price,wholesale_price) values ('P3','I ri',5,4)" >/dev/null
expect "new product outside an import → new_product event" "select count(*) from public.promo_events e join public.products p on p.id=e.product_id where p.sku='P3'" "1"

echo "E. Import (as the admin)"
as_user() { q "begin; select set_config('request.jwt.claims','{\"sub\":\"$1\",\"role\":\"authenticated\"}',true); set local role authenticated; $2; commit;"; }
res=$(as_user "${U}1" "select public.admin_import_products('[{\"row\":2,\"sku\":\"p1\",\"retail_price\":80},{\"row\":3,\"sku\":\"N1\",\"name\":\"Bojler\",\"category\":\"ngrohje\",\"retail_price\":10,\"wholesale_price\":8,\"images\":[\"https://x.supabase.co/a.jpg\"]},{\"row\":4,\"sku\":\"N2\",\"name\":\"Pa çmim\"},{\"row\":5,\"sku\":\"N3\",\"name\":\"X\",\"retail_price\":1,\"wholesale_price\":1,\"images\":[\"javascript:alert(1)\"]},{\"row\":6,\"sku\":\"N4\",\"name\":\"X\",\"retail_price\":-1,\"wholesale_price\":1}]'::jsonb)" | sed -n 2p)
echo "$res" | grep -q '"sku": "P1", "status": "updated"' && ok "existing SKU (other case) updated, not duplicated" || bad "update: $res"
echo "$res" | grep -q '"sku": "N1", "status": "created"' && ok "new SKU created" || bad "create: $res"
echo "$res" | grep -q '"error": "PRICE_REQUIRED"' && ok "new product without prices rejected" || bad "price required: $res"
echo "$res" | grep -q '"error": "INVALID_IMAGE_URL"' && ok "javascript: photo link rejected" || bad "image url: $res"
echo "$res" | grep -q '"error": "INVALID_PRICE"' && ok "negative price rejected" || bad "negative: $res"
expect "P1: only the retail price changed" "select retail_price||'/'||wholesale_price||'/'||name||'/'||stock||'/'||cardinality(images) from public.products where sku='P1'" "80.00/70.00/Rubinet/5/1"
expect "no duplicate SKUs" "select count(*) from public.products where lower(sku) in ('p1','n1')" "2"
expect "N1 in the category, announced, no promo event (notify off)" "select (c.name_sq)||'/'||(p.announced_at is not null)::text||'/'||(select count(*) from public.promo_events e where e.product_id=p.id) from public.products p join public.categories c on c.id=p.category_id where p.sku='N1'" "Ngrohje/true/0"
expect "no price event for the imported price change" "select count(*) from public.promo_events where kind='price'" "1"
if as_user "${U}2" "select public.admin_import_products('[]'::jsonb)" >/dev/null 2>&1; then bad "customer could import"; else ok "a customer gets ADMIN_ONLY"; fi
q "update public.products set retail_price = 70 where sku='P1'" >/dev/null
expect "after the import, a normal save records the price change again (merged into the pending event: 100 → 70)" "select count(*)||'/'||max(data->>'retail_old')||'/'||max(data->>'retail_new') from public.promo_events where kind='price'" "1/100.00/70.00"

echo "F. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
