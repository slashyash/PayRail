// Table of gateway callback deliveries returned by the finance simulator
// (POST /api/mock-gateway/payments/:id/simulate): one row per delivery, with
// the HTTP status and the database's verdict (payment status or SQLSTATE).
import { StatusBadge } from './ui.jsx';

export default function DeliveryResults({ result }) {
  if (!result) return null;
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-slate-200" data-testid="delivery-results">
      <table className="w-full">
        <thead className="bg-slate-50"><tr><th className="th">Callback #</th><th className="th">Event</th><th className="th">HTTP</th><th className="th">Result</th></tr></thead>
        <tbody>
          {result.deliveries.map((d, i) => (
            <tr key={i} className="border-t border-slate-100">
              <td className="td">{i + 1}</td>
              <td className="td font-mono text-xs">{result.event.type} · {result.event.gateway_ref} · {result.event.amount_paise} paise</td>
              <td className="td font-mono">{d.status}</td>
              <td className="td">
                {d.body?.error
                  ? <span className="text-rose-700">{d.body.error.code}{d.body.error.sqlstate ? ` (${d.body.error.sqlstate})` : ''}: {d.body.error.message}</span>
                  : <>payment #{d.body.payment.payment_id} → <StatusBadge status={d.body.payment.status} /></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-slate-500">
        Now: payment #{result.payment.payment_id} is <b>{result.payment.status}</b>; order #{result.order.order_id} is <b>{result.order.status.replace(/_/g, ' ')}</b>.
      </p>
    </div>
  );
}
