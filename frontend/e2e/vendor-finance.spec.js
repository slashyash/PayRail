// Task 5 acceptance, driven through the real UI (Chromium) against the real
// backend and the freshly seeded `payrail_e2e` database (see playwright.config.js).
//   * vendor catalogue CRUD: create draft, edit, archive/reactivate, delete draft, refused delete of an ordered product
//   * vendor → finance payout: request (+ same-key replay), failed → restored exactly once, overspend refused, paid with UTR
//   * unverified vendor and negative-balance vendor cannot request payouts (database refusals)
//   * customer → finance refund: customer requests in the UI, finance approves / rejects in the UI
//   * settlement CSV import (sample files) + reconciliation categories, including an unknown reference
//     that is posted later when its payment appears
// Database effects are checked through the API as BigInt paise.
// NOTE: the settlement test expects the seeded settlement state (default: the DB is rebuilt per run).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { formatINR } from '../src/lib/money.js';

const API = 'http://127.0.0.1:4100/api';
const PASSWORD = 'PayRail@2026';
const SAMPLES = new URL('../../samples/settlements/', import.meta.url);
const big = (s) => BigInt(s);
const rupees = (p) => `${p / 100n}.${String(p % 100n).padStart(2, '0')}`;
const EXPECTED_CONSOLE = /Failed to load resource: the server responded with a status of (404|409|422)/;

async function login(page, email, landing) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(landing);
}

