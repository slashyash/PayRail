// Finance refund queue (W3 step 2).
//   GET  /api/finance/refunds?status&vendor_id&page
//   POST /api/finance/refunds/:id/approve  → fn_approve_refund: processed + balanced refund entry
//   POST /api/finance/refunds/:id/reject   → fn_reject_refund: rejected, reservation released, nothing posted
// Approval reverses the line's vendor / commission / GST split cumulatively from
// the purchase-time snapshots (DEC-005) and may push the vendor balance negative
// (a late refund). A decided refund is final: a second, different decision is
// refused (PRS01); repeating the same decision returns the same row.
import { useState } from 'react';
import { Empty, ErrorBox, Money, Notice, Pager, Spinner, StatusBadge, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import LedgerEntries from './LedgerEntries.jsx';

const PAGE_SIZE = 15;

export default function FinanceRefunds() {
  const [status, setStatus] = useState('requested');
  const [vendorId, setVendorId] = useState('');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);             // { refund, action }
  const vendors = useApi(() => api.get('/finance/vendors'), []);
  const list = useApi(
    () => api.get('/finance/refunds', { status: status || undefined, vendor_id: vendorId || undefined, page, page_size: PAGE_SIZE }),
    [status, vendorId, page],
  );

  async function decide(r, action) {
    setBusyId(r.refund_id);
    setError(null);
    try {
      const refund = await api.post(`/finance/refunds/${r.refund_id}/${action}`);
      setLast({ refund, action, before: r });
      list.reload();
    } catch (err) {
      setError({ err, refundId: r.refund_id });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Refund requests</h1>
          <p className="text-sm text-slate-600">Approve to refund through the gateway and post the reversal; reject to release the reserved amount.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="fr-status">Status</label>
            <select id="fr-status" className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All</option><option value="requested">requested</option>
              <option value="processed">processed</option><option value="rejected">rejected</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="fr-vendor">Vendor</label>
            <select id="fr-vendor" className="input" value={vendorId} onChange={(e) => { setVendorId(e.target.value); setPage(1); }}>
              <option value="">All vendors</option>
              {vendors.data?.items.map((v) => <option key={v.vendor_id} value={v.vendor_id}>{v.legal_name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {last && (
        <div className="space-y-2" data-testid="refund-decision">
          <Notice tone={last.refund.status === 'processed' ? 'success' : 'info'}>
            Refund #{last.refund.refund_id} (<Money paise={last.refund.amount_paise} />) is now <StatusBadge status={last.refund.status} />
            {last.refund.gateway_ref && <> — gateway refund <span className="font-mono">{last.refund.gateway_ref}</span></>}.
            {last.refund.status === 'rejected' && ' The reserved amount is refundable again; nothing was posted.'}
          </Notice>
          {last.refund.status === 'processed' && (
            <LedgerEntries query={{ refund_id: last.refund.refund_id }} title={`Ledger entry for refund #${last.refund.refund_id}`} />
          )}
        </div>
      )}
      {error && <ErrorBox error={error.err} title={`Refund #${error.refundId} not changed`} />}
      <ErrorBox error={list.error} title="Could not load refunds" onRetry={list.reload} />
      {list.loading && !list.data && <Spinner label="Loading refunds…" />}
      {list.data && (list.data.items.length === 0 ? <Empty title="No refunds match" /> : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr>
              <th className="th">Refund</th><th className="th">Order / line</th><th className="th">Customer</th><th className="th">Vendor · product</th>
              <th className="th num">Amount</th><th className="th num">Line total</th><th className="th">Reason</th><th className="th">Status</th>
              <th className="th">Requested</th><th className="th">Decision</th>
            </tr></thead>
            <tbody>
              {list.data.items.map((r) => (
                <tr key={r.refund_id} className="border-t border-slate-100" data-testid="finance-refund-row" data-refund-id={r.refund_id}>
                  <td className="td">#{r.refund_id}</td>
                  <td className="td">#{r.order_id} / {r.line_no}</td>
                  <td className="td">{r.customer_name}</td>
                  <td className="td">{r.vendor_name}<div className="text-xs text-slate-500">{r.product_name}</div></td>
                  <td className="td num"><Money paise={r.amount_paise} /></td>
                  <td className="td num">
                    <Money paise={r.line_total_paise} />
                    <div className="text-xs text-slate-500">refunded <Money paise={r.line_refunded_paise} /></div>
                  </td>
                  <td className="td max-w-[12rem] truncate" title={r.reason}>{r.reason}</td>
                  <td className="td"><StatusBadge status={r.status} /></td>
                  <td className="td whitespace-nowrap">{formatDateTime(r.requested_at)}</td>
                  <td className="td">
                    {r.status === 'requested' ? (
                      <div className="flex gap-1">
                        <button type="button" className="btn-primary" disabled={busyId === r.refund_id} onClick={() => decide(r, 'approve')}>Approve</button>
                        <button type="button" className="btn-secondary" disabled={busyId === r.refund_id} onClick={() => decide(r, 'reject')}>Reject</button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-500">{formatDateTime(r.processed_at)}</span>
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
