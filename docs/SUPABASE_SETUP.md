# Connecting EKO Store to your Supabase project

The Android and web apps use **only** the Project URL and the **publishable** key
(`sb_publishable_…`, or the legacy `anon` key). Never put a `sb_secret_…` /
`service_role` key or the database password in the app, in `.env`, or in chat.

## Step 1 — App connection

Dashboard → **Project Settings → API** (or the **Connect** button): copy the Project URL.

Create `.env` in the project folder (it is git-ignored):

```
EXPO_PUBLIC_SUPABASE_URL=https://YOUR-REF.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
```

For Android builds, store the same two values in EAS:
`eas env:create --name EXPO_PUBLIC_SUPABASE_URL --value https://YOUR-REF.supabase.co --environment preview --environment production --visibility plaintext`
(and the same for `EXPO_PUBLIC_SUPABASE_ANON_KEY`).

## Step 2 — Database (tables, RLS, functions, storage)

Dashboard → **SQL Editor → New query**. Paste the **entire** file
`supabase/migrations/20261105000000_eko_store_v1.sql` and press **Run**.
It should finish with "Success. No rows returned".

This one script creates everything:

| Part | What it sets up |
|---|---|
| Tables | `profiles`, `categories` (3 defaults), `products`, `orders`, `order_items`, `notifications`, `push_tokens` |
| Row Level Security | Enabled on every table. Customers read only their own profile/orders/notifications; categories are public; **`products` is not readable directly** |
| Grants | `anon`/`authenticated` get read-only access; every write goes through checked functions (`place_order`, `admin_save_product`, …) |
| Functions | `list_products()` returns the right price per user (none for guests) |
| Storage | Public bucket `product-images` (5 MB, jpg/png/webp); only admins can upload/delete |
| Realtime | `notifications` added to the realtime publication (live alerts in the app) |
| Trigger | New sign-up → profile created automatically; admins notified |

Optional demo products: run `supabase/seed.sql` the same way.

Check it (SQL Editor):

```sql
select tablename, rowsecurity from pg_tables where schemaname = 'public';   -- all true
select id, public from storage.buckets;                                      -- product-images | true
select count(*) from public.categories;                                      -- 3
```

Then in **Database → Publications → supabase_realtime**, `notifications` should be listed.

## Step 3 — Authentication

Dashboard → **Authentication**:

1. **Sign In / Providers → Email**: enabled.
   - **Confirm email**: for the first tests you may turn it **off** (Supabase's built-in
     mailer only delivers to your own team's addresses and a few mails per hour).
     Turn it back **on** once custom SMTP (point 4) works.
   - Minimum password length: 6 or more.
2. **URL Configuration → Site URL**: the address of your web shop (e.g. `https://shop.eko-shpk.com`).
3. **Emails → Templates → Reset password**: add this line to the template so the
   app's reset-with-code screen works on Android and web:
   ```html
   <p>Kodi / Code: <strong>{{ .Token }}</strong></p>
   ```
4. **Emails → SMTP Settings**: enable custom SMTP (e.g. Resend: host `smtp.resend.com`,
   port 465, user `resend`, password = your Resend API key, sender on your verified domain).

## Step 4 — First administrator

Register in the app with your own e-mail, then in SQL Editor:

```sql
update public.profiles set role = 'admin', wholesale_status = 'none'
where email = 'YOUR_EMAIL';
```

Log out and in again: the **Administrimi** tab appears.

## Step 5 — Notifications (push + e-mail)

Needs the Supabase CLI on your computer (`npx supabase login`, `npx supabase link --project-ref YOUR-REF`):

```bash
npx supabase functions deploy dispatch-notifications --no-verify-jwt
npx supabase secrets set RESEND_API_KEY=re_xxx EMAIL_FROM="EKO Store <porosi@your-domain>" APP_URL=https://shop.your-domain
```

The function uses the service role key that Supabase injects **on the server**;
it is never in the app.

## Step 6 — Test with the publishable key only

```bash
node tests/live-check.mjs setup     # migration, RLS, storage, guest, retail registration + order, business request
```
Approve **TEST Biznes SHPK** in the app (Administrimi → Klientët → Aprovo), then:
```bash
node tests/live-check.mjs verify    # wholesale price + wholesale order
```

## Step 7 — Remove the test data

```sql
delete from public.orders where customer_note = 'TEST – mos e dërgo';
delete from auth.users where email like '%@eko-test.invalid';
```

## Going live checklist

- [ ] "Confirm email" back **on**, custom SMTP working
- [ ] Reset-password template contains `{{ .Token }}`
- [ ] At least one admin; test users deleted
- [ ] `dispatch-notifications` deployed, Resend secrets set, Firebase/FCM set up in EAS for Android push
- [ ] Optional: **Auth → Attack Protection**: enable CAPTCHA / leaked-password protection
