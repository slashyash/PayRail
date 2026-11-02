// Payment page (W1 step 2) — the shop's side of the payment.
//
//  1. "Continue to payment" → POST /api/orders/:id/payments (Idempotency-Key header)
//     fn_initiate_payment creates an 'initiated' attempt whose amount is the
//     DERIVED order total. The key is tied to (order, method) and kept in
//     sessionStorage: a retry after a network error or a refresh reuses it and
//     the database returns the SAME attempt. A new key is generated only for a
//     new logical attempt (different method, or after a declined payment).
//  2. The customer is redirected to the simulated gateway's hosted checkout
//     (/gateway/checkout/:paymentId, GatewayCheckout.jsx). The GATEWAY decides
//     the outcome and calls back the backend; the customer comes back here and
//     sees the result read from the database (DEC-038).
// The shop itself has no "approve/decline" controls; fault injection
// (duplicate callbacks, wrong amount) is a finance-only screen.
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ErrorBox, Money, Notice, Spinner, StatusBadge, formatDateTime } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { useApi } from '../lib/useApi.js';

const METHODS = [['upi', 'UPI'], ['card', 'Card'], ['netbanking', 'Net banking']];

export default function Pay() {
  const { orderId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const order = useApi(() => api.get(`/orders/${orderId}`), [orderId]);
  const idem = useIdempotencyKey(`payrail.paykey.${orderId}`);
  const [method, setMethod] = useState('upi');
  const [newAttempt, setNewAttempt] = useState(false);   // customer chose another method while an attempt is open
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (order.loading && !order.data) return <Spinner label="Loading order…" />;
  if (order.error && !order.data) return <ErrorBox error={order.error} title="Could not load the order" onRetry={order.reload} />;
  const o = order.data;

  const open = [...o.payments].reverse().find((p) => p.status === 'initiated') ?? null;
  const captured = o.payments.find((p) => p.status === 'captured') ?? null;
  const vendors = new Set(o.lines.map((l) => l.vendor_id)).size;
  const result = location.state?.gatewayResult;      // set by the gateway page when it sends the customer back
  const showOpen = open && !newAttempt;

  async function startPayment() {
    setBusy(true);
    setError(null);
    const key = idem.keyFor(`${orderId}:${method}`);
    try {
      const p = await api.post(`/orders/${orderId}/payments`, { method }, { idempotencyKey: key });
      if (p.status !== 'initiated') {                  // an old finished attempt came back for this key
        idem.reset();
        await order.reload();
        return;
      }
      idem.reset();                                    // the attempt exists; the next attempt is a new action
      navigate(`/gateway/checkout/${p.payment_id}`);
    } catch (e) {
      setError(e);                                     // key kept: "Retry" repeats the same logical attempt
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Pay for order #{o.order_id}</h1>
        <Link to={`/orders/${o.order_id}`} className="text-sm text-indigo-700 underline">Order details</Link>
      </div>
      {location.state?.justPlaced && o.status === 'pending_payment' && (
        <Notice tone="success">Order #{o.order_id} placed. Prices and commission rates were snapshotted by the database.</Notice>
      )}
      {result?.outcome === 'failure' && !captured && (
        <Notice tone="warn"><span data-testid="declined-banner">Payment not completed</span> — {result.reason}. No money was taken; you can try again.</Notice>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead><tr><th className="th">#</th><th className="th">Product</th><th className="th">Vendor</th><th className="th num">Unit</th><th className="th num">Qty</th><th className="th num">Line total</th></tr></thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.line_no} className="border-t border-slate-100">
                <td className="td">{l.line_no}</td><td className="td">{l.product_name}</td><td className="td">{l.vendor_name}</td>
                <td className="td num"><Money paise={l.unit_price_paise} /></td><td className="td num">{l.quantity}</td>
                <td className="td num"><Money paise={l.line_total_paise} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200">
              <td className="td text-slate-500" colSpan={5}>Order total (derived from the snapshotted lines) · {vendors} vendor{vendors > 1 ? 's' : ''}</td>
              <td className="td num font-semibold" data-testid="order-total"><Money paise={o.total_paise} /></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {captured ? (
        <div className="space-y-3">
          <Notice tone="success">
            <span data-testid="paid-banner">Payment successful.</span> Payment #{captured.payment_id} captured at {formatDateTime(captured.captured_at)}
            {' '}(gateway ref <span className="font-mono">{captured.gateway_ref}</span>). Order status: <StatusBadge status={o.status} />
          </Notice>
          <Link to={`/orders/${o.order_id}`} className="btn-primary">View order and request refunds</Link>
        </div>
      ) : (
        <div className="card max-w-xl space-y-3">
          {showOpen ? (
            <>
              <p className="text-sm text-slate-600">
                A {open.method} payment of <Money paise={open.amount_paise} /> (attempt #{open.payment_id}) is waiting at the payment gateway.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" onClick={() => navigate(`/gateway/checkout/${open.payment_id}`)}>
                  Continue to payment gateway
                </button>
                <button type="button" className="btn-secondary" onClick={() => setNewAttempt(true)}>Use a different method</button>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="label" htmlFor="method">Payment method</label>
                <select id="method" className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                  {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <button type="button" className="btn-primary" disabled={busy} onClick={startPayment}>
                {busy ? 'Contacting gateway…' : <>Continue to pay <Money paise={o.total_paise} /></>}
              </button>
              <p className="text-xs text-slate-500">You will be redirected to the (simulated) payment gateway. No real money moves.</p>
            </>
          )}
        </div>
      )}

      <ErrorBox error={error} title="Could not start the payment" onRetry={busy ? undefined : startPayment} />
      {error?.code === 'network' && (
        <Notice tone="warn">The request may or may not have reached the server. “Retry” reuses the same
          Idempotency-Key, so at most one payment attempt is created.</Notice>
      )}

      {o.payments.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <h2 className="px-3 pt-3 font-medium">Payment attempts</h2>
          <table className="w-full">
            <thead><tr><th className="th">Payment</th><th className="th">Method</th><th className="th num">Amount</th><th className="th">Status</th><th className="th">Gateway ref</th><th className="th">Created</th></tr></thead>
            <tbody>
              {o.payments.map((p) => (
                <tr key={p.payment_id} className="border-t border-slate-100" data-testid="payment-row">
                  <td className="td">#{p.payment_id}</td><td className="td">{p.method}</td>
                  <td className="td num"><Money paise={p.amount_paise} /></td>
                  <td className="td"><StatusBadge status={p.status} /></td>
                  <td className="td font-mono text-xs">{p.gateway_ref ?? '—'}</td>
                  <td className="td">{formatDateTime(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
