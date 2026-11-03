// Finance reports R1–R6 (Task 6, DEC-040). Every number on this page comes
// from ONE call of a SQL report function in db/schema/32_reports.sql through
// GET /api/finance/reports/<name>; the page only formats it (BigInt money).
//   ?r=R1 … R6 selects the report; each report keeps its filters in the URL.
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty, ErrorBox, Money, Notice, Pager, Spinner, StatusBadge, formatDate, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { chartRupees, cmpPaise, formatBps, formatINR, parseRupees, paiseToInput } from '../../lib/money.js';
import { useApi } from '../../lib/useApi.js';

export const REPORT_TABS = [
  { id: 'R1', name: 'trial-balance',       label: 'R1 Trial balance',        fn: 'fn_report_trial_balance(as_of)' },
  { id: 'R2', name: 'vendor-statement',    label: 'R2 Vendor statement',     fn: 'fn_report_vendor_statement(vendor, from, to)' },
  { id: 'R3', name: 'monthly-performance', label: 'R3 Monthly performance',  fn: 'fn_report_monthly_performance(from, to)' },
  { id: 'R4', name: 'refund-risk',         label: 'R4 Refund risk',          fn: 'fn_report_vendor_refund_risk(from, to, min_sales)' },
  { id: 'R5', name: 'settlement-aging',    label: 'R5 Settlement aging',     fn: 'fn_report_settlement_aging(as_of)' },
  { id: 'R6', name: 'vendor-payables',     label: 'R6 Vendor payables',      fn: 'fn_report_vendor_payables(vendor)' },
];

function useFilters() {
  const [params, setParams] = useSearchParams();
  const get = (k) => params.get(k) ?? '';
  // functional update: two quick changes in a row must not overwrite each other
  const update = (changes) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(changes)) if (v) next.set(k, v); else next.delete(k);
    if (!('page' in changes)) next.delete('page');
    return next;
  }, { replace: true });
  return { get, update };
}

function DateInput({ id, label, value, onChange, type = 'date' }) {
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} type={type} className="input" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

const Num = ({ v }) => <span className="tabular-nums">{v ?? '—'}</span>;
const negClass = (p) => (p !== null && p !== undefined && cmpPaise(p, '0') < 0 ? 'text-rose-700' : '');

export default function Reports() {
  const f = useFilters();
  const current = REPORT_TABS.find((t) => t.id === f.get('r')) ?? REPORT_TABS[0];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="text-sm text-slate-600">Each report is one read-only SQL function; amounts are exact paise from the ledger and the base tables.</p>
      </div>
      <nav className="flex flex-wrap gap-1" aria-label="Reports">
        {REPORT_TABS.map((t) => (
          <button key={t.id} type="button" data-testid={`tab-${t.id}`}
            onClick={() => f.update({ r: t.id, from: '', to: '', as_of: '', vendor_id: f.get('vendor_id'), min_sales: '' })}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${t.id === current.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}>
            {t.label}
          </button>
        ))}
      </nav>
      <p className="text-xs text-slate-500">SQL: <code className="font-mono">{current.fn}</code> in <code className="font-mono">db/schema/32_reports.sql</code></p>
      {current.id === 'R1' && <TrialBalanceReport f={f} />}
      {current.id === 'R2' && <VendorStatementReport f={f} />}
      {current.id === 'R3' && <MonthlyReport f={f} />}
      {current.id === 'R4' && <RefundRiskReport f={f} />}
      {current.id === 'R5' && <AgingReport f={f} />}
      {current.id === 'R6' && <PayablesReport f={f} />}
    </div>
  );
}

function Loading({ q, title, children }) {
  return (
    <>
      <ErrorBox error={q.error} title={title} onRetry={q.reload} />
      {q.loading && !q.data && <Spinner />}
      {q.data && children(q.data)}
    </>
  );
}

