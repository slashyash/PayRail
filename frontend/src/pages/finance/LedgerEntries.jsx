// Shows journal entries (header + lines) from GET /api/finance/journal-entries
// for one payment / refund / payout / order, with Σ debit and Σ credit added up
// as BigInt so the viewer can see each entry balances.
import { ErrorBox, Money, Spinner, StatusBadge, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';

const sum = (lines, dir) => lines.filter((l) => l.direction === dir).reduce((a, l) => a + BigInt(l.amount_paise), 0n).toString();

export default function LedgerEntries({ query, title = 'Ledger entries', reloadToken = 0 }) {
  const key = JSON.stringify(query);
  const res = useApi(() => api.get('/finance/journal-entries', { page_size: 20, ...query }), [key, reloadToken]);
  return (
    <div className="card space-y-2" data-testid="ledger-entries">
      <h3 className="text-sm font-medium">{title}</h3>
      <ErrorBox error={res.error} title="Could not load ledger entries" onRetry={res.reload} />
      {res.loading && !res.data && <Spinner />}
      {res.data && res.data.items.length === 0 && <p className="text-sm text-slate-500">No journal entry (nothing was posted).</p>}
      {res.data?.items.map((e) => {
        const lines = e.lines ?? [];
        const d = sum(lines, 'D');
        const c = sum(lines, 'C');
        return (
          <div key={e.entry_id} className="rounded border border-slate-200" data-testid="ledger-entry" data-entry-type={e.entry_type}>
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-2 py-1 text-xs">
              <span className="font-medium">Entry #{e.entry_id}</span>
              <StatusBadge status={e.entry_type} />
              {e.reverses_entry_id && <span>reverses #{e.reverses_entry_id}</span>}
              <span className="text-slate-500">{formatDateTime(e.created_at)}</span>
              <span className="ml-auto">{e.description}</span>
            </div>
            <table className="w-full">
              <thead><tr><th className="th">Account</th><th className="th num">Debit</th><th className="th num">Credit</th></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.line_no} className="border-t border-slate-100">
                    <td className="td font-mono text-xs">{l.account_code}</td>
                    <td className="td num">{l.direction === 'D' ? <Money paise={l.amount_paise} /> : ''}</td>
                    <td className="td num">{l.direction === 'C' ? <Money paise={l.amount_paise} /> : ''}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-300 font-medium">
                  <td className="td text-xs">Total {d === c ? '— balanced' : '— NOT balanced'}</td>
                  <td className="td num"><Money paise={d} /></td>
                  <td className="td num"><Money paise={c} /></td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
