// Task 4 acceptance, driven through the real UI (Chromium) against the real
// backend and a freshly seeded PostgreSQL database (see playwright.config.js).
// Ledger/database effects are checked through the finance API (the finance UI
// is Task 5); amounts are compared as BigInt paise.
import { expect, test } from '@playwright/test';
import { formatINR } from '../src/lib/money.js';

const API = 'http://127.0.0.1:4100/api';
const PASSWORD = 'PayRail@2026';
const big = (s) => BigInt(s);
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);

// Chrome logs every non-2xx fetch; these are the refusals this test provokes on purpose.
const EXPECTED_CONSOLE = /Failed to load resource: the server responded with a status of (404|409|422)/;

async function login(page, email, landing = /\/shop$/) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(landing);
}

async function financeApi(request) {
  const r = await request.post(`${API}/auth/login`, { data: { email: 'finance@payrail.demo', password: PASSWORD } });
  expect(r.ok()).toBeTruthy();
  const { token } = await r.json();
  const headers = { Authorization: `Bearer ${token}` };
  return {
    get: async (path) => { const x = await request.get(`${API}${path}`, { headers }); expect(x.ok(), path).toBeTruthy(); return x.json(); },
    post: async (path, data) => { const x = await request.post(`${API}${path}`, { headers, data }); return x; },
  };
}

function lineTotals(entry) {
  const by = (dir, code) => sum(entry.lines.filter((l) => l.direction === dir && (!code || l.account_code === code)).map((l) => big(l.amount_paise)));
  return { by, debit: by('D'), credit: by('C') };
}

