// Vendor statement: every ledger line on the vendor's payable account with a
// RUNNING BALANCE computed in PostgreSQL by a window function
// (v_vendor_statement: SUM(credit − debit) OVER (PARTITION BY vendor ORDER BY
// created_at, entry_id, line_no)). The date filter is applied after the window,
// so the running balance on the first shown row already includes earlier history;
// the opening balance is everything before `from`. Served by report R2
// (fn_report_vendor_statement, db/schema/32_reports.sql).
//   GET /api/vendor/statement?from&to&page&page_size
import { useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, Money, Pager, Spinner, Stat, StatusBadge, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { cmpPaise } from '../../lib/money.js';
import { useApi } from '../../lib/useApi.js';

const PAGE_SIZE = 25;

function reference(l) {
  if (l.reference) return l.reference;          // R2: "order 12", "refund 5 (order 12)", "payout 3", …
  if (l.payment_id) return `payment #${l.payment_id}`;
  if (l.refund_id) return `refund #${l.refund_id}`;
  if (l.payout_id) return `payout #${l.payout_id}`;
  if (l.reverses_entry_id) return `reverses entry #${l.reverses_entry_id}`;
  return '—';
}

export default function Statement() {
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
  const badRange = from && to && from > to;
  const st = useApi(
    () => (badRange ? Promise.resolve(null) : api.get('/vendor/statement', { from, to, page, page_size: PAGE_SIZE })),
    [from, to, page, badRange],
  );

  function update(changes) {
    // functional update: two quick changes in a row must not overwrite each other
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) if (v) next.set(k, v); else next.delete(k);
      if (!('page' in changes)) next.delete('page');
      return next;
    }, { replace: true });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Statement</h1>
          <p className="text-sm text-slate-600">Credits: your share of sales. Debits: refunds and payouts. Reversals restore failed payouts.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="st-from">From (IST)</label>
            <input id="st-from" type="date" className="input" value={from} onChange={(e) => update({ from: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="st-to">To (IST)</label>
            <input id="st-to" type="date" className="input" value={to} onChange={(e) => update({ to: e.target.value })} />
          </div>
          {(from || to) && <button type="button" className="btn-secondary" onClick={() => update({ from: '', to: '' })}>Clear</button>}
        </div>
      </div>
      {badRange && <p className="text-sm text-amber-700">“From” must not be after “To”.</p>}
      <ErrorBox error={st.error} title="Could not load the statement" onRetry={st.reload} />
      {st.loading && !st.data && <Spinner label="Loading statement…" />}
      {st.data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label={from ? `Opening balance (before ${from})` : 'Opening balance'} testId="st-opening"><Money paise={st.data.opening_balance_paise} /></Stat>
            <Stat label={to ? `Closing balance (end of ${to})` : 'Closing balance'} testId="st-closing">
              <Money paise={st.data.closing_balance_paise} className={cmpPaise(st.data.closing_balance_paise, '0') < 0 ? 'text-rose-700' : ''} />
            </Stat>
          </div>
          {st.data.items.length === 0 ? <Empty title="No ledger lines in this period" /> : (
            <div className="card overflow-x-auto p-0">
              <table className="w-full">
                <thead><tr>
                  <th className="th">When</th><th className="th">Entry</th><th className="th">Type</th><th className="th">Reference</th>
                  <th className="th">Description</th><th className="th num">Credit</th><th className="th num">Debit</th><th className="th num">Running balance</th>
                </tr></thead>
                <tbody>
                  {st.data.items.map((l) => (
                    <tr key={`${l.entry_id}-${l.line_no}`} className="border-t border-slate-100" data-testid="statement-row">
                      <td className="td whitespace-nowrap">{formatDateTime(l.created_at)}</td>
                      <td className="td">#{l.entry_id}</td>
                      <td className="td"><StatusBadge status={l.entry_type} /></td>
                      <td className="td whitespace-nowrap">{reference(l)}</td>
                      <td className="td max-w-xs truncate" title={l.description}>{l.description}</td>
                      <td className="td num">{cmpPaise(l.credit_paise, '0') ? <Money paise={l.credit_paise} /> : ''}</td>
                      <td className="td num">{cmpPaise(l.debit_paise, '0') ? <Money paise={l.debit_paise} /> : ''}</td>
                      <td className={`td num font-medium ${cmpPaise(l.running_balance_paise, '0') < 0 ? 'text-rose-700' : ''}`}>
                        <Money paise={l.running_balance_paise} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={page} pageSize={PAGE_SIZE} total={st.data.total} onPage={(n) => update({ page: String(n) })} />
        </>
      )}
    </div>
  );
}
