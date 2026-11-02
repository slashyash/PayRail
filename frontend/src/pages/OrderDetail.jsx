// Order detail + per-line refund request (W3 step 1).
// Line amounts come from v_order_line_allocation: refundable = line total
// − processed − pending (requested) refunds. A request RESERVES its amount
// until finance approves (processed) or rejects (released).
//   POST /api/orders/:id/refunds { line_no, amount_paise, reason } + Idempotency-Key
// The database re-checks everything (PRR01 over-refund, PRR02 sub-₹1 partial,
// PRO02 unpaid order) even when the browser's own check is bypassed.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorBox, Money, Notice, Spinner, StatusBadge, formatDateTime } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useIdempotencyKey } from '../lib/idempotency.js';
import { cmpPaise, formatINR, paiseToInput, parseRupees } from '../lib/money.js';
import { useApi } from '../lib/useApi.js';

function RefundForm({ orderId, line, onDone, onClose }) {
  const [amount, setAmount] = useState(paiseToInput(line.refundable_paise));
  const [reason, setReason] = useState('');
  const [bypass, setBypass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);           // { refund, key, payload }
  const [replay, setReplay] = useState(null);
  const idem = useIdempotencyKey(`payrail.refundkey.${orderId}.${line.line_no}`);

  const paise = parseRupees(amount);
  let problem = null;
  if (paise === null || paise === '0') problem = 'Enter a positive rupee amount with at most 2 decimals.';
  else if (cmpPaise(paise, line.refundable_paise) > 0) problem = `More than the refundable ${formatINR(line.refundable_paise)} for this line.`;
  else if (!reason.trim()) problem = 'A reason is required.';
  const formatOk = paise !== null && paise !== '0' && reason.trim();
  const canSend = !busy && (problem === null || (bypass && formatOk));

  async function send(payload, key) {
    return api.post(`/orders/${orderId}/refunds`, payload, { idempotencyKey: key });
  }

  async function submit(e) {
    e.preventDefault();
    if (!canSend) return;
    setBusy(true);
    setError(null);
    const payload = { line_no: line.line_no, amount_paise: paise, reason: reason.trim() };
    // same line + amount + reason → same key (a retry); anything changed → new key
    const key = idem.keyFor(`${payload.line_no}|${payload.amount_paise}|${payload.reason}`);
    try {
      const refund = await send(payload, key);
      setDone({ refund, key, payload });
      idem.reset();                                 // a further refund is a new logical action
      onDone();
    } catch (err) {
      setError(err);                                // key kept: resubmitting the same form is a retry
    } finally {
      setBusy(false);
    }
  }

  async function resendSame() {
    setBusy(true);
    try {
      const r = await send(done.payload, done.key);
      setReplay(r);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-2" data-testid="refund-done">
        <Notice tone="success">
          Refund #{done.refund.refund_id} requested for <Money paise={done.refund.amount_paise} /> — status{' '}
          <StatusBadge status={done.refund.status} />. The amount is reserved until finance approves or rejects it.
        </Notice>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" className="btn-secondary" disabled={busy} onClick={resendSame}>Send the same request again (same key)</button>
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          {replay && (
            <span data-testid="refund-replay">
              Server returned refund #{replay.refund_id} again{replay.refund_id === done.refund.refund_id ? ' — no second refund was created.' : '.'}
            </span>
          )}
        </div>
        <ErrorBox error={error} />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="refund-form">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor={`amt-${line.line_no}`}>Amount (₹) — refundable {formatINR(line.refundable_paise)}</label>
          <input id={`amt-${line.line_no}`} className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`reason-${line.line_no}`}>Reason</label>
          <input id={`reason-${line.line_no}`} className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      {problem && <p className="text-sm text-amber-700">{problem}</p>}
      {problem && formatOk && (
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} />
          Demo: skip the browser check and let the database decide
        </label>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={!canSend}>{busy ? 'Sending…' : 'Request refund'}</button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
      <ErrorBox error={error} title="Refund not requested" />
    </form>
  );
}

export default function OrderDetail() {
  const { orderId } = useParams();
  const order = useApi(() => api.get(`/orders/${orderId}`), [orderId]);
  const [openLine, setOpenLine] = useState(null);

  if (order.loading && !order.data) return <Spinner label="Loading order…" />;
  if (order.error && !order.data) return <ErrorBox error={order.error} title="Could not load the order" onRetry={order.reload} />;
  const o = order.data;
  const paid = o.status !== 'pending_payment';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Order #{o.order_id}</h1>
        <span data-testid="order-status"><StatusBadge status={o.status} /></span>
        <Link to="/orders" className="ml-auto text-sm text-indigo-700 underline">All orders</Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="card"><p className="text-xs text-slate-500">Placed</p><p className="text-sm">{formatDateTime(o.created_at)}</p></div>
        <div className="card"><p className="text-xs text-slate-500">Total</p><p className="font-semibold"><Money paise={o.total_paise} /></p></div>
        <div className="card"><p className="text-xs text-slate-500">Refunded</p><p className="font-semibold" data-testid="order-refunded"><Money paise={o.refunded_paise} /></p></div>
        <div className="card"><p className="text-xs text-slate-500">Refund requests pending</p><p className="font-semibold" data-testid="order-pending"><Money paise={o.refund_pending_paise} /></p></div>
      </div>
      {!paid && (
        <Notice tone="warn">This order is not paid yet. <Link className="underline" to={`/orders/${o.order_id}/pay`}>Pay now</Link></Notice>
      )}
      <ErrorBox error={order.error} title="Refresh failed" onRetry={order.reload} />

      <div className="card overflow-x-auto p-0">
        <h2 className="px-3 pt-3 font-medium">Lines</h2>
        <table className="w-full">
          <thead><tr><th className="th">#</th><th className="th">Product</th><th className="th">Vendor</th><th className="th num">Qty × unit</th><th className="th num">Line total</th><th className="th num">Refunded</th><th className="th num">Pending</th><th className="th num">Refundable</th><th className="th" /></tr></thead>
          <tbody>
            {o.lines.map((l) => (
              <FragmentRow key={l.line_no} l={l} paid={paid} open={openLine === l.line_no}
                onOpen={() => setOpenLine(l.line_no)} onClose={() => setOpenLine(null)}
                form={<RefundForm orderId={o.order_id} line={l} onDone={order.reload} onClose={() => setOpenLine(null)} />} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card overflow-x-auto p-0">
          <h2 className="px-3 pt-3 font-medium">Payments</h2>
          {o.payments.length === 0 ? <p className="p-3 text-sm text-slate-500">No payment attempts.</p> : (
            <table className="w-full">
              <thead><tr><th className="th">#</th><th className="th">Method</th><th className="th num">Amount</th><th className="th">Status</th><th className="th">Ref</th></tr></thead>
              <tbody>
                {o.payments.map((p) => (
                  <tr key={p.payment_id} className="border-t border-slate-100">
                    <td className="td">{p.payment_id}</td><td className="td">{p.method}</td>
                    <td className="td num"><Money paise={p.amount_paise} /></td>
                    <td className="td"><StatusBadge status={p.status} /></td>
                    <td className="td font-mono text-xs">{p.gateway_ref ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card overflow-x-auto p-0">
          <h2 className="px-3 pt-3 font-medium">Refunds</h2>
          {o.refunds.length === 0 ? <p className="p-3 text-sm text-slate-500">No refund requests.</p> : (
            <table className="w-full">
              <thead><tr><th className="th">#</th><th className="th">Line</th><th className="th num">Amount</th><th className="th">Status</th><th className="th">Requested</th></tr></thead>
              <tbody>
                {o.refunds.map((r) => (
                  <tr key={r.refund_id} className="border-t border-slate-100" data-testid="refund-row">
                    <td className="td">{r.refund_id}</td><td className="td">{r.line_no}</td>
                    <td className="td num"><Money paise={r.amount_paise} /></td>
                    <td className="td"><StatusBadge status={r.status} /></td>
                    <td className="td">{formatDateTime(r.requested_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function FragmentRow({ l, paid, open, onOpen, form }) {
  const refundable = l.refundable_paise !== '0';
  return (
    <>
      <tr className="border-t border-slate-100" data-testid="line-row">
        <td className="td">{l.line_no}</td>
        <td className="td">{l.product_name}</td>
        <td className="td">{l.vendor_name}</td>
        <td className="td num">{l.quantity} × <Money paise={l.unit_price_paise} /></td>
        <td className="td num"><Money paise={l.line_total_paise} /></td>
        <td className="td num"><Money paise={l.refunded_paise} /></td>
        <td className="td num"><Money paise={l.refund_pending_paise} /></td>
        <td className="td num" data-testid="line-refundable"><Money paise={l.refundable_paise} /></td>
        <td className="td text-right">
          {paid && refundable && !open && <button type="button" className="btn-secondary" onClick={onOpen}>Request refund</button>}
        </td>
      </tr>
      {open && <tr><td colSpan={9} className="bg-slate-50 px-3 py-3">{form}</td></tr>}
    </>
  );
}
