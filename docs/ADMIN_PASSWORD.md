# Admin sets a customer's password (PC panel → Klientët → 🔑 Fjalëkalimi)

## What it does

* The **main administrator** (and nobody else — not every admin) opens *Klientët*, clicks
  **🔑 Fjalëkalimi** on a customer: name, e-mail, *Fjalëkalimi i ri* (show/hide),
  **Gjenero fjalëkalim të sigurt** (14 characters, upper/lower/digit/symbol, browser crypto),
  *Fjalëkalimi juaj* (re-authentication), **Ruaj fjalëkalimin**.
* The confirmation appears only after Supabase changed the password. The new password can then
  be shown and **copied** for the customer; it exists only in that window and is gone when it
  closes. The old password is never shown (it cannot be: Supabase stores only a hash).
* The customer's open sessions are ended; at the next login the app sends the customer to
  **Ndrysho fjalëkalimin** ("Administratori ju ka vendosur një fjalëkalim të përkohshëm…") and
  nothing else can be used until a new password is chosen. The database clears that requirement
  itself when the password changes.
* Audit: table `password_reset_audit` (administrator, customer, time — never the password),
  not readable through the API. Supabase → Table Editor or SQL:
  `select * from password_reset_audit order by created_at desc;`

## Security

* Edge Function `admin-set-password` (server): verifies the caller's session with Supabase Auth,
  requires the caller's e-mail in the secret **`PASSWORD_ADMIN_EMAILS`** AND role `admin`,
  re-authenticates the administrator's own password (the extra session is closed at once),
  refuses administrators (others and oneself) as targets, uses the Auth Admin API with the
  service key that exists only inside Supabase. Nothing about passwords is logged or stored.
* Without the secret, nobody can use it (the button does not appear).
* The panel has no service key; the button is shown only when the server says so.

## Setup in Supabase (production, once — only with approval)

1. **SQL Editor** → run `supabase/migrations/20261120000000_admin_password_reset.sql`
   (one transaction, safe to run twice; adds `profiles.must_change_password`, the audit table,
   one internal function and a trigger; changes no existing data).
2. **Edge Functions → Deploy a new function → Via Editor**: name **`admin-set-password`**,
   paste `supabase/functions/admin-set-password/index.ts` → **Deploy**.
   In its **Details / Settings**: *Verify JWT* **OFF** (the function verifies the session itself).
3. **Edge Functions → Secrets → Add new secret**: name `PASSWORD_ADMIN_EMAILS`,
   value = your own administrator e-mail (several: comma-separated) → **Save**.
4. Publish the PC panel (approval) and install the Android build that contains the
   "must change password" screen (1.2.4 or later).

## Check

* PC panel as main administrator → *Klientët*: each customer has **🔑 Fjalëkalimi**.
  As another administrator: no button.
* Set a test customer's password → log in to the app with it → *Ndrysho fjalëkalimin* opens →
  change it → the app works normally; the temporary password no longer works.
