// Task 6: the named reports through the real UI (read-only; runs against the
// same payrail_e2e database as the other specs, so expected values are read
// from the API — which reads the SQL functions — not hard-coded).
import { expect, test } from '@playwright/test';
import { formatBps, formatINR } from '../src/lib/money.js';

const API = 'http://127.0.0.1:4100/api';
const PASSWORD = 'PayRail@2026';

async function login(page, email, landing) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(landing);
}

async function apiAs(request, email) {
  const r = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(r.ok(), email).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await r.json()).token}` };
  return { get: async (path) => { const x = await request.get(`${API}${path}`, { headers }); expect(x.ok(), path).toBeTruthy(); return x.json(); } };
}

function watchConsole(page) {
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  return problems;
}

test('finance: R1–R6 render the SQL report results exactly', async ({ page, request }) => {
  const problems = watchConsole(page);
  const fin = await apiAs(request, 'finance@payrail.demo');
  await login(page, 'finance@payrail.demo', /\/finance$/);
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/finance\/reports$/);

  // R1
  const r1 = await fin.get('/finance/reports/trial-balance');
  await expect(page.getByTestId('r1-check')).toContainText('balanced');
  await expect(page.getByTestId('r1-check')).toContainText(formatINR(r1.total.debit_paise));
  await expect(page.getByTestId('r1-row')).toHaveCount(r1.accounts.length);
  await expect(page.getByTestId('r1-total')).toContainText(formatINR(r1.total.debit_balance_paise));
  await page.fill('#r1-asof', '2026-09-30');
  const sep = await fin.get('/finance/reports/trial-balance?as_of=2026-09-30');
  await expect(page.getByTestId('r1-check')).toContainText(formatINR(sep.total.debit_paise));

  // R2: vendor 3, a window inside October
  await page.getByTestId('tab-R2').click();
  await page.selectOption('#r2-vendor', '3');
  await page.fill('#r2-from', '2026-10-01');
  await page.fill('#r2-to', '2026-10-15');
  const r2 = await fin.get('/finance/reports/vendor-statement?vendor_id=3&from=2026-10-01&to=2026-10-15&page_size=25');
  await expect(page.getByTestId('r2-opening')).toHaveText(formatINR(r2.opening_balance_paise));
  await expect(page.getByTestId('r2-closing')).toHaveText(formatINR(r2.closing_balance_paise));
  await expect(page.getByTestId('r2-row')).toHaveCount(Math.min(25, Number(r2.total)));

  // R3: chart + table
  await page.getByTestId('tab-R3').click();
  const r3 = await fin.get('/finance/reports/monthly-performance');
  await expect(page.getByTestId('r3-row')).toHaveCount(r3.items.length);
  await expect(page.getByTestId('r3-chart').locator('.recharts-bar-rectangle')).toHaveCount(r3.items.length * 2);
  await expect(page.getByTestId('r3-row').last()).toContainText(formatINR(r3.items.at(-1).cumulative_gross_paise));
  await expect(page.getByTestId('r3-row').last()).toContainText(formatBps(r3.items.at(-1).refund_rate_bps));
  await page.getByTestId('r3-chart').locator('.recharts-bar-rectangle').first().hover();
  await expect(page.getByTestId('r3-chart')).toContainText(`Captured ${formatINR(r3.items[0].captured_gross_paise)}`);
  await page.fill('#r3-from', '2026-08');
  await page.fill('#r3-to', '2026-11');
  await expect(page.getByTestId('r3-row')).toHaveCount(4);

  // R4
  await page.getByTestId('tab-R4').click();
  const r4 = await fin.get('/finance/reports/refund-risk');
  await expect(page.getByTestId('r4-row')).toHaveCount(r4.items.length);
  const top = r4.items[0];
  await expect(page.getByTestId('r4-row').first()).toContainText(formatBps(top.refund_rate_bps));
  await expect(page.getByTestId('r4-row').first()).toContainText(top.risk_band);

  // R5
  await page.getByTestId('tab-R5').click();
  const r5 = await fin.get('/finance/reports/settlement-aging');
  await expect(page.getByTestId('r5-asof')).toHaveText(r5.as_of);
  await expect(page.getByTestId('r5-subtotal')).toHaveCount(5);
  await expect(page.getByTestId('r5-total')).toContainText(formatINR(r5.total.net_cash_paise));

  // R6
  await page.getByTestId('tab-R6').click();
  const r6 = await fin.get('/finance/reports/vendor-payables');
  await expect(page.getByTestId('r6-row')).toHaveCount(r6.items.length);
  const neg = r6.items.find((v) => v.status === 'negative');
  await expect(page.getByTestId('r6-row').filter({ hasText: `#${neg.vendor_id} ` }).first()).toContainText('negative');

  expect(problems).toEqual([]);
});

test('vendor: own R6 / R4 only; customer cannot open finance reports', async ({ page, request }) => {
  const problems = watchConsole(page);
  const v7 = await apiAs(request, 'vendor7@payrail.demo');
  const me = await v7.get('/vendor/me');
  const risk = await v7.get('/vendor/reports/refund-risk');
  await login(page, 'vendor7@payrail.demo', /\/vendor$/);
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByTestId('vr-balance')).toHaveText(formatINR(me.balance_paise));
  await expect(page.getByTestId('vr-status')).toHaveText('negative');
  await expect(page.getByTestId('vr-rate')).toContainText(formatBps(risk.item.refund_rate_bps));
  await page.getByRole('button', { name: 'Log out' }).click();

  await login(page, 'customer1@payrail.demo', /\/shop$/);
  await page.goto('/finance/reports');
  await expect(page).toHaveURL(/\/shop$/);
  expect(problems).toEqual([]);
});
