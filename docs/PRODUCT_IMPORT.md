# Importi / eksporti i produkteve me Excel (Paneli PC → Produktet)

Vetëm për administratorët. Aplikacioni Android nuk ndryshon.

## Butonat

| Butoni | Çfarë bën |
|---|---|
| **Template Excel** | Shkarkon `eko-produktet-template.xlsx`: fleta *Produktet* (vetëm kolonat) dhe fleta *Udhëzime* (shpjegimi i çdo kolone + lista e kategorive ekzistuese). |
| **Eksporto Excel** | Shkarkon të gjitha produktet ekzistuese në të njëjtin format. Ndryshoni çmimet dhe importojeni sërish skedarin (pa ZIP): fotot ekzistuese mbeten. |
| **Importo produktet** | Zgjidhni skedarin `.xlsx` dhe (opsionale) një ZIP me fotot → **Lexo** → pamje paraprake → **Importo**. |

## Kolonat e template-it

`SKU *` · `Emri (shqip) *` · `Emri (anglisht)` · `Përshkrimi (shqip)` · `Përshkrimi (anglisht)` · `Kategoria` · `Njësia` · `Çmimi pakicë (€) *` · `Çmimi shumicë (€) *` · `Stoku` · `Aktiv (Po/Jo)` · `Fotot (emrat në ZIP, të ndara me ;)`

* **SKU** është çelësi: nëse ekziston (pa dallim shkronjash të mëdha/vogla) → produkti **përditësohet**, përndryshe **krijohet**. I njëjti SKU dy herë në Excel → rreshti i dytë refuzohet. Kështu nuk krijohen dyfishime (kontrolli bëhet edhe në databazë).
* Produkt i ri: Emri, Çmimi pakicë dhe Çmimi shumicë janë të detyrueshëm.
* Përditësim: qelizat bosh **nuk** ndryshojnë asgjë (p.sh. një skedar me vetëm SKU + çmime ndryshon vetëm çmimet).
* Çmimet pranohen si `34,90`, `34.90`, `1.234,50`, `34,90 €`. Pakica dhe shumica importohen veçmas. Paralajmërim (jo gabim) nëse shumica > pakica.
* Kategoria duhet të ekzistojë (emri shqip ose anglisht, si në panel).
* Emrat e kolonave pranohen edhe në variante (p.sh. `Kodi`, `Cmimi pakice`, `Foto`).

## Fotot

* Të gjitha fotot në **një ZIP**; në kolonën *Fotot* shkruhen emrat e skedarëve (pa dosje), të ndara me `;` — deri në 10 për produkt. P.sh. `HS-001-1.jpg; HS-001-2.jpg`.
* Emrat krahasohen pa dallim shkronjash dhe pavarësisht dosjes brenda ZIP-it.
* Formatet: JPG, PNG, WEBP (kontrollohet përmbajtja reale e skedarit, jo vetëm prapashtesa), deri në 15 MB secila. Skedarët e tjerë (`__MACOSX`, skedarë të fshehur, PDF…) anashkalohen.
* Fotot zvogëlohen si te ngarkimi normal dhe ruhen në **Supabase Storage** (`product-images`). Një foto e përdorur nga disa produkte ngarkohet vetëm një herë. Fotot e rreshtave të refuzuar fshihen menjëherë (nuk mbeten skedarë jetimë).
* Foto e shkruar në Excel por që mungon në ZIP → rreshti refuzohet.
* Kolona *Fotot* bosh → fotot ekzistuese mbeten. Lidhjet `https://…` (si në eksport) pranohen.

## Pamja paraprake dhe raporti

* Para importit shfaqen: numri i produkteve të reja / përditësimeve / me gabime, tabela me foton e parë, çmimet (i vjetri → i riu), gabimet dhe paralajmërimet për çdo rresht, me filtra.
* **Produkte në këtë import: 100 / 500 / 1.000** — sa rreshta merren nga skedari.
* Importi dërgohet në grupe prej 50 rreshtash me shirit progresi; çdo rresht përpunohet veçmas, një rresht i gabuar nuk ndalon të tjerët.
* Në fund: raport **Të shtuara / Të përditësuara / Të refuzuara** me arsyen për çdo rresht, i shkarkueshëm si Excel.
* **Njoftimet promocionale**: opsioni "Njofto klientët…" është i çaktivizuar si parazgjedhje → importi nuk krijon njoftime "produkt i ri"/"ndryshim çmimi". Ruajtjet normale në panel/Android funksionojnë si më parë.

## Siguria

* Funksioni `admin_import_products` (SECURITY DEFINER, `search_path=''`) thërret `assert_admin()` në fillim; klientët marrin `ADMIN_ONLY`, vizitorët nuk kanë qasje. Ngarkimi i fotove në Storage lejohet vetëm për administratorët (RLS ekzistuese).
* Maksimumi 200 rreshta për thirrje, lidhjet e fotove vetëm `https://`, çmime 0–9.999.999, stok ≥ 0.
* Nuk përdoret asnjë çelës service_role; paneli përdor vetëm çelësin publik dhe sesionin e administratorit.

## Hapat në production (manualisht, pas miratimit)

1. **Supabase → SQL Editor**: ekzekutoni të gjithë skedarin `supabase/migrations/20261128000000_product_import.sql` një herë (mund të ekzekutohet sërish pa dëm). Nuk ndryshon asnjë tabelë dhe asnjë të dhënë; shton vetëm një indeks për SKU dhe funksionin e importit.
2. Publikoni panelin (`admin-web`, gh-pages).
3. Provë e parë: eksportoni produktet, ndryshoni çmimin e 1 produkti, importoni skedarin dhe kontrolloni raportin.

Rikthim: `drop function public.admin_import_products(jsonb, boolean);` (indeksi `products_sku_lower_idx` mund të mbetet; trigger-i sillet njësoj si më parë kur nuk ka import).
