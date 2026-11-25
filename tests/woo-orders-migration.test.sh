#!/usr/bin/env bash
# Verifies 20261220000000_woo_orders_in.sql the way the SQL Editor runs it
# (whole file as ONE query, role postgres), on the LOCAL stack only.
#   bash tests/woo-orders-migration.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=postgres PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
MIG=supabase/migrations/20261220000000_woo_orders_in.sql
pass=0; fail=0
q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { local got; got=$(q "$2" 2>&1 | tr -d '\n') || true; [[ "$got" == "$3" ]] && ok "$1" || bad "$1 — expected [$3] got [$got]"; }
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; }
w=$(mktemp -d); mkdir -p "$w/supabase/migrations"; cp supabase/config.toml "$w/supabase/"
npx supabase db reset --workdir "$w" >/dev/null 2>&1; rm -rf "$w"

echo "A. Without the WooCommerce migration the script refuses"
for f in supabase/migrations/2026110500*.sql supabase/migrations/2026111000*.sql supabase/migrations/2026111200*.sql; do run_editor "$f"; done
if run_editor "$MIG" 2>/dev/null; then bad "ran too early"; else ok "refused, nothing changed"; fi

echo "B. Production-like database with data"
for f in supabase/migrations/2026112000*.sql supabase/migrations/2026112800*.sql supabase/migrations/2026120500*.sql \
         supabase/migrations/2026121000*.sql supabase/migrations/2026121500*.sql; do run_editor "$f"; done
U=00000000-0000-0000-0000-00000000000
q "insert into auth.users (id,email,aud,role,raw_user_meta_data) values
 ('${U}1','admin@x.com','authenticated','authenticated','{}'), ('${U}2','klient@x.com','authenticated','authenticated','{}');
update public.profiles set role='admin' where id='${U}1';
insert into public.products (sku,name,retail_price,wholesale_price,woo_id,source) values ('W1','Web',10,8,501,'woo');
insert into public.orders (customer_id,status,total,item_count,delivery_name,delivery_phone,delivery_address,delivery_city) values ('${U}2','new',100,1,'K','1','A','C');
insert into public.woo_order_jobs (order_id, kind, status) select id, 'create', 'sent' from public.orders;
update public.orders set woo_order_id = 7000;" >/dev/null
snap() { q "select md5(string_agg(t,'|' order by t)) from (
  select row(id,customer_id,status,total,item_count,woo_order_id,updated_at)::text t from public.orders union all
  select row(id,order_id,kind,status)::text from public.woo_order_jobs union all
  select row(id,sku,retail_price,updated_at)::text from public.products) s"; }
before=$(snap)

echo "C. Migration twice"
run_editor "$MIG" && ok "run 1" || bad "run 1"
run_editor "$MIG" && ok "run 2 (idempotent)" || bad "run 2"
[[ "$(snap)" == "$before" ]] && ok "existing orders, jobs, products identical" || bad "existing data changed"
expect "existing orders are app orders" "select string_agg(distinct source, ',') from public.orders" "app"
expect "from now on (no old website orders imported)" "select (orders_polled_at > now() - interval '1 minute')::text from public.woo_settings" "true"
expect "service-only" "select string_agg(has_function_privilege('authenticated', p.oid, 'execute')::text, ',' order by proname) from pg_proc p where proname in ('woo_import_order','woo_orders_polled')" "false,false"

echo "D. Behaviour"
r=$(q "select public.woo_import_order('{\"woo_order_id\":8001,\"status\":\"processing\",\"email\":\"KLIENT@x.com\",\"name\":\"Arben\",\"phone\":\"1\",\"address\":\"A\",\"city\":\"C\",\"total\":19,\"payment_method\":\"bacs\",\"lines\":[{\"woo_product_id\":501,\"woo_variation_id\":0,\"name\":\"Web\",\"sku\":\"W1\",\"quantity\":2,\"unit_price\":8}]}')->>'action'")
[[ "$r" == "created" ]] && ok "website order created" || bad "import: $r"
expect "linked by e-mail, total incl. shipping line, bank transfer, source woo" "select (customer_id='${U}2')::text||'/'||total||'/'||item_count||'/'||payment_method||'/'||source||'/'||(select count(*) from public.order_items i where i.order_id=o.id) from public.orders o where woo_order_id=8001" "true/19.00/2/bank_transfer/woo/2"
expect "admins notified" "select count(*) from public.notifications where type='new_order' and recipient_id='${U}1'" "1"
q "select public.woo_import_order('{\"woo_order_id\":8001,\"status\":\"completed\"}')" >/dev/null
expect "website completed → app delivered, customer notified, not sent back" "select o.status||'/'||(select count(*) from public.notifications n where n.recipient_id='${U}2' and n.type='order_status')||'/'||(select count(*) from public.woo_order_jobs j where j.order_id=o.id) from public.orders o where woo_order_id=8001" "delivered/1/0"
q "update public.orders set status='cancelled' where woo_order_id=8001" >/dev/null
expect "app change on a website order → status job" "select count(*) from public.woo_order_jobs j join public.orders o on o.id=j.order_id where o.woo_order_id=8001 and j.kind='status'" "1"
expect "app order copy: status from the website (processing keeps the app's detailed status)" "select public.woo_import_order(jsonb_build_object('woo_order_id',7000,'app_order_number',(select order_number from public.orders where woo_order_id=7000)::text,'status','processing'))->>'action'" "unchanged"

echo "E. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
