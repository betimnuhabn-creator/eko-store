#!/usr/bin/env bash
# Verifies 20261228000000_account_link.sql the way the SQL Editor runs it
# (whole file as ONE query, role postgres), on the LOCAL stack only.
#   bash tests/account-link-migration.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=postgres PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
MIG=supabase/migrations/20261228000000_account_link.sql
pass=0; fail=0
q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { local got; got=$(q "$2" 2>&1 | tr -d '\n') || true; [[ "$got" == "$3" ]] && ok "$1" || bad "$1 — expected [$3] got [$got]"; }
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; }
w=$(mktemp -d); mkdir -p "$w/supabase/migrations"; cp supabase/config.toml "$w/supabase/"
npx supabase db reset --workdir "$w" >/dev/null 2>&1; rm -rf "$w"

echo "A. Without the WooCommerce migrations the script refuses"
for f in supabase/migrations/2026110500*.sql; do run_editor "$f"; done
if run_editor "$MIG" 2>/dev/null; then bad "ran too early"; else ok "refused, nothing changed"; fi

echo "B. Production-like database with data"
for f in supabase/migrations/2026111000*.sql supabase/migrations/2026111200*.sql supabase/migrations/2026112000*.sql \
         supabase/migrations/2026112800*.sql supabase/migrations/2026120500*.sql supabase/migrations/2026121000*.sql \
         supabase/migrations/2026121500*.sql supabase/migrations/2026122000*.sql supabase/migrations/2026122200*.sql; do run_editor "$f"; done
U=00000000-0000-0000-0000-00000000000
q "insert into auth.users (id,email,aud,role,raw_user_meta_data) values
 ('${U}1','admin@x.com','authenticated','authenticated','{}'), ('${U}2','klient@x.com','authenticated','authenticated','{}'),
 ('${U}3','ws@x.com','authenticated','authenticated','{}');
update public.profiles set role='admin' where id='${U}1';
update public.profiles set role='wholesale', wholesale_status='approved' where id='${U}3';" >/dev/null
snap() { q "select md5(string_agg(row(id,email,role,wholesale_status,updated_at)::text,'|' order by id)) from public.profiles"; }
before=$(snap)

echo "C. Migration twice"
run_editor "$MIG" && ok "run 1" || bad "run 1"
run_editor "$MIG" && ok "run 2 (idempotent)" || bad "run 2"
[[ "$(snap)" == "$before" ]] && ok "existing profiles identical" || bad "profiles changed"
expect "no jobs for existing customers" "select count(*) from public.link_jobs" "0"
expect "service-only functions" "select string_agg(has_function_privilege('authenticated', p.oid, 'execute')::text, ',') from pg_proc p where proname in ('link_rate_ok','link_user_info','link_set_wholesale','link_claim_jobs','link_finish_job')" "false,false,false,false,false"
expect "tables: RLS on, no API access" "select string_agg(relrowsecurity::text||has_table_privilege('authenticated', oid, 'select')::text, ',') from pg_class where relname in ('link_attempts','link_jobs')" "truefalse,truefalse"

echo "D. Behaviour"
q "update public.profiles set role='wholesale', wholesale_status='approved' where id='${U}2'" >/dev/null
expect "approved in the app → job for the website" "select email||'/'||wholesale::text from public.link_jobs" "klient@x.com/true"
expect "from the website (link_set_wholesale): revoke, no job back" "select public.link_set_wholesale('${U}3', false)||'/'||(select count(*) from public.link_jobs where email='ws@x.com')" "revoked/0"
expect "from the website: approve" "select public.link_set_wholesale('${U}3', true)" "approved"
expect "… with the usual notification, no job back" "select (select count(*) from public.notifications where recipient_id='${U}3' and type='wholesale_approved')||'/'||(select count(*) from public.link_jobs where email='ws@x.com')" "1/0"
expect "administrators untouched" "select public.link_set_wholesale('${U}1', true)||'/'||(select role from public.profiles where id='${U}1')" "skipped/admin"
q "update public.profiles set wholesale_status='approved' where id='${U}1'" >/dev/null
expect "no job for administrators" "select count(*) from public.link_jobs where email='admin@x.com'" "0"
expect "rate limit: 10 per e-mail, 11th refused" "select string_agg(public.link_rate_ok('r@x.com')::text, ',') from generate_series(1, 11)" "true,true,true,true,true,true,true,true,true,true,false"
expect "user info by e-mail (case-insensitive)" "select public.link_user_info('KLIENT@x.com')->>'wholesale_status'" "approved"

echo "E. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
