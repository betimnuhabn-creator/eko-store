# Faqja eko-store.com (WooCommerce) ⇄ aplikacioni EKO Store

## Si funksionon

| Drejtimi | Çfarë | Kur |
|---|---|---|
| Faqja → aplikacioni | Produktet: emri, përshkrimi, fotot, kategoria (më e thella), **Regular price → çmimi i pakicës**, **Wholesale Customer → çmimi i shumicës**, stoku, publikuar/fshehur. Çdo madhësi (variacion) = një artikull "Emri – 80L". | Menjëherë (webhook) + çdo orë + butoni **Produktet → Sinkronizo me faqen** |
| Aplikacioni → faqja | Porositë e aplikacionit krijohen te **WooCommerce → Orders** me çmimet e aplikacionit (pakicë/shumicë), klientin (sipas emailit), adresën; ndryshimet e statusit në panel ndjekin porosinë. | Brenda ~1 minute — **vetëm kur e aktivizoni** te Produktet → "Dërgo porositë në WooCommerce" |

* Produktet e faqes ndryshohen **vetëm në WordPress** (paneli i shënon "Nga faqja"; ndryshimet aty mbishkruhen).
* Produkt i fshirë / Draft në faqe → i fshehur në aplikacion (nuk fshihet, porositë e vjetra e ruajnë).
* **Regular price = 0** (pa çmim pakice): klientët e pakicës shohin "Çmimi sipas kërkesës" dhe nuk e porositin; shumica punon normalisht.
* Sinkronizimi i parë nuk krijon njoftime promocionale; më pas ndryshimet e çmimeve/produktet e reja ndjekin rregullat e njoftimeve (aktualisht modaliteti test).
* Çelësat e WooCommerce ruhen **vetëm** në Supabase (Secrets), kurrë në aplikacion apo panel.

## Hapat në production (një herë)

1. **SQL Editor** → ekzekutoni `supabase/migrations/20261215000000_woocommerce_sync.sql`.
2. **WordPress → WooCommerce → Settings → Advanced → REST API → Add key**: Description `EKO app`, User administratori, Permissions **Read/Write** → Generate. Kopjoni `ck_…` dhe `cs_…`.
3. **Supabase → Edge Functions → Secrets** → shtoni:
   * `WOO_URL` = `https://eko-store.com`
   * `WOO_CONSUMER_KEY` = `ck_…`
   * `WOO_CONSUMER_SECRET` = `cs_…`
   * `WOO_WEBHOOK_SECRET` = një fjalë e gjatë e rastësishme që e zgjidhni vetë (p.sh. 30+ shkronja/numra)
4. **Supabase → Edge Functions → Deploy a new function → Via Editor**: emri `woo-sync`, ngjitni `supabase/functions/woo-sync/index.ts`, Deploy; pastaj **Settings → Verify JWT: OFF** → Save.
5. Paneli publikohet (me miratim) → **Produktet → Sinkronizo me faqen** (sinkronizimi i parë).
6. **WordPress → WooCommerce → Settings → Advanced → Webhooks → Add webhook** (4 herë: Topic **Product created**, **Product updated**, **Product deleted**, **Product restored**):
   * Status: Active · Delivery URL: `https://mfpmcriffqlhlgaptdzx.supabase.co/functions/v1/woo-sync`
   * Secret: i njëjti si `WOO_WEBHOOK_SECRET` · API Version: WP REST API Integration v3 → Save.
7. Automatizimi çdo orë dhe dërgimi i porosive: Paneli → **Njoftimet promocionale → adresa e Edge Functions** = `https://mfpmcriffqlhlgaptdzx.supabase.co/functions/v1` (aktivizon edhe shpërndarjen automatike të njoftimeve; modaliteti test mbetet).
8. **Porositë**: Produktet → "Dërgo porositë në WooCommerce" → bëni 1 porosi provë me një klient test → kontrolloni WooCommerce → Orders → anulojeni.
9. Plotësoni **Regular price** (pakica) te produktet në faqe.
10. Aplikacioni Android: "Çmimi sipas kërkesës" hyn në build-in e ardhshëm (me konfirmim).

## Rikthim

Paneli: fikni "Dërgo porositë në WooCommerce"; fshini webhook-et; Edge Function `woo-sync` mund të fshihet. Produktet e sinkronizuara mbeten në aplikacion (mund t'i fshehni).
