# Fshirja e llogarive të klientëve

## Ku

| Kush | Ku | Konfirmimi |
|---|---|---|
| Administratori | Paneli PC → **Klientët → 🗑 Fshi klientin** | Dritare me emrin, emailin dhe numrin e porosive (të dhënat nga serveri), paralajmërim nëse ka porosi / porosi të hapura, fjalëkalimi i administratorit |
| Klienti | Aplikacioni → **Llogaria → Fshi llogarinë time** | Shpjegim (çfarë fshihet / ruhet), paralajmërim për porosi të hapura, fjalëkalimi i llogarisë + pyetja e fundit "A jeni i sigurt?" |
| Klienti pa aplikacion | Faqja publike **delete-account.html** (Google Play) | Email + fjalëkalim + kutia "E kuptoj…" |

Llogaritë e administratorëve nuk fshihen asnjëherë në këto rrugë (as nga një administrator tjetër, as nga vetja).

## Si funksionon (server)

1. Paneli / aplikacioni / faqja thërrasin Edge Function **`delete-account`** me sesionin e përdoruesit (vetëm çelësi publik).
2. Funksioni verifikon sesionin te Supabase Auth, lexon rolin nga databaza dhe **ri-autentikon** me fjalëkalimin e thirrësit (administratori: fjalëkalimi i vet; klienti: fjalëkalimi i llogarisë). Klienti mund të fshijë vetëm llogarinë e vet; administratori vetëm klientë.
3. Funksioni thërret me çelësin e serverit (që ekziston vetëm në Supabase) **`delete_customer_account(p_user, p_actor)`**, në një transaksion të vetëm:
   * fshin tokenat Push → nuk dërgohen më njoftime;
   * heq emailin e klientit nga regjistri i ndryshimeve të fjalëkalimit (ruhet vetëm kush/kur);
   * shkruan një rresht në `account_deletion_audit` (kur, self/admin, cili administrator, sa porosi u ruajtën) — **pa** emër, email ose telefon;
   * fshin llogarinë në **Supabase Authentication** (`auth.users`) → bashkë me të sesionet dhe refresh token-at, profili (emri, telefoni, adresa, biznesi, preferencat) dhe njoftimet.
4. Aplikacioni çkyçet automatikisht; hyrja me atë email/fjalëkalim refuzohet.

## Çfarë ruhet

**Porositë dhe rreshtat e tyre** ruhen për kontabilitet/ligj: numri, data, produktet, çmimet, totali, mënyra e pagesës dhe të dhënat e dorëzimit të shkruara në porosi (emri, telefoni, adresa). Ato nuk lidhen më me llogarinë (`customer_id = null`); paneli i shfaq si "klient i fshirë". Asgjë tjetër në porosi nuk ndryshon. Porositë e hapura nuk anulohen automatikisht — administratori paralajmërohet dhe vendos vetë.

## Përputhshmëria me versionet e vjetra

Aplikacionet deri në 1.3.0 përdorin RPC `delete_my_account()`. Ai vazhdon të funksionojë (vetëm llogaria e vet, kurrë administrator) dhe tani kalon nga i njëjti funksion, pra regjistrohet njësoj. Pas përditësimit të aplikacionit tek të gjithë, ky RPC mund të mbyllet që fshirja të kërkojë gjithmonë fjalëkalimin.

## Publikimi në production (manualisht, pas miratimit)

1. **SQL Editor:** ekzekutoni `supabase/migrations/20261205000000_account_deletion.sql` (një herë; mund të ri-ekzekutohet). Nuk ndryshon të dhëna ekzistuese.
2. **Edge Function:** publikoni `delete-account` me **Verify JWT = OFF** (funksioni e verifikon vetë sesionin, si `admin-set-password`). Nuk kërkon sekrete të reja.
   * CLI: `npx supabase functions deploy delete-account --no-verify-jwt --project-ref <ref>`
   * ose Dashboard → Edge Functions → Deploy new function → emri `delete-account` → ngjitni `supabase/functions/delete-account/index.ts` → çaktivizoni "Verify JWT".
3. **Paneli PC** (gh-pages): butoni "Fshi klientin".
4. **Faqja publike**: `delete-account.html` publikohet bashkë me faqet ligjore, kur të vendoset `VITE_CONTACT_EMAIL` në `admin-web/.env.production`. URL: `https://betimnuhabn-creator.github.io/eko-store/delete-account.html` → Play Console → *Data safety → Delete account URL*.
5. **Aplikacioni Android**: ekrani i ri hyn në build-in e ardhshëm (versioni + build vetëm me konfirmim). Deri atëherë 1.3.0 përdor fshirjen e vjetër, që vazhdon të funksionojë.

Rikthim: `drop function public.delete_customer_account(uuid, uuid);` dhe rikrijimi i `delete_my_account()` nga migrimi v1 (tabela e auditimit mund të mbetet).
