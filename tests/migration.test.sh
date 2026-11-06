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
#   D. upgrade of a v0.2 database: every wholesale_approved combination,
#      existing data unchanged (checksums), order numbers, admin decisions kept on re-run
#   F. order_number already present as a plain, partly filled column
#   G. order numbers entered manually above the counter, then re-run
#   H. normal CLI path (supabase db reset + seed), then the file run again on top
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

echo "D. Upgrade of a v0.2 database"
"${PSQL[@]}" -f "$LEGACY" >/dev/null 2>&1 || true   # v0.2 script stops half-way (its known bug), as in production
expect "v0.2 left its place_order missing (known v0.2 bug)" "select count(*) from pg_proc where proname='place_order'" "0"
U=00000000-0000-0000-0000-00000000000
q "
insert into auth.users (id,email,aud,role,raw_user_meta_data) values
 ('${U}1','admin@x.com','authenticated','authenticated','{\"full_name\":\"Admin\"}'),
 ('${U}2','biz-ok@x.com','authenticated','authenticated','{\"full_name\":\"Approved\",\"requested_wholesale\":\"true\"}'),
 ('${U}3','biz-wait@x.com','authenticated','authenticated','{\"full_name\":\"Waiting\",\"requested_wholesale\":\"true\"}'),
 ('${U}4','retail@x.com','authenticated','authenticated','{\"full_name\":\"Retail\"}'),
 ('${U}5','retail-flag@x.com','authenticated','authenticated','{\"full_name\":\"Retail flagged\"}'),
 ('${U}6','admin2@x.com','authenticated','authenticated','{\"full_name\":\"Admin 2\"}');
update public.profiles set role='admin', wholesale_approved=true where id='${U}1';
update public.profiles set wholesale_approved=true where id='${U}2';
update public.profiles set wholesale_approved=true where id='${U}5';
update public.profiles set role='admin' where id='${U}6';
insert into public.products (sku,name,description,image_url,retail_price,wholesale_price,stock) values
 ('P1','Rubinet',null,'https://x/1.jpg',10,7,5), ('P2','Tub','desc',null,3,2,0);
insert into public.orders (customer_id,status,total,created_at) values
 ('${U}4','completed',20,'2026-01-03'),
 ('${U}4','accepted',10,'2026-01-01'),
 ('${U}2','new',7,'2026-01-02');
insert into public.order_items (order_id,product_id,quantity,unit_price)
 select o.id,p.id,1,o.total from public.orders o, public.products p where p.sku='P1';
"
expect "v0.2 test data: 6 users, 2 products, 3 orders, 3 lines" "select (select count(*) from auth.users)||','||(select count(*) from public.profiles)||','||(select count(*) from public.products)||','||(select count(*) from public.orders)||','||(select count(*) from public.order_items)" "6,6,2,3,3"
expect "v0.2 roles/flags as created" "select string_agg(u.email||'='||p.role||'/'||p.wholesale_approved, ',' order by u.email collate \"C\") from public.profiles p join auth.users u on u.id = p.id" "admin2@x.com=admin/false,admin@x.com=admin/true,biz-ok@x.com=wholesale/true,biz-wait@x.com=wholesale/false,retail-flag@x.com=retail/true,retail@x.com=retail/false"
snap() { q "select md5(string_agg(t, '|' order by t)) from (
  select row(id,email,raw_user_meta_data)::text t from auth.users union all
  select row(id,full_name,phone,role,wholesale_approved,created_at)::text from public.profiles union all
  select row(id,sku,name,description,image_url,retail_price,wholesale_price,stock,active,created_at)::text from public.products union all
  select row(id,customer_id,status,total,created_at)::text from public.orders union all
  select row(id,order_id,product_id,quantity,unit_price)::text from public.order_items) s"; }
