# Production rollout — Offers + promotional notifications

Migration: `supabase/migrations/20261112000000_offers_promo_notifications.sql`
Rollback:  `supabase/rollback/20261112000000_offers_promo_notifications.down.sql`
Project:   `mfpmcriffqlhlgaptdzx` (Supabase)

Nothing in this document has been run against production. Every step is manual.

---

## 1. Backup (before the migration)

Do **both** A and B. A is the quickest way back; B is a copy you hold yourself and can test.

### A. Supabase-managed backup (Dashboard)

1. Dashboard → project → **Database → Backups**.
2. Look at **Scheduled backups** (and **Point in time**, if your plan has it).
   * A backup from the last 24 hours is listed → write down its date/time.
     Restoring it puts the WHOLE project back to that moment (orders placed after it are lost).
   * The page says backups are not available on your plan, or the list is empty →
     you have **no** Supabase-managed backup. Do B (required).

### B. Your own copy with the Supabase CLI (tested locally)

Needs: Node.js, Docker Desktop running, the database password
(Dashboard → Project Settings → Database → *Reset database password* if unknown).

```bash
npx supabase login
npx supabase link --project-ref mfpmcriffqlhlgaptdzx      # asks for the database password
mkdir eko-backup-$(date +%Y%m%d) && cd eko-backup-$(date +%Y%m%d)
npx supabase db dump --linked -f "$PWD/schema.sql"
npx supabase db dump --linked -f "$PWD/data.sql" --use-copy --data-only \
  -x storage.buckets_vectors,storage.vector_indexes,storage.buckets_analytics,storage.iceberg_namespaces,storage.iceberg_tables,supabase_functions.hooks
npx supabase db dump --linked -f "$PWD/roles.sql" --role-only     # reference only (Supabase's own role settings)
```

Always pass **absolute** paths to `-f` (`"$PWD/..."`). Relative paths are resolved
against the project folder, not the current folder.

Check the files (all must be true):

```bash
grep -c '^COPY "auth"."users"' data.sql          # 1  (customer accounts)
grep -oE '^COPY "public"."[a-z_]+"' data.sql      # categories, products, profiles, notifications, orders, order_items, push_tokens
grep -c 'CREATE OR REPLACE FUNCTION "public"."place_order"' schema.sql   # 1
```

Product photos are files in Storage, not in the database: the migration does not touch them,
and they are not in this backup.

### C. Verify that the backup can be restored (recommended)

Restore it into a **new, empty** Supabase project (e.g. a free project named `eko-restore-test`,
never the production project) or into a local `npx supabase start` stack:

```bash
# <TEST_DB_URL>: test project → Connect → Session pooler connection string
psql "<TEST_DB_URL>" --single-transaction -v ON_ERROR_STOP=1 \
  -f schema.sql -c 'SET session_replication_role = replica' -f data.sql
# Objects that live in Supabase-managed schemas are not in schema.sql
# (sign-up trigger on auth.users, product-photo storage policies): re-create them
psql "<TEST_DB_URL>" -v ON_ERROR_STOP=1 -f supabase/migrations/20261105000000_eko_store_v1.sql
psql "<TEST_DB_URL>" -v ON_ERROR_STOP=1 -f supabase/migrations/20261110000000_order_cancel_archive.sql
```

Run the **snapshot query** (section 4, step 2) in production and in the test project: every
value must be identical. Then delete the test project.

Tested locally (production-like database, v1 + archive, with customers, wholesale, orders,
archived order, notifications): restore OK, all row counts and checksums identical, 47 functions,
RLS on all tables, sign-up trigger and 4 storage policies back, no offer objects.

---

## 2. Rollback (if the migration causes problems)

Choose by situation:

| Situation | What to do | Data written after the migration |
|---|---|---|
| Migration **failed** with an error | Nothing. It runs in one transaction: nothing was changed. | — |
| Migration succeeded, offers/promotions misbehave | **Rollback SQL** (below) | Kept (orders, customers); offer data copied to `eko_rollback_backup` |
| Anything else is wrong (e.g. data damaged) | Restore backup **A** (whole project) or **B**/C | Lost after the backup time |

### Rollback SQL — what it does

* Restores the API/schema to **exactly** the pre-migration state (v1 + archive), verified
  element by element: columns, constraints, indexes, triggers, policies, function source
  and permissions, RLS.
* Does not change any existing row: products, prices, customers, orders, archived orders,
  order lines, notifications. Orders placed while the migration was active stay, with their prices.
* Copies offers, offer products, promo settings/events, customers' promo opt-ins, which offer
  priced an order line and the notification category into the private schema
  `eko_rollback_backup` (not reachable through the API), then removes them.
* Marks undelivered promotional notifications as handled (not deleted) and removes the three
  scheduler jobs: nothing is sent after the rollback.
