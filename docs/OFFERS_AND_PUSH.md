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
   test mode, daily cap, one notification per event and person) — and returns no details.
3. **Scheduler address** — PC panel → *Njoftimet promocionale* → *Adresa e funksioneve*:
   `https://mfpmcriffqlhlgaptdzx.supabase.co/functions/v1` → *Ruaj*.
4. **Android push (Firebase)** — required for notifications on the phone:
   * console.firebase.google.com → new project → add Android app, package `com.ekoshpk.store`
     → download `google-services.json`.
   * expo.dev → project *eko-store* → Environment variables → add **file** variable
     `GOOGLE_SERVICES_JSON` (environments: preview, production) with that file.
   * Firebase → Project settings → Service accounts → *Generate new private key* →
     `npx eas credentials` → Android → Push notifications (FCM V1) → upload the key
     (or expo.dev → project → Credentials).
   * Build a new APK.
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
