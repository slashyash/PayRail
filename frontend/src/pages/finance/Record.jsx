import { Link, useParams, useLocation } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { Money, ErrorBox, Spinner, StatusBadge, formatDateTime } from '../../components/ui.jsx';
import LedgerEntries from './LedgerEntries.jsx';
export default function Record() {
 const {id} = useParams(); const location = useLocation(); const payout = location.pathname.includes('/payouts/');
 const r = useApi(() => api.get(`/finance/${payout ? 'payouts' : 'orders'}/${id}`), [id,payout]);
 return <div className="space-y-4"><Link className="underline" to={payout ? '/finance/payouts' : '/finance/refunds'}>Back to queue</Link><h1 className="text-xl font-semibold">{payout ? 'Payout' : 'Order'} #{id}</h1><button className="btn-secondary" onClick={r.reload}>Refresh record</button><ErrorBox error={r.error}/>{r.loading && <Spinner/>}{r.data && <><StatusBadge status={r.data.status}/><Money paise={r.data.amount_paise ?? r.data.total_paise}/>{payout && <p>Bank reference: {r.data.bank_utr ?? 'Not recorded'}</p>}{!payout && ['payments','refunds'].map(kind => <section className="card" key={kind}><h2 className="font-semibold">{kind}</h2>{r.data[kind].map(x => <div className="border-t py-3" key={x.payment_id ?? x.refund_id}><Link className="underline" to={`/finance/trace/${kind === 'payments' ? 'payment' : 'refund'}/${x.payment_id ?? x.refund_id}`}>#{x.payment_id ?? x.refund_id}</Link> · <StatusBadge status={x.status}/> · <Money paise={x.amount_paise}/><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{formatDateTime(x.created_at ?? x.requested_at)} {x.reason}</p>{x.gateway_ref && <Link className="underline" to={`/finance/reconciliation?ref=${x.gateway_ref}`}>Settlement for {x.gateway_ref}</Link>}</div>)}</section>)}<LedgerEntries query={payout ? {payout_id:id} : {order_id:id}} reloadToken={r.data}/></>}</div>;
}