test('customer: multi-vendor purchase via the gateway page (declined, then approved), refund request (valid, invalid, replay)', async ({ page, request }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !EXPECTED_CONSOLE.test(m.text())) problems.push(m.text()); });

  await login(page, 'customer7@payrail.demo');

  // ---- catalogue: one product from each of two different vendors (vendor filter)
  const vendorSelect = page.locator('#vendor');
  await expect.poll(() => vendorSelect.locator('option').count()).toBeGreaterThan(2);   // vendors loaded
  const vendorOptions = await vendorSelect.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  expect(vendorOptions.length).toBeGreaterThanOrEqual(2);
  for (const [i, qty] of [[0, '2'], [1, '1']]) {
    await vendorSelect.selectOption(vendorOptions[i]);
    const card = page.getByTestId('product-card').first();
    await expect(card).toBeVisible();
    await card.locator('input').fill(qty);
    await card.getByRole('button', { name: 'Add to cart' }).click();
  }
  await expect(page.getByTestId('cart-count')).toHaveText('3');

  // ---- cart → place order (the database snapshots prices; total derived in SQL)
  await page.getByRole('link', { name: /^Cart/ }).click();
  await expect(page.getByTestId('cart-line')).toHaveCount(2);
  await expect(page.getByText('multi-vendor order (2 vendors)')).toBeVisible();
  await page.getByRole('button', { name: 'Place order and pay' }).click();
  await expect(page).toHaveURL(/\/orders\/\d+\/pay$/);
  const orderId = page.url().match(/orders\/(\d+)\/pay/)[1];

  const fin = await financeApi(request);
  const placed = await fin.get(`/finance/orders/${orderId}`);
  expect(placed.status).toBe('pending_payment');
  expect(placed.lines).toHaveLength(2);
  expect(new Set(placed.lines.map((l) => l.vendor_id)).size).toBe(2);
  expect(sum(placed.lines.map((l) => big(l.line_total_paise)))).toBe(big(placed.total_paise));

  // ---- the shop has NO approve/decline controls: the customer is redirected to the gateway
  await expect(page.getByRole('button', { name: /approve|decline/i })).toHaveCount(0);
  await page.getByRole('button', { name: /^Continue to pay ₹/ }).click();
  await expect(page).toHaveURL(/\/gateway\/checkout\/\d+$/);
  await expect(page.getByTestId('gateway-amount')).toHaveText(formatINR(placed.total_paise));

  // ---- attempt 1: the gateway declines the test UPI ID → back at the shop, order still unpaid, no ledger entry
  await page.getByRole('button', { name: 'failure@payrail' }).click();
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${orderId}/pay$`));
  await expect(page.getByTestId('declined-banner')).toBeVisible();
  await expect(page.getByTestId('payment-row')).toHaveCount(1);
  await expect(page.getByTestId('payment-row').first()).toContainText('failed');
  expect((await fin.get(`/finance/journal-entries?order_id=${orderId}`)).items).toHaveLength(0);

  // ---- attempt 2 (new key) by card: a non-test card is refused by the gateway; the test card is approved
  await page.locator('#method').selectOption('card');
  await page.getByRole('button', { name: /^Continue to pay ₹/ }).click();
  await expect(page.getByTestId('gateway-checkout')).toBeVisible();
  await page.fill('#cardno', '5555 5555 5555 4444');
  await page.fill('#expiry', '12/30');
  await page.fill('#cvv', '123');
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await expect(page.getByRole('alert')).toContainText('test instruments');
  await page.getByRole('button', { name: '4111 1111 1111 1111' }).click();
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await expect(page.getByTestId('paid-banner')).toBeVisible();
  await expect(page.getByTestId('payment-row')).toHaveCount(2);

  // ---- ledger: exactly ONE balanced capture entry with the DEC-007 allocation
  const paid = await fin.get(`/finance/orders/${orderId}`);
  expect(paid.status).toBe('paid');
  expect(paid.payments.map((p) => p.status)).toEqual(['failed', 'captured']);
  let entries = (await fin.get(`/finance/journal-entries?order_id=${orderId}`)).items;
  expect(entries).toHaveLength(1);
  const cap = lineTotals(entries[0]);
  expect(entries[0].entry_type).toBe('capture');
  expect(cap.debit).toBe(cap.credit);
  expect(cap.by('D', 'GATEWAY_CLEARING')).toBe(big(paid.total_paise));
  expect(cap.by('C', 'COMMISSION_REVENUE')).toBe(sum(paid.lines.map((l) => big(l.commission_paise))));
  expect(cap.by('C', 'GST_PAYABLE')).toBe(sum(paid.lines.map((l) => big(l.gst_paise))));
  const vendorCredits = entries[0].lines.filter((l) => l.direction === 'C' && l.account_code.startsWith('VENDOR'));
  expect(vendorCredits).toHaveLength(2);
  expect(sum(vendorCredits.map((l) => big(l.amount_paise)))).toBe(sum(paid.lines.map((l) => big(l.vendor_paise))));

  // ---- order detail: an over-limit refund is refused by the DATABASE (browser check bypassed)
  await page.getByRole('link', { name: 'View order and request refunds' }).click();
  await expect(page.getByTestId('order-status')).toContainText('paid');
  const line1 = page.getByTestId('line-row').first();
  const refundable1 = big(paid.lines[0].refundable_paise);
  await line1.getByRole('button', { name: 'Request refund' }).click();
  const form = page.getByTestId('refund-form');
  const over = refundable1 + 100n;
  await form.locator('input[id^=amt-]').fill(`${over / 100n}.${String(over % 100n).padStart(2, '0')}`);
  await form.locator('input[id^=reason-]').fill('Testing the limit');
  await expect(form.getByRole('button', { name: 'Request refund' })).toBeDisabled();
  await form.getByLabel(/skip the browser check/).check();
  await form.getByRole('button', { name: 'Request refund' }).click();
  await expect(form.getByRole('alert')).toContainText('refund_exceeds_refundable · SQLSTATE PRR01');
  expect((await fin.get(`/finance/orders/${orderId}`)).refunds).toHaveLength(0);

  // ---- a valid partial refund (₹100.50) reserves the amount; re-sending the same key creates nothing new
  await form.locator('input[id^=amt-]').fill('100.50');
  await form.locator('input[id^=reason-]').fill('One copy arrived damaged');
  await form.getByRole('button', { name: 'Request refund' }).click();
  await expect(page.getByTestId('refund-done')).toContainText('requested');
  await expect(page.getByTestId('order-pending')).toHaveText('₹100.50');
  await page.getByRole('button', { name: 'Send the same request again (same key)' }).click();
  await expect(page.getByTestId('refund-replay')).toContainText('no second refund was created');
  await expect(page.getByTestId('refund-row')).toHaveCount(1);

  const requested = await fin.get(`/finance/orders/${orderId}`);
  expect(requested.refunds).toHaveLength(1);
  expect(requested.refunds[0]).toMatchObject({ status: 'requested', amount_paise: '10050', line_no: 1 });
  expect(big(requested.lines[0].refundable_paise)).toBe(refundable1 - 10050n);
  // a request only RESERVES: still just the capture entry in the ledger
  expect((await fin.get(`/finance/journal-entries?order_id=${orderId}`)).items).toHaveLength(1);

  // ---- finance approves (API; the finance screen is Task 5) → customer sees the derived status change
  const approve = await fin.post(`/finance/refunds/${requested.refunds[0].refund_id}/approve`);
  expect(approve.status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId('order-status')).toContainText('partially refunded');
  await expect(page.getByTestId('order-refunded')).toHaveText('₹100.50');
  entries = (await fin.get(`/finance/journal-entries?order_id=${orderId}&entry_type=refund`)).items;
  expect(entries).toHaveLength(1);
  const ref = lineTotals(entries[0]);
  expect(ref.debit).toBe(ref.credit);
  expect(ref.by('C', 'GATEWAY_CLEARING')).toBe(10050n);

  const tb = await fin.get('/finance/trial-balance');
  expect(tb.balanced).toBe(true);
  expect(tb.total_debit_paise).toBe(tb.total_credit_paise);

  // ---- My refunds lists it
  await page.getByRole('link', { name: 'My refunds' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`#${orderId}`) })).toContainText('processed');

  // ---- another customer cannot see this order (backend 404, shown as an error state)
  await page.getByRole('button', { name: 'Log out' }).click();
  await login(page, 'customer8@payrail.demo');
  await page.goto(`/orders/${orderId}`);
  await expect(page.getByRole('alert')).toContainText('HTTP 404');

  expect(problems).toEqual([]);
});

