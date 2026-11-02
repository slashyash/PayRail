// Trial balance: Σ debits and Σ credits per account from v_account_balances,
// and the global check Σ debit = Σ credit (always true for a ledger whose every
// entry balances at COMMIT). The fuller report with filters is Task 6 (R1).
//   GET /api/finance/trial-balance
import { useState } from 'react';
import { ErrorBox, Money, Notice, Spinner, StatusBadge } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { cmpPaise } from '../../lib/money.js';
import { useApi } from '../../lib/useApi.js';
import LedgerEntries from './LedgerEntries.jsx';

const ENTRY_TYPES = ['capture', 'refund', 'payout', 'reversal', 'settlement'];

export default function TrialBalance() {
  const tb = useApi(() => api.get('/finance/trial-balance'), []);
  const [entryType, setEntryType] = useState('reversal');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Ledger · trial balance</h1>
        <button type="button" className="btn-secondary" onClick={tb.reload}>Refresh</button>
      </div>
      <ErrorBox error={tb.error} title="Could not load the trial balance" onRetry={tb.reload} />
      {tb.loading && !tb.data && <Spinner />}
      {tb.data && (
        <>
          <Notice tone={tb.data.balanced ? 'success' : 'warn'}>
            <span data-testid="tb-check">
              Σ debits <Money paise={tb.data.total_debit_paise} /> {tb.data.balanced ? '=' : '≠'} Σ credits <Money paise={tb.data.total_credit_paise} />
              {tb.data.balanced ? ' — the ledger balances.' : ' — NOT balanced.'}
            </span>
          </Notice>
          <div className="card overflow-x-auto p-0">
            <table className="w-full">
              <thead><tr>
                <th className="th">Account</th><th className="th">Owner</th><th className="th">Class</th><th className="th">Normal side</th>
                <th className="th num">Debits</th><th className="th num">Credits</th><th className="th num">Balance (normal side)</th>
              </tr></thead>
              <tbody>
                {tb.data.accounts.map((a) => (
                  <tr key={a.account_id} className="border-t border-slate-100">
                    <td className="td font-mono text-xs">{a.code}</td>
                    <td className="td">{a.owner_type}{a.vendor_id ? ` #${a.vendor_id}` : ''}</td>
                    <td className="td">{a.account_class}</td>
                    <td className="td">{a.normal_side}</td>
                    <td className="td num"><Money paise={a.debit_paise} /></td>
                    <td className="td num"><Money paise={a.credit_paise} /></td>
                    <td className={`td num ${cmpPaise(a.balance_paise, '0') < 0 ? 'text-rose-700' : ''}`}><Money paise={a.balance_paise} /></td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-300 font-semibold">
                  <td className="td" colSpan={4}>Total</td>
                  <td className="td num"><Money paise={tb.data.total_debit_paise} /></td>
                  <td className="td num"><Money paise={tb.data.total_credit_paise} /></td>
                  <td className="td" />
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">Latest journal entries</h2>
        {ENTRY_TYPES.map((t) => (
          <button key={t} type="button" onClick={() => setEntryType(t)}
            className={`rounded-full ${entryType === t ? 'ring-2 ring-indigo-500' : ''}`}><StatusBadge status={t} /></button>
        ))}
      </div>
      <LedgerEntries query={{ entry_type: entryType, page_size: 5 }} title={`Latest ${entryType} entries`} />
    </div>
  );
}
