import { supabase } from './supabase';

// Admin offer management + promotional notification settings.
// Every call goes through an admin-only database function (assert_admin()).
// Before the offers migration exists, `offersSupported()` returns false and
// the admin screens show a short notice instead.
// (Same file as admin-web/src/lib/adminOffers.ts.)

export type OfferState = 'live' | 'scheduled' | 'expired' | 'inactive' | 'cancelled';

export type AdminOfferItem = {
  product_id: string;
  sku: string;
  name: string;
  images: string[];
  retail_price: number;
  wholesale_price: number;
  offer_price: number;
  offer_wholesale_price: number | null;
};

export type AdminOffer = {
  id: string;
  title_sq: string;
  title_en: string;
  description_sq: string;
  description_en: string;
  starts_at: string;
  ends_at: string;
  active: boolean;
  cancelled_at: string | null;
  activation_notified_at: string | null;
  created_at: string;
  state: OfferState;
  items: AdminOfferItem[];
};

export type OfferInput = {
  id?: string | null;
  title_sq: string;
  title_en: string;
  description_sq: string;
  description_en: string;
  starts_at: string; // UTC ISO
  ends_at: string; // UTC ISO
  active: boolean;
  items: { product_id: string; offer_price: number; offer_wholesale_price: number | null }[];
};

export type PromoSettings = {
  enabled: boolean;
  test_only: boolean;
  daily_cap: number;
  debounce_minutes: number;
  functions_url: string;
  testers: number;
  opted_in: number;
  pending_events: number;
  events: { id: string; kind: 'new_product' | 'offer' | 'price'; status: string; recipients: number | null; created_at: string; subject: string | null; data: any }[];
};

export async function offersSupported(): Promise<boolean> {
  const { error } = await supabase.rpc('admin_list_offers');
  return !error || !/PGRST202|Could not find the function/i.test(`${error.code} ${error.message}`);
}

export async function listOffers(): Promise<AdminOffer[]> {
  const { data, error } = await supabase.rpc('admin_list_offers');
  if (error) throw error;
  return (data ?? []) as AdminOffer[];
}

export async function saveOffer(o: OfferInput): Promise<string> {
  const { data, error } = await supabase.rpc('admin_save_offer', { p: { ...o, id: o.id ?? null } });
  if (error) throw error;
  return data as string;
}

export async function setOfferActive(id: string, active: boolean) {
  const { error } = await supabase.rpc('admin_set_offer_active', { p_id: id, p_active: active });
  if (error) throw error;
}

export async function cancelOffer(id: string) {
  const { error } = await supabase.rpc('admin_cancel_offer', { p_id: id });
  if (error) throw error;
}

export async function getPromoSettings(): Promise<PromoSettings | null> {
  const { data, error } = await supabase.rpc('admin_get_promo_settings');
  if (error) return null;
  return data as PromoSettings;
}

export async function setPromoSettings(p: Partial<Pick<PromoSettings, 'enabled' | 'test_only' | 'daily_cap' | 'debounce_minutes' | 'functions_url'>>) {
  const { error } = await supabase.rpc('admin_set_promo_settings', { p });
  if (error) throw error;
}

export async function setPromoTester(userId: string, tester: boolean) {
  const { error } = await supabase.rpc('admin_set_promo_tester', { p_user: userId, p_tester: tester });
  if (error) throw error;
}

export const stateTone: Record<OfferState, 'success' | 'info' | 'muted' | 'danger' | 'warning'> = {
  live: 'success',
  scheduled: 'info',
  expired: 'muted',
  inactive: 'warning',
  cancelled: 'danger',
};
