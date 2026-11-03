import { Link, useParams } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { ErrorBox, Money, Spinner, StatusBadge } from '../../components/ui.jsx';
import LedgerEntries from './LedgerEntries.jsx';
export default function Trace() {
 const {kind,id} = useParams(); const [copied,setCopied] = useState('');
 const r = useApi(() => api.get(`/finance/trace/${kind}/${id}`), [kind,id]);
 const x = r.data;
 return <div className="space-y-4"><h1 className="text-xl font-semibold">{kind} #{id}</h1><ErrorBox error={r.error} onRetry={r.reload}/>{r.loading && <Spinner/>}{x && <><StatusBadge status={x.status ?? x.entry_type}/>{x.amount_paise && <Money paise={x.amount_paise}/>}<p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{x.description ?? x.reason}</p>{x.gateway_ref && <p>{x.gateway_ref} <button className="btn-secondary" onClick={async () => {try {await navigator.clipboard.writeText(x.gateway_ref);setCopied('Copied');} catch {setCopied('Copy unavailable; select the reference text.');}}}>Copy reference</button> <span role="status">{copied}</span> <Link className="underline" to={`/finance/reconciliation?ref=${x.gateway_ref}`}>Find settlement</Link></p>}{['order','payment','refund','payout'].map(k => x[`${k}_id`] && <Link className="block underline" key={k} to={k === 'order' || k === 'payout' ? `/finance/${k}s/${x[`${k}_id`]}` : `/finance/trace/${k}/${x[`${k}_id`]}`}>{k} #{x[`${k}_id`]}</Link>)}<LedgerEntries query={{[`${kind}_id`]:id}}/></>}</div>;
}
