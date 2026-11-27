# Një llogari për faqen eko-store.com dhe aplikacionin

* I njëjti **email + fjalëkalim** punon në faqe dhe në aplikacion.
* Lidhja bëhet në momentin e hyrjes:
  * hyrja në **aplikacion** dështon → serveri pyet faqen; fjalëkalimi i saktë atje → krijohet/përditësohet llogaria e aplikacionit;
  * hyrja në **faqe** dështon → faqja pyet aplikacionin; fjalëkalimi i saktë atje → krijohet/përditësohet përdoruesi i WordPress.
* Fjalëkalimi i ndryshuar në njërin vend kalon te tjetri në hyrjen e radhës atje.
* **Shumica**: aprovimi në aplikacion → roli "Wholesale Customer" në faqe (brenda ~1 minute); roli "Wholesale Customer" në faqe → aprovim në aplikacion (menjëherë, me njoftim).
* **Administratorët** (në aplikacion ose në WordPress) nuk lidhen kurrë.
* Kufi: 10 hyrje përmes lidhjes për email në 15 minuta.
* Fjalëkalimet nuk ruhen kurrë të pakoduara dhe nuk shkruhen në log.

## Hapat në production

1. **SQL Editor** → `supabase/migrations/20261228000000_account_link.sql`.
2. Krijoni një sekret të gjatë të rastësishëm (30+ shkronja/numra) → **Supabase → Edge Functions → Secrets**: `EKO_LINK_SECRET` = ai sekret.
3. **Edge Functions**: publikoni `account-link` (i ri, Verify JWT **OFF**) dhe ripublikoni `woo-sync`.
4. **WordPress → Snippets → Add New**: kodi nga `docs/wordpress/eko-account-link.php`; te rreshti `define( 'EKO_LINK_SECRET', 'VENDOSNI-KETU-SEKRETIN' );` vendosni të njëjtin sekret → Run everywhere → Save and Activate.
5. Aplikacioni: hyrja me llogari të faqes kërkon versionin **1.3.4** (me konfirmim).

## Kufizime

* "Keni harruar fjalëkalimin?" funksionon veç e veç: në aplikacion për llogaritë e aplikacionit, në faqe për llogaritë e faqes.
* Hyrja në faqe me **emër përdoruesi** (jo email) lidhet vetëm nëse përdoruesi ekziston tashmë në WordPress.
