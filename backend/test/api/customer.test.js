// W1 checkout + payment (through the mock gateway) and W3 refund requests, as a customer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, key, paidOrder } from './_setup.js';

let ctx;
before(async () => { ctx = await start(); await ctx.login('customer1', 'customer2', 'vendor1'); });
after(async () => ctx.stop());

const entriesFor = (paymentId) => ctx.q('SELECT entry_id FROM journal_entries WHERE payment_id = $1', [paymentId]);
const ledgerBalanced = async () => {
  const r = await ctx.one(`SELECT sum(amount_paise) FILTER (WHERE direction = 'D')::text AS d,
                                  sum(amount_paise) FILTER (WHERE direction = 'C')::text AS c FROM ledger_lines`);
  assert.equal(r.d, r.c, 'trial balance');
};

test('catalogue: search, filters, paging; only active products of verified vendors', async () => {
  const all = await ctx.as('customer1').get('/api/products?page_size=100');
  assert.equal(all.status, 200);
  const ids = all.body.items.map((p) => p.product_id);
  assert.ok(!ids.includes('20'), 'archived product hidden');
  assert.ok(!ids.includes('61'), 'pending-KYC vendor hidden');
  assert.ok(!ids.includes('67'), 'rejected-KYC vendor hidden');
  assert.equal(all.body.total, String(all.body.items.length));
  const s = await ctx.as('customer1').get('/api/products?q=saree');
  assert.ok(s.body.items.length >= 1 && s.body.items.every((p) => /saree/i.test(p.name)));
  const f = await ctx.as('customer1').get('/api/products?vendor_id=3&min_price_paise=100000&sort=price_desc');
  assert.ok(f.body.items.every((p) => p.vendor_id === '3' && BigInt(p.price_paise) >= 100000n));
  const prices = f.body.items.map((p) => BigInt(p.price_paise));
  assert.deepEqual([...prices].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)), prices);
  const pg2 = await ctx.as('customer1').get('/api/products?page=2&page_size=5');
  assert.equal(pg2.body.items.length, 5);
  assert.equal(pg2.body.items[0].product_id, all.body.items[5].product_id);
  const pct = await ctx.as('customer1').get('/api/products?q=%25');
  assert.equal(pct.body.items.length, 0, 'LIKE wildcards in the search text are escaped');
  const bad = await ctx.as('customer1').get('/api/products?page_size=1000&unknown=1');
  assert.equal(bad.status, 422);
  assert.equal((await ctx.as('customer1').get('/api/products/20')).status, 404);
});

