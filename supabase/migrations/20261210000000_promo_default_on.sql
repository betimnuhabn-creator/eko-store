-- =====================================================================
-- EKO Store — promotional notification preferences ON by default
-- File: supabase/migrations/20261210000000_promo_default_on.sql
--
-- * New customers: "Oferta speciale", "Produkte të reja" and "Ndryshime
--   çmimesh" are switched ON at registration (column defaults).
-- * Existing customers: those who have ALL THREE switched off now get all
--   three ON (decision of EKO, 23.11.2026). Customers who already chose some
--   of them keep their choice. Administrators are not changed.
-- * Every customer can still switch them off in the app (Llogaria →
--   Njoftimet promocionale).
-- * This does NOT send anything by itself: promotional notifications are sent
--   only when they are enabled in the PC panel (Njoftimet promocionale), and
--   in TEST MODE only to accounts marked as testers.
-- * One transaction; safe to run more than once. Nothing else changes
--   (profiles.updated_at is kept as it was).
-- =====================================================================

begin;

set local lock_timeout = '10s';

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'promo_offers') then
    raise exception 'Run the offers migration (20261112000000) first. Nothing was changed.';
  end if;
end $$;

alter table public.profiles alter column promo_new_products set default true;
alter table public.profiles alter column promo_offers set default true;
alter table public.profiles alter column promo_price_changes set default true;

-- Keep updated_at unchanged for this one-off update.
alter table public.profiles disable trigger profiles_touch;
update public.profiles
   set promo_new_products = true, promo_offers = true, promo_price_changes = true
 where role <> 'admin'
   and not promo_new_products and not promo_offers and not promo_price_changes;
alter table public.profiles enable trigger profiles_touch;

commit;

-- Check (optional): how many customers have each preference on.
-- select count(*) filter (where promo_offers) as oferta, count(*) filter (where promo_new_products) as produkte_te_reja,
--        count(*) filter (where promo_price_changes) as ndryshime_cmimesh, count(*) as klientet
--   from public.profiles where role <> 'admin';
