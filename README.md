# EKO Store — Android MVP (Expo + Supabase)

Starter implementation for EKO SHPK. Includes customer registration/login, wholesale approval state, role-specific prices, product catalog, cart, secure server-side ordering, and admin product entry by photo URL. **Not a finished production app or APK.**

## Setup
1. Create a Supabase project. In SQL Editor run `supabase/schema.sql`.
2. Copy `.env.example` to `.env` and add Supabase project URL and **publishable/anon** key (never service_role key).
3. Install Node.js 20+, run `npm install`, then `npx expo start` and open with Expo Go on Android.
4. Register your own user and promote it to admin using the SQL statement at the bottom of `schema.sql`.
5. Add products from the admin tab. For now, images are added using a publicly reachable image URL.
6. To create an APK, install EAS CLI (`npm i -g eas-cli`), run `eas login`, `eas build:configure`, then `eas build -p android --profile preview`.

## Important limitations / next phase
- Admin can add products, but **editing/deleting products, uploading images directly from the phone, approving wholesale accounts in-app, order management dashboard, customer address/shipping and push notifications are not yet implemented**.
- Email confirmation settings depend on Supabase Auth configuration.
- Order prices are calculated on the server, not trusted from the mobile client. Stock is decremented transactionally.
- Wholesale prices are only exposed by `list_products()` to approved wholesale accounts and admins. Direct table SELECT is revoked.
- Before production: audit RLS and database grants, add payment/shipping terms, privacy policy, image storage, order cancellation/restock logic, input validation and end-to-end tests.


## Përditësim (v0.2)
- Logoja origjinale EKO është shtuar te `assets/eko-logo.png`.
- Fusha e telefonit është shtuar në regjistrim.
- Shqip/English: zgjedhës gjuhe dhe përkthim fillestar i ekraneve kryesore (përkthimi i plotë mbetet për t'u përfunduar).
- Klienti sheh vetëm statusin Në stok / Me porosi; produktet pa stok mund të porositen.
- Porosia regjistrohet pa pagesë online, pa rezervim automatik të stokut.
- `npm run web` hap të njëjtin aplikacion në PC, por paneli i plotë i porosive, aprovimet nga UI, ngarkimi direkt i fotografive dhe push notifications janë ende për implementim.
- Nëse keni përdorur skemën SQL të versionit të mëparshëm, mos e ekzekutoni të plotë mbi databazën ekzistuese; kërkohet migrim i kontrolluar.
- **Nuk është APK i testuar dhe as aplikacion i publikuar.** Për përdorim real duhen konfigurimi i Supabase, testimi i autorizimeve/RLS dhe build-i Android.
