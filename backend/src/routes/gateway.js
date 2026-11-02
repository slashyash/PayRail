// Gateway routes (DEC-033, DEC-038).
//   POST /api/gateway/callback                     — public, but HMAC-signed (see src/gateway.js)
//   GET  /api/mock-gateway/checkout/:id            — customer (owner): the hosted checkout page's data
//   POST /api/mock-gateway/checkout/:id            — customer (owner): pay with a TEST instrument or cancel;
//                                                    the gateway decides the outcome and sends ONE signed callback
//   POST /api/mock-gateway/payments/:id/simulate   — finance_admin only: fault injection for the demo
//                                                    (any outcome, wrong amount, duplicate deliveries)
// The mock-gateway routes exist only when MOCK_GATEWAY_ENABLED=1 (local demo).
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import { ApiError, notFound } from '../errors.js';
import { TEST_INSTRUMENTS, assertMockEnabled, checkoutSchema, decideCheckout, publicPayment } from '../gateway.js';
import { idString, paiseString, parseBody, parseParams } from '../validate.js';

const simulateSchema = z.object({
  outcome: z.enum(['success', 'failure']),
  // simulate a gateway that reports the wrong amount (capture must be refused, PRP01)
  amount_paise: paiseString.optional(),
  // simulate duplicate deliveries of the same callback (must be harmless)
  deliveries: z.number().int().min(1).max(3).default(1),
}).strict();

export function gatewayCallbackRoutes({ gateway }) {
  const r = Router();
  r.post('/callback', async (req, res) => {
    // req.rawBody is captured by the JSON parser's verify hook (src/app.js):
    // the signature covers the exact bytes received, not a re-serialisation.
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    const out = await gateway.handleCallback(raw, req.headers);
    res.status(out.status).json(out.body);
  });
  return r;
}

export function mockGatewayRoutes({ db, config, gateway, auth }) {
  const r = Router();
  r.use((req, res, next) => { assertMockEnabled(config); next(); });

  const orderState = (orderId) => db.one('SELECT order_id, status, total_paise FROM v_order_summary WHERE order_id = $1', [orderId]);
  const ownPayment = async (paymentId, customerId) => {
    const p = await db.one(
      `SELECT p.* FROM payments p JOIN orders o USING (order_id)
        WHERE p.payment_id = $1 AND o.customer_id = $2`, [paymentId, customerId]);
    if (!p) throw notFound('payment');
    return p;
  };

  // ---- hosted checkout (customer) ------------------------------------------------
  r.get('/checkout/:id', auth.requireAuth, requireRole('customer'), async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const p = await ownPayment(id, req.user.user_id);
    res.json({
      merchant: 'PayRail Marketplace',
      payment: publicPayment(p),
      test_instruments: TEST_INSTRUMENTS[p.method].map(({ outcome, ...t }) => ({ ...t, outcome })),
    });
  });

  r.post('/checkout/:id', auth.requireAuth, requireRole('customer'), async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const body = parseBody(req, checkoutSchema);
    const p = await ownPayment(id, req.user.user_id);
    if (p.status !== 'initiated') {
      throw new ApiError(409, 'invalid_transition', `this payment attempt is already ${p.status}; start a new attempt from the order`);
    }
    const decision = decideCheckout(p.method, body);       // 422 for non-test or mismatched instruments
    // the gateway's own amount = the attempt's amount; the customer cannot change it
    const out = await gateway.simulate(p, { outcome: decision.outcome, deliveries: 1 });
    const delivery = out.deliveries[0];
    const now = await db.one('SELECT * FROM payments WHERE payment_id = $1', [id]);
    res.status(delivery.status === 200 ? 200 : delivery.status).json({
      outcome: decision.outcome, reason: decision.reason, callback: delivery,
      payment: publicPayment(now), order: await orderState(p.order_id),
    });
  });

  // ---- fault injection (finance_admin only) --------------------------------------
  r.post('/payments/:id/simulate', auth.requireAuth, requireRole('finance_admin'), async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const opts = parseBody(req, simulateSchema);
    const payment = await db.one('SELECT * FROM payments WHERE payment_id = $1', [id]);
    if (!payment) throw notFound('payment');
    const out = await gateway.simulate(payment, {
      outcome: opts.outcome, amountOverride: opts.amount_paise, deliveries: opts.deliveries,
    });
    const now = await db.one('SELECT * FROM payments WHERE payment_id = $1', [id]);
    res.json({ ...out, payment: publicPayment(now), order: await orderState(payment.order_id) });
  });
  return r;
}
