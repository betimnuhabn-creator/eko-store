import { supabase } from './supabase';
import type { Product } from './types';

export type ProductInput = {
  id?: string | null;
  sku: string;
  name: string;
  name_en: string;
  description: string;
  description_en: string;
  category_id: string | null;
  unit: string;
  images: string[];
  retail_price: number;
  wholesale_price: number;
  stock: number;
  active: boolean;
};

export const toInput = (p: Product): ProductInput => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  name_en: p.name_en,
  description: p.description,
  description_en: p.description_en,
  category_id: p.category_id,
  unit: p.unit,
  images: p.images,
  retail_price: Number(p.retail_price),
  wholesale_price: Number(p.wholesale_price),
  stock: Number(p.stock),
  active: p.active,
});

/** Create/update through the admin-only database function (it re-checks is_admin()). */
export async function saveProduct(input: ProductInput): Promise<string> {
  const { data, error } = await supabase.rpc('admin_save_product', { p: { ...input, id: input.id ?? null } });
  if (error) throw error;
  return data as string;
}

export async function deleteProduct(id: string) {
  const { error } = await supabase.rpc('admin_delete_product', { p_id: id });
  if (error) throw error;
}