async function logout(page) {
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

async function apiAs(request, email) {
  const r = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(r.ok(), email).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await r.json()).token}` };
  return {
    get: async (path) => { const x = await request.get(`${API}${path}`, { headers }); expect(x.ok(), path).toBeTruthy(); return x.json(); },
    post: (path, data, extra = {}) => request.post(`${API}${path}`, { headers: { ...headers, ...extra }, data }),
  };
}

function watchConsole(page) {
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' && !EXPECTED_CONSOLE.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('dialog', (d) => d.accept());            // confirm() for delete / failed payout
  return problems;
}

/** customer1 places a one-line order and the payment is captured (via the finance simulator API) */
async function paidOrder(request, quantity = 2) {
  const cust = await apiAs(request, 'customer1@payrail.demo');
  const fin = await apiAs(request, 'finance@payrail.demo');
  const product = (await cust.get('/products?page_size=1&sort=price_desc')).items[0];
  const order = await (await cust.post('/orders', { items: [{ product_id: product.product_id, quantity }] })).json();
  const attempt = await (await cust.post(`/orders/${order.order_id}/payments`, { method: 'upi' }, { 'Idempotency-Key': crypto.randomUUID() })).json();
  expect((await fin.post(`/mock-gateway/payments/${attempt.payment_id}/simulate`, { outcome: 'success' })).ok()).toBeTruthy();
  return { cust, fin, order, attempt };
}

test('vendor catalogue: create a draft, edit it, archive / reactivate, delete it; an ordered product cannot be deleted', async ({ page, request }) => {
  const problems = watchConsole(page);
  await login(page, 'vendor1@payrail.demo', /\/vendor$/);
  await expect(page.getByTestId('kyc-status')).toContainText('verified');
  await page.getByRole('link', { name: 'Products', exact: true }).click();

  const name = `E2E Draft Kettle ${Date.now()}`;
  const create = page.getByTestId('product-create');
  await create.getByLabel('Name').fill(name);
  await create.getByLabel('Price (₹)').fill('1,249.50');
  await create.getByLabel(/Save as draft/).check();
  await create.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'added as a draft' })).toBeVisible();

  const row = page.getByTestId('product-row').filter({ hasText: name });
  await expect(row).toContainText('₹1,249.50');
  await expect(row).toContainText('archived');
  const productId = await row.getAttribute('data-product-id');
  // a draft is not in the shop
  const cust = await apiAs(request, 'customer1@payrail.demo');
  expect((await cust.get(`/products?q=${encodeURIComponent(name)}`)).items).toHaveLength(0);

  // edit the price exactly (string → paise, no floats)
  await row.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByTestId('product-edit');
  await edit.getByLabel('Price in rupees').fill('999.99');
  await edit.getByRole('button', { name: 'Save' }).click();
  const saved = page.locator(`[data-testid=product-row][data-product-id="${productId}"]`);
  await expect(saved).toContainText('₹999.99');

  // reactivate → for sale; archive again
  await saved.getByRole('button', { name: 'Reactivate' }).click();
  await expect(saved).toContainText('active');
  const listed = (await cust.get(`/products?q=${encodeURIComponent(name)}`)).items;
  expect(listed.map((p) => p.price_paise)).toEqual(['99999']);
  await saved.getByRole('button', { name: 'Archive' }).click();
  await expect(saved).toContainText('archived');

  // never ordered → delete works
  await saved.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'deleted' })).toBeVisible();
  await expect(page.locator(`[data-product-id="${productId}"]`)).toHaveCount(0);

  // a product with order history: the foreign key from order_items refuses the delete
  const ordered = page.getByTestId('product-row').filter({ hasText: 'ordered' }).first();
  const orderedId = await ordered.getAttribute('data-product-id');
  await ordered.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('alert')).toContainText('referenced · SQLSTATE 23503');
  await expect(page.locator(`[data-product-id="${orderedId}"]`)).toHaveCount(1);
  expect(problems).toEqual([]);
});

test('vendor → finance payout: replay is harmless, overspend refused, failed transfer restores funds exactly once, paid needs a UTR', async ({ page, request }) => {
  const problems = watchConsole(page);
  const vendor = await apiAs(request, 'vendor1@payrail.demo');
  const fin = await apiAs(request, 'finance@payrail.demo');
  const before = big((await vendor.get('/vendor/me')).balance_paise);
  expect(before > 20000n).toBeTruthy();
  const payoutsBefore = big((await vendor.get('/vendor/payouts?page_size=1')).total);

  await login(page, 'vendor1@payrail.demo', /\/vendor$/);
  await expect(page.getByTestId('vendor-balance')).toHaveText(formatINR(before));
  await page.getByRole('link', { name: 'Payouts', exact: true }).click();

  // ---- request ₹150.25, then send the same request again (same Idempotency-Key)
  const form = page.getByTestId('payout-form');
  await form.getByLabel('Amount (₹)').fill('150.25');
  await form.getByRole('button', { name: 'Request payout' }).click();
  await expect(page.getByTestId('payout-done')).toContainText('requested');
  await expect(page.getByTestId('payout-balance')).toHaveText(formatINR(before - 15025n));
  await page.getByRole('button', { name: 'Send the same request again (same key)' }).click();
  await expect(page.getByTestId('payout-replay')).toContainText('no second payout was created');
  expect(big((await vendor.get('/vendor/payouts?page_size=1')).total)).toBe(payoutsBefore + 1n);
  const payout = (await vendor.get('/vendor/payouts?status=requested&page_size=1')).items[0];
  expect(payout.amount_paise).toBe('15025');

  // ---- overspend: browser check bypassed, the database refuses (PRF01), nothing created
  await form.getByLabel('Amount (₹)').fill(rupees(before - 15025n + 1n));
  await expect(form.getByRole('button', { name: 'Request payout' })).toBeDisabled();
  await page.getByLabel(/skip the browser check/).check();
  await form.getByRole('button', { name: 'Request payout' }).click();
  await expect(page.getByRole('alert')).toContainText('insufficient_funds · SQLSTATE PRF01');
  expect(big((await vendor.get('/vendor/payouts?page_size=1')).total)).toBe(payoutsBefore + 1n);
  await logout(page);

  // ---- finance: the transfer FAILED → one reversal restores the funds
  await login(page, 'finance@payrail.demo', /\/finance$/);
  await page.getByRole('link', { name: 'Payouts', exact: true }).click();
  const prow = page.locator(`[data-testid=finance-payout-row][data-payout-id="${payout.payout_id}"]`);
  await prow.getByRole('button', { name: 'Mark failed' }).click();
  const decision = page.getByTestId('payout-decision');
  await expect(decision).toContainText('failed');
  await expect(decision.getByTestId('ledger-entry')).toHaveCount(2);           // the request + its reversal
  await expect(decision.locator('[data-entry-type=reversal]')).toContainText('balanced');
  expect(big((await vendor.get('/vendor/me')).balance_paise)).toBe(before);
  // recording "failed" again changes nothing (same row, no second reversal)
  await page.getByRole('button', { name: /record “failed” again/ }).click();
  await expect(decision).toContainText('failed');
  await expect(decision.getByTestId('ledger-entry')).toHaveCount(2);
  const entries = (await fin.get(`/finance/journal-entries?payout_id=${payout.payout_id}`)).items;
  expect(entries.map((e) => e.entry_type).sort()).toEqual(['payout', 'reversal']);
  expect(big((await vendor.get('/vendor/me')).balance_paise)).toBe(before);
  // a failed payout can never become paid
  const flip = await fin.post(`/finance/payouts/${payout.payout_id}/complete`, { outcome: 'paid', bank_utr: 'SIMUTR99999999' });
  expect(flip.status()).toBe(409);
  expect((await flip.json()).error.sqlstate).toBe('PRS01');

  // ---- a second payout (API, like the vendor screen) is PAID with a UTR
  const second = await (await vendor.post('/vendor/payouts', { amount_paise: '5000' }, { 'Idempotency-Key': crypto.randomUUID() })).json();
  await page.reload();                                                         // the queue now lists it
  const srow = page.locator(`[data-testid=finance-payout-row][data-payout-id="${second.payout_id}"]`);
  await srow.getByRole('button', { name: 'Mark paid…' }).click();
  await srow.getByLabel('Bank UTR').fill('bad utr');
  await expect(srow.getByRole('button', { name: 'Confirm paid' })).toBeDisabled();
  await srow.getByLabel('Bank UTR').fill(`E2EUTR${second.payout_id.padStart(8, '0')}`);
  await srow.getByRole('button', { name: 'Confirm paid' }).click();
  await expect(decision).toContainText('paid');
  await expect(decision).toContainText(`E2EUTR${second.payout_id.padStart(8, '0')}`);
  await expect(decision.getByTestId('ledger-entry')).toHaveCount(1);           // paid posts nothing more
  expect(big((await vendor.get('/vendor/me')).balance_paise)).toBe(before - 5000n);
  await logout(page);

  // ---- the vendor sees both outcomes and the statement's running balance ends at the ledger balance
  await login(page, 'vendor1@payrail.demo', /\/vendor$/);
  await page.getByRole('link', { name: 'Payouts', exact: true }).click();
  await expect(page.locator(`[data-testid=vendor-payout-row][data-payout-id="${payout.payout_id}"]`)).toContainText('failed');
  await expect(page.locator(`[data-testid=vendor-payout-row][data-payout-id="${second.payout_id}"]`)).toContainText('paid');
  await page.getByRole('link', { name: 'Statement' }).click();
  await expect(page.getByTestId('st-closing')).toHaveText(formatINR(before - 5000n));
  expect(problems).toEqual([]);
});

test('unverified vendor and a vendor with a negative balance cannot request payouts', async ({ page }) => {
  const problems = watchConsole(page);
  await login(page, 'vendor11@payrail.demo', /\/vendor$/);
  await expect(page.getByTestId('kyc-status')).toContainText('pending');
  await expect(page.getByRole('status').filter({ hasText: 'not KYC-verified' })).toBeVisible();
  await page.getByRole('link', { name: 'Payouts', exact: true }).click();
  const form = page.getByTestId('payout-form');
  await form.getByLabel('Amount (₹)').fill('10');
  await expect(form.getByRole('button', { name: 'Request payout' })).toBeDisabled();
  await page.getByLabel(/skip the browser check/).check();
  await form.getByRole('button', { name: 'Request payout' }).click();
  await expect(page.getByRole('alert')).toContainText('vendor_not_verified · SQLSTATE PRV03');
  await logout(page);

  // vendor 7's balance is negative in the seed (a refund after its money was paid out)
  await login(page, 'vendor7@payrail.demo', /\/vendor$/);
  await expect(page.getByTestId('vendor-balance')).toContainText('−₹');
  await page.getByRole('link', { name: 'Payouts', exact: true }).click();
  await form.getByLabel('Amount (₹)').fill('1');
  await page.getByLabel(/skip the browser check/).check();
  await form.getByRole('button', { name: 'Request payout' }).click();
  await expect(page.getByRole('alert')).toContainText('insufficient_funds · SQLSTATE PRF01');
  expect(problems).toEqual([]);
});

test('customer → finance refund: requested in the shop, approved and rejected on the finance screen', async ({ page, request }) => {
  const problems = watchConsole(page);
  const { cust, fin, order } = await paidOrder(request, 2);
  const lineTotal = big((await fin.get(`/finance/orders/${order.order_id}`)).lines[0].line_total_paise);

  // ---- customer requests ₹75.25 on line 1 through the order page
  await login(page, 'customer1@payrail.demo', /\/shop$/);
  await page.goto(`/orders/${order.order_id}`);
  await page.getByTestId('line-row').first().getByRole('button', { name: 'Request refund' }).click();
  const form = page.getByTestId('refund-form');
  await form.locator('input[id^=amt-]').fill('75.25');
  await form.locator('input[id^=reason-]').fill('Box was dented');
  await form.getByRole('button', { name: 'Request refund' }).click();
  await expect(page.getByTestId('refund-done')).toContainText('requested');
  const refundId = (await cust.get(`/orders/${order.order_id}`)).refunds[0].refund_id;
  await logout(page);

  // ---- finance approves it on the refund queue
  await login(page, 'finance@payrail.demo', /\/finance$/);
  await page.getByRole('link', { name: 'Refunds', exact: true }).click();
  const row = page.locator(`[data-testid=finance-refund-row][data-refund-id="${refundId}"]`);
  await expect(row).toContainText('Box was dented');
  await row.getByRole('button', { name: 'Approve' }).click();
  const decision = page.getByTestId('refund-decision');
  await expect(decision).toContainText('processed');
  await expect(decision).toContainText('rfnd_');
  const entry = decision.locator('[data-entry-type=refund]');
  await expect(entry).toContainText('balanced');
  await expect(entry).toContainText('GATEWAY_CLEARING');
  await expect(row).toHaveCount(0);                                           // left the "requested" queue
  const approved = await fin.get(`/finance/orders/${order.order_id}`);
  expect(approved.status).toBe('partially_refunded');
  expect(approved.lines[0].refunded_paise).toBe('7525');
  const refundEntry = (await fin.get(`/finance/journal-entries?refund_id=${refundId}`)).items[0];
  const credit = refundEntry.lines.filter((l) => l.direction === 'C').reduce((a, l) => a + big(l.amount_paise), 0n);
  const debit = refundEntry.lines.filter((l) => l.direction === 'D').reduce((a, l) => a + big(l.amount_paise), 0n);
  expect(credit).toBe(7525n);
  expect(debit).toBe(credit);
  // a decided refund cannot be decided differently
  const flip = await fin.post(`/finance/refunds/${refundId}/reject`);
  expect(flip.status()).toBe(409);

  // ---- a second request is REJECTED: the reservation is released, nothing posted
  const second = await (await cust.post(`/orders/${order.order_id}/refunds`,
    { line_no: 1, amount_paise: '10000', reason: 'Changed my mind' }, { 'Idempotency-Key': crypto.randomUUID() })).json();
  expect(big((await fin.get(`/finance/orders/${order.order_id}`)).lines[0].refundable_paise)).toBe(lineTotal - 7525n - 10000n);
  await page.reload();
  const row2 = page.locator(`[data-testid=finance-refund-row][data-refund-id="${second.refund_id}"]`);
  await row2.getByRole('button', { name: 'Reject' }).click();
  await expect(decision).toContainText('rejected');
  await expect(decision).toContainText('nothing was posted');
  expect(big((await fin.get(`/finance/orders/${order.order_id}`)).lines[0].refundable_paise)).toBe(lineTotal - 7525n);
  expect((await fin.get(`/finance/journal-entries?refund_id=${second.refund_id}`)).items).toHaveLength(0);

  await page.getByRole('link', { name: 'Ledger' }).click();
  await expect(page.getByTestId('tb-check')).toContainText('the ledger balances');
  expect(problems).toEqual([]);
});

test('settlement import (sample CSVs) and reconciliation; an unknown reference posts once its payment appears', async ({ page, request }) => {
  const problems = watchConsole(page);
  const fin = await apiAs(request, 'finance@payrail.demo');
  await login(page, 'finance@payrail.demo', /\/finance$/);
  await page.getByRole('link', { name: 'Settlements' }).click();
  const upload = async (file) => {
    // fileURLToPath, not .pathname: a space in the folder name would stay as %20
    await page.setInputFiles('#csv-file', fileURLToPath(new URL(file, SAMPLES)));
    await page.getByRole('button', { name: 'Import' }).click();
    await expect(page.getByTestId('import-results')).toBeVisible();
  };
  const summary = (k) => page.getByTestId(`summary-${k}`);
  const result = (ref) => page.locator(`[data-testid=import-row][data-ref="${ref}"]`);

  // ---- 01: four exact matches → stored and posted
  await upload('01_normal.csv');
  await expect(summary('inserted')).toContainText('4');
  await expect(page.getByTestId('summary-posted')).toContainText('4');
  await expect(result('rfnd_R000000044')).toContainText('matched and posted');

  // ---- 01 again: every row is a duplicate, nothing new is posted
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(summary('duplicate')).toContainText('4');
  await expect(page.getByTestId('summary-posted')).toContainText('0');
  await expect(summary('inserted')).toHaveCount(0);

  // ---- 02: duplicate + conflict (original kept) + one new match
  await upload('02_reupload_duplicate_conflict.csv');
  await expect(result('pay_S000000365')).toHaveAttribute('data-result', 'duplicate');
  await expect(result('pay_S000000366')).toHaveAttribute('data-result', 'conflict');
  await expect(result('pay_S000000368')).toHaveAttribute('data-result', 'inserted');

  // ---- 03: exceptions — stored-but-not-posted, refused by the database, invalid format
  await upload('03_exceptions.csv');
  await expect(summary('inserted')).toContainText('3');
  await expect(summary('rejected')).toContainText('2');
  await expect(summary('invalid')).toContainText('4');
  await expect(page.getByTestId('summary-posted')).toContainText('0');
  await expect(result('pay_S000000369')).toContainText('not posted');
  await expect(result('pay_S000000371')).toContainText('23514');            // fee ≥ gross (CHECK)
  await expect(result('pay_S000000372')).toContainText('PRV07');            // future settlement date
  await expect(result('pay_S000000375')).toContainText('record_type');

  // ---- reconciliation as of the demo date: every category, nothing mismatched is posted
  await page.getByRole('link', { name: 'Reconciliation', exact: true }).click();
  await expect(page.getByTestId('rc-asof-used')).toContainText('2026-10-31');
  await page.getByRole('button', { name: 'Post newly matching settlements' }).click();
  for (const c of ['matched', 'amount_mismatch', 'unknown_reference', 'in_transit', 'overdue_missing']) {
    await expect(page.locator(`[data-testid=rc-category][data-category=${c}]`)).toBeVisible();
  }
  const rcRow = (ref) => page.locator(`[data-testid=rc-row][data-ref="${ref}"]`);
  await page.getByLabel('Gateway reference').fill('pay_S000999999');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(rcRow('pay_S000999999')).toHaveAttribute('data-category', 'unknown_reference');
  await page.getByLabel('Gateway reference').fill('pay_S000000370');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(rcRow('pay_S000000370').filter({ hasText: 'reported as refund' })).toHaveAttribute('data-category', 'amount_mismatch');
  await page.getByLabel('Gateway reference').fill('pay_S000000018');               // overdue in the seed, settled by 01
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(rcRow('pay_S000000018')).toHaveAttribute('data-category', 'matched');
  const settlements = (await fin.get('/finance/settlements?settled_on=2026-10-31&page_size=100')).items;
  for (const ref of ['pay_S000000369', 'pay_S000999999', 'pay_S000000370']) {
    expect(settlements.find((s) => s.gateway_ref === ref).posted_entry_id, ref).toBeNull();
  }

  // ---- revisit: the gateway reports a payment BEFORE its success callback reached us
  const cust = await apiAs(request, 'customer1@payrail.demo');
  const product = (await cust.get('/products?page_size=1')).items[0];
  const order = await (await cust.post('/orders', { items: [{ product_id: product.product_id, quantity: 1 }] })).json();
  const attempt = await (await cust.post(`/orders/${order.order_id}/payments`, { method: 'card' }, { 'Idempotency-Key': crypto.randomUUID() })).json();
  const ref = `pay_S${attempt.payment_id.padStart(9, '0')}`;                   // the simulated gateway's success reference
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  await page.getByRole('link', { name: 'Settlements' }).click();
  await page.getByLabel(/paste/).fill(`gateway_ref,record_type,gross_paise,fee_paise,settled_on\n${ref},payment,${attempt.amount_paise},0,${today}`);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(result(ref)).toContainText('not posted');
  await page.getByRole('link', { name: 'Reconciliation', exact: true }).click();
  await page.getByLabel('As of (IST date)').fill(today);
  await page.getByLabel('Gateway reference').fill(ref);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(rcRow(ref)).toHaveAttribute('data-category', 'unknown_reference');
  // the callback arrives late; the next reconciliation run posts the stored row (once)
  expect((await fin.post(`/mock-gateway/payments/${attempt.payment_id}/simulate`, { outcome: 'success' })).ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Post newly matching settlements' }).click();
  await expect(page.locator('[data-testid=rc-category][data-category=matched] [data-testid=rc-newly]')).toHaveText('1');
  await expect(rcRow(ref)).toHaveAttribute('data-category', 'matched');
  await page.getByRole('button', { name: 'Post newly matching settlements' }).click();
  await expect(page.locator('[data-testid=rc-category][data-category=matched] [data-testid=rc-newly]')).toHaveText('0');
  const late = (await fin.get(`/finance/settlements?settled_on=${today}&page_size=100`)).items.filter((s) => s.gateway_ref === ref);
  expect(late).toHaveLength(1);
  expect(late[0].posted_entry_id).not.toBeNull();

  await page.getByRole('link', { name: 'Ledger' }).click();
  await expect(page.getByTestId('tb-check')).toContainText('the ledger balances');
  expect(problems).toEqual([]);
});
