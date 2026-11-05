import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useCatalog } from './catalog';
import type { Product } from './types';

type Line = { product: Product; quantity: number };
type Ctx = {
  quantities: Record<string, number>;
  lines: Line[];
  count: number;
  /** null when prices are hidden (guest) */
  total: number | null;
  setQuantity: (productId: string, qty: number) => void;
  add: (productId: string, qty?: number) => void;
  clear: () => void;
};

const CartContext = createContext<Ctx | null>(null);
const KEY = 'eko.cart';

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { byId, products, loading } = useCatalog();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((v) => v && setQuantities(JSON.parse(v)))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (loaded) AsyncStorage.setItem(KEY, JSON.stringify(quantities)).catch(() => {});
  }, [quantities, loaded]);

  // Drop products that no longer exist / were deactivated.
  useEffect(() => {
    if (loading || !loaded || products.length === 0) return;
    setQuantities((q) => {
      const next = Object.fromEntries(Object.entries(q).filter(([id]) => byId(id)?.active));
      return Object.keys(next).length === Object.keys(q).length ? q : next;
    });
  }, [products, loading, loaded, byId]);

  const setQuantity = useCallback((id: string, qty: number) => {
    setQuantities((q) => {
      const n = Math.max(0, Math.min(100000, Math.floor(qty || 0)));
      const next = { ...q };
      if (n === 0) delete next[id];
      else next[id] = n;
      return next;
    });
  }, []);

  const value = useMemo<Ctx>(() => {
    const lines = Object.entries(quantities)
      .map(([id, quantity]) => ({ product: byId(id)!, quantity }))
      .filter((l) => l.product);
    const hidden = lines.some((l) => l.product.price == null);
    return {
      quantities,
      lines,
      count: lines.reduce((a, l) => a + l.quantity, 0),
      total: hidden ? null : lines.reduce((a, l) => a + l.quantity * Number(l.product.price), 0),
      setQuantity,
      add: (id, qty = 1) => setQuantity(id, (quantities[id] ?? 0) + qty),
      clear: () => setQuantities({}),
    };
  }, [quantities, byId, setQuantity]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const c = useContext(CartContext);
  if (!c) throw new Error('useCart outside provider');
  return c;
}