counts() { q "select (select count(*) from auth.users)||','||(select count(*) from public.profiles)||','||(select count(*) from public.products)||','||(select count(*) from public.orders)||','||(select count(*) from public.order_items)"; }
before=$(snap); before_counts=$(counts)
if run_editor "$MIG"; then ok "upgrade succeeds"; else bad "upgrade failed"; fi
[[ "$(counts)" == "$before_counts" ]] && ok "no rows lost (users, profiles, products, orders, lines: $before_counts)" || bad "row counts changed: $before_counts -> $(counts)"
[[ "$before" == "$(snap)" ]] && ok "checksum of every v0.2 value identical" || bad "v0.2 data changed"
expect "legacy columns kept (wholesale_approved, image_url)" "select count(*) from information_schema.columns where table_schema='public' and ((table_name='profiles' and column_name='wholesale_approved') or (table_name='products' and column_name='image_url'))" "2"
expect "wholesale_status from every legacy combination" "select string_agg(email||'='||wholesale_status, ',' order by email collate \"C\") from public.profiles" "admin2@x.com=none,admin@x.com=none,biz-ok@x.com=approved,biz-wait@x.com=pending,retail-flag@x.com=none,retail@x.com=none"
price_of() { as_user "$1" "select price from public.list_products() where sku='P1'"; }
for c in "2:7.00:approved wholesale (role wholesale + approved) keeps wholesale price" \
         "3:10.00:unapproved wholesale (role wholesale + not approved) gets retail price" \
         "4:10.00:retail customer gets retail price" \
         "5:10.00:retail role with wholesale_approved=true gets retail price (same as v0.2)"; do
  IFS=: read -r n want label <<<"$c"
  got=$(price_of "${U}$n"); [[ "$got" == "$want" ]] && ok "$label" || bad "$label — got $got"
done
admin_wholesale=$(as_user "${U}1" "select wholesale_price from public.list_products() where sku='P1'")
[[ "$admin_wholesale" == "7.00" ]] && ok "admin still sees both prices" || bad "admin view: $admin_wholesale"
expect "old orders numbered by date" "select string_agg(status||':'||order_number, ',' order by order_number) from public.orders" "accepted:1001,new:1002,completed:1003"
expect "legacy statuses kept" "select count(*) from public.orders where status in ('accepted','completed')" "2"
expect "image copied into new images column" "select images[1] from public.products where sku='P1'" "https://x/1.jpg"
expect "order lines got name/SKU copies" "select string_agg(distinct product_name||'/'||sku, ',') from public.order_items" "Rubinet/P1"
expect "v0.2 policies removed (e.g. profile_admin_update)" "select count(*) from pg_policies where schemaname='public' and policyname in ('profile_admin_update','products_admin_all','products_read','profile_read','orders_read','items_read','orders_admin_update')" "0"
expect "v0.2 column grants on products removed" "select count(*) from information_schema.column_privileges where table_schema='public' and table_name='products' and grantee in ('anon','authenticated')" "0"
expect "v0.2 guest_catalog() removed" "select count(*) from pg_proc where proname='guest_catalog'" "0"
o=$(order_as "${U}4" "sku='P1'"); [[ "$o" == "1004" ]] && ok "new order continues after old ones (1004)" || bad "next order number: $o"

