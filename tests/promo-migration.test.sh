#!/usr/bin/env bash
# Verifies 20261112000000_offers_promo_notifications.sql the way the SQL
# Editor runs it (whole file as ONE query, role postgres), on the local stack.
#   bash tests/promo-migration.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
V1=supabase/migrations/20261105000000_eko_store_v1.sql
ARCH=supabase/migrations/20261110000000_order_cancel_archive.sql
MIG=supabase/migrations/20261112000000_offers_promo_notifications.sql
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
U=00000000-0000-0000-0000-00000000000
snap() { q "select md5(string_agg(t, '|' order by t)) from (
  select row(id,email)::text t from auth.users union all
  select row(id,email,full_name,phone,role,wholesale_status,business_name,address,city,created_at)::text from public.profiles union all
  select row(id,order_number,customer_id,status,price_tier,total,item_count,delivery_name,admin_note,archived_at,created_at)::text from public.orders union all
  select row(id,order_id,product_id,quantity,unit_price,product_name,sku)::text from public.order_items union all
  select row(id,sku,name,retail_price,wholesale_price,stock,active,images,category_id)::text from public.products) s"; }
counts() { q "select (select count(*) from auth.users)||'/'||(select count(*) from public.profiles)||'/'||(select count(*) from public.orders)||'/'||(select count(*) from public.order_items)||'/'||(select count(*) from public.products)"; }

echo "A. Without the archive migration: must stop, change nothing"
empty_project
run_editor "$V1"
if "${PSQL[@]}" -c "$(cat "$MIG")" >/dev/null 2>"$PARKED/err.txt"; then bad "should fail"; else ok "stops with an error"; fi
grep -q "Nothing was changed" "$PARKED/err.txt" && ok "clear message" || bad "message: $(cat "$PARKED/err.txt")"
expect "no offers table created" "select count(*) from pg_tables where tablename in ('offers','promo_events')" "0"

echo "B. Production-like database (v1 + archive) with customers, products and orders"
run_editor "$ARCH"
q "
insert into auth.users (id,email,aud,role,raw_user_meta_data) values
 ('${U}1','admin@x.com','authenticated','authenticated','{\"full_name\":\"Admin\"}'),
 ('${U}2','klient@x.com','authenticated','authenticated','{\"full_name\":\"Klient\"}'),
 ('${U}3','firma@x.com','authenticated','authenticated','{\"full_name\":\"Firma\",\"requested_wholesale\":\"true\"}');
update public.profiles set role='admin' where id='${U}1';
update public.profiles set role='wholesale', wholesale_status='approved' where id='${U}3';
insert into public.products (sku,name,retail_price,wholesale_price,stock) values ('P1','Rubinet',100,70,5), ('P2','Tub',3,2,0);
insert into public.orders (customer_id,status,total,item_count,delivery_name,delivery_phone,delivery_address,delivery_city)
  values ('${U}2','new',100,1,'K','1','A','C'), ('${U}3','cancelled',70,1,'F','1','A','C');
update public.orders set archived_at = now(), archived_by='${U}1' where status='cancelled';
insert into public.order_items (order_id,product_id,quantity,unit_price,product_name,sku,unit)
  select o.id, p.id, 1, o.total, p.name, p.sku, 'copë' from public.orders o, public.products p where p.sku='P1';
insert into public.push_tokens (token,user_id) values ('ExponentPushToken[k]','${U}2');
"
before=$(snap); before_c=$(counts)
run_editor "$MIG" && ok "migration run 1" || bad "run 1"
run_editor "$MIG" && ok "migration run 2 (idempotent)" || bad "run 2"
[[ "$(counts)" == "$before_c" ]] && ok "no rows lost (users/profiles/orders/lines/products = $before_c)" || bad "counts changed"
[[ "$(snap)" == "$before" ]] && ok "checksum of existing customers, orders, lines, product prices identical" || bad "existing data changed"
expect "existing products marked as already announced (no notification)" "select count(*) from public.products where announced_at is null" "0"
expect "no promo events created by the migration" "select count(*) from public.promo_events" "0"
expect "promotional notifications OFF and in test mode" "select enabled::text||'/'||test_only::text from public.promo_settings" "false/true"
expect "customers' promo preferences default OFF (opt-in)" "select count(*) from public.profiles where promo_new_products or promo_offers or promo_price_changes" "0"
expect "existing notifications are category 'order'" "select count(*) from public.notifications where category <> 'order'" "0"
expect "scheduler jobs created" "select string_agg(jobname, ',' order by jobname) from cron.job where jobname like 'eko-%'" "eko-dispatch-minutely,eko-promo-minutely"
expect "historical order line prices untouched" "select string_agg(unit_price::text, ',') from public.order_items" "100.00,70.00"
expect "archived order still archived" "select count(*) from public.orders where archived_at is not null" "1"

echo "C. Scheduler: an offer becomes live and is recorded without any app action"
PID=$(q "select id from public.products where sku='P1'")
q "update public.promo_settings set debounce_minutes = 0;
   insert into public.offers (title_sq, starts_at, ends_at) values ('Cron test', now() + interval '5 seconds', now() + interval '1 hour');
   insert into public.offer_items (offer_id, product_id, offer_price) select id, '$PID', 85 from public.offers where title_sq='Cron test';"
echo "    (waiting up to 75 s for pg_cron)"
for i in $(seq 1 30); do sleep 5; [[ "$(q "select count(*) from public.promo_events where kind='offer' and status <> 'pending'")" == "1" ]] && break; done
expect "pg_cron recorded the activation event by itself" "select count(*) from public.promo_events where kind='offer'" "1"
expect "...and, with notifications OFF, suppressed it (nobody notified)" "select status from public.promo_events where kind='offer'" "suppressed"
expect "no promo notification was created" "select count(*) from public.notifications where category='promo'" "0"
expect "regular product price unchanged by the offer" "select retail_price::text from public.products where id='$PID'" "100.00"

echo "D. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