// ------------------------------------------------------------ R1
function TrialBalanceReport({ f }) {
  const asOf = f.get('as_of');
  const q = useApi(() => api.get('/finance/reports/trial-balance', { as_of: asOf }), [asOf]);
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-3">
        <DateInput id="r1-asof" label="Posted on or before (IST)" value={asOf} onChange={(v) => f.update({ as_of: v })} />
        <p className="text-sm text-slate-500">Per account Σ debits and Σ credits; the balance appears in the Dr or Cr column. A <code>GROUPING SETS</code> total row checks the global equality.</p>
      </div>
      <Loading q={q} title="Could not load R1">{(d) => (
        <>
          <Notice tone={d.total.balanced ? 'success' : 'warn'}>
            <span data-testid="r1-check">
              Σ debits <Money paise={d.total.debit_paise} /> {d.total.balanced ? '=' : '≠'} Σ credits <Money paise={d.total.credit_paise} />;
              {' '}Σ Dr balances <Money paise={d.total.debit_balance_paise} /> {d.total.balanced ? '=' : '≠'} Σ Cr balances <Money paise={d.total.credit_balance_paise} />
              {d.total.balanced ? ' — balanced.' : ' — NOT balanced.'}
            </span>
          </Notice>
          <div className="card overflow-x-auto p-0">
            <table className="w-full">
              <thead><tr>
                <th className="th">Account</th><th className="th">Class</th><th className="th">Owner</th>
                <th className="th num">Σ Debits</th><th className="th num">Σ Credits</th><th className="th num">Dr balance</th><th className="th num">Cr balance</th>
              </tr></thead>
              <tbody>
                {d.accounts.map((a) => (
                  <tr key={a.account_id} className="border-t border-slate-100" data-testid="r1-row">
                    <td className="td font-mono text-xs">{a.code}</td>
                    <td className="td">{a.account_class} <span className="text-slate-400">({a.normal_side})</span></td>
                    <td className="td">{a.vendor_name ?? a.owner_type}</td>
                    <td className="td num"><Money paise={a.debit_paise} /></td>
                    <td className="td num"><Money paise={a.credit_paise} /></td>
                    <td className="td num">{a.debit_balance_paise !== '0' && <Money paise={a.debit_balance_paise} />}</td>
                    <td className="td num">{a.credit_balance_paise !== '0' && <Money paise={a.credit_balance_paise} />}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-300 font-semibold" data-testid="r1-total">
                  <td className="td" colSpan={3}>Total</td>
                  <td className="td num"><Money paise={d.total.debit_paise} /></td>
                  <td className="td num"><Money paise={d.total.credit_paise} /></td>
                  <td className="td num"><Money paise={d.total.debit_balance_paise} /></td>
                  <td className="td num"><Money paise={d.total.credit_balance_paise} /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}</Loading>
    </div>
  );
}

// ------------------------------------------------------------ R2
function VendorStatementReport({ f }) {
  const vendorId = f.get('vendor_id');
  const from = f.get('from');
  const to = f.get('to');
  const page = Math.max(1, Number.parseInt(f.get('page') || '1', 10) || 1);
  const vendors = useApi(() => api.get('/finance/vendors'), []);
  const bad = from && to && from > to;
  const q = useApi(
    () => (vendorId && !bad ? api.get('/finance/reports/vendor-statement', { vendor_id: vendorId, from, to, page, page_size: 25 }) : Promise.resolve(null)),
    [vendorId, from, to, page, bad],
  );
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="r2-vendor">Vendor</label>
          <select id="r2-vendor" className="input" value={vendorId} onChange={(e) => f.update({ vendor_id: e.target.value })}>
            <option value="">Choose a vendor…</option>
            {vendors.data?.items.map((v) => <option key={v.vendor_id} value={v.vendor_id}>#{v.vendor_id} {v.legal_name}</option>)}
          </select>
        </div>
        <DateInput id="r2-from" label="From (IST)" value={from} onChange={(v) => f.update({ from: v })} />
        <DateInput id="r2-to" label="To (IST)" value={to} onChange={(v) => f.update({ to: v })} />
        <p className="max-w-md text-sm text-slate-500">Running balance = <code>SUM(credit − debit) OVER (ORDER BY created_at, entry_id, line_no)</code> over the whole history; the date filter is applied after the window.</p>
      </div>
      {bad && <p className="text-sm text-amber-700">“From” must not be after “To”.</p>}
      {!vendorId && <Empty title="Choose a vendor to see its statement" />}
      {vendorId && <Loading q={q} title="Could not load R2">{(d) => (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <SmallStat label="Opening balance" testId="r2-opening"><Money paise={d.opening_balance_paise} className={negClass(d.opening_balance_paise)} /></SmallStat>
            <SmallStat label="Credits in period"><Money paise={d.period_credit_paise} /></SmallStat>
            <SmallStat label="Debits in period"><Money paise={d.period_debit_paise} /></SmallStat>
            <SmallStat label="Closing balance" testId="r2-closing"><Money paise={d.closing_balance_paise} className={negClass(d.closing_balance_paise)} /></SmallStat>
          </div>
          {d.items.length === 0 ? <Empty title="No ledger lines in this period" /> : (
            <div className="card overflow-x-auto p-0">
              <table className="w-full">
                <thead><tr>
                  <th className="th">#</th><th className="th">When</th><th className="th">Type</th><th className="th">Reference</th>
                  <th className="th num">Credit</th><th className="th num">Debit</th><th className="th num">Running balance</th>
                </tr></thead>
                <tbody>
                  {d.items.map((l) => (
                    <tr key={`${l.entry_id}-${l.line_no}`} className="border-t border-slate-100" data-testid="r2-row">
                      <td className="td text-slate-400">{l.seq}</td>
                      <td className="td whitespace-nowrap">{formatDateTime(l.created_at)}</td>
                      <td className="td"><StatusBadge status={l.entry_type} /></td>
                      <td className="td whitespace-nowrap">{l.reference}</td>
                      <td className="td num">{l.credit_paise !== '0' && <Money paise={l.credit_paise} />}</td>
                      <td className="td num">{l.debit_paise !== '0' && <Money paise={l.debit_paise} />}</td>
                      <td className={`td num font-medium ${negClass(l.running_balance_paise)}`}><Money paise={l.running_balance_paise} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={page} pageSize={25} total={d.total} onPage={(n) => f.update({ page: String(n) })} />
        </>
      )}</Loading>}
    </div>
  );
}

function SmallStat({ label, children, testId }) {
  return (
    <div className="card">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 font-semibold" data-testid={testId}>{children}</p>
    </div>
  );
}

// ------------------------------------------------------------ R3
const SERIES = { gross: '#2a78d6', refunded: '#eb6834' };     // categorical slots 1–2 (validated, light surface)

function MonthTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const m = payload[0].payload;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow">
      <p className="font-medium text-slate-800">{label}</p>
      <p className="text-slate-700"><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: SERIES.gross }} />Captured {formatINR(m.gross)}</p>
      <p className="text-slate-700"><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: SERIES.refunded }} />Refunded {formatINR(m.refunded)}</p>
    </div>
  );
}

const lakh = (r) => (r === 0 ? '0' : `₹${(r / 100000).toLocaleString('en-IN', { maximumFractionDigits: 1 })}L`);   // axis ticks only

function MonthlyReport({ f }) {
  const from = f.get('from');
  const to = f.get('to');
  const bad = from && to && from > to;
  const q = useApi(
    () => (bad ? Promise.resolve(null) : api.get('/finance/reports/monthly-performance', { from: from && `${from}-01`, to: to && `${to}-01` })),
    [from, to, bad],
  );
  const monthLabel = (d) => formatDate(d).replace(/^1 /, '');
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-3">
        <DateInput id="r3-from" type="month" label="From month" value={from} onChange={(v) => f.update({ from: v })} />
        <DateInput id="r3-to" type="month" label="To month" value={to} onChange={(v) => f.update({ to: v })} />
        <p className="max-w-lg text-sm text-slate-500">IST calendar months. Captures by capture time, attempts by creation time (captured or failed only), refunds by processing time, commission / GST / fees from the ledger. Each measure is aggregated per month in its own CTE before joining.</p>
      </div>
      {bad && <p className="text-sm text-amber-700">“From” must not be after “To”.</p>}
      <Loading q={q} title="Could not load R3">{(d) => (d.items.length === 0 ? <Empty title="No months" /> : (
        <>
          <div className="card">
            <h2 className="text-sm font-medium text-slate-800">Captured vs refunded per month</h2>
            <div className="mt-1 flex gap-4 text-xs text-slate-600">
              <span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: SERIES.gross }} />Captured gross</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: SERIES.refunded }} />Refunded</span>
            </div>
            <div className="h-64" data-testid="r3-chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.items.map((m) => ({
                  month: monthLabel(m.month), gross: m.captured_gross_paise, refunded: m.refunded_paise,
                  grossR: chartRupees(m.captured_gross_paise), refundedR: chartRupees(m.refunded_paise),
                }))} barGap={2} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="month" tickLine={false} axisLine={{ stroke: '#cbd5e1' }} tick={{ fontSize: 12, fill: '#475569' }} />
                  <YAxis tickFormatter={lakh} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#64748b' }} width={56} />
                  <Tooltip content={<MonthTooltip />} cursor={{ fill: '#f1f5f9' }} />
                  <Bar dataKey="grossR" name="Captured gross" fill={SERIES.gross} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="refundedR" name="Refunded" fill={SERIES.refunded} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1 text-xs text-slate-400">Bar heights use whole rupees for drawing only; every amount shown as text is exact.</p>
          </div>
          <div className="card overflow-x-auto p-0">
            <table className="w-full">
              <thead><tr>
                <th className="th">Month</th><th className="th num">Captured</th><th className="th num">Gross</th>
                <th className="th num">Attempt success</th><th className="th num">Refunds</th><th className="th num">Refunded</th>
                <th className="th num">Refund rate</th><th className="th num">Commission (net)</th><th className="th num">GST (net)</th>
                <th className="th num">Gateway fees</th><th className="th num">Platform net</th><th className="th num">Cumulative gross</th>
              </tr></thead>
              <tbody>
                {d.items.map((m) => (
                  <tr key={m.month} className="border-t border-slate-100" data-testid="r3-row">
                    <td className="td whitespace-nowrap">{monthLabel(m.month)}</td>
                    <td className="td num"><Num v={m.payments_captured} /></td>
                    <td className="td num"><Money paise={m.captured_gross_paise} /></td>
                    <td className="td num" title={`${m.attempts_final} final attempts, ${m.attempts_failed} failed`}>{formatBps(m.success_rate_bps)}</td>
                    <td className="td num"><Num v={m.refunds_processed} /></td>
                    <td className="td num"><Money paise={m.refunded_paise} /></td>
                    <td className="td num">{formatBps(m.refund_rate_bps)}</td>
                    <td className="td num"><Money paise={m.commission_net_paise} /></td>
                    <td className="td num"><Money paise={m.gst_net_paise} /></td>
                    <td className="td num"><Money paise={m.gateway_fees_paise} /></td>
                    <td className="td num font-medium"><Money paise={m.platform_net_paise} /></td>
                    <td className="td num"><Money paise={m.cumulative_gross_paise} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">Refund rate = refunded in the month ÷ captured gross in the same month (a refund can belong to an earlier sale — R4 uses a sales cohort). Platform net = net commission − gateway fees; GST is a liability, not revenue.</p>
        </>
      ))}</Loading>
    </div>
  );
}

