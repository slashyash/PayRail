// Reconciliation (W4 step 2, DEC-009 / DEC-029).
//   POST /api/finance/reconcile { as_of? }        → fn_reconcile: re-tries unposted rows that now match
//                                                   exactly (e.g. a late payment callback), then summarises
//   GET  /api/finance/reconciliation?as_of&category&gateway_ref&page → fn_reconciliation_report(as_of)
// Dates are IST calendar dates; expected settlement = event date + 2 (T+2, no
// holiday calendar). Settlement rows dated after as_of are ignored for that run.
// Without as_of the server uses PAYRAIL_DEMO_AS_OF (2026-10-31 for the demo).
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, Money, Notice, Pager, Spinner, StatusBadge, formatDate } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';

const PAGE_SIZE = 25;
export const CATEGORIES = {
  matched: 'Known reference, same type and amount — posted to the ledger once.',
  amount_mismatch: 'Known reference but the report differs (amount, fee or record type) — stored, NOT posted; investigate.',
  unknown_reference: 'No captured payment / processed refund with this reference — stored, NOT posted, no payment invented. Re-run later: it posts if the payment appears and matches.',
  in_transit: 'Captured / processed, no settlement row yet, still within T+2.',
  overdue_missing: 'Captured / processed, no settlement row, and T+2 has passed.',
};

