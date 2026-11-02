// Finance-only gateway fault injection (DEC-038).
// Real gateways retry callbacks, deliver them late, or (by mistake) report a
// wrong amount. This screen lets finance send such callbacks for any payment
// attempt to show that the DATABASE stays correct:
//   POST /api/mock-gateway/payments/:id/simulate { outcome, amount_paise?, deliveries? }
// Each delivery goes through the same HMAC-verified callback handler as a real one.
import { useState } from 'react';
import DeliveryResults from '../components/DeliveryResults.jsx';
import { Empty, ErrorBox, Money, Pager, Spinner, StatusBadge, formatDateTime } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { addPaise } from '../lib/money.js';
import { useApi } from '../lib/useApi.js';

const PAGE_SIZE = 10;

export default function GatewaySimulator() {
  const [status, setStatus] = useState('initiated');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const list = useApi(() => api.get('/finance/payments', { status: status || undefined, page, page_size: PAGE_SIZE }), [status, page]);

  async function send(label, body) {
    setBusy(label);
    setError(null);
    try {
      const r = await api.post(`/mock-gateway/payments/${selected.payment_id}/simulate`, body);
      setResult(r);
      setSelected({ ...selected, ...r.payment });
      list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Gateway simulator</h1>
        <p className="text-sm text-slate-600">
          Finance-only test tool. Sends signed gateway callbacks for a payment attempt — including duplicates, late
          contradictory callbacks and wrong amounts — to show that the database accepts each outcome once and refuses the rest.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-3 p-0">
          <div className="flex items-end justify-between gap-3 px-3 pt-3">
            <h2 className="font-medium">Payment attempts</h2>
            <div>
              <label className="label" htmlFor="pstatus">Status</label>
              <select id="pstatus" className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
                <option value="">All</option><option value="initiated">initiated</option>
                <option value="captured">captured</option><option value="failed">failed</option>
              </select>
            </div>
          </div>
          <ErrorBox error={list.error} title="Could not load payments" onRetry={list.reload} />
          {list.loading && !list.data && <Spinner />}
          {list.data && (list.data.items.length === 0 ? <div className="p-3"><Empty title="No payment attempts with this status" /></div> : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr><th className="th">Payment</th><th className="th">Order</th><th className="th num">Amount</th><th className="th">Status</th><th className="th">Created</th></tr></thead>
                <tbody>
                  {list.data.items.map((p) => (
                    <tr key={p.payment_id} data-testid="sim-payment-row"
                      className={`cursor-pointer border-t border-slate-100 hover:bg-indigo-50 ${selected?.payment_id === p.payment_id ? 'bg-indigo-50' : ''}`}
                      onClick={() => { setSelected(p); setResult(null); setError(null); }}>
                      <td className="td">#{p.payment_id}</td><td className="td">#{p.order_id}</td>
                      <td className="td num"><Money paise={p.amount_paise} /></td>
                      <td className="td"><StatusBadge status={p.status} /></td>
                      <td className="td">{formatDateTime(p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div className="px-3 pb-3">
            {list.data && <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
          </div>
        </div>

        <div className="card space-y-3">
          {!selected ? <p className="text-sm text-slate-500">Select a payment attempt.</p> : (
            <>
              <h2 className="font-medium" data-testid="sim-selected">
                Payment #{selected.payment_id} · order #{selected.order_id} · <Money paise={selected.amount_paise} /> · <StatusBadge status={selected.status} />
              </h2>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => send('ok', { outcome: 'success' })}>Success callback</button>
                <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => send('fail', { outcome: 'failure' })}>Failure callback</button>
                <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => send('dup', { outcome: 'success', deliveries: 3 })}>Success, delivered 3×</button>
                <button type="button" className="btn-secondary" disabled={!!busy}
                  onClick={() => send('wrong', { outcome: 'success', amount_paise: addPaise(selected.amount_paise, '100') })}>
                  Gateway error: callback reports a different amount (+₹1)
                </button>
              </div>
              <p className="text-xs text-slate-500">
                The customer always approves the exact amount, but the message the gateway sends back is outside input: a
                gateway bug, a mixed-up callback or a forged message could carry another amount. The database accepts a
                capture only for the exact order total (otherwise <span className="font-mono">PRP01</span>, nothing posted).
              </p>
              <ErrorBox error={error} />
              <DeliveryResults result={result} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
