// Vendor reports (Task 6, DEC-040): the vendor's OWN rows of R6 (payables and
// payouts) and R4 (refund risk). The API takes the vendor id from the login,
// never from the page; R2 (running-balance statement) is the Statement page.
//   GET /api/vendor/reports/payables      → fn_report_vendor_payables(own vendor)
//   GET /api/vendor/reports/refund-risk   → fn_report_vendor_refund_risk(from, to) filtered to own vendor
import { Link, useSearchParams } from 'react-router-dom';
import { ErrorBox, Money, Notice, Spinner, Stat, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { cmpPaise, formatBps } from '../../lib/money.js';
import { useApi } from '../../lib/useApi.js';
import { PAYABLE_STATUS, RiskBand } from '../finance/Reports.jsx';

export default function VendorReports() {
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const bad = from && to && from > to;
  const pay = useApi(() => api.get('/vendor/reports/payables'), []);
  const risk = useApi(() => (bad ? Promise.resolve(null) : api.get('/vendor/reports/refund-risk', { from, to })), [from, to, bad]);
  const set = (k, v) => setParams((prev) => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const p = pay.data?.item;
  const r = risk.data?.item;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-sm text-slate-600">Your rows only. The running-balance statement (R2) is on the <Link className="text-indigo-700 underline" to="/vendor/statement">Statement</Link> page.</p>
      </div>

      <section className="space-y-3">
        <h2 className="font-medium">R6 · Where your balance comes from</h2>
        <ErrorBox error={pay.error} title="Could not load R6" onRetry={pay.reload} />
        {pay.loading && !pay.data && <Spinner />}
        {p && (
          <>
            <div className="grid gap-3 sm:grid-cols-5">
              <Stat label="Your share of sales"><Money paise={p.sales_paise} /></Stat>
              <Stat label="− Refunds"><Money paise={p.refunds_paise} /></Stat>
              <Stat label="− Payouts requested"><Money paise={p.payouts_paise} /></Stat>
              <Stat label="+ Failed payouts restored"><Money paise={p.reversals_paise} /></Stat>
              <Stat label="= Balance" testId="vr-balance">
                <Money paise={p.balance_paise} className={cmpPaise(p.balance_paise, '0') < 0 ? 'text-rose-700' : ''} />
              </Stat>
            </div>
            <div className="card text-sm text-slate-700">
              Payouts: {p.payouts_paid} paid (<Money paise={p.paid_paise} />), {p.payouts_in_flight} in flight (<Money paise={p.in_flight_paise} />),
              {' '}{p.payouts_failed} failed and restored (<Money paise={p.failed_paise} />). Last paid: {p.last_paid_at ? formatDateTime(p.last_paid_at) : '—'}.
              {' '}<span className={`ml-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${PAYABLE_STATUS[p.status]}`} data-testid="vr-status">{p.status.replace(/_/g, ' ')}</span>
              {!p.ledger_consistent && <Notice tone="warn">Payout records and ledger disagree — contact finance.</Notice>}
            </div>
          </>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="mr-auto font-medium">R4 · Refund rate of your sales</h2>
          <div>
            <label className="label" htmlFor="vr-from">Sold from (IST)</label>
            <input id="vr-from" type="date" className="input" value={from} onChange={(e) => set('from', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="vr-to">Sold to (IST)</label>
            <input id="vr-to" type="date" className="input" value={to} onChange={(e) => set('to', e.target.value)} />
          </div>
        </div>
        {bad && <p className="text-sm text-amber-700">“From” must not be after “To”.</p>}
        <ErrorBox error={risk.error} title="Could not load R4" onRetry={risk.reload} />
        {risk.loading && !risk.data && <Spinner />}
        {r && (
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label={`Sales (${r.lines_sold} lines)`}><Money paise={r.sales_paise} /></Stat>
            <Stat label={`Refunded (${r.lines_refunded} lines)`}><Money paise={r.refunded_paise} /></Stat>
            <Stat label="Refund rate" testId="vr-rate">{formatBps(r.refund_rate_bps)} <RiskBand band={r.risk_band} /></Stat>
            <Stat label={`Pending · ${r.refund_requests} requests, ${r.refunds_rejected} rejected`}><Money paise={r.pending_refund_paise} /></Stat>
          </div>
        )}
        <p className="text-xs text-slate-500">Rate = processed refunds of lines sold in the period ÷ those lines' totals (customer prices). Bands: high ≥ 10%, watch ≥ 5%.</p>
      </section>
    </div>
  );
}
