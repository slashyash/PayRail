// Vendor: product CRUD (DEC-014), ledger-derived balance/statement, W2 payout requests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, key, paidOrder } from './_setup.js';

let ctx;
before(async () => { ctx = await start(); await ctx.login('vendor1', 'vendor2', 'vendor9', 'vendor11', 'vendor12', 'customer4'); });
after(async () => ctx.stop());

const dbBalance = async (vendorId) => (await ctx.one('SELECT fn_vendor_balance($1)::text AS b', [vendorId])).b;

test('vendor profile shows the ledger-derived balance', async () => {
  const me = await ctx.as('vendor1').get('/api/vendor/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.vendor_id, '1');
  assert.equal(me.body.balance_paise, await dbBalance(1));
});

test('product CRUD: create, update, archive, reactivate, delete draft, refuse deleting history', async () => {
  const c = await ctx.as('vendor1').post('/api/vendor/products').send({ name: 'Brass Diya', price_paise: '45000' });
  assert.equal(c.status, 201);
  assert.equal(c.body.vendor_id, '1');
  assert.equal(c.body.has_orders, false);
  const id = c.body.product_id;
  const dup = await ctx.as('vendor1').post('/api/vendor/products').send({ name: 'Brass Diya', price_paise: '1' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'duplicate');
  const sneaky = await ctx.as('vendor1').post('/api/vendor/products').send({ name: 'X', price_paise: '1', vendor_id: '2' });
  assert.equal(sneaky.status, 422, 'vendor_id cannot be chosen by the client');
  const badPrice = await ctx.as('vendor1').post('/api/vendor/products').send({ name: 'Y', price_paise: '10000000000' });
  assert.equal(badPrice.status, 422, 'database CHECK: price at most ₹1 crore');

  const u = await ctx.as('vendor1').patch(`/api/vendor/products/${id}`).send({ price_paise: '47500', name: 'Brass Diya (large)' });
  assert.equal(u.status, 200);
  assert.equal(u.body.price_paise, '47500');
  const arch = await ctx.as('vendor1').patch(`/api/vendor/products/${id}`).send({ is_active: false });
  assert.equal(arch.body.is_active, false);
  await ctx.login('customer4');
  assert.equal((await ctx.as('customer4').get(`/api/products/${id}`)).status, 404, 'archived → not in catalogue');
  const ord = await ctx.as('customer4').post('/api/orders').send({ items: [{ product_id: id, quantity: 1 }] });
  assert.equal(ord.status, 422);
  assert.equal(ord.body.error.code, 'product_inactive');
  await ctx.as('vendor1').patch(`/api/vendor/products/${id}`).send({ is_active: true });
  assert.equal((await ctx.as('customer4').get(`/api/products/${id}`)).body.price_paise, '47500');

  assert.equal((await ctx.as('vendor2').patch(`/api/vendor/products/${id}`).send({ price_paise: '1' })).status, 404, 'other vendor');
  assert.equal((await ctx.as('vendor2').delete(`/api/vendor/products/${id}`)).status, 404);
  assert.equal((await ctx.as('vendor1').patch(`/api/vendor/products/${id}`).send({})).status, 422);

  const del = await ctx.as('vendor1').delete('/api/vendor/products/73');          // seeded unreferenced draft
  assert.equal(del.status, 204);
  assert.equal((await ctx.q('SELECT 1 FROM products WHERE product_id = 73')).length, 0);
  const ref = await ctx.as('vendor1').delete('/api/vendor/products/1');            // has order history
  assert.equal(ref.status, 409);
  assert.equal(ref.body.error.code, 'referenced');
  assert.equal((await ctx.q('SELECT 1 FROM products WHERE product_id = 1')).length, 1, 'history kept');

  const price = (await ctx.one('SELECT unit_price_paise::text AS p FROM order_items WHERE product_id = 1 LIMIT 1')).p;
  await ctx.as('vendor1').patch('/api/vendor/products/1').send({ price_paise: '1' });
  const after_ = (await ctx.one('SELECT unit_price_paise::text AS p FROM order_items WHERE product_id = 1 LIMIT 1')).p;
  assert.equal(after_, price, 'price edits never change past order lines (snapshots)');
  await ctx.as('vendor1').patch('/api/vendor/products/1').send({ price_paise: '49999' });
  const list = await ctx.as('vendor1').get('/api/vendor/products?page_size=100');
  assert.ok(list.body.items.every((p) => p.vendor_id === '1'));
  await ctx.login('vendor4');
  const v4 = await ctx.as('vendor4').get('/api/vendor/products?page_size=100');
  assert.ok(v4.body.items.some((p) => p.product_id === '20' && p.is_active === false && p.has_orders), 'archived products listed for the owner');
  const v4active = await ctx.as('vendor4').get('/api/vendor/products?page_size=100&include_archived=0');
  assert.ok(!v4active.body.items.some((p) => p.product_id === '20'));
});

test('statement: window-function running balance ends at the ledger balance; date filter keeps balances', async () => {
  const all = await ctx.as('vendor2').get('/api/vendor/statement?page_size=100');
  assert.equal(all.status, 200);
  const items = all.body.items;
  assert.ok(items.length > 0);
  if (Number(all.body.total) <= 100) {
    assert.equal(items.at(-1).running_balance_paise, await dbBalance(2));
    assert.equal(all.body.closing_balance_paise, await dbBalance(2));
  }
  let run = 0n;
  for (const it of items) {
    run += BigInt(it.credit_paise) - BigInt(it.debit_paise);
    assert.equal(it.running_balance_paise, run.toString());
  }
  const part = await ctx.as('vendor2').get('/api/vendor/statement?from=2026-10-01&to=2026-10-31&page_size=100');
  let r2 = BigInt(part.body.opening_balance_paise);
  for (const it of part.body.items) {
    r2 += BigInt(it.credit_paise) - BigInt(it.debit_paise);
    assert.equal(it.running_balance_paise, r2.toString(), 'filtered rows keep the full-history running balance');
  }
  assert.equal(part.body.closing_balance_paise, r2.toString());
  assert.equal((await ctx.as('vendor2').get('/api/vendor/statement?from=2026-10-31&to=2026-10-01')).status, 422);
  assert.equal((await ctx.as('vendor2').get('/api/vendor/statement?from=2026-02-30')).status, 422);
});

test('payout requests: balance enforced in the database, idempotent, unverified vendors refused', async () => {
  const bal = BigInt(await dbBalance(9));
  const over = await ctx.as('vendor9').post('/api/vendor/payouts').set('Idempotency-Key', key()).send({ amount_paise: (bal + 1n).toString() });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'insufficient_funds');
  const trust = await ctx.as('vendor9').post('/api/vendor/payouts').set('Idempotency-Key', key())
    .send({ amount_paise: '100', balance_paise: '999999999' });
  assert.equal(trust.status, 422, 'a client-supplied balance is not accepted');
  const k = key();
  const amt = (bal / 4n).toString();
  const [a, b] = await Promise.all([1, 2].map(() => ctx.as('vendor9').post('/api/vendor/payouts').set('Idempotency-Key', k).send({ amount_paise: amt })));
  assert.equal(a.status, 201);
  assert.equal(a.body.payout_id, b.body.payout_id);
  assert.equal(a.body.status, 'requested');
  assert.equal(await dbBalance(9), (bal - bal / 4n).toString(), 'funds reserved once');
  const diff = await ctx.as('vendor9').post('/api/vendor/payouts').set('Idempotency-Key', k).send({ amount_paise: '100' });
  assert.equal(diff.status, 409);
  assert.equal(diff.body.error.code, 'idempotency_conflict');
  for (const v of ['vendor11', 'vendor12']) {
    const r = await ctx.as(v).post('/api/vendor/payouts').set('Idempotency-Key', key()).send({ amount_paise: '100' });
    assert.equal(r.status, 422, v);
    assert.equal(r.body.error.code, 'vendor_not_verified');
  }
  const hist = await ctx.as('vendor9').get('/api/vendor/payouts?status=requested');
  assert.ok(hist.body.items.some((p) => p.payout_id === a.body.payout_id));
  const others = await ctx.as('vendor1').get('/api/vendor/payouts?page_size=100');
  assert.ok(!others.body.items.some((p) => p.payout_id === a.body.payout_id), 'vendors see only their own payouts');
});

test('concurrent API payout requests (separate pool connections) cannot overspend', async () => {
  await paidOrder(ctx, 'customer4', [{ product_id: '13', quantity: 2 }]);          // vendor 3 earns
  const bal = BigInt(await dbBalance(3));
  assert.ok(bal > 0n);
  const amt = ((bal * 40n) / 100n).toString();                                       // 40 % each → at most 2 fit
  await ctx.login('vendor3');
  const rs = await Promise.all(Array.from({ length: 6 }, () =>
    ctx.as('vendor3').post('/api/vendor/payouts').set('Idempotency-Key', key()).send({ amount_paise: amt })));
  const ok = rs.filter((r) => r.status === 201).length;
  const refused = rs.filter((r) => r.status === 409 && r.body.error.code === 'insufficient_funds').length;
  console.log(`# 6 concurrent payouts of 40%: ${ok} accepted, ${refused} insufficient_funds`);
  assert.equal(ok, 2);
  assert.equal(refused, 4);
  assert.ok(BigInt(await dbBalance(3)) >= 0n);
});

test('vendor sales list shows only own lines with the snapshot split', async () => {
  const s = await ctx.as('vendor1').get('/api/vendor/sales?page_size=50');
  assert.equal(s.status, 200);
  const prods = new Set((await ctx.q('SELECT name FROM products WHERE vendor_id = 1')).map((x) => x.name));
  assert.ok(s.body.items.length > 0 && s.body.items.every((l) => prods.has(l.product_name)));
  for (const l of s.body.items) {
    assert.equal((BigInt(l.commission_paise) + BigInt(l.gst_paise) + BigInt(l.vendor_paise)).toString(), l.line_total_paise);
  }
});

test('amounts beyond 2^53 travel losslessly as strings; values that cannot fit a BIGINT are refused', async () => {
  const big = '9007199254740993';                                   // 2^53 + 1: not representable as a JS Number
  assert.notEqual(String(Number(big)), big);
  const r = await ctx.as('vendor9').post('/api/vendor/payouts').set('Idempotency-Key', key()).send({ amount_paise: big });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'insufficient_funds');
  assert.ok(r.body.error.message.includes(big), 'the database received the exact value');
  const huge = await ctx.as('vendor9').post('/api/vendor/payouts').set('Idempotency-Key', key()).send({ amount_paise: '9223372036854775808' });
  assert.equal(huge.status, 422);
  const num = await ctx.as('vendor9').post('/api/vendor/payouts').set('Idempotency-Key', key()).send({ amount_paise: 1000 });
  assert.equal(num.status, 422, 'JSON numbers are refused for money');
});
