// Small shared UI pieces: loading, empty and error states, status badges, pager.
import { formatINR } from '../lib/money.js';

export function Spinner({ label = 'Loading…' }) {
  return (
    <div role="status" className="flex items-center gap-2 py-6 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
      {label}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {children && <div className="mt-2 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

/** Shows an ApiError (or any Error) with the backend's code / SQLSTATE and field details. */
export function ErrorBox({ error, onRetry, title }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{title ?? 'Request failed'}: {error.message}</p>
          {(error.code || error.sqlstate) && (
            <p className="mt-0.5 font-mono text-xs text-rose-700">
              {error.status ? `HTTP ${error.status} · ` : ''}{error.code}{error.sqlstate ? ` · SQLSTATE ${error.sqlstate}` : ''}
            </p>
          )}
          {Array.isArray(error.details) && error.details.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {error.details.map((d, i) => <li key={i}><span className="font-mono">{d.path}</span>: {d.message}</li>)}
            </ul>
          )}
        </div>
        {onRetry && <button type="button" className="btn-secondary" onClick={onRetry}>Retry</button>}
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', children }) {
  const tones = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
  };
  return <div role="status" className={`rounded-md border p-3 text-sm ${tones[tone]}`}>{children}</div>;
}

const BADGE = {
  pending_payment: 'bg-amber-100 text-amber-800',
  paid: 'bg-emerald-100 text-emerald-800',
  partially_refunded: 'bg-sky-100 text-sky-800',
  refunded: 'bg-slate-200 text-slate-700',
  initiated: 'bg-amber-100 text-amber-800',
  captured: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800',
  requested: 'bg-amber-100 text-amber-800',
  processed: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-rose-100 text-rose-800',
  // vendors / products (T5)
  verified: 'bg-emerald-100 text-emerald-800',
  pending: 'bg-amber-100 text-amber-800',
  active: 'bg-emerald-100 text-emerald-800',
  archived: 'bg-slate-200 text-slate-700',
  // settlement import results and reconciliation categories (T5, DEC-009/029)
  inserted: 'bg-emerald-100 text-emerald-800',
  duplicate: 'bg-slate-200 text-slate-700',
  conflict: 'bg-rose-100 text-rose-800',
  invalid: 'bg-rose-100 text-rose-800',
  matched: 'bg-emerald-100 text-emerald-800',
  amount_mismatch: 'bg-rose-100 text-rose-800',
  unknown_reference: 'bg-violet-100 text-violet-800',
  in_transit: 'bg-sky-100 text-sky-800',
  overdue_missing: 'bg-amber-100 text-amber-800',
};
export function StatusBadge({ status }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[status] ?? 'bg-slate-100 text-slate-700'}`}>
      {String(status).replace(/_/g, ' ')}
    </span>
  );
}

export function Money({ paise, className = '' }) {
  if (paise === null || paise === undefined) return <span className="text-slate-400">—</span>;   // e.g. SUM over no rows
  return <span className={`tabular-nums ${className}`}>{formatINR(paise)}</span>;
}

/** total is the API's decimal-string row count (a count, not money: Number is fine here) */
export function Pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(Number(total) / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
      <span>Page {page} of {pages} · {total} results</span>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

/** small labelled value box used on the vendor/finance dashboards */
export function Stat({ label, children, testId }) {
  return (
    <div className="card">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 font-semibold" data-testid={testId}>{children}</p>
    </div>
  );
}

/** "YYYY-MM-DD" (a DATE from the API) → "31 Oct 2026"; no time-zone shift */
export function formatDate(d) {
  if (!d) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d).slice(0, 10));
  if (!m) return d;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}
