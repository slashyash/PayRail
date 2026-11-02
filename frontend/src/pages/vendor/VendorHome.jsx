// Vendor dashboard: who we are, the LEDGER-DERIVED balance and recent sales.
//   GET /api/vendor/me     → vendor row + fn_vendor_balance(vendor_id) + payouts in flight
//   GET /api/vendor/sales  → this vendor's sold lines with the snapshot split (v_order_line_allocation)
// Nothing here is stored as a balance column: the number is Σ credits − Σ debits
// on the vendor's payable account (DEC-004 / invariant "balances are derived").
import { Link } from 'react-router-dom';
import { Empty, ErrorBox, Money, Notice, Spinner, Stat, StatusBadge, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { cmpPaise } from '../../lib/money.js';
import { useApi } from '../../lib/useApi.js';

/** commission in basis points (integer) → "12.50%" without floating point */
export function formatBps(bps) {
  const b = Number(bps);                     // 0..5000, a small integer: Number is exact here
  return `${Math.floor(b / 100)}.${String(b % 100).padStart(2, '0')}%`;
}

export default function VendorHome() {
  const me = useApi(() => api.get('/vendor/me'), []);
  const sales = useApi(() => api.get('/vendor/sales', { page: 1, page_size: 8 }), []);

  if (me.loading && !me.data) return <Spinner label="Loading vendor…" />;
  if (me.error && !me.data) return <ErrorBox error={me.error} title="Could not load your vendor" onRetry={me.reload} />;
  const v = me.data;
  const negative = cmpPaise(v.balance_paise, '0') < 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{v.legal_name}</h1>
        <span data-testid="kyc-status"><StatusBadge status={v.kyc_status} /></span>
        <span className="text-sm text-slate-500">GSTIN {v.gstin ?? '—'} · commission {formatBps(v.commission_bps)}</span>
      </div>

      {v.kyc_status !== 'verified' && (
        <Notice tone="warn">
          This vendor is not KYC-verified ({v.kyc_status}). Customers cannot buy its products and payout requests are
          refused by the database (<span className="font-mono">PRV03</span>).
        </Notice>
      )}
      {negative && (
        <Notice tone="warn">
          The balance is negative: a refund was processed after the money had already been paid out. Future sales
          recover it first; until the balance is positive no payout can be requested (<span className="font-mono">PRF01</span>).
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Available balance (from the ledger)" testId="vendor-balance">
          <Money paise={v.balance_paise} className={negative ? 'text-rose-700' : ''} />
        </Stat>
        <Stat label="Payouts requested, not yet completed" testId="vendor-inflight">
          <Money paise={v.payouts_in_flight_paise} />
        </Stat>
        <div className="card flex flex-col justify-center gap-2 text-sm">
          <Link className="text-indigo-700 underline" to="/vendor/payouts">Request a payout →</Link>
          <Link className="text-indigo-700 underline" to="/vendor/statement">Statement with running balance →</Link>
          <Link className="text-indigo-700 underline" to="/vendor/products">Manage products →</Link>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Requested payouts are already deducted from the available balance (the request debits the payable account under a
        row lock); a failed transfer restores the amount with a reversal entry.
      </p>

      <div className="card space-y-2 p-0">
        <h2 className="px-3 pt-3 font-medium">Recent sales (purchase-time snapshots)</h2>
        <ErrorBox error={sales.error} title="Could not load sales" onRetry={sales.reload} />
        {sales.loading && !sales.data && <Spinner />}
        {sales.data && (sales.data.items.length === 0 ? <div className="p-3"><Empty title="No paid sales yet" /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr>
                <th className="th">Order / line</th><th className="th">Product</th><th className="th num">Qty</th>
                <th className="th num">Line total</th><th className="th num">Commission</th><th className="th num">GST on comm.</th>
                <th className="th num">Your share</th><th className="th num">Refunded</th><th className="th">Paid</th>
              </tr></thead>
              <tbody>
                {sales.data.items.map((s) => (
                  <tr key={`${s.order_id}-${s.line_no}`} className="border-t border-slate-100">
                    <td className="td">#{s.order_id} / {s.line_no}</td>
                    <td className="td">{s.product_name}</td>
                    <td className="td num">{s.quantity}</td>
                    <td className="td num"><Money paise={s.line_total_paise} /></td>
                    <td className="td num"><Money paise={s.commission_paise} /></td>
                    <td className="td num"><Money paise={s.gst_paise} /></td>
                    <td className="td num"><Money paise={s.vendor_paise} /></td>
                    <td className="td num"><Money paise={s.refunded_paise} /></td>
                    <td className="td">{formatDateTime(s.captured_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
