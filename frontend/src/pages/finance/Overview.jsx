import { Link } from 'react-router-dom';
import { useApi } from '../../lib/useApi.js';
import { api } from '../../lib/api.js';
import { ErrorBox, Money, Spinner, formatDateTime, StatusBadge } from '../../components/ui.jsx';
export default function Overview() {
 const r = useApi(() => api.get('/finance/overview'), []);
 return <div className="space-y-4"><h1 className="text-xl font-semibold">Finance overview</h1><button className="btn-secondary" onClick={r.reload}>Refresh</button><ErrorBox error={r.error} onRetry={r.reload}/>{r.loading && <Spinner/>}{r.data && <>
 <p>Pending work is current. Settlement exceptions are as of {r.data.as_of} (IST).</p>
 <div className="grid gap-4 sm:grid-cols-2">{['refunds','payouts'].map(k => <Link key={k} to={`/finance/${k}`} className="card"><h2 className="font-semibold">Pending {k}: {r.data[k].items}</h2><Money paise={r.data[k].amount_paise}/><p>Oldest: {formatDateTime(r.data[k].oldest)}</p></Link>)}</div>
 <h2 className="font-semibold">Settlement exceptions</h2>{r.data.categories.filter(c => !['matched','in_transit'].includes(c.category)).map(c => <Link key={c.category} className="card block" to={`/finance/reconciliation?category=${c.category}&as_of=${r.data.as_of}`}><StatusBadge status={c.category}/> · {c.items} records · Expected <Money paise={c.expected_paise}/> · Reported <Money paise={c.settled_gross_paise}/></Link>)}
 <h2 className="font-semibold">Negative vendor balances ({r.data.negative_vendors.length})</h2>{r.data.negative_vendors.map(v => <Link className="card block" key={v.vendor_id} to={`/finance/reports?r=R6&vendor_id=${v.vendor_id}`}>Vendor #{v.vendor_id} · <Money paise={v.balance_paise}/></Link>)}{!r.data.negative_vendors.length && <p>No negative balances.</p>}
 </>}</div>;
}
