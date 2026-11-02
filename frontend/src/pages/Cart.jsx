// Cart and checkout (W1 step 1): POST /api/orders { items: [{product_id, quantity}] }.
// Only ids and quantities leave the browser; fn_place_order snapshots the
// price and commission rate of each line, and its total is DERIVED in SQL.
// Placing an order moves no money (DEC-037): the payment step is separate.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Empty, ErrorBox, Money, Notice } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { mulPaise, addPaise } from '../lib/money.js';
import { MAX_QTY, useCart } from '../state/cart.jsx';

export default function Cart() {
  const cart = useCart();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (cart.items.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Cart</h1>
        <Empty title="Your cart is empty"><Link className="text-indigo-700 underline" to="/shop">Browse the shop</Link></Empty>
      </div>
    );
  }

  // group lines by vendor: one order may contain several vendors' products
  const groups = new Map();
  for (const i of cart.items) {
    if (!groups.has(i.vendor_id)) groups.set(i.vendor_id, { vendor_name: i.vendor_name, items: [] });
    groups.get(i.vendor_id).items.push(i);
  }

  async function placeOrder() {
    setBusy(true);
    setError(null);
    try {
      const order = await api.post('/orders', {
        items: cart.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
      });
      cart.clear();
      navigate(`/orders/${order.order_id}/pay`, { state: { justPlaced: true } });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Cart</h1>
      {cart.vendorCount > 1 && (
        <Notice>This is a multi-vendor order ({cart.vendorCount} vendors). You pay once; the ledger splits each line
          between the vendor, the platform commission and GST on that commission.</Notice>
      )}
      {[...groups.entries()].map(([vendorId, g]) => {
        const subtotal = g.items.reduce((s, i) => addPaise(s, mulPaise(i.price_paise, i.quantity)), '0');
        return (
          <div key={vendorId} className="card overflow-x-auto p-0">
            <div className="flex justify-between border-b border-slate-100 px-3 py-2 text-sm">
              <span className="font-medium">{g.vendor_name}</span>
              <span className="text-slate-500">Subtotal <Money paise={subtotal} /></span>
            </div>
            <table className="w-full">
              <thead><tr><th className="th">Product</th><th className="th num">Price</th><th className="th">Qty</th><th className="th num">Line</th><th className="th" /></tr></thead>
              <tbody>
                {g.items.map((i) => (
                  <tr key={i.product_id} className="border-t border-slate-100" data-testid="cart-line">
                    <td className="td">{i.name}</td>
                    <td className="td num"><Money paise={i.price_paise} /></td>
                    <td className="td">
                      <input aria-label={`Quantity of ${i.name}`} className="input w-20" type="number" min={1} max={MAX_QTY}
                        value={i.quantity} onChange={(e) => cart.setQuantity(i.product_id, Number(e.target.value))} />
                    </td>
                    <td className="td num"><Money paise={mulPaise(i.price_paise, i.quantity)} /></td>
                    <td className="td text-right">
                      <button type="button" className="text-sm text-rose-700 hover:underline" onClick={() => cart.remove(i.product_id)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <div className="card flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">Estimated total ({cart.count} items)</p>
          <p className="text-xl font-semibold"><Money paise={cart.estimate} /></p>
          <p className="text-xs text-slate-500">The final amount is computed by the database from current catalogue prices when the order is placed.</p>
        </div>
        <button type="button" className="btn-primary" disabled={busy} onClick={placeOrder}>
          {busy ? 'Placing order…' : 'Place order and pay'}
        </button>
      </div>
      <ErrorBox error={error} title="Order not placed" onRetry={busy ? undefined : placeOrder} />
      {error?.code === 'network' && (
        <Notice tone="warn">
          The server may have created the order before the connection dropped. Check{' '}
          <Link className="underline" to="/orders?status=pending_payment">unpaid orders</Link> before retrying —
          an unpaid order moves no money and can simply be left unpaid.
        </Notice>
      )}
    </div>
  );
}
