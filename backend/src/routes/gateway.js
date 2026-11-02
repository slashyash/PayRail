// Gateway routes (DEC-033).
//   POST /api/gateway/callback                     — public, but HMAC-signed (see src/gateway.js)
//   POST /api/mock-gateway/payments/:id/simulate   — customer (owner of the payment), local demo only
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth.js';
import { notFound } from '../errors.js';
import { assertMockEnabled, publicPayment } from '../gateway.js';
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
  r.post('/payments/:id/simulate', auth.requireAuth, requireRole('customer'), async (req, res) => {
    assertMockEnabled(config);
    const { id } = parseParams(req, { id: idString });
    const opts = parseBody(req, simulateSchema);
    const payment = await db.one(
      `SELECT p.* FROM payments p JOIN orders o USING (order_id)
        WHERE p.payment_id = $1 AND o.customer_id = $2`, [id, req.user.user_id]);
    if (!payment) throw notFound('payment');
    const out = await gateway.simulate(payment, {
      outcome: opts.outcome, amountOverride: opts.amount_paise, deliveries: opts.deliveries,
    });
    const now = await db.one('SELECT * FROM payments WHERE payment_id = $1', [id]);
    const order = await db.one('SELECT status, total_paise FROM v_order_summary WHERE order_id = $1', [payment.order_id]);
    res.json({ ...out, payment: publicPayment(now), order: { order_id: payment.order_id, ...order } });
  });
  return r;
}
