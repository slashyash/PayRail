// Settlement report import (W4 step 1).
//   POST /api/finance/settlements/import   Content-Type: text/csv
//     header (exact): gateway_ref,record_type,gross_paise,fee_paise,settled_on
//   GET  /api/finance/settlements?settled_on&page
// The backend parses the CSV with a bounded, strict parser (≤ 1000 rows,
// ≤ 256 KB, no quoting) and validates every row on its own; the import runs in
// ONE transaction with a SAVEPOINT per row, so a row the database refuses
// (future date, fee ≥ gross, …) is reported and skipped while the rest is kept.
// Per-row results:
//   inserted  — stored; posted to the ledger only if it matched exactly
//   duplicate — same reference with identical values already imported (re-upload is harmless)
//   conflict  — same reference with DIFFERENT values; the original row is kept
//   rejected  — the database refused the row (SQLSTATE shown)
//   invalid   — the row failed format validation before reaching the database
// Sample files: samples/settlements/*.csv
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorBox, Money, Notice, Pager, Spinner, StatusBadge, formatDate, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';

const PAGE_SIZE = 15;
const MAX_BYTES = 256 * 1024;
const HEADER = 'gateway_ref,record_type,gross_paise,fee_paise,settled_on';

function ImportResults({ result }) {
  const order = ['inserted', 'duplicate', 'conflict', 'rejected', 'invalid'];
  return (
    <div className="card space-y-3" data-testid="import-results">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Import result:</span>
        {order.filter((k) => result.summary[k]).map((k) => (
          <span key={k} data-testid={`summary-${k}`}><StatusBadge status={k} /> {result.summary[k]}</span>
        ))}
        <span data-testid="summary-posted">· posted to the ledger: <strong>{result.summary.posted}</strong></span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead><tr><th className="th">CSV line</th><th className="th">Reference</th><th className="th">Result</th><th className="th">Details</th></tr></thead>
          <tbody>
            {result.results.map((r) => (
              <tr key={r.line} className="border-t border-slate-100" data-testid="import-row" data-result={r.result} data-ref={r.gateway_ref ?? ''}>
                <td className="td">{r.line}</td>
                <td className="td font-mono text-xs">{r.gateway_ref ?? '—'}</td>
                <td className="td"><StatusBadge status={r.result} /></td>
                <td className="td text-xs">
                  {r.result === 'inserted' && (r.posted_entry_id
                    ? <>stored as settlement #{r.settlement_id}; matched and posted as entry #{r.posted_entry_id}</>
                    : <>stored as settlement #{r.settlement_id}; <strong>not posted</strong> (no exact match yet — see Reconciliation)</>)}
                  {r.result === 'duplicate' && <>already imported with identical values (settlement #{r.settlement_id}); nothing changed</>}
                  {r.result === 'conflict' && <>reference already imported with different values (settlement #{r.settlement_id}); original kept, row refused</>}
                  {r.result === 'rejected' && <>{r.error?.message} <span className="font-mono">{r.error?.sqlstate}</span></>}
                  {r.result === 'invalid' && r.errors?.join('; ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Settlements() {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [tick, setTick] = useState(0);
  const list = useApi(() => api.get('/finance/settlements', { page, page_size: PAGE_SIZE }), [page, tick]);

  async function pickFile(e) {
    const f = e.target.files?.[0];
    setError(null);
    if (!f) return;
    if (f.size > MAX_BYTES) { setError(new Error(`File is ${f.size} bytes; the limit is ${MAX_BYTES}.`)); return; }
    setFileName(f.name);
    setText(await f.text());
  }

  async function upload() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.postText('/finance/settlements/import', text, 'text/csv'));
      setPage(1);
      setTick((t) => t + 1);
    } catch (err) {
      setError(err);
      setTick(t => t + 1); // refresh stored rows even if the import response was lost
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Settlement import</h1>
        <p className="text-sm text-slate-600">
          Upload the simulated gateway's settlement report. Rows that exactly match a captured payment or processed refund are
          posted (bank + fee expense / gateway clearing); everything else is stored as received for{' '}
          <Link className="text-indigo-700 underline" to="/finance/reconciliation">reconciliation</Link>. Re-uploading a file is harmless.
        </p>
      </div>

      <div className="card space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="csv-file">CSV file (≤ 256 KB, ≤ 1000 rows)</label>
            <input id="csv-file" type="file" accept=".csv,text/csv" className="text-sm" onChange={pickFile} />
          </div>
          {fileName && <span className="text-xs text-slate-500">loaded {fileName}</span>}
        </div>
        <div>
          <label className="label" htmlFor="csv-text">…or paste / edit the CSV</label>
          <textarea id="csv-text" className="input h-40 font-mono text-xs" spellCheck={false} placeholder={`${HEADER}\npay_S000000365,payment,1678600,33572,2026-10-31`}
            value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-primary" disabled={busy || !text.trim()} onClick={upload}>{busy ? 'Importing…' : 'Import'}</button>
          {text && <button type="button" className="btn-secondary" onClick={() => { setText(''); setFileName(''); setResult(null); }}>Clear</button>}
        </div>
        <p className="text-xs text-slate-500">
          Header must be exactly <span className="font-mono">{HEADER}</span>. Amounts are integer paise; dates are
          YYYY-MM-DD (IST) and may not be in the future. Refund rows carry fee 0.
        </p>
        <ErrorBox error={error} title="Import refused" />
      </div>

      {result && <ImportResults result={result} />}
      {result && result.summary.inserted > result.summary.posted && (
        <Notice tone="warn">Some rows were stored but not posted. Open Reconciliation to see why (amount mismatch or unknown reference).</Notice>
      )}

      <h2 className="font-medium">Imported settlement rows</h2>
      <ErrorBox error={list.error} title="Could not load settlements" onRetry={list.reload} />
      {list.loading && !list.data && <Spinner />}
      {list.data && (list.data.items.length === 0 ? <Empty title="No settlement rows yet" /> : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr>
              <th className="th">Id</th><th className="th">Reference</th><th className="th">Type</th><th className="th num">Gross</th>
              <th className="th num">Fee</th><th className="th">Settled on</th><th className="th">Imported</th><th className="th">Posted entry</th>
            </tr></thead>
            <tbody>
              {list.data.items.map((s) => (
                <tr key={s.settlement_id} className="border-t border-slate-100">
                  <td className="td">#{s.settlement_id}</td>
                  <td className="td font-mono text-xs"><Link className="underline" to={`/finance/reconciliation?ref=${s.gateway_ref}&as_of=${s.settled_on}`}>{s.gateway_ref}</Link></td>
                  <td className="td">{s.record_type}</td>
                  <td className="td num"><Money paise={s.gross_paise} /></td>
                  <td className="td num"><Money paise={s.fee_paise} /></td>
                  <td className="td">{formatDate(s.settled_on)}</td>
                  <td className="td whitespace-nowrap">{formatDateTime(s.imported_at)}</td>
                  <td className="td">{s.posted_entry_id ? <Link className="underline" to={`/finance/trace/entry/${s.posted_entry_id}`}>#{s.posted_entry_id}</Link> : <span className="text-amber-700">not posted</span>}</td>
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
