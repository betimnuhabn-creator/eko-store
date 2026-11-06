# EKO Store — Android + Web (Expo + Supabase) · v1.0

One codebase for the **Android app** and the **web shop/admin panel** of EKO SHPK.

**Shqip, shkurt:** aplikacion i plotë për klientë pakice dhe shumice. Çmimet shfaqen vetëm pas hyrjes. Llogaritë e shumicës i aprovon administratori. Administratori menaxhon produktet me foto, kategoritë, porositë (pa pagesë online) dhe klientët, dhe merr njoftime në aplikacion, push në telefon dhe email. Gjuhët: shqip dhe anglisht.

## Features

| Area | What works |
|---|---|
| Languages | Albanian (default) and English, switchable everywhere. Product and category names/descriptions in both languages. |
| Customers | Register (name, phone, email; optional business with name and NUI/NIPT), log in, reset password with an e-mail code, edit profile/address, request wholesale later, delete account (required by Google Play). |
| Prices | Guests see products but **no prices**. Retail customers see retail prices. **Approved** wholesale customers see wholesale prices. Prices are enforced in the database, not just hidden in the app. |
| Shopping | Catalog with search and categories, product page with photo gallery, "In stock / Available to order", cart (saved on the device), checkout with delivery address. |
| Orders | No online payment: *cash on delivery* or *bank transfer after confirmation*. Totals are calculated on the server. Customers see order history and status, and can cancel while the order is "New". |
| Admin | Dashboard (new orders, wholesale requests, 30-day sales…). Products: create/edit/hide/delete, both prices, stock, unit, up to 10 photos uploaded from the phone camera, gallery or PC (resized automatically). Categories. Orders by status, change status with an internal note, call or e-mail the customer. Customers: approve/reject/revoke wholesale. |
| Notifications | Admins are notified of **new orders, cancellations, wholesale requests and new customers**. Customers are notified of **order status changes and wholesale decisions**. Delivered in the app (live), as **push notifications** on Android, as **browser notifications** in the web admin, and as **e-mail** to admins. |

## Project layout

```
app/                     screens (expo-router)
  (tabs)/                Products · Cart · Orders · Account · Admin
  admin/                 products, categories, orders, customers
components/ lib/         UI, translations (lib/i18n.tsx), auth, cart, catalog, notifications
supabase/migrations/     database (tables, security rules, functions, storage)
supabase/functions/      dispatch-notifications (push + e-mail sender)
supabase/seed.sql        demo products for LOCAL development only
tests/                   backend integration tests + browser end-to-end tests
```

## 1. Set up Supabase (once)

**Detailed, click-by-click guide: [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md)** (including a test you can run against your real project with only the publishable key).

1. Create a project at supabase.com.
2. **Database:** open *SQL Editor*, paste the whole file `supabase/migrations/20261105000000_eko_store_v1.sql` and run it.
   It works on an empty project **and** on a project where the old v0.2 `schema.sql` was run, and it keeps existing data. Running it twice is safe.
   (Alternatively, with the CLI: `npx supabase link --project-ref <ref>` then `npx supabase db push`.)
3. **Auth → URL configuration:** set *Site URL* to your web shop address.
4. **Auth → Email templates → Reset password:** add this line so the app's code-based reset works on Android and web:
   `<p>Kodi / Code: <strong>{{ .Token }}</strong></p>`
5. **Auth → SMTP:** configure your own SMTP (e.g. Resend). Supabase's built-in mailer only sends a few e-mails per hour.
6. **Notification function:**
   ```bash
   npx supabase functions deploy dispatch-notifications --no-verify-jwt
   # optional e-mail to admins (resend.com, with a verified domain):
   npx supabase secrets set RESEND_API_KEY=re_xxx EMAIL_FROM="EKO Store <porosi@your-domain.com>" APP_URL=https://shop.your-domain.com
   # optional extra recipients: ADMIN_EMAILS=a@x.com,b@y.com
   ```
7. **First administrator:** register in the app, then in SQL Editor:
   ```sql
   update public.profiles set role = 'admin', wholesale_status = 'none' where email = 'YOUR_EMAIL';
   ```

## 2. Run the app

```bash
cp .env.example .env      # fill in the project URL + publishable/anon key
npm install
npm start                 # Expo dev server; press "w" for the web version
```

## 3. Android APK / Play Store

```bash
npm i -g eas-cli
eas login
eas init                  # creates the EAS project id, needed for push notifications
eas build -p android --profile preview      # installable APK for testing
eas build -p android --profile production   # .aab for Google Play
```
The Supabase URL and publishable key go into `eas.json` (see [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md), step 1). Run `npm run check:config` before building: it rejects missing values and any secret key.

**Push notifications on Android** need Firebase Cloud Messaging: create a Firebase project, add an Android app with package `com.ekoshpk.store`, and upload the FCM v1 service-account key with `eas credentials` (see Expo's "Push notifications setup" guide). Push does **not** work in Expo Go; use the APK. Admins receive push on every phone where they are logged in.

## 4. Web shop and admin panel

```bash
npm run build:web          # output in dist/
```
Upload `dist/` to any static host (Netlify, Vercel, Cloudflare Pages, or your own server). `_redirects` and `vercel.json` are included so links like `/admin/orders/…` work. On your own server, send unknown paths to `index.html`.

## 5. Tests (local, needs Docker)

```bash
npm run db:start                 # local Supabase (same Postgres/Auth/Storage as hosted)
npm run functions:serve:test     # second terminal: Edge Function wired to a fake push/e-mail server
npm run test:migration           # 58 checks: empty project, re-runs, rollback on error, v0.2 upgrade (all wholesale_approved cases), order numbers, no data loss
npm run test:security            # 36 checks: privileges, RLS, SECURITY DEFINER audit, direct API/GraphQL attacks, storage, wholesale approval
npm run test:notify-db           # 15 checks: claim tokens, stale workers, both finish_notifications() updates, give-up
npm run test:notifications       # 8 checks: delivery only marked done after success, retries, give-up after 5, crash recovery
npm run test:backend             # 28 checks: catalog, orders, products, categories, account deletion
cp .env.example .env.local       # point it at http://127.0.0.1:54321 + local publishable key (npx supabase status)
npm run test:e2e                 # browser: guest → register → order → admin approves → wholesale prices
```

## Security notes

- The app only ever uses the publishable/anon key. Every change goes through database functions that check who is calling, and clients have no direct write access to any table.
- The `products` table cannot be read directly: `list_products()` returns the right price for the caller.
- Notifications are marked delivered only after push/e-mail succeeded; failures are retried up to 5 times (`last_error` shows why).
- Stock is **not** reserved automatically. EKO confirms availability after receiving the order (as requested). Stock is shown to customers only as "In stock / Available to order".

## Before going live

- Use a **high-resolution or vector EKO logo**: the current icon is upscaled from a 250 px image.
- Publish a privacy policy (required by Google Play) and your delivery/payment terms.
- Test push notifications with a real APK and a Firebase project.
