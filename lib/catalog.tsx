import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth';
import { supabase } from './supabase';
import type { Category, Product } from './types';

type Ctx = {
  products: Product[];
  categories: Category[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  byId: (id: string) => Product | undefined;
};

const CatalogContext = createContext<Ctx | null>(null);
const PAGE = 1000; // PostgREST default max rows per request

async function fetchAllProducts(): Promise<Product[]> {
  const all: Product[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.rpc('list_products').range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...((data ?? []) as Product[]));
    if (!data || data.length < PAGE) return all;
  }
}

export function CatalogProvider({ children }: { children: React.ReactNode }) {
  const { session, profile, ready } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, cats] = await Promise.all([
        fetchAllProducts(),
        supabase.from('categories').select('*').order('sort_order').order('name_sq'),
      ]);
      if (cats.error) throw cats.error;
      setProducts(list);
      setCategories((cats.data ?? []) as Category[]);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Prices depend on who is logged in and on their role: reload when either changes.
  const userKey = `${session?.user.id ?? 'guest'}:${profile?.role ?? ''}`;
  useEffect(() => {
    if (ready) reload();
  }, [ready, userKey, reload]);

  const value = useMemo<Ctx>(() => {
    const map = new Map(products.map((p) => [p.id, p]));
    return { products, categories, loading, error, reload, byId: (id) => map.get(id) };
  }, [products, categories, loading, error, reload]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog() {
  const c = useContext(CatalogContext);
  if (!c) throw new Error('useCatalog outside provider');
  return c;
}
