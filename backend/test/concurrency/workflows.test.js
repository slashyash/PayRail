// Genuine concurrency tests for the Task 2 stored workflows.
// Run: cd backend && npm run test:concurrency   (needs an admin PG* environment;
// rebuilds the dedicated database payrail_conc first — see harness.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildDatabase, adminClient, race, tally, uuid } from './harness.js';

let admin;
const id = {};
let seq = 0;
const nextKey = () => uuid(++seq);
const log = (name, r) =>
  console.log(`# ${name}: outcomes ${JSON.stringify(tally(r.results))}, max workers blocked on a lock: ${r.maxBlocked}`);

async function one(sql, params) {
  const { rows } = await admin.query(sql, params);
  return rows[0];
}

// place + pay an order as the customer; returns the order id
async function paidOrder(items) {
  const { o } = await one('SELECT fn_place_order($1, $2::jsonb) AS o', [id.customer, JSON.stringify(items)]);
  const p = await one('SELECT * FROM fn_initiate_payment($1, $2, $3, $4)', [id.customer, o, 'upi', nextKey()]);
  await one('SELECT * FROM fn_capture_payment($1, $2, $3)', [p.payment_id, `pay_CONC${String(seq).padStart(6, '0')}`, p.amount_paise]);
  return o;
}
const balance = async (vendorId) => BigInt((await one('SELECT fn_vendor_balance($1) AS b', [vendorId])).b);

before(async () => {
  rebuildDatabase();
  admin = await adminClient();
  await admin.query(`
    INSERT INTO users (full_name, email, role, password_hash) VALUES
      ('Conc Customer', 'cust@conc.test', 'customer',      crypt('pw', gen_salt('bf', 4))),
      ('Conc Vendor A', 'va@conc.test',   'vendor_admin',  crypt('pw', gen_salt('bf', 4))),
      ('Conc Vendor B', 'vb@conc.test',   'vendor_admin',  crypt('pw', gen_salt('bf', 4))),
      ('Conc Finance',  'fin@conc.test',  'finance_admin', crypt('pw', gen_salt('bf', 4)))`);
  for (const [k, email] of [['customer', 'cust'], ['va', 'va'], ['vb', 'vb'], ['finance', 'fin']]) {
    id[k] = (await one('SELECT user_id FROM users WHERE email = $1', [`${email}@conc.test`])).user_id;
  }
  id.vendorA = (await one(`INSERT INTO vendors (owner_user_id, legal_name, commission_bps, kyc_status)
                           VALUES ($1, 'Conc A', 1000, 'verified') RETURNING vendor_id`, [id.va])).vendor_id;
  id.vendorB = (await one(`INSERT INTO vendors (owner_user_id, legal_name, commission_bps, kyc_status)
                           VALUES ($1, 'Conc B', 250, 'verified') RETURNING vendor_id`, [id.vb])).vendor_id;
  id.prodA = (await one(`INSERT INTO products (vendor_id, name, price_paise) VALUES ($1, 'Bottle', 49999) RETURNING product_id`, [id.vendorA])).product_id;
  id.prodB = (await one(`INSERT INTO products (vendor_id, name, price_paise) VALUES ($1, 'Saree', 123456) RETURNING product_id`, [id.vendorB])).product_id;
});

after(async () => {
  const tb = await one('SELECT sum(debit_paise)::text AS d, sum(credit_paise)::text AS c FROM v_account_balances');
  console.log(`# final trial balance: debits ${tb.d} = credits ${tb.c}`);
  assert.equal(tb.d, tb.c);
  await admin.end();
});

test('8 concurrent payouts of 30% each: exactly 3 succeed, no overspending', async () => {
  await paidOrder([{ product_id: id.prodA, quantity: 10 }]);          // V = 499990 − 50000 − 9000 = 440990
  const start = await balance(id.vendorA);
  const amount = (start * 30n) / 100n;
  const r = await race(8, async (c, i) =>
    (await c.query('SELECT * FROM fn_request_payout($1, $2, $3)', [id.va, amount.toString(), uuid(1000 + i)])).rows[0]);
  log('payouts', r);
  const t = tally(r.results);
  assert.equal(t.ok, 3);
  assert.equal(t.PRF01, 5);
  assert.equal(await balance(id.vendorA), start - 3n * amount);
  assert.ok((await balance(id.vendorA)) >= 0n);
  assert.ok(r.maxBlocked >= 1, 'workers really waited on the account lock');
});

