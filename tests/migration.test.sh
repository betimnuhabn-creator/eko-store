#!/usr/bin/env bash
# Verifies the migration the way the Supabase SQL Editor runs it: the whole
# file sent as ONE query, as the `postgres` role, on a real Supabase database
# (local stack: `npx supabase start`).
#
#   bash tests/migration.test.sh
#
# Scenarios:
#   A. completely empty project (+ an unrelated function that must not be touched)
#   B. running the same script a second time
#   C. a failure in the middle rolls back everything
#   D. upgrade of a v0.2 database: existing data unchanged, order numbers
#   E. after the checks, the database is reset to the normal local state
set -euo pipefail
cd "$(dirname "$0")/.."

MIG=supabase/migrations/20261105000000_eko_store_v1.sql
LEGACY=supabase/legacy/schema_v0.2.sql
export PGPASSWORD=postgres
export PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
PARKED=$(mktemp -d)
pass=0; fail=0

q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { # name, sql, expected
  local got; got=$(q "$2" 2>&1 | tr -d '\n') || true
  if [[ "$got" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$3] got [$got]"; fi
}
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; } # one query string, like the SQL Editor

empty_project() {
  mv supabase/migrations/*.sql "$PARKED/"
  mv supabase/seed.sql "$PARKED/" 2>/dev/null || true
  npx supabase db reset >/dev/null 2>&1 || { restore; echo "db reset failed"; exit 1; }
  restore
}
restore() {
  mv "$PARKED"/*.sql supabase/migrations/ 2>/dev/null || true
  [[ -f "$PARKED/seed.sql" ]] && mv "$PARKED/seed.sql" supabase/ || true
  mv supabase/migrations/seed.sql supabase/ 2>/dev/null || true
}
trap restore EXIT

lines_for() { # product sku filter -> JSON cart, read as the owner (customers cannot read products)
  q "select jsonb_agg(jsonb_build_object('product_id',id,'quantity',1)) from public.products where $1"
}
order_as() { # uid, sku filter -> order number
  as_user "$1" "select (public.place_order('$(lines_for "$2")'::jsonb, '{\"name\":\"n\",\"phone\":\"p\",\"address\":\"a\",\"city\":\"c\"}'))->>'order_number'"
}
as_user() { # uid, sql  -> runs as the 'authenticated' API role with that user id
  q "begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, true); $2; commit;" | tail -n +2 | head -1
}

echo "A. Empty Supabase project"
empty_project
expect "project starts without EKO tables" "select count(*) from pg_tables where schemaname='public'" "0"
q "create function public.other_app_fn() returns int language sql as 'select 1'; grant execute on function public.other_app_fn() to anon;"
before=$(q "select proacl::text from pg_proc where proname='other_app_fn'")
if run_editor "$MIG"; then ok "migration succeeds on an empty project"; else bad "migration failed on empty project"; fi
expect "unrelated function privileges untouched" "select proacl::text from pg_proc where proname='other_app_fn'" "$before"
expect "anon can still execute the unrelated function" "select has_function_privilege('anon','public.other_app_fn()','execute')" "t"
expect "7 EKO tables, all with RLS" "select count(*) from pg_tables where schemaname='public' and rowsecurity and tablename in ('profiles','categories','products','orders','order_items','notifications','push_tokens')" "7"
expect "order_number is an identity column" "select is_identity from information_schema.columns where table_name='orders' and column_name='order_number'" "YES"
expect "photo bucket created" "select public from storage.buckets where id='product-images'" "t"
expect "3 default categories" "select count(*) from public.categories" "3"
expect "notifications in realtime publication" "select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='notifications'" "1"
q "insert into auth.users (id,email,aud,role,raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1','x@x.com','authenticated','authenticated','{\"full_name\":\"X\"}')"
q "insert into public.products (sku,name,retail_price,wholesale_price) values ('A',  'A', 10, 7)"
o1=$(order_as 00000000-0000-0000-0000-0000000000a1 "true")
[[ "$o1" == "1001" ]] && ok "first order gets number 1001" || bad "first order number: $o1"

echo "B. Running the script a second time"
if run_editor "$MIG"; then ok "second run succeeds"; else bad "second run failed"; fi
o2=$(order_as 00000000-0000-0000-0000-0000000000a1 "true")
[[ "$o2" == "1002" ]] && ok "numbering continues after re-run (1002)" || bad "order number after re-run: $o2"
expect "categories not duplicated" "select count(*) from public.categories" "3"
expect "existing order kept its number" "select string_agg(order_number::text, ',' order by order_number) from public.orders" "1001,1002"

echo "C. A failure rolls back the whole script"
empty_project
sed 's/^commit;$/select 1\/0;\ncommit;/' "$MIG" > "$PARKED/broken.sql"
if run_editor "$PARKED/broken.sql" 2>/dev/null; then bad "broken script should fail"; else ok "broken script reports an error"; fi
rm -f "$PARKED/broken.sql"
expect "nothing was created" "select count(*) from pg_tables where schemaname='public'" "0"
expect "no bucket was created" "select count(*) from storage.buckets where id='product-images'" "0"

echo "D. Upgrade of a v0.2 database (data must not change)"
"${PSQL[@]}" -f "$LEGACY" >/dev/null 2>&1 || true   # v0.2 script fails half-way (known bug), like in production
q "
insert into auth.users (id,email,aud,role,raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000001','admin@x.com','authenticated','authenticated','{\"full_name\":\"Admin\"}'),
 ('00000000-0000-0000-0000-000000000002','biz-ok@x.com','authenticated','authenticated','{\"full_name\":\"Approved\",\"requested_wholesale\":\"true\"}'),
 ('00000000-0000-0000-0000-000000000003','biz-wait@x.com','authenticated','authenticated','{\"full_name\":\"Waiting\",\"requested_wholesale\":\"true\"}'),
 ('00000000-0000-0000-0000-000000000004','retail@x.com','authenticated','authenticated','{\"full_name\":\"Retail\"}');
update public.profiles set role='admin', wholesale_approved=true where id='00000000-0000-0000-0000-000000000001';
update public.profiles set wholesale_approved=true where id='00000000-0000-0000-0000-000000000002';
insert into public.products (sku,name,description,image_url,retail_price,wholesale_price,stock) values
 ('P1','Rubinet',null,'https://x/1.jpg',10,7,5), ('P2','Tub','desc',null,3,2,0);
insert into public.orders (customer_id,status,total,created_at) values
 ('00000000-0000-0000-0000-000000000004','completed',20,'2026-01-03'),
 ('00000000-0000-0000-0000-000000000004','accepted',10,'2026-01-01'),
 ('00000000-0000-0000-0000-000000000002','new',7,'2026-01-02');
insert into public.order_items (order_id,product_id,quantity,unit_price)
 select o.id,p.id,1,o.total from public.orders o, public.products p where p.sku='P1';
"
snap() { q "select md5(string_agg(t, '|' order by t)) from (
  select row(id,full_name,phone,role,wholesale_approved,created_at)::text t from public.profiles union all
  select row(id,sku,name,description,image_url,retail_price,wholesale_price,stock,active,created_at)::text from public.products union all
  select row(id,customer_id,status,total,created_at)::text from public.orders union all
  select row(id,order_id,product_id,quantity,unit_price)::text from public.order_items) s"; }
before=$(snap)
if run_editor "$MIG"; then ok "upgrade succeeds"; else bad "upgrade failed"; fi
after=$(snap); [[ "$before" == "$after" ]] && ok "checksum of old data identical" || bad "old data changed"
expect "old orders numbered by date" "select string_agg(status||':'||order_number, ',' order by order_number) from public.orders" "accepted:1001,new:1002,completed:1003"
expect "legacy statuses kept" "select count(*) from public.orders where status in ('accepted','completed')" "2"
expect "wholesale status filled from v0.2 data" "select string_agg(email||'='||wholesale_status, ',' order by email) from public.profiles" "admin@x.com=none,biz-ok@x.com=approved,biz-wait@x.com=pending,retail@x.com=none"
expect "image copied into new images column" "select images[1] from public.products where sku='P1'" "https://x/1.jpg"
expect "order lines got name/SKU copies" "select product_name||'/'||sku from public.order_items limit 1" "Rubinet/P1"
tier_wait=$(as_user 00000000-0000-0000-0000-000000000003 "select price from public.list_products() where sku='P1'")
[[ "$tier_wait" == "10.00" ]] && ok "unapproved v0.2 'wholesale' account gets retail prices" || bad "pending tier: $tier_wait"
tier_ok=$(as_user 00000000-0000-0000-0000-000000000002 "select price from public.list_products() where sku='P1'")
[[ "$tier_ok" == "7.00" ]] && ok "approved v0.2 wholesale account keeps wholesale prices" || bad "approved tier: $tier_ok"
o=$(order_as 00000000-0000-0000-0000-000000000004 "sku='P1'")
[[ "$o" == "1004" ]] && ok "new order continues after old ones (1004)" || bad "next order number: $o"
expect "old place_order(jsonb) from v0.2 removed" "select count(*) from pg_proc where proname='place_order' and pronargs=1" "0"
before_rerun=$(snap)
if run_editor "$MIG"; then ok "re-run on upgraded database succeeds"; else bad "re-run failed"; fi
after2=$(snap); [[ "$before_rerun" == "$after2" ]] && ok "no data changed by the re-run" || bad "old data changed on re-run"

echo "E. Restoring the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "local database reset (migration + seed)" || bad "reset failed"

echo; echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
