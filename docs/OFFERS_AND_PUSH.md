# Ofertat e Momentit + automatic promotional push notifications

## What it does

**Customers (Android app, later iPhone)**
* New **Ofertat** tab: live offers with photo, name, regular price (struck through),
  offer price, discount %, start/end date (Kosovo time), add to cart, open product.
* Red **banner** on the home screen while offers are live.
* Offer price and end date also shown in the catalog and on the product page.
* **Njoftime për oferta** in *Llogaria*: opt in per type (offers, new products, price changes).
  A one-time invitation appears in the Ofertat tab. Order notifications are never affected.
* Notifications list has separate **Porositë** / **Ofertat** filters.

**Admins (PC panel and Android admin)**
* **Ofertat**: create, edit, extend (+7 days), activate, deactivate, cancel; choose products,
  promotional retail price and optional wholesale offer price; dates in Kosovo time.
* **Njoftimet promocionale**: master switch, test mode, daily cap per customer,
  waiting time (merges quick edits), recent events with status and number of recipients.
* PC customers page: **🧪 Testues promo** switch per account.

**Automatic**
* Offers start and end exactly at their times (price calculated live by the database); regular
  price returns automatically; checkout always charges the current server-side price.
* Push notification when: a product is published, an offer becomes active, a regular price goes
  down or up (both retail and wholesale customers get *their own* old/new price only).
* Duplicate prevention (one notification per event and person; one per offer ever; quick edits
  merged; price edited back = nothing sent), daily cap, batching (200 per run, 100 per Expo request).
* An event that cannot be processed is marked **Dështoi / Failed** (reason shown to admins) and
  never blocks the others. If a product is in two live offers at once, customers see (and pay)
  only the cheaper one.

## Safety switches

| Setting | After migration | Meaning |
|---|---|---|
| Promotional notifications | **OFF** | Nothing is sent; events are recorded as "not sent". |
| Test mode | **ON** | Once switched on, only accounts marked *Testues promo* receive them. |
| Customer preferences | **OFF** (opt-in) | Customers choose in the app. |

## Production setup (only after approval)

1. **Database** — SQL Editor: run `supabase/migrations/20261112000000_offers_promo_notifications.sql`
   (requires the v1 and order-archive migrations; stops with a message otherwise).
   It enables `pg_cron` and `pg_net` (schema `extensions`) and schedules three jobs:
   `eko-promo-minutely`, `eko-dispatch-minutely` (idle until step 3) and
   `eko-cron-log-cleanup` (daily, deletes only the eko-* jobs' run log older than 7 days).
2. **Edge Function** — redeploy `supabase/functions/dispatch-notifications/index.ts`
   (dashboard editor or `npx supabase functions deploy dispatch-notifications --no-verify-jwt`).
   Keep **Verify JWT = OFF** (as today): the scheduler calls it without a key, and the new
   `sb_publishable_` keys are not JWTs. This is safe because the function reads no input —
   it only delivers what the database has already queued under its own rules (opt-in,
   test mode, daily cap, one notification per event and person). Only `POST` runs a dispatch
   (other methods: 405); callers without the server key receive just `{"ok":true}` — no counts,
   no error details.
3. **Scheduler address** — PC panel → *Njoftimet promocionale* → *Adresa e funksioneve*:
   `https://mfpmcriffqlhlgaptdzx.supabase.co/functions/v1` → *Ruaj*. Only this form
   (`https://<ref>.supabase.co/functions/v1`) is accepted. Within a minute the panel shows
   **✓ Planifikuesi funksionon (HTTP 200)**; *HTTP 401* means Verify JWT is still ON for
   `dispatch-notifications`. SQL check: `select public.promo_dispatch_status();`
4. **Android push (Firebase)** — required for notifications on the phone (browser only):
   * console.firebase.google.com → **Create a project** (`EKO Store`, Analytics off) →
     **Add app → Android**, package `com.ekoshpk.store` → **Register app** →
     **Download google-services.json** (skip the remaining SDK steps).
   * Firebase → ⚙ **Project settings → Service accounts → Generate new private key** → a JSON
     key file (SECRET: never e-mail, chat or commit it).
   * expo.dev → project **eko-store** → **Credentials → Android → com.ekoshpk.store →
     FCM V1 service account key → Add** → upload that key file.
   * expo.dev → project **eko-store** → **Environment variables → Add variable**: name
     `GOOGLE_SERVICES_JSON`, type **File**, environments **preview** and **production**,
     visibility **Sensitive** → upload `google-services.json`.
   * Build a new APK (`eas.json` maps the `preview` profile to the `preview` environment).
5. **iPhone (later)** — Apple Developer account, then `eas build -p ios`; EAS creates the
   push key (APNs). The app is already configured (`ios.bundleIdentifier`, background mode).

## Test on a real Samsung phone (no real customers involved)

1. Install the new APK, register a **test customer** account (e.g. your second e-mail).
2. Allow notifications when asked; in *Ofertat* tap **Aktivizo** (or switch them on in *Llogaria*).
3. PC panel → *Klientët* → **🧪 Testues promo** on that account.
4. PC panel → *Njoftimet promocionale* → tick **Dërgo njoftime promocionale**
   (test mode stays ON). Optional: *Prit (minuta)* = 0 for faster tests.
5. Tests (the phone may be closed / in the background):
   * new product (active) → "EKO Store – Produkt i ri!" → tap opens the product;
   * lower a price → "EKO Store – Ulje çmimi! Produkti … nga 100€ tani 85€.";
   * raise it → "EKO Store – Ndryshim çmimi! …";
   * offer starting in 2 minutes → push at start → tap opens the offer; after the end the
     regular price is back;
   * change the same price twice quickly → only one notification;
   * switch a preference off → no notification of that type;
   * a wholesale test account receives wholesale prices, a retail one retail prices.
6. Real customers: untick test mode only when you are satisfied.
