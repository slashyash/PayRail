// Gateway callback authentication (HMAC) and replay behaviour, called over HTTP directly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, config, key } from './_setup.js';
import { signedHeaders, signPayload } from '../../src/gateway.js';

let ctx;
let payment;
let order;
before(async () => {
  ctx = await start();
  await ctx.login('customer3');
  order = (await ctx.as('customer3').post('/api/orders').send({ items: [{ product_id: '10', quantity: 3 }] })).body;
  payment = (await ctx.as('customer3').post(`/api/orders/${order.order_id}/payments`).set('Idempotency-Key', key()).send({ method: 'card' })).body;
});
after(async () => ctx.stop());

const eventFor = (over = {}) => ({
  event_id: `evt_T${payment.payment_id}`, type: 'payment.captured', payment_id: payment.payment_id,
  gateway_ref: `pay_T${payment.payment_id.padStart(9, '0')}`, amount_paise: payment.amount_paise, ...over,
});
const send = (raw, headers) => {
  const r = ctx.api().post('/api/gateway/callback');
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r.send(raw);
};

test('unsigned, wrongly signed, stale and tampered callbacks are refused before touching the database', async () => {
  const raw = JSON.stringify(eventFor());
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    unsigned: { 'Content-Type': 'application/json' },
    'wrong secret': signedHeaders('x'.repeat(64), raw),
    stale: { 'Content-Type': 'application/json', 'X-PayRail-Timestamp': String(now - 3600), 'X-PayRail-Signature': signPayload(config.gatewaySecret, now - 3600, raw) },
    'bad header': { 'Content-Type': 'application/json', 'X-PayRail-Timestamp': 'yesterday', 'X-PayRail-Signature': 'v1=00' },
  };
  for (const [name, h] of Object.entries(cases)) {
    const r = await send(raw, h);
    assert.equal(r.status, 401, name);
    assert.equal(r.body.error.code, 'bad_signature');
  }
  const h = signedHeaders(config.gatewaySecret, raw);
  const tampered = raw.replace(payment.amount_paise, '1');
  const t = await send(tampered, h);
  assert.equal(t.status, 401, 'signature covers the exact body');
  const st = await ctx.one('SELECT status FROM payments WHERE payment_id = $1', [payment.payment_id]);
  assert.equal(st.status, 'initiated');
});

test('signed but malformed event → 422', async () => {
  const raw = JSON.stringify({ ...eventFor(), amount_paise: 100 });          // number, not a decimal string
  const r = await send(raw, signedHeaders(config.gatewaySecret, raw));
  assert.equal(r.status, 422);
});

test('valid signed capture, replay is harmless, conflicting replays are refused', async () => {
  const raw = JSON.stringify(eventFor());
  const r1 = await send(raw, signedHeaders(config.gatewaySecret, raw));
  assert.equal(r1.status, 200);
  assert.equal(r1.body.payment.status, 'captured');
  const r2 = await send(raw, signedHeaders(config.gatewaySecret, raw));
  assert.equal(r2.status, 200, 'exact replay → original row');
  const n = await ctx.one('SELECT count(*)::int AS n FROM journal_entries WHERE payment_id = $1', [payment.payment_id]);
  assert.equal(n.n, 1);
  const otherRef = JSON.stringify(eventFor({ gateway_ref: 'pay_OTHERREF001' }));
  const r3 = await send(otherRef, signedHeaders(config.gatewaySecret, otherRef));
  assert.equal(r3.status, 409);
  assert.equal(r3.body.error.code, 'idempotency_conflict');
  const fail = JSON.stringify(eventFor({ type: 'payment.failed', gateway_ref: `pay_F${payment.payment_id.padStart(9, '0')}` }));
  const r4 = await send(fail, signedHeaders(config.gatewaySecret, fail));
  assert.equal(r4.status, 409);
  assert.equal(r4.body.error.code, 'invalid_transition');
  const unknown = JSON.stringify(eventFor({ payment_id: '999999' }));
  const r5 = await send(unknown, signedHeaders(config.gatewaySecret, unknown));
  assert.equal(r5.status, 404);
});

test('simultaneous callbacks: identical ones post once; success racing failure ends in exactly one final state', async () => {
  const o = (await ctx.as('customer3').post('/api/orders').send({ items: [{ product_id: '11', quantity: 1 }] })).body;
  const p = (await ctx.as('customer3').post(`/api/orders/${o.order_id}/payments`).set('Idempotency-Key', key()).send({ method: 'upi' })).body;
  const ev = (type, prefix) => JSON.stringify({ event_id: `evt_${prefix}${p.payment_id}`, type, payment_id: p.payment_id,
    gateway_ref: `pay_${prefix}${p.payment_id.padStart(9, '0')}`, amount_paise: p.amount_paise });
  const ok = ev('payment.captured', 'S');
  const rs = await Promise.all(Array.from({ length: 4 }, () => send(ok, signedHeaders(config.gatewaySecret, ok))));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200]);
  assert.equal((await ctx.one('SELECT count(*)::int AS n FROM journal_entries WHERE payment_id = $1', [p.payment_id])).n, 1);

  const o2 = (await ctx.as('customer3').post('/api/orders').send({ items: [{ product_id: '12', quantity: 1 }] })).body;
  const p2 = (await ctx.as('customer3').post(`/api/orders/${o2.order_id}/payments`).set('Idempotency-Key', key()).send({ method: 'upi' })).body;
  const mk = (type, prefix) => JSON.stringify({ event_id: `evt_${prefix}${p2.payment_id}`, type, payment_id: p2.payment_id,
    gateway_ref: `pay_${prefix}${p2.payment_id.padStart(9, '0')}`, amount_paise: p2.amount_paise });
  const s = mk('payment.captured', 'S');
  const f = mk('payment.failed', 'F');
  const mix = await Promise.all([s, f, s, f].map((raw) => send(raw, signedHeaders(config.gatewaySecret, raw))));
  const final = (await ctx.one('SELECT status FROM payments WHERE payment_id = $1', [p2.payment_id])).status;
  const winners = mix.filter((r) => r.status === 200).map((r) => r.body.payment.status);
  console.log(`# success vs failure race: final ${final}, responses ${mix.map((r) => r.status).join(',')}`);
  assert.ok(['captured', 'failed'].includes(final));
  assert.ok(winners.every((w) => w === final), 'every accepted callback agrees with the final state');
  assert.equal(mix.filter((r) => r.status === 409).length, 2, 'the losing outcome is refused both times');
  const entries = (await ctx.one('SELECT count(*)::int AS n FROM journal_entries WHERE payment_id = $1', [p2.payment_id])).n;
  assert.equal(entries, final === 'captured' ? 1 : 0);
});
