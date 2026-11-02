// Shopping cart (browser only, per customer, kept in localStorage).
//
// Domain rule (DBD BR / DC-03): each product appears once per order; adding it
// again increases the quantity, capped at 100. The cart enforces the same rule
// for a friendly UI, but the DATABASE is the authority (fn_place_order
// aggregates and re-checks; the order_items CHECK caps at 100).
//
// The cart remembers the catalogue price only to DISPLAY an estimate. When the
// order is placed, the browser sends just { product_id, quantity }; the
// database snapshots the real price and commission rate (never trust the client).
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { mulPaise, addPaise } from '../lib/money.js';
import { useAuth } from './auth.jsx';

export const MAX_QTY = 100;
const CartContext = createContext(null);

const storageKey = (user) => (user ? `payrail.cart.${user.user_id}` : null);
function load(key) {
  if (!key) return [];
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function CartProvider({ children }) {
  const { user } = useAuth();
  const key = storageKey(user);
  const [items, setItems] = useState(() => load(key));

  useEffect(() => { setItems(load(key)); }, [key]);
  useEffect(() => {
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(items)); } catch { /* ignore */ }
  }, [key, items]);

  /** add qty of a catalogue product; returns { added, capped } */
  const add = useCallback((product, qty = 1) => {
    const existing = items.find((i) => i.product_id === product.product_id);
    const have = existing ? existing.quantity : 0;
    const next = Math.min(MAX_QTY, have + qty);
    if (existing) {
      setItems(items.map((i) => (i.product_id === product.product_id ? { ...i, quantity: next } : i)));
    } else {
      const { product_id, name, price_paise, vendor_id, vendor_name } = product;
      setItems([...items, { product_id, name, price_paise, vendor_id, vendor_name, quantity: next }]);
    }
    return { added: next - have, capped: have + qty > MAX_QTY };
  }, [items]);

  const setQuantity = useCallback((productId, qty) => {
    const q = Math.max(1, Math.min(MAX_QTY, Math.trunc(qty) || 1));
    setItems((cur) => cur.map((i) => (i.product_id === productId ? { ...i, quantity: q } : i)));
  }, []);
  const remove = useCallback((productId) => setItems((cur) => cur.filter((i) => i.product_id !== productId)), []);
  const clear = useCallback(() => setItems([]), []);

  const value = useMemo(() => {
    const count = items.reduce((n, i) => n + i.quantity, 0);
    const estimate = items.reduce((s, i) => addPaise(s, mulPaise(i.price_paise, i.quantity)), '0');
    const vendorCount = new Set(items.map((i) => i.vendor_id)).size;
    return { items, count, estimate, vendorCount, add, setQuantity, remove, clear };
  }, [items, add, setQuantity, remove, clear]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  return useContext(CartContext);
}
