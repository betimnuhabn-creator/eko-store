# EKO Store — PC admin panel

A desktop web panel for EKO administrators. It uses the **same Supabase
project, database, security rules and functions** as the Android app. There is no
separate database and no server of its own: the panel is a set of static files.

## Features

| Area | What you can do |
|---|---|
| Login | Email + password. Only accounts with `role = 'admin'` get in. A non-admin is signed out immediately. The role is re-checked whenever the tab regains focus, and you are signed out after **30 minutes of inactivity**. |
| Dashboard | New orders, open orders, wholesale requests, 30-day sales, active / out-of-stock products, customers, latest orders. |
| Products | Table with search, category / status / stock filters, sorting, paging and CSV export. **Edit retail price, wholesale price, stock and visibility directly in the table** and save all changes at once. |
| Product page | SKU, Albanian + English name/description, category, unit, both prices (warning if wholesale > retail), stock, active. **Photos**: drag & drop or choose up to 10, automatically resized to max 1600 px JPEG and uploaded to Supabase Storage; reorder, choose the main photo, remove, or add a photo URL. |
| Categories | Create, rename (SQ/EN), order, hide, delete (products keep existing without a category). |
| Orders | Status filters, search by number / name / phone / city, date range, totals, CSV export. Order page: lines, delivery, customer, **status change with internal note (the customer is notified)**, print view. |
| Customers | All / pending / wholesale / retail, search, order count and total per customer, CSV export. **Approve or reject wholesale requests, grant or remove wholesale status.** |
| Notifications | Live bell (new orders, cancellations, wholesale requests, new customers) and optional browser notifications. |
| Language | Albanian / English. |

## Security

* Uses only the **publishable** key (`.env.production`). A secret / service_role key
  is refused at start-up and the deploy script aborts if one is present.
* All writes go through the existing admin-only database functions
  (`admin_save_product`, `admin_review_wholesale`, `admin_set_order_status`, …), which
  check `is_admin()` themselves. Product photos can only be uploaded/deleted by admins
  (Storage policies). Even someone who edits this code in the browser cannot do more
  than their database role allows.
* Content-Security-Policy: scripts only from the panel itself; network only to the
  EKO Supabase project. The panel refuses to run inside a frame. `noindex` for search engines.
* Hosts that support a `_headers` file (Netlify, Cloudflare Pages) also get
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` (see `public/_headers`).

## Build

```bash
cd admin-web
npm install
npm run build          # → admin-web/dist/  (static files)
npm run dev            # local development at http://localhost:5173
```

Settings come from `admin-web/.env.production`:

```
VITE_SUPABASE_URL=https://mfpmcriffqlhlgaptdzx.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

The panel uses hash links (`…/#/orders/…`), so `dist/` works from any folder of any
static host without rewrite rules.

## Deploy — choose one

### A. GitHub Pages (free, this repository)

1. One-time: GitHub → repository **Settings → Pages → Build and deployment →
   Source: Deploy from a branch → Branch: `gh-pages` / `(root)` → Save**.
2. Publish (from a computer with this repository):
   `cd admin-web && npm run deploy:gh-pages`
3. URL: **https://betimnuhabn-creator.github.io/eko-store/**

Note: the repository is public, so the panel's code is public too. That is fine:
it contains no secrets and every action is checked by the database.

### B. Netlify / Cloudflare Pages (adds security headers)

* **Netlify**: app.netlify.com → *Add new site → Deploy manually* → drag the
  `admin-web/dist` folder. Or connect the repository with
  base directory `admin-web`, build command `npm run build`, publish directory `admin-web/dist`.
* **Cloudflare Pages**: *Create → Pages → Connect to Git* with root directory `admin-web`,
  build command `npm run build`, output `dist`.

### C. Your own web server

Upload the contents of `admin-web/dist/` to any folder (e.g. `https://eko-shpk.com/admin/`).
Recommended response headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`. HTTPS is required.

## After deploying

* Supabase needs no change for email/password login.
* Keep at least one account with `role = 'admin'`:
  `update public.profiles set role = 'admin' where email = '…';`

## Tests

`tests/admin-web.e2e.mjs` (from the repository root, against the LOCAL Supabase
stack): non-admin refused, dashboard, product with photo upload, quick edit of
prices/stock/visibility, categories, order status + customer notification,
wholesale approve/revoke with price check, live notification bell, demoted admin
signed out, mobile layout, no secret key in the build.
