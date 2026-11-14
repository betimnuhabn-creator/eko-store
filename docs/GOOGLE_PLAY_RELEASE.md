# EKO Store — Google Play release checklist

App: **EKO Store**, package **`com.ekoshpk.store`**, version **1.3.0 (versionCode 8)**.
Builds: `eas build -p android --profile production` → **AAB** for Google Play;
`--profile preview` → **APK** for testing on phones. Both use the production Supabase project and
the Firebase file from the EAS environment (`GOOGLE_SERVICES_JSON`), and are signed with the same
EAS keystore, so installed test APKs update in place.

Android permissions in the build: CAMERA (admins photograph products), INTERNET,
POST_NOTIFICATIONS, VIBRATE. Removed: RECORD_AUDIO, READ/WRITE_EXTERNAL_STORAGE,
SYSTEM_ALERT_WINDOW. `allowBackup=false` (the login session is not copied to cloud backups).

## 1. Before the first upload (manual, once)

1. **Contact e-mail for the legal pages** — `admin-web/.env.production`:
   `VITE_CONTACT_EMAIL=<public contact address of EKO SHPK>` → then publish the PC panel
   (the deploy script refuses to publish the legal pages without it). Pages:
   * Privacy Policy: `https://betimnuhabn-creator.github.io/eko-store/privacy.html`
   * Terms of Service: `https://betimnuhabn-creator.github.io/eko-store/terms.html`
   * Account deletion: `https://betimnuhabn-creator.github.io/eko-store/delete-account.html`
   Have the texts reviewed by EKO (they are a template based on what the app really does).
2. **Supabase → Authentication → Emails → SMTP**: custom SMTP (e.g. Resend) — required so real
   customers receive password-recovery e-mails (see `docs/PASSWORD_RESET.md`).
3. **Then Supabase → Authentication → Providers → Email → Confirm email: ON** (recommended;
   currently OFF, so anyone can register with someone else's address). Only after step 2.
4. **Promotional notifications** stay in TEST MODE until you decide otherwise (PC panel →
   Njoftimet promocionale). Not changed by the release.

## 2. Google Play Console

1. Developer account (one-time fee). New *personal* accounts must run a **closed test with at
   least 12 testers for 14 days** before production access is granted.
2. **Create app**: name "EKO Store", default language Albanian (add English), App, Free.
3. **Testing → Internal testing → Create release** → upload the **AAB** → accept **Play App
   Signing** (the EAS keystore becomes the upload key).
4. **Store listing**: short/long description (sq + en), app icon 512×512 (from `assets/icon.png`),
   feature graphic 1024×500, at least 2 phone screenshots.
5. **App content**:
   * Privacy policy URL: the privacy page above.
   * **App access**: login required for prices and orders → give Google a working **retail test
     account** (e-mail + password) — not a real customer, not an admin.
   * Ads: **No**. Content rating questionnaire. Target audience: **18+**.
   * **Data safety** (answers below). **Account deletion URL**: the delete-account page above.
   * Not a news app, no government/financial features, no health data.

### Data safety answers (what the app really does)

| Data | Collected | Shared | Purpose | Optional |
|---|---|---|---|---|
| Name, e-mail, phone, address | Yes | No | Account management, app functionality | Required |
| Business name / NUI (wholesale) | Yes ("Other info") | No | App functionality | Optional |
| Purchase history (orders) | Yes | No | App functionality | Required for ordering |
| Device or other IDs (push token) | Yes | No | App functionality (notifications) | Optional (permission) |
| Photos (admins only, product photos) | Yes | No | App functionality | Optional |
| Location, contacts, messages, health, financial/payment info, web history, ads data | No | — | — | — |

Encrypted in transit: **Yes**. Users can request deletion: **Yes** (in the app and via the URL).
Service providers (Supabase, Expo, Firebase, e-mail provider, GitHub Pages) process data on
EKO's behalf — that is not "sharing" in Play's definition.

## 3. Final test on a Samsung phone (preview APK)

Install over the previous version (update keeps the login), then:
retail login → catalog prices → cart → order → push "Porosia …" after a status change in the
PC panel → notifications in 4 categories; wholesale login → wholesale prices; admin in the app;
forgot password → e-mail → link → new password → login; profile → change password;
Account → Privacy Policy / Terms open; delete a **test** account.
