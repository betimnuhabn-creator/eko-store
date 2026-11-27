#!/usr/bin/env bash
# Verifies 20261120000000_admin_password_reset.sql the way the SQL Editor runs
# it (whole file as ONE query, role postgres), on the LOCAL stack only.
#   bash tests/admin-password-migration.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=postgres PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
MIG=supabase/migrations/20261120000000_admin_password_reset.sql
pass=0; fail=0
q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { local got; got=$(q "$2" 2>&1 | tr -d '\n') || true; [[ "$got" == "$3" ]] && ok "$1" || bad "$1 — expected [$3] got [$got]"; }
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; }
w=$(mktemp -d); mkdir -p "$w/supabase/migrations"; cp supabase/config.toml "$w/supabase/"
npx supabase db reset --workdir "$w" >/dev/null 2>&1; rm -rf "$w"
echo "A. Production-like database (all earlier migrations) with data"
for f in supabase/migrations/2026110500*.sql supabase/migrations/2026111000*.sql supabase/migrations/2026111200*.sql; do run_editor "$f"; done
U=00000000-0000-0000-0000-00000000000
q "insert into auth.users (id,email,aud,role,raw_user_meta_data,encrypted_password) values
 ('${U}1','admin@x.com','authenticated','authenticated','{\"full_name\":\"Admin\"}', crypt('a', gen_salt('bf'))),
 ('${U}2','klient@x.com','authenticated','authenticated','{\"full_name\":\"Klient\"}', crypt('b', gen_salt('bf')));
update public.profiles set role='admin' where id='${U}1';
insert into public.products (sku,name,retail_price,wholesale_price,stock) values ('P1','Rubinet',100,70,5);
insert into public.orders (customer_id,status,total,item_count,delivery_name,delivery_phone,delivery_address,delivery_city) values ('${U}2','new',100,1,'K','1','A','C');
insert into public.notifications (recipient_id,type,data) values ('${U}2','order_status','{}');"
snap() { q "select md5(string_agg(t,'|' order by t)) from (
  select row(id,email,encrypted_password)::text t from auth.users union all
  select row(id,email,full_name,role,wholesale_status,created_at,updated_at)::text from public.profiles union all
  select row(id,status,total,created_at,updated_at)::text from public.orders union all
  select row(id,retail_price,wholesale_price,updated_at)::text from public.products union all
  select row(id,type,read_at)::text from public.notifications) s"; }
before=$(snap)
echo "B. Migration twice"
run_editor "$MIG" && ok "run 1" || bad "run 1"
run_editor "$MIG" && ok "run 2 (idempotent)" || bad "run 2"
[[ "$(snap)" == "$before" ]] && ok "existing users, passwords, profiles, orders, products, notifications identical" || bad "existing data changed"
expect "existing customers: must_change_password = false" "select count(*) from public.profiles where must_change_password" "0"
expect "audit table empty, RLS on, no API access" "select (select count(*) from public.password_reset_audit)::text||'/'||relrowsecurity::text||'/'||has_table_privilege('authenticated','public.password_reset_audit','select')::text from pg_class where oid='public.password_reset_audit'::regclass" "0/true/false"
expect "trigger on auth.users installed once" "select count(*) from pg_trigger where tgname='on_auth_password_changed'" "1"
expect "internal function only for service_role" "select has_function_privilege('authenticated','public.record_admin_password_change(uuid,uuid)','execute')::text||'/'||has_function_privilege('service_role','public.record_admin_password_change(uuid,uuid)','execute')::text" "false/true"
echo "C. Behaviour"
q "select public.record_admin_password_change('${U}1','${U}2')" >/dev/null && ok "record change for a customer" || bad "record"
expect "customer must change password; audit row without password" "select (select must_change_password::text from public.profiles where id='${U}2')||'/'||(select count(*) from public.password_reset_audit where customer_id='${U}2' and admin_email='admin@x.com')" "true/1"
if q "select public.record_admin_password_change('${U}1','${U}1')" >/dev/null 2>&1; then bad "admin target allowed"; else ok "an administrator cannot be the target"; fi
if q "select public.record_admin_password_change('${U}2','${U}2')" >/dev/null 2>&1; then bad "non-admin allowed"; else ok "a non-admin cannot record a change"; fi
q "update auth.users set encrypted_password = crypt('new', gen_salt('bf')) where id='${U}2'"
expect "password changed by the customer → flag cleared by the database" "select must_change_password::text from public.profiles where id='${U}2'" "false"
q "update auth.users set email_confirmed_at = now() where id='${U}2'; select public.record_admin_password_change('${U}1','${U}2'); update auth.users set last_sign_in_at = now() where id='${U}2'" >/dev/null
expect "other auth.users updates (login, confirmation) do not clear it" "select must_change_password::text from public.profiles where id='${U}2'" "true"
echo "D. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
