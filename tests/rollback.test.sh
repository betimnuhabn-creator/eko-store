#!/usr/bin/env bash
# Verifies supabase/rollback/20261112000000_offers_promo_notifications.down.sql
# the way the SQL Editor runs it (whole file as ONE query, role postgres),
# on the LOCAL stack only:
#   production-like DB (v1 + archive + data) -> offers migration -> features used
#   -> rollback -> schema identical to before, original rows identical,
#   nothing left to send, backups kept -> rollback again -> migrate again.
#   bash tests/rollback.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
V1=supabase/migrations/20261105000000_eko_store_v1.sql
ARCH=supabase/migrations/20261110000000_order_cancel_archive.sql
MIG=supabase/migrations/20261112000000_offers_promo_notifications.sql
DOWN=supabase/rollback/20261112000000_offers_promo_notifications.down.sql
export PGPASSWORD=postgres PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
W=$(mktemp -d)
pass=0; fail=0
q() { "${PSQL[@]}" -tA -c "$1"; }
ok() { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✖ $1"; fail=$((fail+1)); }
expect() { local got; got=$(q "$2" 2>&1 | tr -d '\n') || true; [[ "$got" == "$3" ]] && ok "$1" || bad "$1 — expected [$3] got [$got]"; }
run_editor() { "${PSQL[@]}" -c "$(cat "$1")" >/dev/null; }
empty_project() {
  local w; w=$(mktemp -d)
  mkdir -p "$w/supabase/migrations"
  cp supabase/config.toml "$w/supabase/"
  npx supabase db reset --workdir "$w" >/dev/null 2>&1 || { echo "empty db reset failed"; exit 1; }
  rm -rf "$w"
}
as_user() { q "begin; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, true); $2; commit;" | sed -n 2p; }
# Every schema element of "public" that the apps or the API can depend on.
schema_rows() { q "select x from (
  select 'col '||table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' def='||coalesce(column_default,'') x
    from information_schema.columns where table_schema='public'
  union all select 'con '||conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace
  union all select 'idx '||indexdef from pg_indexes where schemaname='public'
  union all select 'trg '||tgrelid::regclass||' '||pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where not t.tgisinternal and c.relnamespace='public'::regnamespace
  union all select 'pol '||tablename||' '||policyname||' '||cmd||' '||array_to_string(roles,',')||' '||coalesce(qual,'')||' '||coalesce(with_check,'')
    from pg_policies where schemaname='public'
  union all select 'fn '||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') -> '||pg_get_function_result(p.oid)
      ||' src='||md5(p.prosrc)||' definer='||p.prosecdef||' cfg='||coalesce(array_to_string(p.proconfig,','),'')||' vol='||p.provolatile::text
      ||' acl='||coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a),'')
    from pg_proc p where p.pronamespace='public'::regnamespace
  union all select 'rel '||c.relname||' kind='||c.relkind::text||' rls='||c.relrowsecurity
      ||' acl='||coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a),'')
    from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','S','m')
) s order by x"; }
# Every original row (only columns that existed before the migration).
data_rows() { q "select t from (
  select 'u '||row(id,email)::text t from auth.users union all
  select 'p '||row(id,email,full_name,phone,role,wholesale_status,business_name,address,city,created_at,updated_at)::text from public.profiles union all
  select 'o '||row(id,order_number,customer_id,status,price_tier,total,item_count,delivery_name,admin_note,archived_at,created_at,updated_at)::text from public.orders union all
  select 'l '||row(id,order_id,product_id,quantity,unit_price,product_name,sku)::text from public.order_items union all
  select 'r '||row(id,sku,name,retail_price,wholesale_price,stock,active,images,category_id,created_at,updated_at)::text from public.products union all
  select 'n '||row(id,recipient_id,type,data,read_at,created_at)::text from public.notifications union all
  select 't '||row(token,user_id)::text from public.push_tokens) s order by t"; }

U=00000000-0000-0000-0000-00000000000
echo "A. Production-like database WITHOUT the offers migration (v1 + archive + data)"
empty_project
run_editor "$V1"; run_editor "$ARCH"
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
insert into public.push_tokens (token,user_id) values ('ExponentPushToken[k]','${U}2'), ('ExponentPushToken[w]','${U}3');
insert into public.notifications (recipient_id,type,data,read_at,dispatched_at) values
 ('${U}2','order_status','{\"order_number\":1,\"status\":\"confirmed\"}', now(), now()),
 ('${U}3','order_status','{\"order_number\":2,\"status\":\"cancelled\"}', null, null);
"
schema_rows > "$W/schema0"; data_rows > "$W/data0"
ok "baseline captured ($(wc -l < "$W/schema0") schema elements, $(wc -l < "$W/data0") rows)"

echo "B. Offers migration applied and its features used"
run_editor "$MIG" && ok "migration applied" || bad "migration"
P1=$(q "select id from public.products where sku='P1'")
OFF=$(as_user "${U}1" "select public.admin_save_offer(jsonb_build_object('title_sq','Test','starts_at',now()-interval '1 minute','ends_at',now()+interval '1 day','items',jsonb_build_array(jsonb_build_object('product_id','$P1','offer_price',85,'offer_wholesale_price',60))))")
[[ -n "$OFF" ]] && ok "offer created by admin" || bad "offer"
as_user "${U}2" "select public.set_my_promo_preferences(true,true,true)" >/dev/null
as_user "${U}3" "select public.set_my_promo_preferences(true,true,true)" >/dev/null
ORD=$(as_user "${U}2" "select public.place_order(jsonb_build_array(jsonb_build_object('product_id','$P1','quantity',2)), '{\"name\":\"K\",\"phone\":\"1\",\"address\":\"A\",\"city\":\"C\"}')->>'id'")
expect "order during the migration charged the offer price" "select total::text from public.orders where id='$ORD'" "170.00"
q "update public.promo_settings set enabled=true, test_only=false, debounce_minutes=0"
as_user "${U}1" "select public.admin_save_product(jsonb_build_object('sku','NEW1','name','I ri','retail_price',10,'wholesale_price',8,'stock',1))" >/dev/null
q "select public.promo_fanout(200)" >/dev/null
expect "promo notifications queued and NOT yet delivered" "select count(*) from public.notifications where category='promo' and dispatched_at is null" "4"
NOTIF_BEFORE=$(q "select count(*) from public.notifications")
data_rows > "$W/data_pre_rollback"

