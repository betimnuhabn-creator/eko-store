#!/usr/bin/env bash
# Verifies 20261230000000_woo_price_push.sql the way the SQL Editor runs it
# (whole file as ONE query, role postgres), on the LOCAL stack only.
#   bash tests/woo-price-migration.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=postgres PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
MIG=supabase/migrations/20261230000000_woo_price_push.sql
pass=0; fail=0
q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { local got; got=$(q "$2" 2>&1 | tr -d '\n') || true; [[ "$got" == "$3" ]] && ok "$1" || bad "$1 — expected [$3] got [$got]"; }
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; }
w=$(mktemp -d); mkdir -p "$w/supabase/migrations"; cp supabase/config.toml "$w/supabase/"
npx supabase db reset --workdir "$w" >/dev/null 2>&1; rm -rf "$w"

echo "A. Without the earlier migrations the script refuses"
for f in supabase/migrations/2026110500*.sql; do run_editor "$f"; done
if run_editor "$MIG" 2>/dev/null; then bad "ran too early"; else ok "refused, nothing changed"; fi

echo "B. Production-like database with data"
for f in supabase/migrations/2026111000*.sql supabase/migrations/2026111200*.sql supabase/migrations/2026112000*.sql \
         supabase/migrations/2026112800*.sql supabase/migrations/2026120500*.sql supabase/migrations/2026121000*.sql \
         supabase/migrations/2026121500*.sql supabase/migrations/2026122000*.sql supabase/migrations/2026122200*.sql \
         supabase/migrations/2026122800*.sql; do run_editor "$f"; done
U=00000000-0000-0000-0000-00000000000
q "insert into auth.users (id,email,aud,role,raw_user_meta_data) values
 ('${U}1','admin@x.com','authenticated','authenticated','{}'), ('${U}2','klient@x.com','authenticated','authenticated','{}');
update public.profiles set role='admin' where id='${U}1';
insert into public.products (sku,name,retail_price,wholesale_price,stock,source,woo_id) values
 ('W1','Nga faqja',100,80,5,'woo',501), ('A1','Vetëm app',10,8,5,'app',null);" >/dev/null
snap() { q "select md5(string_agg(row(id,sku,retail_price,wholesale_price,updated_at)::text,'|' order by id)) from public.products"; }
before=$(snap)
as() { echo "begin; set local request.jwt.claims to '{\"sub\":\"$1\",\"role\":\"authenticated\"}'; $2; commit;"; }

echo "C. Migration twice"
run_editor "$MIG" && ok "run 1" || bad "run 1"
run_editor "$MIG" && ok "run 2 (idempotent)" || bad "run 2"
[[ "$(snap)" == "$before" ]] && ok "existing products identical" || bad "products changed"
expect "no jobs for existing products" "select count(*) from public.woo_price_jobs" "0"
expect "service-only functions" "select string_agg(has_function_privilege('authenticated', p.oid, 'execute')::text, ',' order by proname) from pg_proc p where proname in ('woo_claim_price_jobs','woo_finish_price_job','woo_price_trigger','woo_price_keep_trigger')" "false,false,false,false"
expect "table: RLS on, no API access" "select relrowsecurity::text||has_table_privilege('authenticated', oid, 'select')::text from pg_class where relname='woo_price_jobs'" "truefalse"
expect "panel status still for admins" "select has_function_privilege('authenticated', 'public.admin_woo_status()', 'execute')" "t"

echo "D. Behaviour"
q "$(as "${U}1" "update public.products set retail_price=110 where sku='W1'")" >/dev/null
expect "admin changes the retail price → job (retail only)" "select retail::text||'/'||wholesale::text||'/'||status from public.woo_price_jobs" "true/false/pending"
q "$(as "${U}1" "update public.products set wholesale_price=85 where sku='W1'")" >/dev/null
expect "changed again → same job, both prices, rev 2" "select count(*)||'/'||bool_and(retail and wholesale)::text||'/'||max(rev) from public.woo_price_jobs" "1/true/2"
q "update public.products set retail_price=100, wholesale_price=80, stock=7 where sku='W1'" >/dev/null
expect "website sync while waiting: app prices kept, stock updated" "select retail_price||'/'||wholesale_price||'/'||stock from public.products where sku='W1'" "110.00/85.00/7"
J=$(q "select id from public.woo_price_jobs")
expect "claim returns current prices" "select (j->0->>'retail_price')||'/'||(j->0->>'wholesale_price')||'/'||(j->0->>'woo_id') from (select public.woo_claim_price_jobs(10) j) s" "110.00/85.00/501"
q "select public.woo_finish_price_job($J, 1, null)" >/dev/null
expect "finished with an old rev → still pending" "select status from public.woo_price_jobs" "pending"
q "select public.woo_finish_price_job($J, 2, null)" >/dev/null
expect "finished with the current rev → sent" "select status from public.woo_price_jobs" "sent"
q "update public.products set retail_price=120 where sku='W1'" >/dev/null
expect "price from the website: applied, no job back" "select (select retail_price from public.products where sku='W1')||'/'||(select count(*) from public.woo_price_jobs)" "120.00/1"
q "$(as "${U}1" "update public.products set retail_price=11 where sku='A1'")" >/dev/null
q "$(as "${U}2" "update public.products set retail_price=1 where sku='W1'")" >/dev/null
expect "no job for app-only products or non-admins" "select count(*) from public.woo_price_jobs" "1"
q "$(as "${U}1" "update public.products set retail_price=130 where sku='W1'")" >/dev/null
J=$(q "select id from public.woo_price_jobs where status='pending'")
for i in 1 2 3 4 5; do q "select public.woo_claim_price_jobs(10); select public.woo_finish_price_job($J, 1, 'HTTP 500')" >/dev/null; done
expect "5 failures → failed, shown in the panel" "$(as "${U}1" "select (s->>'prices_failed')||'/'||(s->>'last_price_error') from (select public.admin_woo_status() s) x")" "1/HTTP 500"
expect "dispatch knows the price queue" "select prosrc like '%woo_price_jobs%' from pg_proc where proname='woo_dispatch'" "t"

echo "E. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