test('8 concurrent duplicates of one payout key: one payout, one posting, same id for all', async () => {
  await paidOrder([{ product_id: id.prodA, quantity: 2 }]);
  const start = await balance(id.vendorA);
  const key = uuid(2000);
  const r = await race(8, async (c) =>
    (await c.query('SELECT * FROM fn_request_payout($1, $2, $3)', [id.va, '1000', key])).rows[0]);
  log('payout same key', r);
  assert.equal(tally(r.results).ok, 8);
  assert.equal(new Set(r.results.map((x) => x.value.payout_id)).size, 1);
  const n = await one(`SELECT count(*)::int AS n FROM journal_entries je JOIN payouts p USING (payout_id)
                        WHERE p.idempotency_key = $1`, [key]);
  assert.equal(n.n, 1);
  assert.equal(await balance(id.vendorA), start - 1000n);
});

test('same payout key with 8 different amounts: one wins, the rest get PRI01', async () => {
  const key = uuid(3000);
  const r = await race(8, async (c, i) =>
    (await c.query('SELECT * FROM fn_request_payout($1, $2, $3)', [id.va, String(100 + i), key])).rows[0]);
  log('payout key conflict', r);
  const t = tally(r.results);
  assert.equal(t.ok, 1);
  assert.equal(t.PRI01, 7);
  assert.equal((await one('SELECT count(*)::int AS n FROM payouts WHERE idempotency_key = $1', [key])).n, 1);
});

test('8 concurrent refund requests of ₹400 on one ₹1499.97 line: exactly 3 reserved', async () => {
  const o = await paidOrder([{ product_id: id.prodA, quantity: 3 }]);  // L = 149997
  const r = await race(8, async (c, i) =>
    (await c.query('SELECT * FROM fn_request_refund($1, $2, 1, 40000, $3, $4)',
                   [id.customer, o, 'race', uuid(4000 + i)])).rows[0]);
  log('refund requests', r);
  const t = tally(r.results);
  assert.equal(t.ok, 3);
  assert.equal(t.PRR01, 5);
  const a = await one('SELECT refundable_paise::bigint AS x FROM v_order_line_allocation WHERE order_id = $1 AND line_no = 1', [o]);
  assert.equal(BigInt(a.x), 149997n - 120000n);
  id.raceOrder = o;
  id.raceRefunds = r.results.filter((x) => x.ok).map((x) => x.value.refund_id);
});

test('8 concurrent approvals of the same refund: processed once, one refund entry', async () => {
  const refundId = id.raceRefunds[0];
  const before = await balance(id.vendorA);
  const r = await race(8, async (c) =>
    (await c.query('SELECT * FROM fn_approve_refund($1, $2)', [id.finance, refundId])).rows[0]);
  log('refund approvals', r);
  assert.equal(tally(r.results).ok, 8);
  assert.ok(r.results.every((x) => x.value.status === 'processed'));
  assert.equal((await one('SELECT count(*)::int AS n FROM journal_entries WHERE refund_id = $1', [refundId])).n, 1);
  // ΔV for ₹400 of L=149997 (C 15000, G 2700): ΔC = rhu(4000.08) = 4000, ΔG = rhu(720.01) = 720 → ΔV = 35280
  assert.equal(await balance(id.vendorA), before - 35280n);
});

