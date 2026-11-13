// Finance operations endpoints added on 2026-11-03 (overview, trace, exact-record
// reads used for lost-response recovery, journal-entries?entry_id=). All are
// read-only and finance-only; these tests check the numbers against the database,
// that nothing is posted on GET, and that other roles are refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './_setup.js';

let ctx;
before(async () => {
  ctx = await start();
  await ctx.login('finance', 'customer1', 'vendor1');
});
after(async () => ctx.stop());

const ledgerCount = async () => (await ctx.one('SELECT count(*)::int AS n FROM journal_entries')).n;

test('overview: queue totals, negative vendors and reconciliation categories agree with the database; GET posts nothing', async () => {
  const before = await ledgerCount();
  const r = await ctx.as('finance').get('/api/finance/overview?as_of=2026-10-31');
  assert.equal(r.status, 200);
  assert.equal(r.body.as_of, '2026-10-31');

  const ref = await ctx.one(`SELECT count(*)::text AS items, coalesce(sum(amount_paise),0)::text AS amt
                               FROM refunds WHERE status = 'requested'`);
  assert.equal(String(r.body.refunds.items), ref.items);
  assert.equal(r.body.refunds.amount_paise, ref.amt);
  assert.equal(typeof r.body.refunds.amount_paise, 'string', 'paise stay strings');
  const pay = await ctx.one(`SELECT count(*)::text AS items, coalesce(sum(amount_paise),0)::text AS amt
                               FROM payouts WHERE status = 'requested'`);
  assert.equal(String(r.body.payouts.items), pay.items);
  assert.equal(r.body.payouts.amount_paise, pay.amt);

  const neg = await ctx.q(`SELECT vendor_id::text FROM v_account_balances
                            WHERE owner_type = 'vendor' AND balance_paise < 0 ORDER BY balance_paise`);
  assert.deepEqual(r.body.negative_vendors.map((v) => String(v.vendor_id)), neg.map((v) => v.vendor_id));
  assert.ok(neg.length >= 1, 'the seed ends with a negative-balance vendor (DEC-030 scenario)');

  const cats = await ctx.q(`SELECT category, count(*)::text AS n FROM fn_reconciliation_report('2026-10-31')
                             GROUP BY category ORDER BY category`);
  assert.deepEqual(r.body.categories.map((c) => [c.category, String(c.items)]), cats.map((c) => [c.category, c.n]));
  assert.equal(cats.length, 5, 'all five reconciliation categories present in the seed');

  assert.equal(await ledgerCount(), before, 'overview is read-only');
});

test('overview: default as-of is the configured demo date; bad dates are rejected (422)', async () => {
  const r = await ctx.as('finance').get('/api/finance/overview');
  assert.equal(r.status, 200);
  assert.equal(r.body.as_of, '2026-10-31');
  const bad = await ctx.as('finance').get('/api/finance/overview?as_of=2026-13-40');
  assert.equal(bad.status, 422);
});

test('exact-record reads: refunds/:id and payouts/:id return the stored row without the idempotency key; 404 / 422 otherwise', async () => {
  const rf = await ctx.one(`SELECT refund_id::text AS id, status, amount_paise::text AS amt FROM refunds ORDER BY refund_id LIMIT 1`);
  const r = await ctx.as('finance').get(`/api/finance/refunds/${rf.id}`);
  assert.equal(r.status, 200);
  assert.equal(String(r.body.refund_id), rf.id);
  assert.equal(r.body.status, rf.status);
  assert.equal(r.body.amount_paise, rf.amt);
  assert.ok(!('idempotency_key' in r.body), 'idempotency key is not exposed');

  const po = await ctx.one(`SELECT payout_id::text AS id, status FROM payouts WHERE status = 'failed' ORDER BY payout_id LIMIT 1`);
  const p = await ctx.as('finance').get(`/api/finance/payouts/${po.id}`);
  assert.equal(p.status, 200);
  assert.equal(p.body.status, 'failed');
  assert.ok(!('idempotency_key' in p.body));

  assert.equal((await ctx.as('finance').get('/api/finance/refunds/999999999')).status, 404);
  assert.equal((await ctx.as('finance').get('/api/finance/payouts/999999999')).status, 404);
  assert.equal((await ctx.as('finance').get('/api/finance/payouts/abc')).status, 422);
  assert.equal((await ctx.as('finance').get('/api/finance/payouts/-1')).status, 422);
});

test('trace: payment, refund and entry kinds; unknown kind is 422, missing id 404', async () => {
  const pm = await ctx.one(`SELECT payment_id::text AS id, gateway_ref FROM payments WHERE status = 'captured' ORDER BY payment_id LIMIT 1`);
  const t = await ctx.as('finance').get(`/api/finance/trace/payment/${pm.id}`);
  assert.equal(t.status, 200);
  assert.equal(t.body.gateway_ref, pm.gateway_ref);
  assert.ok(!('idempotency_key' in t.body));

  const rf = await ctx.one(`SELECT refund_id::text AS id FROM refunds WHERE status = 'processed' ORDER BY refund_id LIMIT 1`);
  assert.equal(String((await ctx.as('finance').get(`/api/finance/trace/refund/${rf.id}`)).body.refund_id), rf.id);

  const en = await ctx.one(`SELECT entry_id::text AS id, entry_type FROM journal_entries ORDER BY entry_id LIMIT 1`);
  const te = await ctx.as('finance').get(`/api/finance/trace/entry/${en.id}`);
  assert.equal(te.status, 200);
  assert.equal(te.body.entry_type, en.entry_type);

  assert.equal((await ctx.as('finance').get(`/api/finance/trace/users/1`)).status, 422, 'only whitelisted kinds');
  assert.equal((await ctx.as('finance').get(`/api/finance/trace/payment/999999999`)).status, 404);
});

test('journal-entries?entry_id= returns exactly that balanced entry with string amounts', async () => {
  const en = await ctx.one(`SELECT entry_id::text AS id FROM journal_entries WHERE entry_type = 'capture' ORDER BY entry_id DESC LIMIT 1`);
  const r = await ctx.as('finance').get(`/api/finance/journal-entries?entry_id=${en.id}`);
  assert.equal(r.status, 200);
  assert.equal(String(r.body.total), "1");
  const [e] = r.body.items;
  assert.equal(String(e.entry_id), en.id);
  assert.ok(e.lines.length >= 2);
  let d = 0n, c = 0n;
  for (const l of e.lines) {
    assert.equal(typeof l.amount_paise, 'string');
    if (l.direction === 'D') d += BigInt(l.amount_paise); else c += BigInt(l.amount_paise);
  }
  assert.equal(d, c, 'returned entry balances');
  assert.equal((await ctx.as('finance').get('/api/finance/journal-entries?entry_id=x')).status, 422);
});

test('vendor and customer tokens are refused on every operations endpoint; no token is 401', async () => {
  const rf = (await ctx.one('SELECT refund_id::text AS id FROM refunds LIMIT 1')).id;
  const po = (await ctx.one('SELECT payout_id::text AS id FROM payouts LIMIT 1')).id;
  const paths = ['/api/finance/overview', `/api/finance/refunds/${rf}`, `/api/finance/payouts/${po}`,
    '/api/finance/trace/payment/1', '/api/finance/journal-entries?entry_id=1'];
  for (const p of paths) {
    for (const who of ['vendor1', 'customer1']) {
      const r = await ctx.as(who).get(p);
      assert.equal(r.status, 403, `${who} ${p}`);
    }
    assert.equal((await ctx.api().get(p)).status, 401, `anonymous ${p}`);
  }
});
