// My orders: GET /api/orders (v_order_summary — status DERIVED from payments
// and refunds, never stored). Filter by status, paged.
import { Link, useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, Money, Pager, Spinner, StatusBadge, formatDateTime } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

const PAGE_SIZE = 15;
const STATUSES = ['pending_payment', 'paid', 'partially_refunded', 'refunded'];

export default function Orders() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
  const orders = useApi(() => api.get('/orders', { status: status || undefined, page, page_size: PAGE_SIZE }), [status, page]);

  function update(changes) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) if (v) next.set(k, v); else next.delete(k);
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">My orders</h1>
        <div>
          <label className="label" htmlFor="status">Status</label>
          <select id="status" className="input" value={status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
      </div>
      <ErrorBox error={orders.error} title="Could not load orders" onRetry={orders.reload} />
      {orders.loading && <Spinner label="Loading orders…" />}
      {!orders.loading && orders.data && (orders.data.items.length === 0 ? (
        <Empty title={status ? 'No orders with this status' : 'No orders yet'}>
          <Link className="text-indigo-700 underline" to="/shop">Go shopping</Link>
        </Empty>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr><th className="th">Order</th><th className="th">Placed</th><th className="th num">Lines</th><th className="th num">Total</th><th className="th num">Refunded</th><th className="th">Status</th><th className="th" /></tr></thead>
            <tbody>
              {orders.data.items.map((o) => (
                <tr key={o.order_id} className="border-t border-slate-100" data-testid="order-row">
                  <td className="td"><Link className="text-indigo-700 underline" to={`/orders/${o.order_id}`}>#{o.order_id}</Link></td>
                  <td className="td">{formatDateTime(o.created_at)}</td>
                  <td className="td num">{o.line_count}</td>
                  <td className="td num"><Money paise={o.total_paise} /></td>
                  <td className="td num"><Money paise={o.refunded_paise} /></td>
                  <td className="td"><StatusBadge status={o.status} /></td>
                  <td className="td text-right">
                    {o.status === 'pending_payment' && <Link className="btn-secondary" to={`/orders/${o.order_id}/pay`}>Pay</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {orders.data && <Pager page={page} pageSize={PAGE_SIZE} total={orders.data.total} onPage={(n) => update({ page: String(n) })} />}
    </div>
  );
}