export default function Reconciliation() {
  const [params, setParams] = useSearchParams();
  const asOf = params.get('as_of') ?? '';
  const category = params.get('category') ?? '';
  const ref = params.get('ref') ?? '';
  const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
  const [refInput, setRefInput] = useState(ref);
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [run, setRun] = useState(null);

  // the summary always comes from the same function as the run (no client-side counting)
  const report = useApi(
    () => api.get('/finance/reconciliation', { as_of: asOf, category, gateway_ref: ref, page, page_size: PAGE_SIZE }),
    [asOf, category, ref, page, tick],
  );

  function update(changes) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) if (v) next.set(k, v); else next.delete(k);
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  }

  async function reconcile() {
    setRunning(true);
    setRunError(null);
    try {
      setRun(await api.post('/finance/reconcile', asOf ? { as_of: asOf } : {}));
      setTick((t) => t + 1);
    } catch (err) {
      setRunError(err);
    } finally {
      setRunning(false);
    }
  }

  const refOk = !refInput || /^[A-Za-z0-9_]{1,64}$/.test(refInput);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Reconciliation</h1>
        <p className="text-sm text-slate-600">
          Compares every captured payment and processed refund with the gateway's settlement rows as of a date.
        </p>
      </div>

      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="rc-asof">As of (IST date)</label>
          <input id="rc-asof" type="date" className="input" value={asOf} onChange={(e) => update({ as_of: e.target.value })} />
        </div>
        <button type="button" className="btn-primary" disabled={running} onClick={reconcile}>{running ? 'Running…' : 'Run reconciliation'}</button>
        <span className="text-sm text-slate-500" data-testid="rc-asof-used">Using as-of date: <strong>{report.data?.as_of ?? '…'}</strong>{!asOf && ' (server demo default)'}</span>
      </div>
      <ErrorBox error={runError} title="Reconciliation failed" />

      {run && (
        <div className="card space-y-2 p-0" data-testid="rc-summary">
          <h2 className="px-3 pt-3 font-medium">Summary as of {formatDate(run.as_of)}</h2>
          <table className="w-full">
            <thead><tr>
              <th className="th">Category</th><th className="th num">Items</th><th className="th num">Expected</th>
              <th className="th num">Settled gross</th><th className="th num">Fees</th><th className="th num">Posted</th><th className="th num">Newly posted now</th>
            </tr></thead>
            <tbody>
              {run.categories.map((c) => (
                <tr key={c.category} className="border-t border-slate-100" data-testid="rc-category" data-category={c.category}>
                  <td className="td"><button type="button" className="hover:underline" onClick={() => update({ category: c.category })}><StatusBadge status={c.category} /></button></td>
                  <td className="td num" data-testid="rc-items">{c.items}</td>
                  <td className="td num"><Money paise={c.expected_paise} /></td>
                  <td className="td num"><Money paise={c.settled_gross_paise} /></td>
                  <td className="td num"><Money paise={c.fee_paise} /></td>
                  <td className="td num">{c.posted_items}</td>
                  <td className="td num" data-testid="rc-newly">{c.newly_posted}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {run.categories.some((c) => c.newly_posted !== '0') && (
            <div className="px-3 pb-3"><Notice tone="success">Rows that now match exactly were posted during this run.</Notice></div>
          )}
        </div>
      )}

      <details className="card text-sm">
        <summary className="cursor-pointer font-medium">What the categories mean</summary>
        <dl className="mt-2 space-y-1">
          {Object.entries(CATEGORIES).map(([k, v]) => (
            <div key={k} className="flex gap-2"><dt className="w-40 shrink-0"><StatusBadge status={k} /></dt><dd className="text-slate-600">{v}</dd></div>
          ))}
        </dl>
      </details>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="label" htmlFor="rc-cat">Category</label>
          <select id="rc-cat" className="input" value={category} onChange={(e) => update({ category: e.target.value })}>
            <option value="">All</option>
            {Object.keys(CATEGORIES).map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (refOk) update({ ref: refInput.trim() }); }}>
          <div>
            <label className="label" htmlFor="rc-ref">Gateway reference</label>
            <input id="rc-ref" className="input font-mono" placeholder="pay_S000000365" value={refInput} onChange={(e) => setRefInput(e.target.value)} />
          </div>
          <button type="submit" className="btn-secondary" disabled={!refOk}>Find</button>
          {ref && <button type="button" className="btn-secondary" onClick={() => { setRefInput(''); update({ ref: '' }); }}>Clear</button>}
        </form>
      </div>

      <ErrorBox error={report.error} title="Could not load the reconciliation report" onRetry={report.reload} />
      {report.loading && !report.data && <Spinner label="Loading report…" />}
      {report.data && (report.data.items.length === 0 ? <Empty title="Nothing in this category" /> : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr>
              <th className="th">Category</th><th className="th">Reference</th><th className="th">Event → due (T+2)</th><th className="th">Settled</th><th className="th num">Expected</th><th className="th num">Reported</th>
              <th className="th num">Fee</th><th className="th num">Days overdue</th><th className="th">Posted</th><th className="th">Detail</th>
            </tr></thead>
            <tbody>
              {report.data.items.map((r, i) => (
                <tr key={`${r.gateway_ref}-${r.settlement_id ?? ''}-${i}`} className="border-t border-slate-100" data-testid="rc-row" data-category={r.category} data-ref={r.gateway_ref}>
                  <td className="td"><StatusBadge status={r.category} /></td>
                  <td className="td font-mono text-xs">{r.gateway_ref}<div className="font-sans text-slate-500">{r.record_type}</div></td>
                  <td className="td whitespace-nowrap">{r.event_on ? `${formatDate(r.event_on)} → ${formatDate(r.expected_on)}` : '—'}</td>
                  <td className="td whitespace-nowrap">{formatDate(r.settled_on)}</td>
                  <td className="td num">{r.expected_paise ? <Money paise={r.expected_paise} /> : '—'}</td>
                  <td className="td num">{r.settled_gross_paise ? <Money paise={r.settled_gross_paise} /> : '—'}</td>
                  <td className="td num">{r.fee_paise ? <Money paise={r.fee_paise} /> : '—'}</td>
                  <td className="td num">{r.days_overdue ?? '—'}</td>
                  <td className="td">{r.posted_entry_id ? `#${r.posted_entry_id}` : '—'}</td>
                  <td className="td min-w-[14rem] text-xs">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {report.data && <Pager page={page} pageSize={PAGE_SIZE} total={report.data.total} onPage={(n) => update({ page: String(n) })} />}
    </div>
  );
}
