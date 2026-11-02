// Hosted checkout of the SIMULATED payment gateway (DEC-038).
// Plays the part of an external gateway page (like a real gateway in test
// mode): the shop redirects the customer here, the customer pays with one of
// the published TEST instruments, and the gateway — not the customer — decides
// the outcome and sends a signed callback to the shop's backend. The customer
// is then sent back to the shop, which shows the result from the database.
//   GET  /api/mock-gateway/checkout/:id   amount, method, test instruments
//   POST /api/mock-gateway/checkout/:id   { action: 'pay', instrument } | { action: 'cancel' }
// Nothing typed here is stored; only test instruments are accepted.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ErrorBox, Money, Spinner } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-slate-900 text-white">
        <div className="mx-auto flex max-w-lg items-center justify-between px-4 py-3">
          <span className="font-semibold tracking-wide">MockPay Gateway</span>
          <span className="rounded bg-amber-400 px-2 py-0.5 text-xs font-bold text-slate-900">TEST MODE</span>
        </div>
      </header>
      <main className="mx-auto max-w-lg px-4 py-8">{children}</main>
      <p className="pb-6 text-center text-xs text-slate-400">Simulated gateway for the PayRail demo. Never enter real payment details.</p>
    </div>
  );
}

export default function GatewayCheckout() {
  const { paymentId } = useParams();
  const navigate = useNavigate();
  const data = useApi(() => api.get(`/mock-gateway/checkout/${paymentId}`), [paymentId]);
  const [vpa, setVpa] = useState('');
  const [card, setCard] = useState({ number: '', expiry: '', cvv: '' });
  const [bank, setBank] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (data.loading && !data.data) return <Shell><Spinner label="Loading checkout…" /></Shell>;
  if (data.error && !data.data) return <Shell><ErrorBox error={data.error} title="Checkout unavailable" onRetry={data.reload} /></Shell>;
  const { merchant, payment, test_instruments: tests } = data.data;
  const backToShop = `/orders/${payment.order_id}/pay`;

  async function submit(body) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/mock-gateway/checkout/${paymentId}`, body);
      // redirect back to the merchant; the shop re-reads the order from its database
      navigate(backToShop, { replace: true, state: { gatewayResult: { outcome: r.outcome, reason: r.reason } } });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  function pay(e) {
    e.preventDefault();
    const instrument = payment.method === 'upi' ? { vpa }
      : payment.method === 'card' ? card
        : { bank };
    submit({ action: 'pay', instrument });
  }

  if (payment.status !== 'initiated') {
    return (
      <Shell>
        <div className="card space-y-3 text-center">
          <p className="font-medium">This payment is already {payment.status}.</p>
          <Link className="btn-primary" to={backToShop} replace>Return to {merchant}</Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={pay} className="card space-y-5" data-testid="gateway-checkout">
        <div className="border-b border-slate-100 pb-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Paying {merchant}</p>
          <p className="mt-1 text-3xl font-semibold" data-testid="gateway-amount"><Money paise={payment.amount_paise} /></p>
          <p className="text-xs text-slate-500">Order #{payment.order_id} · attempt #{payment.payment_id} · {payment.method}</p>
        </div>

        {payment.method === 'upi' && (
          <div>
            <label className="label" htmlFor="vpa">UPI ID</label>
            <input id="vpa" className="input" placeholder="name@bank" autoComplete="off" required value={vpa} onChange={(e) => setVpa(e.target.value)} />
          </div>
        )}
        {payment.method === 'card' && (
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-3">
              <label className="label" htmlFor="cardno">Card number</label>
              <input id="cardno" className="input font-mono" inputMode="numeric" autoComplete="off" required
                value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="label" htmlFor="expiry">Expiry (MM/YY)</label>
              <input id="expiry" className="input" placeholder="12/30" autoComplete="off" required
                value={card.expiry} onChange={(e) => setCard({ ...card, expiry: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="cvv">CVV</label>
              <input id="cvv" className="input" inputMode="numeric" maxLength={3} autoComplete="off" required
                value={card.cvv} onChange={(e) => setCard({ ...card, cvv: e.target.value })} />
            </div>
          </div>
        )}
        {payment.method === 'netbanking' && (
          <fieldset className="space-y-2">
            <legend className="label">Choose your bank</legend>
            {tests.map((t) => (
              <label key={t.bank} className="flex items-center gap-2 text-sm">
                <input type="radio" name="bank" value={t.bank} checked={bank === t.bank} onChange={() => setBank(t.bank)} required />
                {t.label}
              </label>
            ))}
          </fieldset>
        )}

        {payment.method !== 'netbanking' && (
          <div className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">
            <p className="mb-1 font-semibold">Test {payment.method === 'upi' ? 'UPI IDs' : 'cards'} (click to fill)</p>
            <ul className="space-y-1">
              {tests.map((t) => (
                <li key={t.vpa ?? t.number}>
                  <button type="button" className="font-mono underline"
                    onClick={() => (t.vpa ? setVpa(t.vpa) : setCard({ number: t.number, expiry: '12/30', cvv: '123' }))}>
                    {t.vpa ?? t.number.replace(/(\d{4})(?=\d)/g, '$1 ')}
                  </button>{' '}— {t.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        <ErrorBox error={error} title="Payment not submitted" />
        <div className="flex flex-col gap-2">
          <button type="submit" className="btn-primary py-2.5" disabled={busy}>
            {busy ? 'Processing…' : <>Pay <Money paise={payment.amount_paise} /></>}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => submit({ action: 'cancel' })}>
            Cancel and return to {merchant}
          </button>
        </div>
      </form>
    </Shell>
  );
}