test('unauthenticated visitors are sent to the login page; bad credentials show an error', async ({ page }) => {
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/login$/);
  await page.fill('#email', 'customer1@payrail.demo');
  await page.fill('#password', 'wrong-password');
  await page.click('button[type=submit]');
  await expect(page.getByRole('alert')).toContainText('invalid_credentials');
});

test('a lost response is retried with the SAME Idempotency-Key: one payment attempt, one refund', async ({ page, request }) => {
  // set-up through the API as customer9: a pending order (A) and a paid order (B)
  const token = (await (await request.post(`${API}/auth/login`, { data: { email: 'customer9@payrail.demo', password: PASSWORD } })).json()).token;
  const headers = { Authorization: `Bearer ${token}` };
  const products = (await (await request.get(`${API}/products?page_size=2`, { headers })).json()).items;
  const newOrder = async () => (await (await request.post(`${API}/orders`, { headers, data: { items: [{ product_id: products[0].product_id, quantity: 1 }] } })).json()).order_id;
  const orderA = await newOrder();
  const orderB = await newOrder();
  const pay = await (await request.post(`${API}/orders/${orderB}/payments`, { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { method: 'card' } })).json();
  const paidB = await request.post(`${API}/mock-gateway/checkout/${pay.payment_id}`,
    { headers, data: { action: 'pay', instrument: { number: '4111111111111111', expiry: '12/30', cvv: '123' } } });
  expect((await paidB.json()).payment.status).toBe('captured');

  await login(page, 'customer9@payrail.demo');

  // The first POST reaches the server and COMMITS, but the browser never sees the answer.
  const dropFirstResponse = (pattern) => {
    let dropped = 0;
    return page.route(pattern, async (route) => {
      if (route.request().method() !== 'POST' || dropped > 0) return route.continue();
      dropped += 1;
      await route.fetch();          // delivered to the backend…
      await route.abort('failed');  // …but the response is lost
    });
  };

  // ---- payment attempt
  await dropFirstResponse('**/api/orders/*/payments');
  await page.goto(`/orders/${orderA}/pay`);
  await page.getByRole('button', { name: /^Continue to pay ₹/ }).click();
  await expect(page.getByRole('alert')).toContainText('network');
  await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
  await expect(page).toHaveURL(/\/gateway\/checkout\/\d+$/);       // same key → the attempt that was committed
  const a = await (await request.get(`${API}/orders/${orderA}`, { headers })).json();
  expect(a.payments).toHaveLength(1);
  expect(page.url()).toMatch(new RegExp(`/gateway/checkout/${a.payments[0].payment_id}$`));

  // ---- refund request
  await dropFirstResponse('**/api/orders/*/refunds');
  await page.goto(`/orders/${orderB}`);
  await page.getByTestId('line-row').first().getByRole('button', { name: 'Request refund' }).click();
  const form = page.getByTestId('refund-form');
  await form.locator('input[id^=amt-]').fill('5.00');
  await form.locator('input[id^=reason-]').fill('Lost response test');
  await form.getByRole('button', { name: 'Request refund' }).click();
  await expect(form.getByRole('alert')).toContainText('network');
  await form.getByRole('button', { name: 'Request refund' }).click();      // same payload → same key
  await expect(page.getByTestId('refund-done')).toBeVisible();
  await expect(page.getByTestId('refund-row')).toHaveCount(1);
  const b = await (await request.get(`${API}/orders/${orderB}`, { headers })).json();
  expect(b.refunds).toHaveLength(1);
  expect(b.refund_pending_paise).toBe('500');
});