test('multi-vendor order: repeated products aggregate; prices come from the catalogue', async () => {
  const r = await ctx.as('customer1').post('/api/orders').send({
    items: [{ product_id: '1', quantity: 2 }, { product_id: '7', quantity: 1 }, { product_id: '1', quantity: 3 }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'pending_payment');
  assert.equal(r.body.lines.length, 2);
  assert.deepEqual(r.body.lines.map((l) => [l.product_id, l.quantity]), [['1', 5], ['7', 1]]);
  const cat = await ctx.q('SELECT product_id::text, price_paise::text FROM products WHERE product_id IN (1, 7) ORDER BY 1');
  assert.equal(r.body.lines[0].unit_price_paise, cat[0].price_paise);
  const expected = 5n * BigInt(cat[0].price_paise) + BigInt(cat[1].price_paise);
  assert.equal(r.body.total_paise, expected.toString());
  assert.notEqual(r.body.lines[0].vendor_id, r.body.lines[1].vendor_id);
});

test('order input that tries to set prices, commission or the customer is rejected', async () => {
  for (const body of [
    { items: [{ product_id: '1', quantity: 1, unit_price_paise: '1' }] },
    { items: [{ product_id: '1', quantity: 1, commission_bps: 0 }] },
    { items: [{ product_id: '1', quantity: 1 }], customer_id: '5' },
    { items: [{ product_id: '1', quantity: 1 }], total_paise: '1' },
    { items: [] },
    { items: [{ product_id: 1, quantity: 1 }] },                    // ids must be strings (lossless)
    { items: [{ product_id: '1', quantity: 0 }] },
    { items: [{ product_id: '1', quantity: 1.5 }] },
  ]) {
    const r = await ctx.as('customer1').post('/api/orders').send(body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal(r.body.error.code, 'invalid_input');
  }
});

test('order rules are enforced by the database and mapped to clear errors', async () => {
  const cases = [
    [[{ product_id: '20', quantity: 1 }], 422, 'product_inactive'],
    [[{ product_id: '61', quantity: 1 }], 422, 'vendor_not_verified'],
    [[{ product_id: '999999', quantity: 1 }], 404, 'not_found'],
    [[{ product_id: '1', quantity: 60 }, { product_id: '1', quantity: 41 }], 422, 'invalid_input'],
  ];
  for (const [items, status, code] of cases) {
    const r = await ctx.as('customer1').post('/api/orders').send({ items });
    assert.equal(r.status, status, JSON.stringify(items));
    assert.equal(r.body.error.code, code);
    assert.ok(r.body.error.sqlstate, 'database verdict carries its SQLSTATE');
  }
});

test('payment attempt: key required, amount derived, concurrent duplicates return the same attempt', async () => {
  const o = (await ctx.as('customer1').post('/api/orders').send({ items: [{ product_id: '2', quantity: 1 }] })).body;
  const noKey = await ctx.as('customer1').post(`/api/orders/${o.order_id}/payments`).send({ method: 'upi' });
  assert.equal(noKey.status, 422);
  const tooMuch = await ctx.as('customer1').post(`/api/orders/${o.order_id}/payments`).set('Idempotency-Key', key())
    .send({ method: 'upi', amount_paise: '1' });
  assert.equal(tooMuch.status, 422, 'client cannot choose the amount');
  const k = key();
  const [a, b] = await Promise.all([1, 2].map(() =>
    ctx.as('customer1').post(`/api/orders/${o.order_id}/payments`).set('Idempotency-Key', k).send({ method: 'card' })));
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.payment_id, b.body.payment_id);
  assert.equal(a.body.amount_paise, o.total_paise);
  assert.equal(a.body.status, 'initiated');
  assert.equal('idempotency_key' in a.body, false);
  const n = await ctx.one('SELECT count(*)::int AS n FROM payments WHERE order_id = $1', [o.order_id]);
  assert.equal(n.n, 1);
  const conflict = await ctx.as('customer1').post(`/api/orders/${o.order_id}/payments`).set('Idempotency-Key', k).send({ method: 'upi' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
});

test('capture through the mock gateway: duplicate callbacks post exactly once', async () => {
  const o = (await ctx.as('customer1').post('/api/orders').send({
    items: [{ product_id: '3', quantity: 1 }, { product_id: '13', quantity: 2 }] })).body;
  const p = (await ctx.as('customer1').post(`/api/orders/${o.order_id}/payments`).set('Idempotency-Key', key()).send({ method: 'upi' })).body;
  const s = await ctx.as('customer1').post(`/api/mock-gateway/payments/${p.payment_id}/simulate`).send({ outcome: 'success', deliveries: 3 });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.deliveries.map((d) => d.status), [200, 200, 200]);
  assert.equal(s.body.payment.status, 'captured');
  assert.equal(s.body.payment.gateway_ref, `pay_S${p.payment_id.padStart(9, '0')}`);
  assert.equal(s.body.order.status, 'paid');
  assert.equal((await entriesFor(p.payment_id)).length, 1, 'one capture entry');
  const lines = await ctx.q(`SELECT a.code, l.direction, l.amount_paise::text AS amt FROM ledger_lines l
                               JOIN accounts a USING (account_id) JOIN journal_entries e USING (entry_id)
                              WHERE e.payment_id = $1 ORDER BY l.line_no`, [p.payment_id]);
  assert.equal(lines[0].code, 'GATEWAY_CLEARING');
  assert.equal(lines[0].amt, o.total_paise);
  assert.equal(lines.filter((l) => l.code.startsWith('VENDOR_PAYABLE_')).length, 2, 'one credit per vendor');
  const again = await ctx.as('customer1').post(`/api/orders/${o.order_id}/payments`).set('Idempotency-Key', key()).send({ method: 'upi' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_paid');
  const detail = await ctx.as('customer1').get(`/api/orders/${o.order_id}`);
  assert.equal(detail.body.status, 'paid');
  assert.equal(detail.body.captured_payment_id, p.payment_id);
  await ledgerBalanced();
});

test('capture amount mismatch is refused with no change; failed attempt cannot be captured; retry with a new attempt works', async () => {
  const o = (await ctx.as('customer1').post('/api/orders').send({ items: [{ product_id: '4', quantity: 1 }] })).body;
  const p1 = (await ctx.as('customer1').post(`/api/orders/${o.order_id}/payments`).set('Idempotency-Key', key()).send({ method: 'upi' })).body;
  const wrong = (BigInt(o.total_paise) - 1n).toString();
  const mm = await ctx.as('customer1').post(`/api/mock-gateway/payments/${p1.payment_id}/simulate`).send({ outcome: 'success', amount_paise: wrong });
  assert.equal(mm.body.deliveries[0].status, 409);
  assert.equal(mm.body.deliveries[0].body.error.code, 'amount_mismatch');
  assert.equal(mm.body.payment.status, 'initiated');
  assert.equal((await entriesFor(p1.payment_id)).length, 0, 'nothing posted');

  const f = await ctx.as('customer1').post(`/api/mock-gateway/payments/${p1.payment_id}/simulate`).send({ outcome: 'failure', deliveries: 2 });
  assert.deepEqual(f.body.deliveries.map((d) => d.status), [200, 200]);
  assert.equal(f.body.payment.status, 'failed');
  const late = await ctx.as('customer1').post(`/api/mock-gateway/payments/${p1.payment_id}/simulate`).send({ outcome: 'success' });
  assert.equal(late.body.deliveries[0].status, 409);
  assert.equal(late.body.deliveries[0].body.error.code, 'invalid_transition');
  assert.equal(late.body.payment.status, 'failed', 'a final outcome cannot be switched by a retry');

  const p2 = (await ctx.as('customer1').post(`/api/orders/${o.order_id}/payments`).set('Idempotency-Key', key()).send({ method: 'netbanking' })).body;
  const ok = await ctx.as('customer1').post(`/api/mock-gateway/payments/${p2.payment_id}/simulate`).send({ outcome: 'success' });
  assert.equal(ok.body.payment.status, 'captured');
  assert.equal(ok.body.order.status, 'paid');
  const det = await ctx.as('customer1').get(`/api/orders/${o.order_id}`);
  assert.deepEqual(det.body.payments.map((x) => x.status), ['failed', 'captured']);
});

test('customers cannot see or act on another customer\'s orders and payments', async () => {
  const { order, payment } = await paidOrder(ctx, 'customer1', [{ product_id: '5', quantity: 1 }]);
  assert.equal((await ctx.as('customer2').get(`/api/orders/${order.order_id}`)).status, 404);
  const pay = await ctx.as('customer2').post(`/api/orders/${order.order_id}/payments`).set('Idempotency-Key', key()).send({ method: 'upi' });
  assert.equal(pay.status, 403);
  assert.equal(pay.body.error.sqlstate, 'PRA01', 'the database refuses the actor');
  const sim = await ctx.as('customer2').post(`/api/mock-gateway/payments/${payment.payment_id}/simulate`).send({ outcome: 'failure' });
  assert.equal(sim.status, 404);
  const ref = await ctx.as('customer2').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', key())
    .send({ line_no: 1, amount_paise: '100', reason: 'not mine' });
  assert.equal(ref.status, 403);
  const list = await ctx.as('customer2').get('/api/orders?page_size=100');
  assert.ok(!list.body.items.some((x) => x.order_id === order.order_id));
});

test('refund requests: reserve, replay, limits, unpaid order', async () => {
  const { order } = await paidOrder(ctx, 'customer1', [{ product_id: '6', quantity: 2 }]);
  const total = BigInt(order.total_paise);
  const k = key();
  const body = { line_no: 1, amount_paise: (total / 3n).toString(), reason: 'one item damaged' };
  const [r1, r2] = await Promise.all([1, 2].map(() =>
    ctx.as('customer1').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', k).send(body)));
  assert.equal(r1.status, 201);
  assert.equal(r1.body.refund_id, r2.body.refund_id, 'concurrent duplicate → same refund');
  assert.equal(r1.body.status, 'requested');
  const other = await ctx.as('customer1').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', k).send({ ...body, reason: 'changed' });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'idempotency_conflict');
  const det = (await ctx.as('customer1').get(`/api/orders/${order.order_id}`)).body;
  assert.equal(det.lines[0].refund_pending_paise, body.amount_paise);
  assert.equal(det.lines[0].refundable_paise, (total - total / 3n).toString());
  const over = await ctx.as('customer1').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', key())
    .send({ line_no: 1, amount_paise: (total - total / 3n + 1n).toString(), reason: 'too much' });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'refund_exceeds_refundable');
  const tiny = await ctx.as('customer1').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', key())
    .send({ line_no: 1, amount_paise: '50', reason: 'tiny' });
  assert.equal(tiny.status, 422);
  assert.equal(tiny.body.error.code, 'refund_below_minimum');
  const noLine = await ctx.as('customer1').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', key())
    .send({ line_no: 9, amount_paise: '100', reason: 'x' });
  assert.equal(noLine.status, 404);
  const unpaid = (await ctx.as('customer1').post('/api/orders').send({ items: [{ product_id: '8', quantity: 1 }] })).body;
  const np = await ctx.as('customer1').post(`/api/orders/${unpaid.order_id}/refunds`).set('Idempotency-Key', key())
    .send({ line_no: 1, amount_paise: '100', reason: 'x' });
  assert.equal(np.status, 409);
  assert.equal(np.body.error.code, 'order_not_paid');
  const mine = await ctx.as('customer1').get('/api/refunds?status=requested');
  assert.ok(mine.body.items.some((x) => x.refund_id === r1.body.refund_id));
  const filtered = await ctx.as('customer1').get(`/api/orders?status=pending_payment&page_size=100`);
  assert.ok(filtered.body.items.every((x) => x.status === 'pending_payment'));
  assert.ok(filtered.body.items.some((x) => x.order_id === unpaid.order_id));
});

test('a failed workflow call leaves nothing behind: the same key works afterwards', async () => {
  const { order } = await paidOrder(ctx, 'customer1', [{ product_id: '9', quantity: 1 }]);
  const k = key();
  const big = (BigInt(order.total_paise) + 1n).toString();
  const bad = await ctx.as('customer1').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', k)
    .send({ line_no: 1, amount_paise: big, reason: 'x' });
  assert.equal(bad.status, 409);
  const good = await ctx.as('customer1').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', k)
    .send({ line_no: 1, amount_paise: '100', reason: 'x' });
  assert.equal(good.status, 201, 'the failed attempt did not poison the key');
});
