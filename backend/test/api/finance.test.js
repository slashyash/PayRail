// Finance: W3 refund decisions, W2 payout completion, W4 settlement import and reconciliation, ledger views.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, key, paidOrder } from './_setup.js';

let ctx;
let today;                                        // IST calendar date of the API's (real) clock
before(async () => {
  ctx = await start();
  await ctx.login('finance', 'customer5', 'customer6', 'vendor5');
  today = (await ctx.one(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
});
after(async () => ctx.stop());

const pad = (id) => String(id).padStart(9, '0');
const dbBalance = async (v) => BigInt((await ctx.one('SELECT fn_vendor_balance($1)::text AS b', [v])).b);
const entryLines = (where, id) => ctx.q(
  `SELECT a.code, l.direction, l.amount_paise::text AS amt FROM ledger_lines l JOIN accounts a USING (account_id)
     JOIN journal_entries e USING (entry_id) WHERE e.${where} = $1 ORDER BY l.line_no`, [id]);

test('refund approval posts the cumulative allocation; repeated partial + final refund reverse the capture exactly', async () => {
  const { order } = await paidOrder(ctx, 'customer5', [{ product_id: '2', quantity: 3 }, { product_id: '8', quantity: 1 }]);
  const line = order.lines[0];
  const L = BigInt(line.line_total_paise);
  const first = (L / 3n).toString();
  const r1 = (await ctx.as('customer5').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', key())
    .send({ line_no: 1, amount_paise: first, reason: 'one damaged' })).body;

  const pending = await ctx.as('finance').get('/api/finance/refunds?status=requested&page_size=100');
  const row = pending.body.items.find((x) => x.refund_id === r1.refund_id);
  assert.ok(row, 'finance sees the request');
  assert.equal(row.customer_name.length > 0, true);

  const a1 = await ctx.as('finance').post(`/api/finance/refunds/${r1.refund_id}/approve`);
  assert.equal(a1.status, 200);
  assert.equal(a1.body.status, 'processed');
  assert.equal(a1.body.gateway_ref, `rfnd_R${pad(r1.refund_id)}`);
  const again = await ctx.as('finance').post(`/api/finance/refunds/${r1.refund_id}/approve`);
  assert.equal(again.status, 200, 'repeated approval is harmless');
  assert.equal((await ctx.q('SELECT 1 FROM journal_entries WHERE refund_id = $1', [r1.refund_id])).length, 1);
  const rej = await ctx.as('finance').post(`/api/finance/refunds/${r1.refund_id}/reject`);
  assert.equal(rej.status, 409);
  assert.equal(rej.body.error.code, 'invalid_transition');

  const rest = (L - L / 3n).toString();
  const r2 = (await ctx.as('customer5').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', key())
    .send({ line_no: 1, amount_paise: rest, reason: 'return the rest' })).body;
  assert.equal((await ctx.as('finance').post(`/api/finance/refunds/${r2.refund_id}/approve`)).status, 200);

  const alloc = await ctx.one(`SELECT vendor_paise::text v, commission_paise::text c, gst_paise::text g, vendor_id
                                 FROM v_order_line_allocation WHERE order_id = $1 AND line_no = 1`, [order.order_id]);
  const sums = { v: 0n, c: 0n, g: 0n, clearing: 0n };
  for (const id of [r1.refund_id, r2.refund_id]) {
    for (const l of await entryLines('refund_id', id)) {
      if (l.code.startsWith('VENDOR_PAYABLE_')) { assert.equal(l.direction, 'D'); sums.v += BigInt(l.amt); }
      if (l.code === 'COMMISSION_REVENUE') sums.c += BigInt(l.amt);
      if (l.code === 'GST_PAYABLE') sums.g += BigInt(l.amt);
      if (l.code === 'GATEWAY_CLEARING') { assert.equal(l.direction, 'C'); sums.clearing += BigInt(l.amt); }
    }
  }
  assert.deepEqual([sums.v.toString(), sums.c.toString(), sums.g.toString(), sums.clearing.toString()],
    [alloc.v, alloc.c, alloc.g, L.toString()], 'full refund reverses the capture split exactly');
  const det = await ctx.as('customer5').get(`/api/orders/${order.order_id}`);
  assert.equal(det.body.status, 'partially_refunded');
  assert.equal(det.body.lines[0].refundable_paise, '0');

  // rejection releases the reservation
  const r3 = (await ctx.as('customer5').post(`/api/orders/${order.order_id}/refunds`).set('Idempotency-Key', key())
    .send({ line_no: 2, amount_paise: '1000', reason: 'changed mind' })).body;
  const j = await ctx.as('finance').post(`/api/finance/refunds/${r3.refund_id}/reject`);
  assert.equal(j.body.status, 'rejected');
  assert.equal((await ctx.as('finance').post(`/api/finance/refunds/${r3.refund_id}/approve`)).status, 409);
  const after2 = (await ctx.as('customer5').get(`/api/orders/${order.order_id}`)).body.lines[1];
  assert.equal(after2.refundable_paise, after2.line_total_paise);
  assert.equal((await ctx.as('finance').post('/api/finance/refunds/999999/approve')).status, 404);

  const je = await ctx.as('finance').get(`/api/finance/journal-entries?order_id=${order.order_id}`);
  assert.deepEqual(je.body.items.map((e) => e.entry_type).sort(), ['capture', 'refund', 'refund']);
  assert.equal(typeof je.body.items[0].lines[0].amount_paise, 'string', 'ledger amounts stay strings inside JSON');
  const fo = await ctx.as('finance').get(`/api/finance/orders/${order.order_id}`);
  assert.equal(fo.body.lines.length, 2);
});

test('payout completion: failure reverses exactly once, outcomes are final, UTR validated', async () => {
  const start0 = await dbBalance(5);
  const amt = (start0 / 10n).toString();
  const p1 = (await ctx.as('vendor5').post('/api/vendor/payouts').set('Idempotency-Key', key()).send({ amount_paise: amt })).body;
  const p2 = (await ctx.as('vendor5').post('/api/vendor/payouts').set('Idempotency-Key', key()).send({ amount_paise: amt })).body;
  assert.equal(await dbBalance(5), start0 - 2n * BigInt(amt));

  const listed = await ctx.as('finance').get('/api/finance/payouts?status=requested&vendor_id=5');
  assert.ok(listed.body.items.some((x) => x.payout_id === p1.payout_id));

  const f1 = await ctx.as('finance').post(`/api/finance/payouts/${p1.payout_id}/complete`).send({ outcome: 'failed' });
  assert.equal(f1.status, 200);
  assert.equal(f1.body.status, 'failed');
  const f2 = await ctx.as('finance').post(`/api/finance/payouts/${p1.payout_id}/complete`).send({ outcome: 'failed' });
  assert.equal(f2.status, 200, 'repeated failure report is harmless');
  const rev = await ctx.q(`SELECT r.entry_id FROM journal_entries r JOIN journal_entries p ON r.reverses_entry_id = p.entry_id
                            WHERE p.payout_id = $1`, [p1.payout_id]);
  assert.equal(rev.length, 1, 'exactly one reversal');
  assert.equal(await dbBalance(5), start0 - BigInt(amt), 'failed payout restored');
  const flip = await ctx.as('finance').post(`/api/finance/payouts/${p1.payout_id}/complete`).send({ outcome: 'paid', bank_utr: 'UTR000000000001' });
  assert.equal(flip.status, 409);
  assert.equal(flip.body.error.code, 'invalid_transition');

  for (const body of [{ outcome: 'paid' }, { outcome: 'paid', bank_utr: 'utr-lower' }, { outcome: 'failed', bank_utr: 'UTR000000000002' }, { outcome: 'lost' }]) {
    const r = await ctx.as('finance').post(`/api/finance/payouts/${p2.payout_id}/complete`).send(body);
    assert.equal(r.status, 422, JSON.stringify(body));
  }
  const paid = await ctx.as('finance').post(`/api/finance/payouts/${p2.payout_id}/complete`).send({ outcome: 'paid', bank_utr: 'HDFCN52026110200' });
  assert.equal(paid.body.status, 'paid');
  assert.equal(paid.body.bank_utr, 'HDFCN52026110200');
  assert.equal((await ctx.as('finance').post(`/api/finance/payouts/${p2.payout_id}/complete`).send({ outcome: 'paid', bank_utr: 'HDFCN52026110200' })).status, 200);
  const diff = await ctx.as('finance').post(`/api/finance/payouts/${p2.payout_id}/complete`).send({ outcome: 'paid', bank_utr: 'HDFCN52026110299' });
  assert.equal(diff.status, 409);
  assert.equal(diff.body.error.code, 'idempotency_conflict');
  assert.equal(await dbBalance(5), start0 - BigInt(amt), 'paid only records the UTR');
  const hist = await ctx.as('vendor5').get('/api/vendor/payouts?page_size=5');
  assert.deepEqual(hist.body.items.slice(0, 2).map((x) => x.status).sort(), ['failed', 'paid']);
});

test('settlement CSV import: row-level results, only exact matches posted, unknowns kept', async () => {
  const a = await paidOrder(ctx, 'customer6', [{ product_id: '25', quantity: 1 }]);
  const b = await paidOrder(ctx, 'customer6', [{ product_id: '26', quantity: 2 }]);
  const ref = (p) => `pay_S${pad(p.payment_id)}`;
  const gross = BigInt(a.payment.amount_paise);
  const fee = ((gross * 2n) / 100n).toString();
  // a processed refund on order b, to settle as a refund row
  const rf = (await ctx.as('customer6').post(`/api/orders/${b.order.order_id}/refunds`).set('Idempotency-Key', key())
    .send({ line_no: 1, amount_paise: '5000', reason: 'partial' })).body;
  await ctx.as('finance').post(`/api/finance/refunds/${rf.refund_id}/approve`);
  const future = (await ctx.one(`SELECT ($1::date + 3)::text AS d`, [today])).d;

  const csv = [
    'gateway_ref,record_type,gross_paise,fee_paise,settled_on',
    `${ref(a.payment)},payment,${gross},${fee},${today}`,                                   // 2 matched → posted
    `${ref(a.payment)},payment,${gross},${fee},${today}`,                                   // 3 duplicate
    `${ref(a.payment)},payment,${gross},1,${today}`,                                        // 4 conflict
    `rfnd_R${pad(rf.refund_id)},refund,5000,0,${today}`,                                    // 5 matched refund
    `pay_UNKNOWNAPI01,payment,250000,5000,${today}`,                                        // 6 unknown → kept, not posted
    `${ref(b.payment)},payment,${BigInt(b.payment.amount_paise) - 100n},0,${today}`,       // 7 amount mismatch → not posted
    `pay_FEETOOHIGH01,payment,1000,1000,${today}`,                                          // 8 DB CHECK fee < gross
    `pay_FUTURE00001,payment,1000,0,${future}`,                                             // 9 future date (PRV07)
    `pay_BADDATE0001,payment,1000,0,2026-13-01`,                                            // 10 invalid date
    'pay_SHORT,payment,1000',                                                               // 11 wrong field count
    '',
  ].join('\n');
  const r = await ctx.as('finance').post('/api/finance/settlements/import').set('Content-Type', 'text/csv').send(csv);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.results.map((x) => [x.line, x]));
  assert.equal(by[2].result, 'inserted'); assert.ok(by[2].posted_entry_id);
  assert.equal(by[3].result, 'duplicate'); assert.equal(by[3].posted_entry_id, by[2].posted_entry_id);
  assert.equal(by[4].result, 'conflict');
  assert.equal(by[5].result, 'inserted'); assert.ok(by[5].posted_entry_id);
  assert.equal(by[6].result, 'inserted'); assert.equal(by[6].posted_entry_id, null);
  assert.equal(by[7].result, 'inserted'); assert.equal(by[7].posted_entry_id, null);
  assert.equal(by[8].result, 'rejected'); assert.equal(by[8].error.sqlstate, '23514');
  assert.equal(by[9].result, 'rejected'); assert.equal(by[9].error.sqlstate, 'PRV07');
  assert.equal(by[10].result, 'invalid');
  assert.equal(by[11].result, 'invalid');
  assert.deepEqual(r.body.summary, { inserted: 4, duplicate: 1, conflict: 1, rejected: 2, invalid: 2, posted: 2 });
  assert.equal((await ctx.q(`SELECT 1 FROM gateway_settlements WHERE gateway_ref IN ('pay_FEETOOHIGH01','pay_FUTURE00001')`)).length, 0,
    'rejected rows were rolled back to their savepoint');
  const st = await entryLines('settlement_id', by[2].settlement_id);
  assert.deepEqual(st.map((l) => [l.code, l.direction, l.amt]),
    [['BANK', 'D', (gross - BigInt(fee)).toString()], ['GATEWAY_FEE_EXPENSE', 'D', fee], ['GATEWAY_CLEARING', 'C', gross.toString()]]);

  const rep = async (gref) => (await ctx.as('finance').get(`/api/finance/reconciliation?as_of=${today}&gateway_ref=${gref}`)).body.items;
  const [ma] = await rep(ref(a.payment));
  assert.equal(ma.category, 'matched'); assert.ok(ma.posted_entry_id);
  const [mr] = await rep(`rfnd_R${pad(rf.refund_id)}`);
  assert.equal(mr.category, 'matched');
  const [mm] = await rep(ref(b.payment));
  assert.equal(mm.category, 'amount_mismatch'); assert.equal(mm.posted_entry_id, null);
  assert.match(mm.detail, /^reported /);
  const [mu] = await rep('pay_UNKNOWNAPI01');
  assert.equal(mu.category, 'unknown_reference'); assert.equal(mu.posted_entry_id, null);
  const cat = (await ctx.as('finance').get(`/api/finance/reconciliation?as_of=${today}&category=unknown_reference&page_size=100`)).body;
  assert.ok(cat.items.length >= 1 && cat.items.every((x) => x.category === 'unknown_reference'));
  const old = await ctx.as('finance').get(`/api/finance/reconciliation?as_of=2026-10-31&gateway_ref=${ref(a.payment)}`);
  assert.equal(old.body.items.length, 0, 'events after the as-of date are ignored');
  assert.equal((await ctx.as('finance').post('/api/finance/settlements/import').set('Content-Type', 'text/csv').send('ref,type\nx,y')).status, 422);
  assert.equal((await ctx.as('finance').get('/api/finance/reconciliation?category=bogus')).status, 422);
});

test('unknown reference is posted by a later reconcile once its payment is captured', async () => {
  const o = (await ctx.as('customer6').post('/api/orders').send({ items: [{ product_id: '27', quantity: 1 }] })).body;
  const p = (await ctx.as('customer6').post(`/api/orders/${o.order_id}/payments`).set('Idempotency-Key', key()).send({ method: 'upi' })).body;
  const ref = `pay_S${pad(p.payment_id)}`;
  const imp = await ctx.as('finance').post('/api/finance/settlements/import')
    .send({ rows: [{ gateway_ref: ref, record_type: 'payment', gross_paise: p.amount_paise, fee_paise: '0', settled_on: today }] });
  assert.equal(imp.body.results[0].result, 'inserted');
  assert.equal(imp.body.results[0].posted_entry_id, null, 'not captured yet → stored, not posted');
  await ctx.as('finance').post(`/api/mock-gateway/payments/${p.payment_id}/simulate`).send({ outcome: 'success' });
  const rec = await ctx.as('finance').post('/api/finance/reconcile').send({ as_of: today });
  assert.equal(rec.status, 200);
  const matched = rec.body.categories.find((c) => c.category === 'matched');
  assert.ok(Number(matched.newly_posted) >= 1);
  const again = await ctx.as('finance').post('/api/finance/reconcile').send({ as_of: today });
  assert.equal(again.body.categories.find((c) => c.category === 'matched').newly_posted, '0', 'reconcile posts at most once');
  const def = await ctx.as('finance').post('/api/finance/reconcile').send({});
  assert.equal(def.body.as_of, '2026-10-31', 'default as-of is the configured demo date');
  const invalidJson = await ctx.as('finance').post('/api/finance/settlements/import').send({ rows: [{ gateway_ref: 'x' }] });
  assert.equal(invalidJson.body.results[0].result, 'invalid');
});

test('trial balance balances; vendor balances listed; settlements listed', async () => {
  const tb = await ctx.as('finance').get('/api/finance/trial-balance');
  assert.equal(tb.status, 200);
  assert.equal(tb.body.balanced, true);
  assert.equal(tb.body.total_debit_paise, tb.body.total_credit_paise);
  console.log(`# trial balance after API tests: ${tb.body.total_debit_paise} paise each side`);
  const vs = await ctx.as('finance').get('/api/finance/vendors');
  const v7 = vs.body.items.find((v) => v.vendor_id === '7');
  assert.ok(BigInt(v7.balance_paise) < 0n, 'seeded negative vendor balance is visible');
  const s = await ctx.as('finance').get(`/api/finance/settlements?settled_on=${today}`);
  assert.ok(s.body.items.length >= 5);
});
