# Password recovery and password change

## How it works

1. **App → Hyr → "Keni harruar fjalëkalimin?"** → the customer enters the e-mail.
   The format is checked, then `supabase.auth.resetPasswordForEmail(email, { redirectTo })`
   is called with `redirectTo = https://betimnuhabn-creator.github.io/eko-store/reset-password.html`.
   The app always answers *"Nëse kjo adresë është e regjistruar, do të pranoni një email…"*
   (it never reveals whether the address exists); only "too many requests" and "no connection"
   get their own message. A new request is possible after 60 s.
2. **E-mail** (Supabase Auth) with the link `{{ .ConfirmationURL }}` (and, if the template has it,
   a 6-digit code `{{ .Token }}`).
3. **Link** → Supabase verifies it (single use, expires) → redirects to the **reset page**
   (`admin-web/reset-password.html`, published with the PC panel on GitHub Pages) with a one-time
   recovery session in the URL fragment. The page:
   * checks the link with Supabase first (expired / used / forged → "Lidhja nuk është më e vlefshme");
   * removes the tokens from the address bar, sends no referrer;
   * **"Hap në aplikacionin EKO Store"** → `ekostore://reset-password#…` opens the Android app
     (closed, in the background or open) on the screen *Fjalëkalimi i ri*;
   * or lets the customer set the new password **on the web** (alternative, e.g. on a PC).
4. **App screen "Fjalëkalimi i ri"** (`app/reset-password.tsx`): `setSession` verifies the tokens
   with Supabase before the form is shown; new password + confirmation + show/hide;
   `updateUser({ password })`; then **all sessions of the account are signed out** and the app
   opens *Hyr* with "Fjalëkalimi u ndryshua. Hyni me fjalëkalimin e ri."
5. **6-digit code** (alternative): *"Keni marrë një kod me 6 shifra në email?"* → code + new password
   (`verifyOtp` type `recovery`, then `updateUser`).
6. **Llogaria → Siguria → Ndrysho fjalëkalimin** (`app/change-password.tsx`): current password is
   verified with Supabase first (re-authentication), then `updateUser`; the success message appears
   only after Supabase accepted it. No other profile data changes.

No database change. No secret key, password or SMTP credential is in the code.

## Manual setup in Supabase (production, once)

Dashboard → project `mfpmcriffqlhlgaptdzx`:

1. **Authentication → URL Configuration**
   * **Redirect URLs → Add URL**:
     `https://betimnuhabn-creator.github.io/eko-store/reset-password.html`
     and `ekostore://reset-password`
   * **Site URL**: if it is `http://localhost:3000` (or empty), set it to
     `https://betimnuhabn-creator.github.io/eko-store/reset-password.html`
     (the page also handles sign-up confirmation links). Otherwise leave it.
2. **Authentication → Emails → SMTP Settings** — required for real customers. Supabase's
   built-in sender only delivers to the project's team members and only a few e-mails per hour.
   Enable **custom SMTP**, e.g. with Resend (resend.com, verified sending domain):
   Host `smtp.resend.com`, Port `465`, Username `resend`, Password = your Resend API key
   (typed only into this Supabase form), Sender e-mail e.g. `noreply@<your domain>`,
   Sender name `EKO Store`. Then **Authentication → Rate Limits → e-mails per hour**: e.g. 30.
3. **Authentication → Emails → Templates → Reset Password**
   * Subject: `EKO Store – Rikuperimi i fjalëkalimit`
   * Body:
     ```html
     <h2>EKO Store – Rikuperimi i fjalëkalimit</h2>
     <p>Kemi marrë një kërkesë për të ndryshuar fjalëkalimin e llogarisë suaj.</p>
     <p><a href="{{ .ConfirmationURL }}">Vendos fjalëkalimin e ri</a></p>
     <p>Ose shkruani këtë kod në aplikacion: <strong>{{ .Token }}</strong></p>
     <p>Lidhja dhe kodi vlejnë për pak kohë dhe përdoren vetëm një herë.
        Nëse nuk e keni kërkuar ju, injorojeni këtë email.</p>
     ```
4. **Authentication → Providers → Email**: *Minimum password length* 6 (as in the app). A stricter
   policy also works: the app then shows Supabase's "password too weak" message.
5. Publish the PC panel (the reset page is part of it) — only with approval.

## Test on the Samsung phone (after steps 1–5)

1. Install the new APK. *Hyr → Keni harruar fjalëkalimin?* → your test e-mail → *Dërgo*.
2. Open the e-mail **on the phone** (also check Spam) → tap the link → the reset page opens.
3. Tap **Hap në aplikacionin EKO Store** → the app opens *Fjalëkalimi i ri* (try with the app closed,
   in the background and open).
4. New password twice → *Ruaj fjalëkalimin* → *Hyr* opens with the success message.
5. Log in with the new password ✓; the old one is refused ✓.
6. Tap the same e-mail link again → "Lidhja nuk është më e vlefshme" ✓.
7. *Llogaria → Ndrysho fjalëkalimin*: wrong current password refused, correct one changes it ✓.
