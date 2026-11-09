#!/usr/bin/env bash
# Verifies 20261110000000_order_cancel_archive.sql the way the Supabase SQL
# Editor runs it (whole file as ONE query, role postgres), on the local stack.
#   bash tests/archive-migration.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

V1=supabase/migrations/20261105000000_eko_store_v1.sql
MIG=supabase/migrations/20261110000000_order_cancel_archive.sql
LEGACY=supabase/legacy/schema_v0.2.sql
export PGPASSWORD=postgres PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
PARKED=$(mktemp -d)
pass=0; fail=0
q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { local got; got=$(q "$2" 2>&1 | tr -d '\n') || true; [[ "$got" == "$3" ]] && ok "$1" || bad "$1 — expected [$3] got [$got]"; }
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; }
restore() { mv "$PARKED"/*.sql supabase/migrations/ 2>/dev/null || true; mv supabase/migrations/seed.sql supabase/ 2>/dev/null || true; }
trap restore EXIT
empty_project() { mv supabase/migrations/*.sql "$PARKED/"; mv supabase/seed.sql "$PARKED/"; npx supabase db reset >/dev/null 2>&1 || true; restore; }
as_user() { # uid, sql -> result (or ERROR text)
  "${PSQL[@]}" -tA -c "begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, true); $2; commit;" 2>&1 | tail -n +2 | head -1
}
as_err() { # uid, sql -> error message only
  "${PSQL[@]}" -tA -c "begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, true); $2; commit;" 2>&1 | grep -o 'ERROR: .*' | head -1 || true
}
U=00000000-0000-0000-0000-00000000000
ADMIN=${U}1; CUST=${U}2
snap() { q "select md5(string_agg(t, '|' order by t)) from (
  select row(id,email,raw_user_meta_data)::text t from auth.users union all
  select row(id,email,full_name,phone,role,wholesale_status,business_name,address,city,created_at)::text from public.profiles union all
  select row(id,order_number,customer_id,status,price_tier,total,item_count,payment_method,delivery_name,delivery_phone,delivery_address,delivery_city,customer_note,admin_note,created_at)::text from public.orders union all
  select row(id,order_id,product_id,quantity,unit_price,product_name,sku,unit)::text from public.order_items) s"; }
counts() { q "select (select count(*) from auth.users)||'/'||(select count(*) from public.profiles)||'/'||(select count(*) from public.orders)||'/'||(select count(*) from public.order_items)"; }

seed_v1_data() { # customers + one order in EVERY status incl. legacy accepted/completed
  q "
  insert into auth.users (id,email,aud,role,raw_user_meta_data) values
    ('$ADMIN','admin@x.com','authenticated','authenticated','{\"full_name\":\"Admin\"}'),
    ('$CUST','cust@x.com','authenticated','authenticated','{\"full_name\":\"Klient\"}');
  update public.profiles set role='admin' where id='$ADMIN';
  insert into public.products (sku,name,retail_price,wholesale_price,stock) values ('T1','Test',10,7,5);
  insert into public.orders (customer_id,status,total,item_count,delivery_name,delivery_phone,delivery_address,delivery_city,created_at)
  select '$CUST', s, 10, 1, 'Klient', '+383', 'Rr. 1', 'Prishtinë', now() - (i || ' minutes')::interval
  from unnest(array['new','confirmed','preparing','shipped','delivered','cancelled','accepted','completed']) with ordinality as t(s,i);
  insert into public.order_items (order_id,product_id,quantity,unit_price,product_name,sku,unit)
  select o.id, p.id, 1, 10, 'Test', 'T1', 'copë' from public.orders o, public.products p;"
}
oid() { q "select id from public.orders where status='$1' order by created_at limit 1"; }

echo "A. Database WITHOUT EKO Store v1 (wrong project): must stop, change nothing"
empty_project
if "${PSQL[@]}" -c "$(cat "$MIG")" >/dev/null 2>"$PARKED/err.txt"; then bad "should fail without v1"; else ok "stops with an error"; fi
grep -q "EKO Store v1 schema not found" "$PARKED/err.txt" && ok "clear message: run v1 first" || bad "message: $(cat "$PARKED/err.txt")"
expect "no tables created" "select count(*) from pg_tables where schemaname='public'" "0"
expect "no functions created" "select count(*) from pg_proc where proname in ('admin_cancel_order','admin_archive_order','admin_restore_order')" "0"

echo "B. v1 database with customers and orders in all 8 statuses"
"${PSQL[@]}" -c "$(cat "$V1")" >/dev/null
seed_v1_data
expect "orders per status before" "select string_agg(status, ',' order by status) from public.orders" "accepted,cancelled,completed,confirmed,delivered,new,preparing,shipped"
before=$(snap); before_c=$(counts)
open_before=$(as_user "$ADMIN" "select (public.admin_stats()->>'open_orders')")
run_editor "$MIG" && ok "migration run 1" || bad "run 1 failed"
run_editor "$MIG" && ok "migration run 2 (idempotent)" || bad "run 2 failed"
[[ "$(counts)" == "$before_c" ]] && ok "no rows lost (users/profiles/orders/lines = $before_c)" || bad "counts $before_c -> $(counts)"
[[ "$(snap)" == "$before" ]] && ok "checksum of all existing customer/order/line values identical" || bad "existing data changed"
expect "no order archived by the migration" "select count(*) from public.orders where archived_at is not null" "0"
expect "status rule unchanged (8 statuses incl. accepted/completed)" "select pg_get_constraintdef(oid) like '%accepted%' and pg_get_constraintdef(oid) like '%completed%' from pg_constraint where conname='orders_status_check'" "t"
expect "RLS still on, orders_select policy unchanged" "select relrowsecurity::text || (select count(*) from pg_policies where tablename='orders') from pg_class where oid='public.orders'::regclass" "true1"
expect "API roles still have no write privilege on orders" "select count(*) from information_schema.role_table_grants where table_name='orders' and grantee in ('anon','authenticated') and privilege_type<>'SELECT'" "0"
open_after=$(as_user "$ADMIN" "select (public.admin_stats()->>'open_orders')")
[[ "$open_before" == "5" && "$open_after" == "5" ]] && ok "open orders count unchanged (5: new, confirmed, preparing, shipped, accepted)" || bad "open orders $open_before -> $open_after"

echo "C. 'accepted' and the other statuses with the new actions"
for s in accepted new confirmed preparing shipped; do
  r=$(as_err "$ADMIN" "select public.admin_cancel_order('$(oid $s)', null)")
  [[ -z "$r" ]] && ok "admin can cancel a '$s' order" || bad "cancel $s: $r"
done
for s in delivered completed; do
  r=$(as_err "$ADMIN" "select public.admin_cancel_order('$(oid $s)', null)")
  [[ "$r" == *CANNOT_CANCEL_DELIVERED* ]] && ok "'$s' order cannot be cancelled" || bad "cancel $s: $r"
done
expect "customer notified for each cancelled order" "select count(*) from public.notifications where recipient_id='$CUST' and type='order_status' and data->>'status'='cancelled'" "5"
r=$(as_err "$ADMIN" "select public.admin_archive_order('$(oid delivered)')"); [[ "$r" == *ONLY_CANCELLED_CAN_BE_ARCHIVED* ]] && ok "non-cancelled order cannot be archived" || bad "archive delivered: $r"
CANC=$(q "select id from public.orders where status='cancelled' order by created_at limit 1")
r=$(as_err "$ADMIN" "select public.admin_archive_order('$CANC')"); [[ -z "$r" ]] && ok "cancelled order archived" || bad "archive: $r"
r=$(as_err "$ADMIN" "select public.admin_set_order_status('$CANC','new',null)"); [[ "$r" == *ORDER_ARCHIVED* ]] && ok "status change blocked while archived" || bad "$r"
r=$(as_err "$CUST" "select public.admin_restore_order('$CANC')"); [[ "$r" == *ADMIN_ONLY* ]] && ok "customer cannot restore" || bad "$r"
r=$(as_err "$CUST" "select public.admin_cancel_order('$(oid delivered)', null)"); [[ "$r" == *ADMIN_ONLY* ]] && ok "customer cannot cancel via admin function" || bad "$r"
expect "guests cannot execute the new functions" "select bool_or(has_function_privilege('anon',p.oid,'execute'))::text from pg_proc p where proname in ('admin_cancel_order','admin_archive_order','admin_restore_order')" "false"
expect "customer still sees all 8 orders (archived included)" "begin; set local role authenticated; select set_config('request.jwt.claims','{\"sub\":\"$CUST\",\"role\":\"authenticated\"}',true); select count(*) from public.orders; commit;" "$(printf '{"sub":"%s","role":"authenticated"}8' "$CUST")"

echo "D. Re-run after archiving: archive state and data preserved"
before=$(snap); arch=$(q "select archived_at::text from public.orders where id='$CANC'")
run_editor "$MIG" && ok "re-run after use" || bad "re-run failed"
[[ "$(snap)" == "$before" ]] && ok "no data changed" || bad "data changed on re-run"
expect "archived order still archived (same timestamp)" "select archived_at::text from public.orders where id='$CANC'" "$arch"
r=$(as_err "$ADMIN" "select public.admin_restore_order('$CANC')"); [[ -z "$r" ]] && ok "restore works" || bad "$r"
expect "restored order is cancelled and active" "select status||'/'||coalesce(archived_at::text,'active') from public.orders where id='$CANC'" "cancelled/active"

echo "E. Existing v1 order management still works"
r=$(as_err "$ADMIN" "select public.admin_set_order_status('$CANC','confirmed','reopened after restore')"); [[ -z "$r" ]] && ok "admin_set_order_status (v1) works" || bad "$r"
r=$(as_err "$CUST" "select public.place_order((select jsonb_agg(jsonb_build_object('product_id',id,'quantity',1)) from (select '$(q "select id from public.products limit 1")'::uuid as id) x), '{\"name\":\"n\",\"phone\":\"p\",\"address\":\"a\",\"city\":\"c\"}')"); [[ -z "$r" ]] && ok "customer can still place orders" || bad "$r"
NEWO=$(q "select id from public.orders where status='new' and archived_at is null order by created_at desc limit 1")
r=$(as_err "$CUST" "select public.cancel_my_order('$NEWO')"); [[ -z "$r" ]] && ok "customer can still cancel own new order (v1)" || bad "$r"

echo "F. Upgrade path v0.2 -> v1 -> archive migration (legacy 'accepted' orders)"
empty_project
"${PSQL[@]}" -f "$LEGACY" >/dev/null 2>&1 || true
q "insert into auth.users (id,email,aud,role) values ('$CUST','c@x.com','authenticated','authenticated');
   insert into public.products (sku,name,retail_price,wholesale_price,stock) values ('L1','Legacy',5,4,1);
   insert into public.orders (customer_id,status,total) values ('$CUST','accepted',5),('$CUST','completed',5);
   insert into public.order_items (order_id,product_id,quantity,unit_price) select o.id,p.id,1,5 from public.orders o, public.products p;"
run_editor "$V1"; run_editor "$MIG"; run_editor "$MIG"
expect "legacy statuses kept" "select string_agg(status, ',' order by status) from public.orders" "accepted,completed"
expect "legacy order lines kept" "select count(*) from public.order_items" "2"
expect "legacy 'accepted' counted as open" "select count(*) from public.orders where status in ('new','confirmed','preparing','shipped','accepted') and archived_at is null" "1"

echo "G. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
