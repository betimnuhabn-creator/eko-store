-- Local development data only (applied by `supabase db reset`). Not used in production.
insert into public.products (sku, name, name_en, description, description_en, category_id, unit, retail_price, wholesale_price, stock)
select v.sku, v.name, v.name_en, v.d, v.d_en, c.id, v.unit, v.r, v.w, v.s
from (values
  ('HS-001', 'Rubinet lavamani krom', 'Chrome basin tap', 'Rubinet me një levë, krom.', 'Single-lever basin tap, chrome.', 'Pajisje banjoje', 'copë', 34.90, 26.50, 12),
  ('HS-002', 'Tub PPR 20mm', 'PPR pipe 20mm', 'Tub PPR për ujë të ngrohtë dhe të ftohtë, 4 m.', 'PPR pipe for hot and cold water, 4 m.', 'Hidrosanitari', 'copë', 3.20, 2.10, 400),
  ('NG-001', 'Radiator alumini 600', 'Aluminium radiator 600', 'Element radiatori alumini, lartësia 600 mm.', 'Aluminium radiator section, 600 mm high.', 'Ngrohje', 'copë', 11.50, 8.90, 0),
  ('HS-003', 'Valvul topi 1/2"', 'Ball valve 1/2"', 'Valvul topi prej bronzi.', 'Brass ball valve.', 'Hidrosanitari', 'copë', 4.80, 3.30, 150)
) v(sku, name, name_en, d, d_en, cat, unit, r, w, s)
join public.categories c on c.name_sq = v.cat
on conflict (sku) do nothing;
