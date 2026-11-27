#!/usr/bin/env bash
# Verifies 20261210000000_promo_default_on.sql the way the SQL Editor runs it
# (whole file as ONE query, role postgres), on the LOCAL stack only.
#   bash tests/promo-default-migration.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=postgres PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
MIG=supabase/migrations/20261210000000_promo_default_on.sql
pass=0; fail=0
q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { local got; got=$(q "$2" 2>&1 | tr -d '\n') || true; [[ "$got" == "$3" ]] && ok "$1" || bad "$1 — expected [$3] got [$got]"; }
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; }
w=$(mktemp -d); mkdir -p "$w/supabase/migrations"; cp supabase/config.toml "$w/supabase/"
npx supabase db reset --workdir "$w" >/dev/null 2>&1; rm -rf "$w"

echo "A. Without the offers migration the script refuses"
for f in supabase/migrations/2026110500*.sql; do run_editor "$f"; done
if run_editor "$MIG" 2>/dev/null; then bad "ran without the offers migration"; else ok "refused, nothing changed"; fi

echo "B. Production-like database with customers"
for f in supabase/migrations/2026111000*.sql supabase/migrations/2026111200*.sql supabase/migrations/2026112000*.sql \
         supabase/migrations/2026112800*.sql supabase/migrations/2026120500*.sql; do run_editor "$f"; done
U=00000000-0000-0000-0000-00000000000
q "insert into auth.users (id,email,aud,role,raw_user_meta_data) values
 ('${U}1','admin@x.com','authenticated','authenticated','{}'), ('${U}2','none@x.com','authenticated','authenticated','{}'),
 ('${U}3','partial@x.com','authenticated','authenticated','{}'), ('${U}4','all@x.com','authenticated','authenticated','{}');
update public.profiles set role='admin' where id='${U}1';
update public.profiles set promo_offers=true where id='${U}3';
update public.profiles set promo_offers=true, promo_new_products=true, promo_price_changes=true where id='${U}4';
insert into public.orders (customer_id,status,total,item_count,delivery_name,delivery_phone,delivery_address,delivery_city) values ('${U}2','new',10,1,'K','1','A','C');" >/dev/null
expect "before: everything off by default, one partial, one all on" "select string_agg(email||':'||promo_offers::int||promo_new_products::int||promo_price_changes::int, ' ' order by email) from public.profiles" "admin@x.com:000 all@x.com:111 none@x.com:000 partial@x.com:100"
upd=$(q "select string_agg(updated_at::text,',' order by email) from public.profiles")
other=$(q "select md5(string_agg(row(id,email,full_name,phone,role,wholesale_status,must_change_password,promo_tester)::text,'|' order by id)) from public.profiles")
orders=$(q "select md5(string_agg(row(o.*)::text,'|')) from public.orders o")

echo "C. Migration twice"
run_editor "$MIG" && ok "run 1" || bad "run 1"
run_editor "$MIG" && ok "run 2 (idempotent)" || bad "run 2"
expect "customer with all off → all on; partial choice kept; admin unchanged" "select string_agg(email||':'||promo_offers::int||promo_new_products::int||promo_price_changes::int, ' ' order by email) from public.profiles" "admin@x.com:000 all@x.com:111 none@x.com:111 partial@x.com:100"
[[ "$(q "select string_agg(updated_at::text,',' order by email) from public.profiles")" == "$upd" ]] && ok "profiles.updated_at unchanged" || bad "updated_at changed"
[[ "$(q "select md5(string_agg(row(id,email,full_name,phone,role,wholesale_status,must_change_password,promo_tester)::text,'|' order by id)) from public.profiles")" == "$other" ]] && ok "other profile data identical" || bad "profile data changed"
[[ "$(q "select md5(string_agg(row(o.*)::text,'|')) from public.orders o")" == "$orders" ]] && ok "orders identical" || bad "orders changed"
expect "update trigger re-enabled" "select tgenabled from pg_trigger where tgname='profiles_touch'" "O"
expect "promo settings untouched (sending still off / test mode)" "select enabled::text||'/'||test_only::text from public.promo_settings" "false/true"

echo "D. New registrations"
q "insert into auth.users (id,email,aud,role,raw_user_meta_data) values ('${U}5','new@x.com','authenticated','authenticated','{}')" >/dev/null
expect "a new customer starts with all three ON" "select promo_offers::int::text||promo_new_products::int::text||promo_price_changes::int::text from public.profiles where id='${U}5'" "111"
q "begin; select set_config('request.jwt.claims','{\"sub\":\"${U}5\",\"role\":\"authenticated\"}',true); set local role authenticated; select public.set_my_promo_preferences(false,false,false); commit;" >/dev/null
expect "the customer can still switch them off" "select promo_offers::int::text||promo_new_products::int::text||promo_price_changes::int::text from public.profiles where id='${U}5'" "000"

echo "E. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
