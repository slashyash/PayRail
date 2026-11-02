// Simulated payment gateway (Task 3, DEC-033). No real gateway, money or credentials.
//
// Callback authentication (local demo): the gateway and the backend share
// GATEWAY_WEBHOOK_SECRET. A callback carries
//   X-PayRail-Timestamp: <unix seconds>
//   X-PayRail-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
// and is accepted only if the signature matches (constant-time comparison)
// and the timestamp is within ±5 minutes (limits replay of a captured request;
// a replay inside the window is harmless anyway — see below).
//
// Stable retry identity: for payment P the gateway always uses
//   success → gateway_ref pay_S<P padded to 9>, event_id evt_S<…>
//   failure → gateway_ref pay_F<P padded to 9>, event_id evt_F<…>
// (the same convention as the seed). The database treats (payment, outcome,
// gateway_ref, amount) as the callback's identity: a repeated callback returns
// the original row and posts nothing; the opposite outcome after a terminal
// state is refused (PRS01); a different ref/amount for a captured payment is
// refused (PRI01); a wrong amount is refused without any change (PRP01).
import crypto from 'node:crypto';
import { z } from 'zod';
import { ApiError, fromDbError } from './errors.js';
import { idString, paiseString } from './validate.js';

const TOLERANCE_SECONDS = 300;

export const eventSchema = z.object({
  event_id: z.string().regex(/^evt_[A-Za-z0-9_]{1,60}$/),
  type: z.enum(['payment.captured', 'payment.failed']),
  payment_id: idString,
  gateway_ref: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
  amount_paise: paiseString,
}).strict();

export function signPayload(secret, timestamp, rawBody) {
  return 'v1=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function signedHeaders(secret, rawBody, now = Math.floor(Date.now() / 1000)) {
  return {
    'Content-Type': 'application/json',
    'X-PayRail-Timestamp': String(now),
    'X-PayRail-Signature': signPayload(secret, now, rawBody),
  };
}

export function verifySignature(secret, rawBody, timestampHeader, signatureHeader, now = Math.floor(Date.now() / 1000)) {
  if (!/^\d{1,12}$/.test(timestampHeader || '') || typeof signatureHeader !== 'string') return false;
  if (Math.abs(now - Number(timestampHeader)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signPayload(secret, timestampHeader, rawBody));
  const given = Buffer.from(signatureHeader);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export const refFor = (paymentId, outcome) => `pay_${outcome === 'success' ? 'S' : 'F'}${String(paymentId).padStart(9, '0')}`;
export const eventIdFor = (paymentId, outcome) => `evt_${outcome === 'success' ? 'S' : 'F'}${String(paymentId).padStart(9, '0')}`;

export function gatewayService({ db, config }) {
  /**
   * Process one callback exactly as received over HTTP.
   * Returns { status, body } — used by the HTTP route and by the in-process simulator,
   * so both go through the same signature check and database call.
   */
  async function handleCallback(rawBody, headers) {
    if (!verifySignature(config.gatewaySecret, rawBody, headers['x-payrail-timestamp'], headers['x-payrail-signature'])) {
      return { status: 401, body: { error: { code: 'bad_signature', message: 'missing, invalid or expired gateway signature' } } };
    }
    let event;
    try {
      event = eventSchema.parse(JSON.parse(rawBody));
    } catch {
      return { status: 422, body: { error: { code: 'invalid_input', message: 'malformed gateway event' } } };
    }
    try {
      const payment = event.type === 'payment.captured'
        ? await db.one('SELECT * FROM fn_capture_payment($1, $2, $3)', [event.payment_id, event.gateway_ref, event.amount_paise])
        : await db.one('SELECT * FROM fn_fail_payment($1, $2)', [event.payment_id, event.gateway_ref]);
      return { status: 200, body: { received: true, event_id: event.event_id, payment: publicPayment(payment) } };
    } catch (e) {
      const api = fromDbError(e);
      if (!api) throw e;
      return { status: api.status, body: { error: { code: api.code, message: api.message, sqlstate: api.sqlstate } } };
    }
  }

  /**
   * Local-demo simulator: build the event the gateway would send for this
   * payment, sign it, and deliver it `deliveries` times (duplicates).
   * amountOverride simulates a gateway reporting the wrong amount.
   */
  async function simulate(payment, { outcome, amountOverride, deliveries }) {
    const event = {
      event_id: eventIdFor(payment.payment_id, outcome),
      type: outcome === 'success' ? 'payment.captured' : 'payment.failed',
      payment_id: String(payment.payment_id),
      gateway_ref: refFor(payment.payment_id, outcome),
      amount_paise: amountOverride ?? String(payment.amount_paise),
    };
    const rawBody = JSON.stringify(event);
    const results = [];
    for (let i = 0; i < deliveries; i++) {
      const h = signedHeaders(config.gatewaySecret, rawBody);
      results.push(await handleCallback(rawBody, { 'x-payrail-timestamp': h['X-PayRail-Timestamp'], 'x-payrail-signature': h['X-PayRail-Signature'] }));
    }
    return { event, deliveries: results };
  }

  return { handleCallback, simulate };
}

export function publicPayment(p) {
  if (!p) return p;
  const { idempotency_key, ...rest } = p;
  return rest;
}

export function assertMockEnabled(config) {
  if (!config.mockGatewayEnabled) throw new ApiError(404, 'not_found', 'mock gateway disabled');
}
