// Named reports R1–R6 over HTTP (Task 6): role/ownership scoping, filters,
// validation, lossless strings, and agreement with the database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from './_setup.js';

let ctx;
let v3;                                            // vendor id owned by vendor3@payrail.demo
before(async () => {
  ctx = await start();
  await ctx.login('finance', 'vendor3', 'vendor7', 'customer1');
  v3 = (await ctx.one(`SELECT v.vendor_id::text AS id FROM vendors v JOIN users u ON u.user_id = v.owner_user_id
                        WHERE u.email = 'vendor3@payrail.demo'`)).id;
});
after(async () => ctx.stop());

const NAMES = ['trial-balance', 'vendor-statement?vendor_id=1', 'monthly-performance', 'refund-risk', 'settlement-aging', 'vendor-payables'];

test('reports are finance-only; unauthenticated → 401, customer/vendor → 403', async () => {
  for (const n of NAMES) {
    assert.equal((await ctx.api().get(`/api/finance/reports/${n}`)).status, 401, n);
    assert.equal((await ctx.as('customer1').get(`/api/finance/reports/${n}`)).status, 403, n);
    assert.equal((await ctx.as('vendor3').get(`/api/finance/reports/${n}`)).status, 403, n);
    assert.equal((await ctx.as('finance').get(`/api/finance/reports/${n}`)).status, 200, n);
  }
  const list = await ctx.as('finance').get('/api/finance/reports');
  assert.deepEqual(list.body.items.map((x) => x.id), ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
  assert.equal((await ctx.as('customer1').get('/api/vendor/reports/payables')).status, 403);
});

test('R1 trial balance: balanced, totals as strings equal the ledger, as_of filter, legacy path agrees', async () => {
  const r = await ctx.as('finance').get('/api/finance/reports/trial-balance');
  assert.equal(r.body.id, 'R1');
  assert.equal(r.body.total.balanced, true);
  assert.equal(typeof r.body.total.debit_paise, 'string');
  const db = await ctx.one(`SELECT sum(amount_paise) FILTER (WHERE direction = 'D')::text d,
                                   sum(amount_paise) FILTER (WHERE direction = 'C')::text c FROM ledger_lines`);
  assert.equal(r.body.total.debit_paise, db.d);
  assert.equal(r.body.total.credit_paise, db.c);
  assert.equal(r.body.accounts.length, Number((await ctx.one('SELECT count(*)::int n FROM accounts')).n));
  const sep = await ctx.as('finance').get('/api/finance/reports/trial-balance?as_of=2026-09-30');
  assert.equal(sep.body.total.balanced, true);
  assert.ok(BigInt(sep.body.total.debit_paise) < BigInt(r.body.total.debit_paise), 'September is a prefix of the ledger');
  const legacy = await ctx.as('finance').get('/api/finance/trial-balance');
  assert.equal(legacy.body.total_debit_paise, r.body.total.debit_paise);
  assert.equal(legacy.body.balanced, true);
  assert.equal((await ctx.as('finance').get('/api/finance/reports/trial-balance?as_of=2026-13-01')).status, 422);
  assert.equal((await ctx.as('finance').get('/api/finance/reports/trial-balance?foo=1')).status, 422, 'strict query');
});

test('R2 vendor statement (finance + vendor): opening + period = closing; closing = ledger balance; scoping', async () => {
  const all = await ctx.as('finance').get(`/api/finance/reports/vendor-statement?vendor_id=${v3}&page_size=100`);
  assert.equal(all.status, 200);
  const bal = (await ctx.one('SELECT fn_vendor_balance($1)::text b', [v3])).b;
  assert.equal(all.body.closing_balance_paise, bal);
  const win = await ctx.as('vendor3').get('/api/vendor/statement?from=2026-10-01&to=2026-10-15&page_size=100');
  const { opening_balance_paise: o, closing_balance_paise: c, period_credit_paise: pc, period_debit_paise: pd } = win.body;
  assert.equal((BigInt(o) + BigInt(pc) - BigInt(pd)).toString(), c);
  const last = win.body.items.at(-1);
  assert.equal(last.running_balance_paise, c, 'last running balance = closing');
  assert.equal(win.body.items.length, Number(win.body.total));
  assert.ok(win.body.items.every((l) => typeof l.reference === 'string' && l.reference.length > 0));
  // finance sees the same statement for that vendor
  const fin = await ctx.as('finance').get(`/api/finance/reports/vendor-statement?vendor_id=${v3}&from=2026-10-01&to=2026-10-15&page_size=100`);
  assert.deepEqual(fin.body.items, win.body.items);
  assert.equal((await ctx.as('finance').get('/api/finance/reports/vendor-statement')).status, 422, 'vendor_id required');
  assert.equal((await ctx.as('finance').get('/api/finance/reports/vendor-statement?vendor_id=999999')).status, 404);
  // a vendor cannot ask for someone else's statement: vendor_id is not an accepted parameter
  assert.equal((await ctx.as('vendor3').get('/api/vendor/statement?vendor_id=1')).status, 422);
});

test('R3 monthly performance: months in order, sums agree with payments, range validation', async () => {
  const r = await ctx.as('finance').get('/api/finance/reports/monthly-performance');
  assert.deepEqual(r.body.items.map((m) => m.month), ['2026-09-01', '2026-10-01']);
  const sum = r.body.items.reduce((a, m) => a + BigInt(m.captured_gross_paise), 0n);
  const db = (await ctx.one(`SELECT sum(amount_paise)::text s FROM payments WHERE status = 'captured'`)).s;
  assert.equal(sum.toString(), db);
  assert.equal(r.body.items.at(-1).cumulative_gross_paise, db);
  const range = await ctx.as('finance').get('/api/finance/reports/monthly-performance?from=2026-08-01&to=2026-11-30');
  assert.equal(range.body.items.length, 4);
  assert.equal(range.body.items[0].payments_captured, '0');
  assert.equal((await ctx.as('finance').get('/api/finance/reports/monthly-performance?from=2026-10-01&to=2026-09-01')).status, 422);
  assert.equal((await ctx.as('finance').get('/api/finance/reports/monthly-performance?from=1900-01-01&to=2026-01-01')).status, 422);
});

test('R4 refund risk: explicit rate = rhu(refunded × 10000 / sales); vendor sees only its own row, without rank', async () => {
  const r = await ctx.as('finance').get('/api/finance/reports/refund-risk');
  assert.equal(r.body.items.length, Number((await ctx.one('SELECT count(*)::int n FROM vendors')).n));
  for (const x of r.body.items.filter((i) => i.refund_rate_bps !== null)) {
    const s = BigInt(x.sales_paise), f = BigInt(x.refunded_paise);
    assert.equal(x.refund_rate_bps, ((2n * f * 10000n + s) / (2n * s)).toString(), `vendor ${x.vendor_id}`);
  }
  const mine = await ctx.as('vendor7').get('/api/vendor/reports/refund-risk');
  const v7 = r.body.items.find((x) => x.vendor_id === mine.body.item.vendor_id);
  assert.equal(mine.body.item.refund_rate_bps, v7.refund_rate_bps);
  assert.equal('rate_rank' in mine.body.item, false);
  assert.equal(mine.body.item.risk_band, 'high');
  assert.equal((await ctx.as('vendor7').get('/api/vendor/reports/refund-risk?vendor_id=1')).status, 422);
  const cohort = await ctx.as('finance').get('/api/finance/reports/refund-risk?from=2026-10-01&to=2026-10-31&min_sales_paise=0');
  assert.equal(cohort.status, 200);
  assert.equal((await ctx.as('finance').get('/api/finance/reports/refund-risk?min_sales_paise=-1')).status, 422);
});

test('R5 settlement aging: default demo as-of, five categories, total = reconciliation rows', async () => {
  const r = await ctx.as('finance').get('/api/finance/reports/settlement-aging');
  assert.equal(r.body.as_of, '2026-10-31');
  const cats = r.body.items.filter((x) => x.is_subtotal).map((x) => x.category);
  assert.deepEqual(cats, ['amount_mismatch', 'in_transit', 'matched', 'overdue_missing', 'unknown_reference']);
  const n = (await ctx.one(`SELECT count(*)::text n FROM fn_reconciliation_report('2026-10-31')`)).n;
  assert.equal(r.body.total.items, n);
  const early = await ctx.as('finance').get('/api/finance/reports/settlement-aging?as_of=2026-09-15');
  assert.ok(BigInt(early.body.total.items) < BigInt(n));
});

test('R6 payables: identity per vendor; vendor scope; negative vendor flagged', async () => {
  const r = await ctx.as('finance').get('/api/finance/reports/vendor-payables');
  for (const x of r.body.items) {
    const lhs = BigInt(x.sales_paise) - BigInt(x.refunds_paise) - BigInt(x.payouts_paise) + BigInt(x.reversals_paise);
    assert.equal(lhs.toString(), x.balance_paise);
    assert.equal(x.ledger_consistent, true);
  }
  const mine = await ctx.as('vendor7').get('/api/vendor/reports/payables');
  assert.equal(mine.body.item.status, 'negative');
  const one = await ctx.as('finance').get(`/api/finance/reports/vendor-payables?vendor_id=${mine.body.item.vendor_id}`);
  assert.deepEqual(one.body.items, [mine.body.item]);
});
