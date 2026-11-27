# EKO Store – materialet për Google Play

Të gjitha skedarët në këtë dosje janë gati për t'u ngarkuar në Play Console.

| Skedari | Ku ngarkohet | Kërkesa e Google |
|---|---|---|
| `icon-512.png` | Store listing → App icon | 512×512 PNG |
| `feature-graphic.png` | Store listing → Feature graphic | 1024×500, pa transparencë |
| `screenshots/1…7-*.png` | Store listing → Phone screenshots | 1080×1920 (2–8 foto) |

Screenshots janë nga aplikacioni i vërtetë me një **katalog demo** (produkte, çmime dhe klient prove).
Kur katalogu real të ketë produkte me foto, mund t'i zëvendësoni me screenshots nga telefoni juaj.
Ekrani 7 tregon "Fshi llogarinë time", që hyn në versionin 1.3.1.

---

## 1. Store listing (copy-paste)

**Emri i aplikacionit** (maks. 30): `EKO Store`

### Shqip (gjuha kryesore)

**Përshkrimi i shkurtër** (maks. 80):
```
Hidrosanitari, ngrohje dhe pajisje banjoje – porositni me çmime pakicë/shumicë.
```

**Përshkrimi i plotë:**
```
EKO Store është aplikacioni zyrtar i EKO SHPK për porosi të shpejta të materialeve hidrosanitare, ngrohjes dhe pajisjeve të banjës.

ÇFARË MUND TË BËNI
• Shfletoni katalogun sipas kategorive: Hidrosanitari, Ngrohje, Pajisje banjoje
• Kërkoni produkte sipas emrit ose kodit
• Shihni çmimet tuaja: klientët me pakicë shohin çmimin e pakicës, bizneset e aprovuara çmimin e shumicës
• Ofertat e momentit me zbritje dhe afat të qartë
• Shtoni në shportë dhe dërgoni porosinë për pak sekonda
• Ndiqni statusin e porosisë: e re, e konfirmuar, në përgatitje, e dërguar, e dorëzuar
• Njoftime për porositë tuaja, dhe sipas dëshirës për oferta, produkte të reja dhe ndryshime çmimesh

PËR BIZNESE
Regjistrohuni si biznes me emrin dhe NUI/NIPT. Pas aprovimit nga EKO, në aplikacion shfaqen automatikisht çmimet e shumicës.

PAGESA DHE DORËZIMI
Pagesa bëhet në dorëzim ose me transfer bankar. Në aplikacion nuk kërkohen të dhëna të kartës.

PRIVATËSIA
Të dhënat tuaja përdoren vetëm për llogarinë dhe porositë. Llogarinë mund ta fshini në çdo kohë nga aplikacioni (Llogaria → Fshi llogarinë time).
```

### English

**Short description:**
```
Plumbing, heating & bathroom supplies – order at retail or wholesale prices.
```

**Full description:**
```
EKO Store is the official app of EKO SHPK for fast ordering of plumbing materials, heating equipment and bathroom fittings.

WHAT YOU CAN DO
• Browse the catalog by category: Plumbing, Heating, Bathroom
• Search products by name or code
• See your prices: retail customers see retail prices, approved businesses see wholesale prices
• Current offers with discounts and clear end dates
• Add to cart and send your order in seconds
• Track your order: new, confirmed, preparing, shipped, delivered
• Notifications about your orders and, if you wish, about offers, new products and price changes

FOR BUSINESSES
Register as a business with your company name and business number. Once EKO approves it, wholesale prices appear automatically.

PAYMENT AND DELIVERY
Pay on delivery or by bank transfer. The app never asks for card details.

PRIVACY
Your data is used only for your account and orders. You can delete your account at any time in the app (Account → Delete my account).
```

**Kategoria:** Shopping · **Email kontakti:** adresa e EKO SHPK · **Faqe interneti:** opsionale.

---

## 2. App content (përgjigjet)

| Seksioni | Përgjigja |
|---|---|
| Privacy policy | `https://betimnuhabn-creator.github.io/eko-store/privacy.html` (aktive pasi të publikohen faqet ligjore) |
| App access | **All or some functionality is restricted** → "Login required to see prices and order" → email + fjalëkalimi i një **llogarie test pakice** (jo klient real, jo admin) |
| Ads | **No, my app does not contain ads** |
| Content rating | Kategoria **Utility / Shopping**: pa dhunë, pa përmbajtje seksuale, pa drogë, pa bixhoz. Përdoruesit **nuk** komunikojnë me njëri-tjetrin. Aplikacioni **shet mallra fizike** → po. |
| Target audience | **18 and over** |
| News app | No |
| Data safety | Tabela te `docs/GOOGLE_PLAY_RELEASE.md` (Name, Email, Phone, Address, Purchase history, Device IDs; asgjë e ndarë me palë të treta; encrypted in transit: Yes; users can request deletion: Yes) |
| Delete account URL | `https://betimnuhabn-creator.github.io/eko-store/delete-account.html` |
| Government / Financial / Health | No |

---

## 3. Mesazhi për testuesit (nëse kërkohet closed testing me 12 persona)

```
Përshëndetje! Po testojmë aplikacionin EKO Store para publikimit në Google Play.
1) Hapeni këtë link nga telefoni Android me llogarinë tuaj Google dhe shtypni "Become a tester": <LINKU NGA PLAY CONSOLE>
2) Instaloni EKO Store nga Google Play.
3) Regjistrohuni, shfletoni produktet dhe provoni një porosi test.
Ju lutem mbajeni aplikacionin të instaluar të paktën 14 ditë. Faleminderit!
```