test('concurrent approvals of DIFFERENT refunds of one line: cumulative allocation stays exact', async () => {
  const [, r2, r3] = id.raceRefunds;
  const r = await race(2, async (c, i) =>
    (await c.query('SELECT * FROM fn_approve_refund($1, $2)', [id.finance, [r2, r3][i]])).rows[0]);
  log('approvals on one line', r);
  assert.equal(tally(r.results).ok, 2);
  // three processed refunds of 40000 → cumulative 120000: C = rhu(15000·120000/149997) = 12000, G = 2160
  const s = await one(`SELECT sum(l.amount_paise) FILTER (WHERE a.code = 'COMMISSION_REVENUE')::bigint AS c,
                              sum(l.amount_paise) FILTER (WHERE a.code = 'GST_PAYABLE')::bigint AS g
                         FROM journal_entries e JOIN ledger_lines l USING (entry_id) JOIN accounts a USING (account_id)
                        WHERE e.refund_id = ANY ($1::bigint[])`, [id.raceRefunds]);
  assert.equal(s.c, '12000');
  assert.equal(s.g, '2160');
});

test('8 concurrent "failed" completions of one payout: exactly one reversal', async () => {
  const p = await one('SELECT * FROM fn_request_payout($1, $2, $3)', [id.va, '5000', nextKey()]);
  const before = await balance(id.vendorA);
  const r = await race(8, async (c) =>
    (await c.query(`SELECT * FROM fn_complete_payout($1, $2, 'failed', NULL)`, [id.finance, p.payout_id])).rows[0]);
  log('payout failures', r);
  assert.equal(tally(r.results).ok, 8);
  const n = await one(`SELECT count(*)::int AS n FROM journal_entries
                        WHERE reverses_entry_id = (SELECT entry_id FROM journal_entries WHERE payout_id = $1)`, [p.payout_id]);
  assert.equal(n.n, 1);
  assert.equal(await balance(id.vendorA), before + 5000n);
});

test('paid vs failed raced on one payout: one terminal outcome wins, the other gets PRS01', async () => {
  const p = await one('SELECT * FROM fn_request_payout($1, $2, $3)', [id.va, '7000', nextKey()]);
  const r = await race(2, async (c, i) =>
    (await c.query('SELECT * FROM fn_complete_payout($1, $2, $3, $4)',
                   [id.finance, p.payout_id, i === 0 ? 'paid' : 'failed', i === 0 ? 'UTRCONC0000001' : null])).rows[0]);
  log('paid vs failed', r);
  const t = tally(r.results);
  assert.equal(t.ok, 1);
  assert.equal(t.PRS01, 1);
  const final = await one('SELECT status FROM payouts WHERE payout_id = $1', [p.payout_id]);
  const reversals = await one(`SELECT count(*)::int AS n FROM journal_entries
                               WHERE reverses_entry_id = (SELECT entry_id FROM journal_entries WHERE payout_id = $1)`, [p.payout_id]);
  assert.equal(reversals.n, final.status === 'failed' ? 1 : 0);
});

test('two payment attempts of one order captured concurrently: exactly one capture', async () => {
  const { o } = await one('SELECT fn_place_order($1, $2::jsonb) AS o', [id.customer, JSON.stringify([{ product_id: id.prodB, quantity: 1 }])]);
  const a = await one('SELECT * FROM fn_initiate_payment($1, $2, $3, $4)', [id.customer, o, 'upi', nextKey()]);
  const b = await one('SELECT * FROM fn_initiate_payment($1, $2, $3, $4)', [id.customer, o, 'card', nextKey()]);
  const pays = [a.payment_id, b.payment_id];
  const r = await race(8, async (c, i) =>
    (await c.query('SELECT * FROM fn_capture_payment($1, $2, 123456)', [pays[i % 2], `pay_DBL${String(pays[i % 2]).padStart(6, "0")}`])).rows[0]);
  log('double capture', r);
  const t = tally(r.results);
  assert.equal(t.ok, 4);              // the winner's 4 callbacks (1 capture + 3 harmless replays)
  assert.equal(t.PRS02, 4);           // the other attempt's 4 callbacks
  assert.equal((await one(`SELECT count(*)::int AS n FROM payments WHERE order_id = $1 AND status = 'captured'`, [o])).n, 1);
  assert.equal((await one(`SELECT count(*)::int AS n FROM journal_entries WHERE payment_id = ANY ($1::bigint[])`, [pays])).n, 1);
});