// ------------------------------------------------------------ R4
const BAND = { high: 'bg-rose-100 text-rose-800', watch: 'bg-amber-100 text-amber-800', normal: 'bg-emerald-100 text-emerald-800' };
export function RiskBand({ band }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${BAND[band] ?? 'bg-slate-100 text-slate-700'}`}>{band.replace('_', ' ')}</span>;
}

function RefundRiskReport({ f }) {
  const from = f.get('from');
  const to = f.get('to');
  const minText = f.get('min_sales') || '1000';
  const minPaise = parseRupees(minText);
  const bad = (from && to && from > to) || minPaise === null;
  const q = useApi(
    () => (bad ? Promise.resolve(null) : api.get('/finance/reports/refund-risk', { from, to, min_sales_paise: minPaise })),
    [from, to, minPaise, bad],
  );
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-3">
        <DateInput id="r4-from" label="Sold from (IST)" value={from} onChange={(v) => f.update({ from: v })} />
        <DateInput id="r4-to" label="Sold to (IST)" value={to} onChange={(v) => f.update({ to: v })} />
        <div>
          <label className="label" htmlFor="r4-min">Rank only vendors with sales ≥ ₹</label>
          <input id="r4-min" className="input w-32" value={minText} onChange={(e) => f.update({ min_sales: e.target.value })} />
        </div>
        <p className="max-w-md text-sm text-slate-500">Cohort = lines of orders captured in the window. Rate = processed refunds of those lines ÷ their line totals. Refunds are summed per line first, so a line with several refunds is not counted twice.</p>
      </div>
      {minPaise === null && <p className="text-sm text-amber-700">Enter a rupee amount (up to 2 decimals).</p>}
      <Loading q={q} title="Could not load R4">{(d) => (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr>
              <th className="th">Rank</th><th className="th">Vendor</th><th className="th num">Lines sold</th><th className="th num">Sales</th>
              <th className="th num">Requests</th><th className="th num">Rejected</th><th className="th num">Lines refunded</th>
              <th className="th num">Refunded</th><th className="th num">Pending</th><th className="th num">Refund rate</th><th className="th">Band</th>
            </tr></thead>
            <tbody>
              {d.items.map((v) => (
                <tr key={v.vendor_id} className="border-t border-slate-100" data-testid="r4-row">
                  <td className="td"><Num v={v.rate_rank} /></td>
                  <td className="td">#{v.vendor_id} {v.legal_name}{v.kyc_status !== 'verified' && <span className="ml-1 text-xs text-slate-400">({v.kyc_status})</span>}</td>
                  <td className="td num"><Num v={v.lines_sold} /></td>
                  <td className="td num"><Money paise={v.sales_paise} /></td>
                  <td className="td num"><Num v={v.refund_requests} /></td>
                  <td className="td num"><Num v={v.refunds_rejected} /></td>
                  <td className="td num"><Num v={v.lines_refunded} /></td>
                  <td className="td num"><Money paise={v.refunded_paise} /></td>
                  <td className="td num"><Money paise={v.pending_refund_paise} /></td>
                  <td className="td num font-medium">{formatBps(v.refund_rate_bps)}</td>
                  <td className="td"><RiskBand band={v.risk_band} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-xs text-slate-500">Bands: high ≥ 10%, watch ≥ 5%. Vendors below ₹{paiseToInput(d.min_sales_paise)} of sales are “low volume” and not ranked.</p>
        </div>
      )}</Loading>
    </div>
  );
}

// ------------------------------------------------------------ R5
const AGE_MEANING = {
  matched: 'settlement lag (settled − event)',
  in_transit: 'days since the event (≤ 2)',
  overdue_missing: 'days past the T+2 due date',
  amount_mismatch: 'days since the row was settled (open)',
  unknown_reference: 'days since the row was settled (open)',
};

function AgingReport({ f }) {
  const asOf = f.get('as_of');
  const q = useApi(() => api.get('/finance/reports/settlement-aging', { as_of: asOf }), [asOf]);
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-3">
        <DateInput id="r5-asof" label="As of (IST)" value={asOf} onChange={(v) => f.update({ as_of: v })} />
        <span className="text-sm text-slate-500">Using <strong data-testid="r5-asof">{q.data?.as_of ?? '…'}</strong>{!asOf && ' (server demo default)'}. Matching by gateway reference, T+2 calendar days; subtotals and total via <code>GROUPING SETS</code>.</span>
      </div>
      <Loading q={q} title="Could not load R5">{(d) => (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr>
              <th className="th">Category</th><th className="th">Age bucket</th><th className="th num">Items</th><th className="th num">Expected</th>
              <th className="th num">Settled gross</th><th className="th num">Fees</th><th className="th num">Difference</th>
              <th className="th num">Net cash posted</th><th className="th num">Oldest (days)</th>
            </tr></thead>
            <tbody>
              {d.items.map((x) => (
                <tr key={`${x.category}-${x.age_bucket ?? 'all'}`}
                  className={`border-t border-slate-100 ${x.is_subtotal ? 'bg-slate-50 font-medium' : ''}`} data-testid={x.is_subtotal ? 'r5-subtotal' : 'r5-row'}>
                  <td className="td">{x.is_subtotal && <><StatusBadge status={x.category} /><span className="ml-2 text-xs font-normal text-slate-500">age = {AGE_MEANING[x.category]}</span></>}</td>
                  <td className="td">{x.is_subtotal ? 'all' : <span className="pl-3">{x.age_bucket}</span>}</td>
                  <td className="td num"><Num v={x.items} /></td>
                  <td className="td num"><Money paise={x.expected_paise} /></td>
                  <td className="td num"><Money paise={x.settled_gross_paise} /></td>
                  <td className="td num"><Money paise={x.fee_paise} /></td>
                  <td className={`td num ${negClass(x.difference_paise)}`}><Money paise={x.difference_paise} /></td>
                  <td className="td num"><Money paise={x.net_cash_paise} /></td>
                  <td className="td num"><Num v={x.oldest_age_days} /></td>
                </tr>
              ))}
              {d.total && (
                <tr className="border-t-2 border-slate-300 font-semibold" data-testid="r5-total">
                  <td className="td" colSpan={2}>Total</td>
                  <td className="td num"><Num v={d.total.items} /></td>
                  <td className="td num"><Money paise={d.total.expected_paise} /></td>
                  <td className="td num"><Money paise={d.total.settled_gross_paise} /></td>
                  <td className="td num"><Money paise={d.total.fee_paise} /></td>
                  <td className="td num"><Money paise={d.total.difference_paise} /></td>
                  <td className="td num"><Money paise={d.total.net_cash_paise} /></td>
                  <td className="td num"><Num v={d.total.oldest_age_days} /></td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="px-3 py-2 text-xs text-slate-500">Only matched rows are posted (net cash = gross − fee for payments, −amount for refunds). Mismatched and unknown rows are stored but never posted. Row-level detail: Reconciliation page.</p>
        </div>
      )}</Loading>
    </div>
  );
}

// ------------------------------------------------------------ R6
export const PAYABLE_STATUS = {
  payable: 'bg-emerald-100 text-emerald-800', negative: 'bg-rose-100 text-rose-800',
  payouts_blocked_kyc: 'bg-amber-100 text-amber-800', nothing_payable: 'bg-slate-100 text-slate-700',
};

const istDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' });
function CountCell({ n, paise }) {
  return <td className="td num"><Money paise={paise} /><div className="text-xs text-slate-400">{n} payout{n === '1' ? '' : 's'}</div></td>;
}

function PayablesReport() {
  const q = useApi(() => api.get('/finance/reports/vendor-payables'), []);
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">Balance decomposed from the ledger: sales − refunds − payouts + reversals. “Ledger ✓” checks the payouts table against the ledger (payout debits − reversal credits = requested + paid payouts).</p>
      <Loading q={q} title="Could not load R6">{(d) => (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr>
              <th className="th">Vendor</th><th className="th num">Sales</th><th className="th num">Refunds</th><th className="th num">Payouts</th>
              <th className="th num">Reversals</th><th className="th num">Balance</th><th className="th num">Paid</th><th className="th num">In flight</th>
              <th className="th num">Failed</th><th className="th">Last paid</th><th className="th">Ledger</th><th className="th">Status</th>
            </tr></thead>
            <tbody>
              {d.items.map((v) => (
                <tr key={v.vendor_id} className="border-t border-slate-100 whitespace-nowrap" data-testid="r6-row">
                  <td className="td">#{v.vendor_id} {v.legal_name}</td>
                  <td className="td num"><Money paise={v.sales_paise} /></td>
                  <td className="td num"><Money paise={v.refunds_paise} /></td>
                  <td className="td num"><Money paise={v.payouts_paise} /></td>
                  <td className="td num"><Money paise={v.reversals_paise} /></td>
                  <td className={`td num font-medium ${negClass(v.balance_paise)}`}><Money paise={v.balance_paise} /></td>
                  <CountCell n={v.payouts_paid} paise={v.paid_paise} />
                  <CountCell n={v.payouts_in_flight} paise={v.in_flight_paise} />
                  <CountCell n={v.payouts_failed} paise={v.failed_paise} />
                  <td className="td">{v.last_paid_at ? istDate(v.last_paid_at) : '—'}</td>
                  <td className="td">{v.ledger_consistent ? '✓' : '✗'}</td>
                  <td className="td"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${PAYABLE_STATUS[v.status]}`}>{v.status.replace(/_/g, ' ')}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}</Loading>
    </div>
  );
}
