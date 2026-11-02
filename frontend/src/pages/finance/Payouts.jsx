// Finance payout queue (W2 step 2): the simulated bank transfer's outcome.
//   GET  /api/finance/payouts?status&vendor_id&page
//   POST /api/finance/payouts/:id/complete { outcome: 'paid', bank_utr } | { outcome: 'failed' }
// paid   → status paid + UTR; nothing posted (the money left at request time).
// failed → status failed + ONE reversal entry that restores the vendor's funds.
// Terminal states never change (PRS01); repeating "failed" returns the same row and
// posts nothing more, so a failed transfer restores funds exactly once.
import { useState } from 'react';
import { Empty, ErrorBox, Money, Notice, Pager, Spinner, StatusBadge, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { cmpPaise } from '../../lib/money.js';
import { useApi } from '../../lib/useApi.js';
import LedgerEntries from './LedgerEntries.jsx';

const PAGE_SIZE = 15;
const UTR_RE = /^[A-Z0-9]{12,22}$/;
// the bank would supply the UTR; for the simulation we suggest one (editable)
const suggestUtr = (id) => `SIMUTR${String(id).padStart(8, '0')}`.slice(0, 22);

function VendorBalances({ reloadToken }) {
  const res = useApi(() => api.get('/finance/vendors'), [reloadToken]);
  return (
    <details className="card">
      <summary className="cursor-pointer text-sm font-medium">Vendor balances (ledger-derived)</summary>
      <ErrorBox error={res.error} onRetry={res.reload} />
      {res.data && (
        <table className="mt-2 w-full">
          <thead><tr><th className="th">Vendor</th><th className="th">KYC</th><th className="th num">Balance</th><th className="th num">Pending payouts</th></tr></thead>
          <tbody>
            {res.data.items.map((v) => (
              <tr key={v.vendor_id} className="border-t border-slate-100" data-testid="fin-vendor-row" data-vendor-id={v.vendor_id}>
                <td className="td">{v.legal_name}</td>
                <td className="td"><StatusBadge status={v.kyc_status} /></td>
                <td className={`td num ${cmpPaise(v.balance_paise, '0') < 0 ? 'text-rose-700' : ''}`} data-testid="fin-vendor-balance"><Money paise={v.balance_paise} /></td>
                <td className="td num">{v.pending_payouts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

export default function FinancePayouts() {
  const [status, setStatus] = useState('requested');
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState(null);          // { payout_id, utr }
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);
  const [tick, setTick] = useState(0);
  const list = useApi(() => api.get('/finance/payouts', { status: status || undefined, page, page_size: PAGE_SIZE }), [status, page, tick]);

  async function complete(p, body) {
    setBusyId(p.payout_id);
    setError(null);
    try {
      const payout = await api.post(`/finance/payouts/${p.payout_id}/complete`, body);
      setLast({ payout, body });
      setPaying(null);
      setTick((t) => t + 1);
    } catch (err) {
      setError({ err, payoutId: p.payout_id });
    } finally {
      setBusyId(null);
    }
  }

  const fail = (p) => {
    if (!window.confirm(`Record that the bank transfer for payout #${p.payout_id} FAILED? The amount is restored to the vendor with a reversal entry.`)) return;
    complete(p, { outcome: 'failed' });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Payouts</h1>
          <p className="text-sm text-slate-600">Record the outcome of each simulated bank transfer.</p>
        </div>
        <div>
          <label className="label" htmlFor="fp-status">Status</label>
          <select id="fp-status" className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option><option value="requested">requested</option>
            <option value="paid">paid</option><option value="failed">failed</option>
          </select>
        </div>
      </div>

      {last && (
        <div className="space-y-2" data-testid="payout-decision">
          <Notice tone={last.payout.status === 'paid' ? 'success' : 'warn'}>
            Payout #{last.payout.payout_id} (<Money paise={last.payout.amount_paise} />) is now <StatusBadge status={last.payout.status} />
            {last.payout.bank_utr && <> — UTR <span className="font-mono">{last.payout.bank_utr}</span></>}.
            {last.payout.status === 'failed' && ' A reversal entry restored the amount to the vendor.'}
          </Notice>
          {last.payout.status === 'failed' && (
            <button type="button" className="btn-secondary" disabled={busyId === last.payout.payout_id}
              onClick={() => complete(last.payout, { outcome: 'failed' })}>
              Demo: record “failed” again (retry)
            </button>
          )}
          <LedgerEntries query={{ payout_id: last.payout.payout_id }} reloadToken={tick}
            title={`Ledger entries for payout #${last.payout.payout_id} (request + any reversal)`} />
        </div>
      )}
      {error && <ErrorBox error={error.err} title={`Payout #${error.payoutId} not changed`} />}
      <VendorBalances reloadToken={tick} />

      <ErrorBox error={list.error} title="Could not load payouts" onRetry={list.reload} />
      {list.loading && !list.data && <Spinner label="Loading payouts…" />}
      {list.data && (list.data.items.length === 0 ? <Empty title="No payouts match" /> : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr>
              <th className="th">Payout</th><th className="th">Vendor</th><th className="th num">Amount</th><th className="th">Status</th>
              <th className="th">Requested</th><th className="th">Outcome</th>
            </tr></thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.payout_id} className="border-t border-slate-100" data-testid="finance-payout-row" data-payout-id={p.payout_id}>
                  <td className="td">#{p.payout_id}</td>
                  <td className="td">{p.vendor_name}</td>
                  <td className="td num"><Money paise={p.amount_paise} /></td>
                  <td className="td"><StatusBadge status={p.status} /></td>
                  <td className="td whitespace-nowrap">{formatDateTime(p.requested_at)}</td>
                  <td className="td">
                    {p.status !== 'requested' ? (
                      <span className="text-xs text-slate-500">
                        {p.bank_utr && <span className="font-mono">{p.bank_utr} · </span>}{formatDateTime(p.completed_at)}
                      </span>
                    ) : paying?.payout_id === p.payout_id ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <input aria-label="Bank UTR" className="input w-48 font-mono" value={paying.utr}
                          onChange={(e) => setPaying({ ...paying, utr: e.target.value.toUpperCase() })} />
                        <button type="button" className="btn-primary" disabled={busyId === p.payout_id || !UTR_RE.test(paying.utr)}
                          onClick={() => complete(p, { outcome: 'paid', bank_utr: paying.utr })}>Confirm paid</button>
                        <button type="button" className="btn-secondary" onClick={() => setPaying(null)}>Cancel</button>
                        {!UTR_RE.test(paying.utr) && <span className="text-xs text-amber-700">12–22 letters/digits</span>}
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <button type="button" className="btn-secondary" disabled={busyId === p.payout_id}
                          onClick={() => setPaying({ payout_id: p.payout_id, utr: suggestUtr(p.payout_id) })}>Mark paid…</button>
                        <button type="button" className="btn-secondary text-rose-700" disabled={busyId === p.payout_id} onClick={() => fail(p)}>Mark failed</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {list.data && <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
    </div>
  );
}