test('8 concurrent initiations with one key: one payment attempt', async () => {
  const { o } = await one('SELECT fn_place_order($1, $2::jsonb) AS o', [id.customer, JSON.stringify([{ product_id: id.prodB, quantity: 1 }])]);
  const key = uuid(5000);
  const r = await race(8, async (c) =>
    (await c.query('SELECT * FROM fn_initiate_payment($1, $2, $3, $4)', [id.customer, o, 'upi', key])).rows[0]);
  log('initiate same key', r);
  assert.equal(tally(r.results).ok, 8);
  assert.equal(new Set(r.results.map((x) => x.value.payment_id)).size, 1);
  assert.equal((await one('SELECT count(*)::int AS n FROM payments WHERE order_id = $1', [o])).n, 1);
});

test('payout requests racing a late refund approval on the same vendor: balance never overspent', async () => {
  const o = await paidOrder([{ product_id: id.prodB, quantity: 2 }]);     // vendor B: L 246912, V 240158
  const { refund_id } = await one('SELECT * FROM fn_request_refund($1, $2, 1, 200000, $3, $4)', [id.customer, o, 'late', nextKey()]);
  const start = await balance(id.vendorB);
  const payout = (start * 45n) / 100n;
  const r = await race(5, async (c, i) => {
    if (i === 0) return (await c.query('SELECT * FROM fn_approve_refund($1, $2)', [id.finance, refund_id])).rows[0];
    return (await c.query('SELECT * FROM fn_request_payout($1, $2, $3)', [id.vb, payout.toString(), uuid(6000 + i)])).rows[0];
  });
  log('payouts vs refund', r);
  assert.ok(r.results[0].ok, 'refund approval always succeeds (may drive the balance negative)');
  assert.ok(!r.results.some((x) => x.code === '40P01'), 'no deadlock');
  const paid = r.results.slice(1).filter((x) => x.ok).length;
  assert.ok(paid <= 2, 'at most two 45% payouts fit the starting balance');
  const v = await one(`SELECT sum(l.amount_paise)::bigint AS d FROM journal_entries e JOIN ledger_lines l USING (entry_id)
                        JOIN accounts a USING (account_id) WHERE e.refund_id = $1 AND a.owner_type = 'vendor'`, [refund_id]);
  assert.equal(await balance(id.vendorB), start - BigInt(paid) * payout - BigInt(v.d));
  // Replay vendor B's payable account in posting (entry_id) order — the order in which the
  // account lock was obtained — and check every payout fitted the balance at that moment.
  const lines = (await admin.query(
    `SELECT e.entry_type, l.direction, l.amount_paise::bigint AS amt
       FROM ledger_lines l JOIN journal_entries e USING (entry_id)
      WHERE l.account_id = fn_vendor_payable_account($1) ORDER BY l.entry_id, l.line_no`, [id.vendorB])).rows;
  let bal = 0n;
  for (const x of lines) {
    const amt = BigInt(x.amt);
    if (x.entry_type === 'payout') assert.ok(bal >= amt, `payout of ${amt} exceeded balance ${bal}`);
    bal += x.direction === 'C' ? amt : -amt;
  }
});

test('8 concurrent imports of the same settlement row: stored once, posted once', async () => {
  const o = await paidOrder([{ product_id: id.prodA, quantity: 1 }]);
  const p = await one(`SELECT gateway_ref, amount_paise FROM payments WHERE order_id = $1 AND status = 'captured'`, [o]);
  const r = await race(8, async (c) =>
    (await c.query('SELECT * FROM fn_record_settlement($1, $2, $3, $4, $5, current_date)',
                   [id.finance, p.gateway_ref, 'payment', p.amount_paise, '1000'])).rows[0]);
  log('settlement import', r);
  assert.equal(tally(r.results).ok, 8);
  const results = r.results.map((x) => x.value.result).sort();
  assert.deepEqual(results, ['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'inserted']);
  assert.equal((await one(`SELECT count(*)::int AS n FROM journal_entries je JOIN gateway_settlements s USING (settlement_id)
                            WHERE s.gateway_ref = $1`, [p.gateway_ref])).n, 1);
});
