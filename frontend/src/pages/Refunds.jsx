// My refunds: GET /api/refunds (the caller's refund requests across orders).
import { Link, useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, Money, Pager, Spinner, StatusBadge, formatDateTime } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

const PAGE_SIZE = 15;

export default function Refunds() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
  const refunds = useApi(() => api.get('/refunds', { status: status || undefined, page, page_size: PAGE_SIZE }), [status, page]);

  function update(changes) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) if (v) next.set(k, v); else next.delete(k);
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">My refunds</h1>
        <div>
          <label className="label" htmlFor="rstatus">Status</label>
          <select id="rstatus" className="input" value={status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">All</option>
            <option value="requested">requested</option>
            <option value="processed">processed</option>
            <option value="rejected">rejected</option>
          </select>
        </div>
      </div>
      <ErrorBox error={refunds.error} title="Could not load refunds" onRetry={refunds.reload} />
      {refunds.loading && <Spinner label="Loading refunds…" />}
      {!refunds.loading && refunds.data && (refunds.data.items.length === 0 ? (
        <Empty title="No refund requests">Refunds are requested per order line from an order's detail page.</Empty>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr><th className="th">Refund</th><th className="th">Order / line</th><th className="th">Product</th><th className="th num">Amount</th><th className="th">Reason</th><th className="th">Status</th><th className="th">Requested</th><th className="th">Processed</th></tr></thead>
            <tbody>
              {refunds.data.items.map((r) => (
                <tr key={r.refund_id} className="border-t border-slate-100">
                  <td className="td">#{r.refund_id}</td>
                  <td className="td"><Link className="text-indigo-700 underline" to={`/orders/${r.order_id}`}>#{r.order_id}</Link> / {r.line_no}</td>
                  <td className="td">{r.product_name}</td>
                  <td className="td num"><Money paise={r.amount_paise} /></td>
                  <td className="td max-w-xs truncate" title={r.reason}>{r.reason}</td>
                  <td className="td"><StatusBadge status={r.status} /></td>
                  <td className="td">{formatDateTime(r.requested_at)}</td>
                  <td className="td">{formatDateTime(r.processed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {refunds.data && <Pager page={page} pageSize={PAGE_SIZE} total={refunds.data.total} onPage={(n) => update({ page: String(n) })} />}
    </div>
  );
}