echo "C. Rollback"
run_editor "$DOWN" && ok "rollback applied (one transaction)" || bad "rollback"
schema_rows > "$W/schema1"; data_rows > "$W/data1"
if diff "$W/schema0" "$W/schema1" > "$W/schema.diff"; then ok "schema/API identical to before the migration (columns, constraints, indexes, triggers, policies, functions incl. source + permissions, RLS)"; else bad "schema differs:"; cat "$W/schema.diff"; fi
if diff "$W/data_pre_rollback" "$W/data1" > "$W/data.diff"; then ok "the rollback itself changed no row (all users, profiles, products+prices, orders, order lines, notifications, push tokens identical before/after)"; else bad "rollback changed rows:"; cat "$W/data.diff"; fi
# Against the original baseline: only what customers did while the migration was live.
changed=$(comm -23 "$W/data0" "$W/data1" | cut -c1-39 | sort | tr '\n' ';')
[[ "$changed" == "p (${U}2;p (${U}3;" ]] \
  && ok "vs. original: every row identical except the 2 customers' profile updated_at (they opted in during the test)" || bad "unexpected differences: $changed"
core0=$(grep '^p ' "$W/data0" | sed -E 's/,"[^"]*"\)$/)/' | md5sum); core1=$(grep '^p ' "$W/data1" | sed -E 's/,"[^"]*"\)$/)/' | md5sum)
[[ "$core0" == "$core1" ]] && ok "profiles: all values except updated_at identical to the original" || bad "profile values changed"
expect "the order placed during the migration is kept with its price" "select total::text||'/'||(select string_agg(unit_price::text,',') from public.order_items where order_id='$ORD') from public.orders where id='$ORD'" "170.00/85.00"
expect "no notification deleted" "select count(*)::text from public.notifications" "$NOTIF_BEFORE"
expect "nothing left to send (undelivered promo notifications marked handled)" "select count(*) from public.notifications where type like 'promo_%' and dispatched_at is null" "0"
expect "scheduler jobs removed" "select count(*) from cron.job where jobname like 'eko-%'" "0"
expect "backups kept: offers, offer products, settings, events, opt-ins, order-line offers" \
  "select string_agg(regexp_replace(c.relname, '_[0-9]{8}_[0-9]{6}$', ''), ',' order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='eko_rollback_backup' and c.relkind='r'" \
  "notifications_promo,offer_items,offers,order_items_offer,products_announced,profiles_promo,promo_events,promo_settings"
expect "backup: the offer and the opted-in customers" "select (select count(*) from eko_rollback_backup.\"$(q "select relname from pg_class where relname like 'offers_2%' limit 1")\")||'/'||(select count(*) from eko_rollback_backup.\"$(q "select relname from pg_class where relname like 'profiles_promo_2%' limit 1")\")" "1/2"
expect "backup schema not reachable by API roles" "select has_schema_privilege('anon','eko_rollback_backup','usage')::text||has_schema_privilege('authenticated','eko_rollback_backup','usage')::text" "falsefalse"
expect "pre-migration price again (no offer logic)" "select string_agg(n,',') from (select count(*)::text n from pg_proc where proname in ('best_offer','list_offers','promo_fanout','promo_dispatch')) s" "0"

echo "D. Running the rollback again / migrating again"
run_editor "$DOWN" && ok "rollback twice: no error" || bad "rollback twice"
schema_rows > "$W/schema2"; diff -q "$W/schema0" "$W/schema2" >/dev/null && ok "still identical schema" || bad "schema changed on 2nd rollback"
diff -q "$W/data1" <(data_rows) >/dev/null && ok "second rollback changed no row" || bad "rows changed"
run_editor "$MIG" && ok "migration can be applied again after a rollback" || bad "re-migrate"
expect "...promotions OFF + test mode again" "select enabled::text||'/'||test_only::text from public.promo_settings" "false/true"
expect "...no notification sent or queued by re-migrating" "select count(*) from public.notifications where type like 'promo_%' and dispatched_at is null" "0"
run_editor "$DOWN" && ok "and rolled back again" || bad "rollback 3"
diff -q "$W/schema0" <(schema_rows) >/dev/null && ok "schema identical after migrate/rollback cycle" || bad "cycle schema"

echo "E. Wrong database: refuses and changes nothing"
empty_project
if "${PSQL[@]}" -c "$(cat "$DOWN")" >/dev/null 2>"$W/err"; then bad "should refuse"; else grep -q "Nothing was changed" "$W/err" && ok "refuses on a database without the EKO migrations" || bad "message: $(cat "$W/err")"; fi

echo "F. Back to the normal local database"
npx supabase db reset >/dev/null 2>&1 && ok "reset" || bad "reset failed"
rm -rf "$W"
echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
