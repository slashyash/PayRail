// Vendor payouts (W2 step 1) — request + history.
//   POST /api/vendor/payouts { amount_paise } + Idempotency-Key
//   GET  /api/vendor/payouts?status&page
// The request never carries a balance. fn_request_payout locks the vendor's
// payable account, reads the ledger balance and refuses an overspend (PRF01),
// an unverified vendor (PRV03) or a reused key with a different amount (PRI01).
// One key per logical request: retrying the same amount after a network error
// reuses it, so a lost response can never create a second payout.
import { useState } from 'react';
import { Empty, ErrorBox, Money, Notice, Pager, Spinner, Stat, StatusBadge, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useIdempotencyKey } from '../../lib/idempotency.js';
import { cmpPaise, formatINR, paiseToInput, parseRupees } from '../../lib/money.js';
import { useApi } from '../../lib/useApi.js';

const PAGE_SIZE = 15;
// a refusal from the database is final for this payload → the next attempt is a new action
const FINAL = new Set([409, 422]);

function RequestForm({ me, onDone }) {
  const [amount, setAmount] = useState('');
  const [bypass, setBypass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);          // { payout, key, payload }
  const [replay, setReplay] = useState(null);
  const idem = useIdempotencyKey('payrail.payoutkey');

  const paise = parseRupees(amount);
  const formatOk = paise !== null && paise !== '0';
  let problem = null;
  if (!formatOk) problem = amount ? 'Enter a positive rupee amount with at most 2 decimals.' : null;
  else if (me.kyc_status !== 'verified') problem = `This vendor is not KYC-verified (${me.kyc_status}).`;
  else if (cmpPaise(paise, me.balance_paise) > 0) problem = `More than the available ${formatINR(me.balance_paise)}.`;
  const canSend = !busy && formatOk && (problem === null || bypass);

  async function submit(e) {
    e.preventDefault();
    if (!canSend) return;
    setBusy(true);
    setError(null);
    setReplay(null);
    const payload = { amount_paise: paise };
    const key = idem.keyFor(payload.amount_paise);           // same amount → same key (a retry)
    try {
      const payout = await api.post('/vendor/payouts', payload, { idempotencyKey: key });
      setDone({ payout, key, payload });
      idem.reset();                                          // the next payout is a new logical action
      setAmount('');
      setBypass(false);
      onDone();
    } catch (err) {
      setError(err);
      if (FINAL.has(err.status)) idem.reset();               // refused: a corrected request gets a new key
    } finally {
      setBusy(false);
    }
  }

  async function resendSame() {
    setBusy(true);
    try {
      setReplay(await api.post('/vendor/payouts', done.payload, { idempotencyKey: done.key }));
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <h2 className="font-medium">Request a payout to your registered bank account</h2>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2" data-testid="payout-form">
        <div>
          <label className="label" htmlFor="po-amount">Amount (₹)</label>
          <input id="po-amount" className="input w-44" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        {cmpPaise(me.balance_paise, '0') > 0 && (
          <button type="button" className="btn-secondary" onClick={() => setAmount(paiseToInput(me.balance_paise))}>Whole balance</button>
        )}
        <button type="submit" className="btn-primary" disabled={!canSend}>{busy ? 'Sending…' : 'Request payout'}</button>
      </form>
      {problem && <p className="text-sm text-amber-700">{problem}</p>}
      {problem && formatOk && (
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} />
          Demo: skip the browser check and let the database decide
        </label>
      )}
      <ErrorBox error={error} title="Payout not requested" />
      {done && (
        <div className="space-y-2" data-testid="payout-done">
          <Notice tone="success">
            Payout #{done.payout.payout_id} for <Money paise={done.payout.amount_paise} /> requested — status{' '}
            <StatusBadge status={done.payout.status} />. The amount has been deducted from your available balance; finance
            completes the bank transfer.
          </Notice>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" className="btn-secondary" disabled={busy} onClick={resendSame}>Send the same request again (same key)</button>
            {replay && (
              <span data-testid="payout-replay">
                {replay.payout_id === done.payout.payout_id
                  ? `Server returned payout #${replay.payout_id} again — no second payout was created.`
                  : `Server created ANOTHER payout #${replay.payout_id} — the retry was not idempotent!`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function VendorPayouts() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const me = useApi(() => api.get('/vendor/me'), []);
  const list = useApi(() => api.get('/vendor/payouts', { status: status || undefined, page, page_size: PAGE_SIZE }), [status, page]);
  const refresh = () => { me.reload(); list.reload(); };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Payouts</h1>
      <ErrorBox error={me.error} title="Could not load your balance" onRetry={me.reload} />
      {me.loading && !me.data && <Spinner />}
      {me.data && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Available balance (from the ledger)" testId="payout-balance">
              <Money paise={me.data.balance_paise} className={cmpPaise(me.data.balance_paise, '0') < 0 ? 'text-rose-700' : ''} />
            </Stat>
            <Stat label="Requested, awaiting the bank"><Money paise={me.data.payouts_in_flight_paise} /></Stat>
            <Stat label="KYC"><StatusBadge status={me.data.kyc_status} /></Stat>
          </div>
          <RequestForm me={me.data} onDone={refresh} />
        </>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-medium">History</h2>
        <div>
          <label className="label" htmlFor="po-status">Status</label>
          <select id="po-status" className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option><option value="requested">requested</option>
            <option value="paid">paid</option><option value="failed">failed</option>
          </select>
        </div>
      </div>
      <ErrorBox error={list.error} title="Could not load payouts" onRetry={list.reload} />
      {list.loading && !list.data && <Spinner label="Loading payouts…" />}
      {list.data && (list.data.items.length === 0 ? <Empty title="No payouts" /> : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr>
              <th className="th">Payout</th><th className="th num">Amount</th><th className="th">Status</th>
              <th className="th">Bank UTR</th><th className="th">Requested</th><th className="th">Completed</th>
            </tr></thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.payout_id} className="border-t border-slate-100" data-testid="vendor-payout-row" data-payout-id={p.payout_id}>
                  <td className="td">#{p.payout_id}</td>
                  <td className="td num"><Money paise={p.amount_paise} /></td>
                  <td className="td"><StatusBadge status={p.status} /></td>
                  <td className="td font-mono text-xs">{p.bank_utr ?? '—'}</td>
                  <td className="td">{formatDateTime(p.requested_at)}</td>
                  <td className="td">{formatDateTime(p.completed_at)}</td>
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
