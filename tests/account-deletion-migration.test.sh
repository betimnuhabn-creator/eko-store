#!/usr/bin/env bash
# Verifies 20261205000000_account_deletion.sql the way the SQL Editor runs it
# (whole file as ONE query, role postgres), on the LOCAL stack only.
#   bash tests/account-deletion-migration.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=postgres PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
MIG=supabase/migrations/20261205000000_account_deletion.sql
pass=0; fail=0
q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { local got; got=$(q "$2" 2>&1 | tr -d '\n') || true; [[ "$got" == "$3" ]] && ok "$1" || bad "$1 — expected [$3] got [$got]"; }
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; }
w=$(mktemp -d); mkdir -p "$w/supabase/migrations"; cp supabase/config.toml "$w/supabase/"
npx supabase db reset --workdir "$w" >/dev/null 2>&1; rm -rf "$w"

echo "A. Without the earlier migrations the script refuses and changes nothing"
if run_editor "$MIG" 2>/dev/null; then bad "ran on an empty database"; else ok "refused"; fi
expect "no audit table created" "select count(*) from pg_class where relname='account_deletion_audit'" "0"

echo "B. Production-like database (all earlier migrations) with data"
for f in supabase/migrations/2026110500*.sql supabase/migrations/2026111000*.sql supabase/migrations/2026111200*.sql \
         supabase/migrations/2026112000*.sql supabase/migrations/2026112800*.sql; do run_editor "$f"; done
U=00000000-0000-0000-0000-00000000000
q "insert into auth.users (id,email,aud,role,raw_user_meta_data) values
 ('${U}1','admin@x.com','authenticated','authenticated','{\"full_name\":\"Admin\"}'),
 ('${U}2','klient@x.com','authenticated','authenticated','{\"full_name\":\"Klient\"}'),
 ('${U}3','tjeter@x.com','authenticated','authenticated','{\"full_name\":\"Tjetër\"}');
update public.profiles set role='admin' where id='${U}1';
insert into public.products (sku,name,retail_price,wholesale_price,stock) values ('P1','Rubinet',100,70,5);
insert into public.orders (customer_id,status,total,item_count,delivery_name,delivery_phone,delivery_address,delivery_city) values
 ('${U}2','delivered',100,1,'Klient','044','Rr. 1','Prishtinë'), ('${U}2','new',50,1,'Klient','044','Rr. 1','Prishtinë'),
 ('${U}3','new',70,1,'Tjetër','045','Rr. 2','Pejë');
insert into public.order_items (order_id,product_id,product_name,quantity,unit_price)
 select o.id, p.id, 'Rubinet', 1, o.total from public.orders o, public.products p;
insert into public.push_tokens (user_id,token,platform) values ('${U}2','tok-2','android'), ('${U}3','tok-3','android');
insert into public.notifications (recipient_id,type,data) values ('${U}2','order_status','{}'), ('${U}3','order_status','{}');
insert into public.password_reset_audit (admin_id,admin_email,customer_id,customer_email) values ('${U}1','admin@x.com','${U}2','klient@x.com');" >/dev/null
snap() { q "select md5(string_agg(t,'|' order by t)) from (
  select row(id,email)::text t from auth.users union all
  select row(id,role,full_name,phone,updated_at)::text from public.profiles union all
  select row(id,customer_id,status,total,delivery_name,updated_at)::text from public.orders union all
  select row(id,order_id,quantity,unit_price)::text from public.order_items union all
  select row(user_id,token)::text from public.push_tokens union all
  select row(id,recipient_id)::text from public.notifications union all
  select row(id,customer_email)::text from public.password_reset_audit) s"; }
before=$(snap)

echo "C. Migration twice"
run_editor "$MIG" && ok "run 1" || bad "run 1"
run_editor "$MIG" && ok "run 2 (idempotent)" || bad "run 2"
[[ "$(snap)" == "$before" ]] && ok "existing users, profiles, orders, lines, tokens, notifications, audit identical" || bad "existing data changed"
expect "audit table: RLS on, no API access" "select relrowsecurity::text||'/'||has_table_privilege('authenticated','public.account_deletion_audit','select')::text||'/'||has_table_privilege('anon','public.account_deletion_audit','select')::text from pg_class where oid='public.account_deletion_audit'::regclass" "true/false/false"
expect "delete_customer_account: service_role only" "select has_function_privilege('service_role','public.delete_customer_account(uuid,uuid)','execute')::text||'/'||has_function_privilege('authenticated','public.delete_customer_account(uuid,uuid)','execute')::text||'/'||has_function_privilege('anon','public.delete_customer_account(uuid,uuid)','execute')::text" "true/false/false"
expect "delete_my_account still for logged-in users only" "select has_function_privilege('authenticated','public.delete_my_account()','execute')::text||'/'||has_function_privilege('anon','public.delete_my_account()','execute')::text" "true/false"
expect "both functions: security definer + empty search_path" "select string_agg(prosecdef::text||array_to_string(proconfig,','),' ' order by proname) from pg_proc where proname in ('delete_customer_account','delete_my_account')" "truesearch_path=\"\" truesearch_path=\"\""

echo "D. Behaviour"
if q "select public.delete_customer_account('${U}1','${U}1')" >/dev/null 2>&1; then bad "admin deleted"; else ok "an administrator is never deleted (TARGET_IS_ADMIN)"; fi
if q "select public.delete_customer_account('${U}2','${U}3')" >/dev/null 2>&1; then bad "customer deleted another"; else ok "a customer cannot delete another customer (NOT_ALLOWED)"; fi
expect "admin deletes customer 2 → orders kept / open" "select public.delete_customer_account('${U}2','${U}1')::text" '{"open_orders": 1, "orders_kept": 2}'
expect "customer 2: Auth, profile, tokens, notifications gone" "select (select count(*) from auth.users where id='${U}2')||'/'||(select count(*) from public.profiles where id='${U}2')||'/'||(select count(*) from public.push_tokens where user_id='${U}2')||'/'||(select count(*) from public.notifications where recipient_id='${U}2')" "0/0/0/0"
expect "orders + lines kept, unlinked, delivery data intact" "select count(*)||'/'||count(*) filter (where customer_id is null)||'/'||min(delivery_name)||'/'||(select count(*) from public.order_items i where i.order_id = any(array_agg(o.id))) from public.orders o where delivery_name='Klient'" "2/2/Klient/2"
expect "password audit kept without the e-mail" "select count(*)||'/'||max(customer_email) from public.password_reset_audit where customer_id='${U}2'" "1/"
expect "deletion audit: admin, 2 orders, no personal data" "select via||'/'||admin_id||'/'||orders_kept||'/'||open_orders from public.account_deletion_audit where deleted_user_id='${U}2'" "admin/${U}1/2/1"
expect "customer 3 untouched" "select (select count(*) from auth.users where id='${U}3')||'/'||(select count(*) from public.push_tokens where user_id='${U}3')||'/'||(select customer_id::text from public.orders where delivery_name='Tjetër')" "1/1/${U}3"
q "begin; select set_config('request.jwt.claims','{\"sub\":\"${U}3\",\"role\":\"authenticated\"}',true); set local role authenticated; select public.delete_my_account(); commit;" >/dev/null
expect "customer 3 deletes self (as the old app does) → recorded as self, Auth account gone" "select via||'/'||(select count(*) from auth.users where id='${U}3') from public.account_deletion_audit where deleted_user_id='${U}3'" "self/0"

echo "E. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
