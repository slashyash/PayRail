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
// The preview below the input is a browser-side FORMAT check only
// (lib/settlementCsv.js); the backend and the database decide.
// Sample files: samples/settlements/*.csv (bundled through import.meta.glob;
// vite.config.js allows that one folder).
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorBox, Money, Pager, Spinner, StatusBadge, formatDate, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { formatINR } from '../../lib/money.js';
import { HEADER, MAX_BYTES, MAX_ROWS, checkSettlementCsv } from '../../lib/settlementCsv.js';

const PAGE_SIZE = 15;

const SAMPLE_FILES = import.meta.glob('../../../../samples/settlements/*.csv', { query: '?raw', import: 'default', eager: true });
const sampleText = (name) => Object.entries(SAMPLE_FILES).find(([p]) => p.endsWith(`/${name}`))?.[1];
const SAMPLES = [
  { file: '01_normal.csv', title: 'Clean matches', hint: '4 rows that match and post' },
  { file: '02_reupload_duplicate_conflict.csv', title: 'Re-upload', hint: 'a duplicate, a conflict, one new row' },
  { file: '03_exceptions.csv', title: 'Exceptions', hint: 'mismatch, unknown ref, refused, malformed' },
].filter((s) => sampleText(s.file));

const FORMAT = [
  { col: 'gateway_ref', what: 'Gateway reference of the payment or refund', ex: 'pay_S000000365' },
  { col: 'record_type', what: 'payment or refund', ex: 'payment' },
  { col: 'gross_paise', what: 'Gross amount, integer paise', ex: '1678600', inr: '1678600' },
  { col: 'fee_paise', what: 'Gateway fee, integer paise (0 for refunds)', ex: '33572', inr: '33572' },
  { col: 'settled_on', what: 'Settlement date, YYYY-MM-DD (IST), not in the future', ex: '2026-10-31' },
];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ preview (format check)
function Preview({ check }) {
  if (check.headerError) {
    return (
      <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800" data-testid="csv-header-error">
        <p className="font-medium">Header line not recognised</p>
        <p className="mt-0.5">{check.headerError}</p>
      </div>
    );
  }
  const rows = check.rows;
  if (rows.length === 0) return <p className="text-sm text-slate-500">The header is fine; add at least one data row.</p>;
  const bad = rows.filter((r) => r.errors.length).length;
  return (
    <div className="space-y-2" data-testid="csv-preview">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium text-slate-800">{plural(rows.length, 'row')}</span>
        <span className="text-emerald-700">{rows.length - bad} well-formed</span>
        {bad > 0 && <span className="text-rose-700" data-testid="csv-preview-malformed">{bad} malformed — will be reported as invalid</span>}
        {check.tooMany && <span className="text-rose-700">more than {MAX_ROWS} rows — split the file</span>}
      </div>
      <div className="max-h-72 overflow-auto rounded-md border border-slate-200">
        <table className="w-full">
          <thead className="sticky top-0 bg-slate-50">
            <tr>
              <th className="th">Line</th><th className="th">Reference</th><th className="th">Type</th>
              <th className="th num">Gross</th><th className="th num">Fee</th><th className="th">Settled on</th><th className="th">Format</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line} className={`border-t border-slate-100 ${r.errors.length ? 'bg-rose-50/60' : ''}`}>
                <td className="td text-slate-500">{r.line}</td>
                {r.cells ? (
                  <>
                    <td className="td font-mono text-xs">{r.cells.gateway_ref}</td>
                    <td className="td">{r.cells.record_type}</td>
                    <td className="td num">{formatINR(r.cells.gross_paise)}</td>
                    <td className="td num">{formatINR(r.cells.fee_paise)}</td>
                    <td className="td whitespace-nowrap">{formatDate(r.cells.settled_on)}</td>
                    <td className="td"><span className="text-xs font-medium text-emerald-700">✓ ok</span></td>
                  </>
                ) : (
                  <>
                    <td className="td font-mono text-xs">{r.ref ?? '—'}</td>
                    <td className="td" colSpan={5}>
                      <p className="text-xs font-medium text-rose-700">✗ {r.errors.join('; ')}</p>
                      <p className="mt-0.5 break-all font-mono text-xs text-slate-500">{r.raw.join(',')}</p>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        This only checks the format. Matching, duplicates, future dates and fee limits are decided by the database when you import.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ result of an import
function Tile({ label, value, tone, testId, children }) {
  const tones = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    slate: 'border-slate-200 bg-slate-50 text-slate-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-900',
  };
  return (
    <div className={`rounded-lg border p-3 ${tones[tone]}`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums" data-testid={testId}>{value}</p>
      {children && <div className="mt-1 text-xs">{children}</div>}
    </div>
  );
}

function ImportResults({ result }) {
  const s = result.summary;
  const notPosted = Number(s.inserted ?? 0) - Number(s.posted ?? 0);
  return (
    <section className="card space-y-4" data-testid="import-results" aria-label="Import result">
      <h2 className="font-medium">Import result</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Posted to the ledger" value={s.posted} tone="emerald" testId="summary-posted" />
        {Number(s.inserted) > 0 && (
          <Tile label="New rows stored" value={s.inserted} tone={notPosted > 0 ? 'amber' : 'emerald'} testId="summary-inserted">
            {notPosted > 0 && (
              <>{notPosted} not posted · <Link className="font-medium underline" to="/finance/reconciliation">see why</Link></>
            )}
          </Tile>
        )}
        {Number(s.duplicate) > 0 && <Tile label="Duplicates (no change)" value={s.duplicate} tone="slate" testId="summary-duplicate" />}
        {Number(s.conflict) > 0 && <Tile label="Conflicts (original kept)" value={s.conflict} tone="rose" testId="summary-conflict" />}
        {Number(s.rejected) > 0 && <Tile label="Refused by the database" value={s.rejected} tone="rose" testId="summary-rejected" />}
        {Number(s.invalid) > 0 && <Tile label="Malformed rows" value={s.invalid} tone="rose" testId="summary-invalid" />}
      </div>
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="w-full">
          <thead className="bg-slate-50"><tr><th className="th">CSV line</th><th className="th">Reference</th><th className="th">Result</th><th className="th">Details</th></tr></thead>
          <tbody>
            {result.results.map((r) => (
              <tr key={r.line} className="border-t border-slate-100" data-testid="import-row" data-result={r.result} data-ref={r.gateway_ref ?? ''}>
                <td className="td">{r.line}</td>
                <td className="td font-mono text-xs">{r.gateway_ref ?? '—'}</td>
                <td className="td"><StatusBadge status={r.result} /></td>
                <td className="td text-xs">
                  {r.result === 'inserted' && (r.posted_entry_id
                    ? <>stored as settlement #{r.settlement_id}; matched and posted as entry{' '}
                        <Link className="underline" to={`/finance/trace/entry/${r.posted_entry_id}`}>#{r.posted_entry_id}</Link></>
                    : <>stored as settlement #{r.settlement_id}; <strong>not posted</strong> (no exact match yet —{' '}
                        <Link className="underline" to={`/finance/reconciliation?ref=${r.gateway_ref}`}>see Reconciliation</Link>)</>)}
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
    </section>
  );
}

// ------------------------------------------------------------------ page
export default function Settlements() {
  const [mode, setMode] = useState('upload');          // 'upload' | 'paste'
  const [text, setText] = useState('');
  const [source, setSource] = useState(null);          // { name, sample?, edited? } when text came from a file/sample
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [tick, setTick] = useState(0);
  const list = useApi(() => api.get('/finance/settlements', { page, page_size: PAGE_SIZE }), [page, tick]);
  const check = useMemo(() => checkSettlementCsv(text), [text]);

  async function readFile(f) {
    setError(null);
    if (!f) return;
    if (f.size > MAX_BYTES) { setError(new Error(`${f.name} is ${Math.ceil(f.size / 1024)} KB; the limit is 256 KB.`)); return; }
    setText(await f.text());
    setSource({ name: f.name });
  }
  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    readFile(e.dataTransfer.files?.[0]);
  }
  function loadSample(file) {
    setError(null);
    setText(sampleText(file));
    setSource({ name: file, sample: true });
  }
  function clear() {
    setText('');
    setSource(null);
    setResult(null);
    setError(null);
  }

  const rowCount = check.rows.length;
  let blocked = null;
  if (!text.trim()) blocked = mode === 'upload' ? 'Choose a CSV file or load a sample to continue.' : 'Paste CSV rows to continue.';
  else if (check.headerError) blocked = 'Fix the header line first.';
  else if (rowCount === 0) blocked = 'The file has no data rows.';
  else if (check.tooMany) blocked = `At most ${MAX_ROWS} rows per import.`;

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
      setTick((t) => t + 1); // refresh stored rows even if the import response was lost
    } finally {
      setBusy(false);
    }
  }

  const tab = (id, label) => (
    <button type="button" role="tab" id={`tab-${id}`} aria-selected={mode === id} aria-controls={`panel-${id}`}
      onClick={() => setMode(id)}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${mode === id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
      {label}
    </button>
  );

  return (
    <div className="space-y-6">
      <header className="max-w-3xl space-y-2">
        <h1 className="text-xl font-semibold">Settlement import</h1>
        <p className="text-sm text-slate-600">
          Upload the simulated gateway's settlement report. Rows that match a captured payment or processed refund are posted
          to the ledger; everything else is saved for{' '}
          <Link className="text-indigo-700 underline" to="/finance/reconciliation">reconciliation</Link>.
          Importing the same file again changes nothing.
        </p>
        <details className="group text-sm text-slate-600">
          <summary className="cursor-pointer select-none font-medium text-indigo-700 hover:text-indigo-800">What gets posted?</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li><strong>Payment row</strong> that exactly matches a captured payment: debit Bank (gross − fee) and Gateway fee expense (fee), credit Gateway clearing (gross).</li>
            <li><strong>Refund row</strong> that exactly matches a processed refund: debit Gateway clearing, credit Bank.</li>
            <li><strong>Anything else</strong> (amount mismatch, unknown reference) is stored as received with no ledger entry. If its payment appears later, the next reconciliation run posts it once.</li>
          </ul>
        </details>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-5">
        {/* ---------------- input */}
        <section className="card space-y-4 lg:col-span-3" aria-label="Settlement file">
          <div role="tablist" aria-label="How to provide the CSV" className="inline-flex rounded-lg bg-slate-100 p-1">
            {tab('upload', 'Upload file')}
            {tab('paste', 'Paste CSV')}
          </div>

          {mode === 'upload' ? (
            <div id="panel-upload" role="tabpanel" aria-labelledby="tab-upload" className="space-y-3">
              <input id="csv-file" type="file" accept=".csv,text/csv" className="peer sr-only"
                onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
              <label htmlFor="csv-file"
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={`flex cursor-pointer flex-col [&>*]:pointer-events-none items-center justify-center gap-1 rounded-lg border-2 border-dashed px-6 text-center ${source && text ? 'py-4' : 'py-8'} transition peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 ${dragging ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-slate-50 hover:border-indigo-400 hover:bg-indigo-50/40'}`}>
                <svg aria-hidden="true" viewBox="0 0 24 24" className={`mb-1 text-slate-400 ${source && text ? 'hidden' : 'h-8 w-8'}`} fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
                <span className="text-sm text-slate-700">{source && text ? 'Drop another CSV or' : 'Drop a CSV here or'} <span className="font-medium text-indigo-700 underline">browse</span></span>
                <span className="text-xs text-slate-500">Up to 256 KB and {MAX_ROWS} rows</span>
              </label>
            </div>
          ) : (
            <div id="panel-paste" role="tabpanel" aria-labelledby="tab-paste" className="space-y-1">
              <label className="label" htmlFor="csv-text">CSV text — paste or edit (first line is the header)</label>
              <textarea id="csv-text" rows={7} className="input font-mono text-xs leading-relaxed" spellCheck={false}
                placeholder="Paste CSV rows here, starting with the header line…"
                value={text}
                onChange={(e) => { const v = e.target.value; setText(v); if (!v) setSource(null); else if (source) setSource({ ...source, edited: true }); }} />
              {!text && (
                <button type="button" className="text-xs font-medium text-indigo-700 underline"
                  onClick={() => setText(`${HEADER}\n`)}>
                  Start with the header line
                </button>
              )}
            </div>
          )}

          {source && text && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm" data-testid="csv-source">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5" />
              </svg>
              <span className="font-mono text-xs">{source.name}</span>
              {source.sample && <span className="rounded bg-indigo-100 px-1.5 text-xs text-indigo-800">sample</span>}
              {source.edited && <span className="text-xs text-slate-500">(edited)</span>}
              <span className="text-xs text-slate-500">· {plural(rowCount, 'row')}</span>
              <button type="button" className="ml-auto text-xs font-medium text-slate-600 underline hover:text-slate-900" onClick={clear}>Remove</button>
            </div>
          )}

          {text.trim() && <Preview check={check} />}

          <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
            <button type="button" className="btn-primary px-4" disabled={busy || !!blocked} onClick={upload}>
              {busy ? 'Importing…' : rowCount > 0 && !blocked ? `Import ${plural(rowCount, 'row')}` : 'Import'}
            </button>
            {text && !source && <button type="button" className="btn-secondary" onClick={clear}>Clear</button>}
            {blocked && !busy && <span className="text-xs text-slate-500" data-testid="import-blocked">{blocked}</span>}
          </div>
          <ErrorBox error={error} title="Import refused" />
        </section>

        {/* ---------------- help */}
        <aside className="space-y-4 lg:col-span-2">
          <section className="card space-y-3" aria-labelledby="fmt-title">
            <h2 id="fmt-title" className="font-medium">File format</h2>
            <p className="text-xs text-slate-500">First line exactly as below, then one row per settlement. No quoted fields.</p>
            <code className="block rounded bg-slate-100 px-2 py-1.5 font-mono text-xs text-slate-800">
              {HEADER.split(',').map((c, i) => <span key={c}>{i > 0 && <>,<wbr /></>}{c}</span>)}
            </code>
            <dl className="divide-y divide-slate-100 text-sm">
              {FORMAT.map((f) => (
                <div key={f.col} className="py-1.5">
                  <dt className="font-mono text-xs font-medium text-slate-800">{f.col}</dt>
                  <dd className="text-xs text-slate-600">
                    {f.what} · e.g. <span className="whitespace-nowrap font-mono">{f.ex}</span>
                    {f.inr && <span className="text-slate-500"> = {formatINR(f.inr)}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {SAMPLES.length > 0 && (
            <section className="card space-y-3" aria-labelledby="samples-title">
              <div>
                <h2 id="samples-title" className="font-medium">Sample files</h2>
                <p className="text-xs text-slate-500">For a freshly seeded database. Use them in this order, then open Reconciliation (as of 31 Oct 2026).</p>
              </div>
              <div className="space-y-2">
                {SAMPLES.map((s, i) => (
                  <button key={s.file} type="button" onClick={() => loadSample(s.file)}
                    aria-label={`Load sample ${i + 1}: ${s.title}`}
                    className={`flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition hover:border-indigo-400 hover:bg-indigo-50/40 ${source?.name === s.file && !source.edited ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200'}`}>
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">{i + 1}</span>
                    <span>
                      <span className="block text-sm font-medium text-slate-800">{s.title}</span>
                      <span className="block text-xs text-slate-500">{s.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>

      {result && <ImportResults result={result} />}

      <section className="space-y-3" aria-labelledby="stored-title">
        <h2 id="stored-title" className="font-medium">Imported settlement rows</h2>
        <ErrorBox error={list.error} title="Could not load settlements" onRetry={list.reload} />
        {list.loading && !list.data && <Spinner />}
        {list.data && (list.data.items.length === 0 ? <Empty title="No settlement rows yet" /> : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full">
              <thead className="bg-slate-50"><tr>
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
      </section>
    </div>
  );
}