* One transaction; safe to run more than once; refuses to run on a non-EKO database.
* Leaves the `pg_cron` / `pg_net` extensions installed (no jobs).
* The migration can be applied again later (tested); copied offers are not re-imported automatically.

### Rollback steps

1. SQL Editor → New query → paste the **whole** rollback file → Run → *Success*.
2. Snapshot query (section 4, step 2): products / customers / orders / order_items / notifications
   counts and checksums equal the values from **before** the migration — except rows created
   since (new orders etc.) and the `updated_at` of customers who changed their promo preferences.
3. `select count(*) from cron.job where jobname like 'eko-%';` → `0`.
4. Open APK 1.2.0 and the PC panel: catalog, cart, orders, admin work; *Ofertat* empty and
   *Njoftimet promocionale* shows "migration required" — exactly as before the migration.
5. If the new `dispatch-notifications` was deployed: keep it (it works with and without the migration).

### Compatibility after a rollback (tested locally)

After the rollback the API answers like before the migration: `list_offers` → 404,
`admin_list_offers` → PGRST202 ("migration required"), `profiles.promo_*` → 400 (preferences
hidden), `list_products` → 200. These suites passed against the rolled-back database:
backend 28/28, order-archive 14/14, notify-db 15/15, order notifications 9/9 (with the updated
Edge Function), customer app in a browser 6/6, PC admin panel 13/13, admin sync 3/3.
(The 2 promotional-push tests need the migration and are expected to fail after a rollback.)
The browser tests use the Expo web build of the same screen code as APK 1.2.0 — it is not the
APK itself: check on the phone (step 4).

---

## 3. Safety during the migration

* Promotional notifications: `enabled = false`, `test_only = true`, every customer's
  preferences OFF, no testers, `functions_url` empty.
* The migration creates no promotional event or notification. Existing products are marked
  "already announced" without an UPDATE (no trigger runs).
* The scheduler job `eko-dispatch-minutely` does nothing while `functions_url` is empty
  (no HTTP call). `eko-promo-minutely` only marks events "suppressed" while promotions are off.
* Order notifications are not affected and keep working as today.

---

## 4. Deployment checklist

**Before**
- [ ] 1. Backup A checked (date/time noted) **or** backup B made and its checks pass.
- [ ] 2. Snapshot query run in production, result saved:
```sql
select (select count(*) from public.products) products,
       (select count(*) from public.profiles) customers,
       (select count(*) from public.orders) orders,
       (select count(*) from public.order_items) order_items,
       (select count(*) from public.notifications) notifications,
       (select coalesce(sum(total),0) from public.orders) orders_total,
       (select md5(string_agg(row(id,retail_price,wholesale_price,stock,active,updated_at)::text, '|' order by id)) from public.products) products_md5,
       (select md5(string_agg(row(id,status,total,archived_at,updated_at)::text, '|' order by id)) from public.orders) orders_md5,
       (select md5(string_agg(row(id,unit_price,quantity)::text, '|' order by id)) from public.order_items) lines_md5,
       (select md5(string_agg(row(id,type,data,read_at,dispatched_at)::text, '|' order by id)) from public.notifications) notif_md5;
```
- [ ] 3. Optional: backup C (restore test) passed.
- [ ] 4. Rollback file opened in a second SQL Editor tab (not run).
- [ ] 5. Quiet time chosen (few customers ordering). The migration takes seconds; with
      `lock_timeout = 10s` it stops cleanly (nothing changed) if a table is busy — just run it again.

**Migration**
- [ ] 6. New query → paste the whole migration → Run once → *Success*.

**After**
- [ ] 7. Snapshot query again → every value identical to step 2.
- [ ] 8. `select enabled, test_only, daily_cap, functions_url from public.promo_settings;` → `false | true | 3 | ''`
- [ ] 9. `select public.promo_dispatch_status();` → `{"state": "not_called"}`
- [ ] 10. `select jobname, schedule, command from cron.job where jobname like 'eko-%' order by 1;`
      → `eko-cron-log-cleanup`, `eko-dispatch-minutely` (`select public.promo_dispatch()`), `eko-promo-minutely`.
- [ ] 11. `select count(*) from public.promo_events;` → `0`; `select count(*) from public.notifications where category='promo';` → `0`.
- [ ] 12. APK 1.2.0: log in, catalog prices, cart, place a test order and cancel it; *Ofertat* tab opens (empty).
- [ ] 13. PC panel: orders, customers, *Ofertat* list (empty), *Njoftimet promocionale* shows OFF + test mode.
- [ ] 14. If anything in 7–13 is wrong → rollback (section 2).

**Later, each only with approval**: Edge Function redeploy (Verify JWT OFF) → save the functions
address and check "HTTP 200" → Firebase / FCM → test-mode trial with your own test account → real customers.