echo "D2. Admin decisions after the upgrade survive a re-run"
as_user "${U}1" "select public.admin_review_wholesale('${U}2', false)" >/dev/null   # revoke a v0.2-approved account
as_user "${U}1" "select public.admin_review_wholesale('${U}3', true)" >/dev/null    # approve the waiting one
expect "state after admin decisions" "select string_agg(email||'='||role||'/'||wholesale_status, ',' order by email) from public.profiles where id in ('${U}2','${U}3')" "biz-ok@x.com=retail/rejected,biz-wait@x.com=wholesale/approved"
numbers_before=$(q "select md5(string_agg(id||':'||order_number, ',' order by id)) from public.orders")
before_rerun=$(snap); counts_rerun=$(counts)
if run_editor "$MIG"; then ok "re-run on upgraded database succeeds"; else bad "re-run failed"; fi
expect "admin decisions NOT overwritten by the legacy backfill" "select string_agg(email||'='||role||'/'||wholesale_status, ',' order by email) from public.profiles where id in ('${U}2','${U}3')" "biz-ok@x.com=retail/rejected,biz-wait@x.com=wholesale/approved"
[[ "$before_rerun" == "$(snap)" && "$counts_rerun" == "$(counts)" ]] && ok "re-run changed no data and lost no rows" || bad "re-run changed data"
expect "re-run did not renumber orders" "select md5(string_agg(id||':'||order_number, ',' order by id)) from public.orders" "$numbers_before"
o=$(order_as "${U}4" "sku='P1'"); [[ "$o" == "1005" ]] && ok "numbering continues after re-run (1005)" || bad "next after re-run: $o"
p2=$(price_of "${U}2"); [[ "$p2" == "10.00" ]] && ok "revoked account stays on retail price after re-run" || bad "revoked price $p2"

echo "F. order_number already present as a plain, partly filled column"
empty_project
"${PSQL[@]}" -f "$LEGACY" >/dev/null 2>&1 || true
q "
insert into auth.users (id,email,aud,role) values ('${U}7','f@x.com','authenticated','authenticated');
alter table public.orders add column order_number bigint;
insert into public.orders (customer_id,status,total,created_at,order_number) values
 ('${U}7','new',1,'2026-02-01',5000), ('${U}7','new',2,'2026-02-03',null), ('${U}7','new',3,'2026-02-02',null);
"
if run_editor "$MIG"; then ok "migration succeeds with an existing plain order_number column"; else bad "migration failed (F)"; fi
expect "existing number kept, missing ones filled by date after the highest" "select string_agg(total::int||':'||order_number, ',' order by total) from public.orders" "1:5000,2:5002,3:5001"
expect "column became an identity" "select is_identity from information_schema.columns where table_name='orders' and column_name='order_number'" "YES"
q "insert into public.products (sku,name,retail_price,wholesale_price) values ('F1','F',1,1)"
o=$(order_as "${U}7" "sku='F1'"); [[ "$o" == "5003" ]] && ok "next order is 5003" || bad "next order (F): $o"

echo "G. Numbers entered manually above the counter, then re-run"
q "insert into public.orders (customer_id,status,total,order_number) values ('${U}7','new',9,7000)"
if run_editor "$MIG"; then ok "re-run succeeds"; else bad "re-run failed (G)"; fi
o=$(order_as "${U}7" "sku='F1'"); [[ "$o" == "7001" ]] && ok "counter moved past the manual number (7001), no duplicate" || bad "next order (G): $o"
if run_editor "$MIG"; then ok "third run succeeds"; else bad "third run failed"; fi
o=$(order_as "${U}7" "sku='F1'"); [[ "$o" == "7002" ]] && ok "counter never moves backwards (7002)" || bad "next order (G2): $o"
expect "order numbers unique" "select count(*) = count(distinct order_number) from public.orders" "t"

echo "H. Normal CLI path, then the SQL file again on top (seeded data)"
npx supabase db reset >/dev/null 2>&1 && ok "supabase db reset applies migration + seed" || bad "db reset failed"
seed_snap=$(q "select md5(string_agg(row(id,sku,name,retail_price,wholesale_price,stock,images,category_id)::text, '|' order by sku)) from public.products")
if run_editor "$MIG"; then ok "running the SQL file again on a migrated database succeeds"; else bad "re-run (H) failed"; fi
expect "seeded products unchanged" "select md5(string_agg(row(id,sku,name,retail_price,wholesale_price,stock,images,category_id)::text, '|' order by sku)) from public.products" "$seed_snap"
expect "still exactly one of each EKO policy on products-images storage" "select count(*) from pg_policies where schemaname='storage' and policyname like 'product images%'" "4"

echo; echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
