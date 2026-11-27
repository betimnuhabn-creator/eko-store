import { supabase } from './supabase';

// Live offers for customers ("Ofertat e Momentit"). Prices come from the
// database for the logged-in customer's own tier only (none for guests).
// Before the offers migration exists, everything returns empty (no errors).

export type OfferItem = {
  product_id: string;
  sku: string;
  name: string;
  name_en: string;
  images: string[];
  unit: string;
  in_stock: boolean;
  regular_price: number | null;
  offer_price: number | null;
  discount_percent: number | null;
};

export type Offer = {
  id: string;
  title_sq: string;
  title_en: string;
  description_sq: string;
  description_en: string;
  starts_at: string;
  ends_at: string;
  items: OfferItem[];
};

export async function fetchOffers(): Promise<Offer[]> {
  const { data, error } = await supabase.rpc('list_offers');
  if (error || !data) return [];
  const map = new Map<string, Offer>();
  for (const r of data as any[]) {
    if (!map.has(r.offer_id)) {
      map.set(r.offer_id, {
        id: r.offer_id, title_sq: r.title_sq, title_en: r.title_en, description_sq: r.description_sq,
        description_en: r.description_en, starts_at: r.starts_at, ends_at: r.ends_at, items: [],
      });
    }
    map.get(r.offer_id)!.items.push({
      product_id: r.product_id, sku: r.sku, name: r.name, name_en: r.name_en, images: r.images ?? [], unit: r.unit,
      in_stock: r.in_stock, regular_price: r.regular_price, offer_price: r.offer_price, discount_percent: r.discount_percent,
    });
  }
  return [...map.values()];
}

export type PromoPrefs = { promo_new_products: boolean; promo_offers: boolean; promo_price_changes: boolean };

/** null when the database does not support promotional notifications yet. */
export async function fetchPromoPrefs(userId: string): Promise<PromoPrefs | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('promo_new_products,promo_offers,promo_price_changes')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as PromoPrefs;
}

export async function savePromoPrefs(p: PromoPrefs) {
  const { error } = await supabase.rpc('set_my_promo_preferences', {
    p_new_products: p.promo_new_products,
    p_offers: p.promo_offers,
    p_price_changes: p.promo_price_changes,
  });
  if (error) throw error;
}