test('finance gateway simulator: wrong amount refused, 3 duplicate deliveries capture once, late failure refused', async ({ page, request }) => {
  // a pending payment attempt made by customer10 through the API
  const token = (await (await request.post(`${API}/auth/login`, { data: { email: 'customer10@payrail.demo', password: PASSWORD } })).json()).token;
  const headers = { Authorization: `Bearer ${token}` };
  const products = (await (await request.get(`${API}/products?page_size=1&sort=price_desc`, { headers })).json()).items;
  const order = await (await request.post(`${API}/orders`, { headers, data: { items: [{ product_id: products[0].product_id, quantity: 1 }] } })).json();
  const attempt = await (await request.post(`${API}/orders/${order.order_id}/payments`, { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { method: 'upi' } })).json();
  // customers cannot use the simulator
  expect((await request.post(`${API}/mock-gateway/payments/${attempt.payment_id}/simulate`, { headers, data: { outcome: 'success' } })).status()).toBe(403);

  await login(page, 'finance@payrail.demo', /\/finance$/);
  await page.getByRole('link', { name: 'Gateway simulator' }).click();
  const fin = await financeApi(request);
  const row = page.getByTestId('sim-payment-row').filter({ hasText: `#${attempt.payment_id}` });
  await row.click();
  await expect(page.getByTestId('sim-selected')).toContainText(`Payment #${attempt.payment_id}`);

  await page.getByRole('button', { name: /callback reports a different amount/ }).click();
  await expect(page.getByTestId('delivery-results')).toContainText('amount_mismatch (PRP01)');
  await expect(page.getByTestId('delivery-results')).toContainText('is initiated');
  expect((await fin.get(`/finance/journal-entries?payment_id=${attempt.payment_id}`)).items).toHaveLength(0);

  await page.getByRole('button', { name: 'Success, delivered 3×' }).click();
  const rows = page.getByTestId('delivery-results').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(rows.nth(i)).toContainText('captured');
  expect((await fin.get(`/finance/journal-entries?payment_id=${attempt.payment_id}`)).items).toHaveLength(1);

  await page.getByRole('button', { name: 'Failure callback' }).click();
  await expect(page.getByTestId('delivery-results')).toContainText('invalid_transition (PRS01)');
  const after = await fin.get(`/finance/orders/${order.order_id}`);
  expect(after.status).toBe('paid');
  expect(after.payments.map((p) => p.status)).toEqual(['captured']);
  expect((await fin.get(`/finance/journal-entries?payment_id=${attempt.payment_id}`)).items).toHaveLength(1);
});
