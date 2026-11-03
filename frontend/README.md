# PayRail frontend (Task 4 customer UI · Task 5 vendor and finance UI)

React 19 + Vite 8 + Tailwind CSS 4 + React Router 7. Node **22.12+** (Vite 8's minimum; the repo pins 22 in `.nvmrc`).
The browser talks only to `/api/*`; the Vite dev server proxies that to the Express backend, so there is no CORS setup.
Every number on screen comes from the API — no mock data.

## Run (local demo)
```bash
# 1. database + backend (see backend/README.md)
docker compose up -d db
cd backend && npm ci && npm start            # http://127.0.0.1:4000
# 2. UI, in a second terminal
cd frontend && npm ci && npm run dev         # http://127.0.0.1:5173
```
Log in (password `PayRail@2026`) as `customer1@payrail.demo` … `customer60@payrail.demo`, `vendor1@payrail.demo` …
`vendor10@payrail.demo` (verified; vendor7's balance is negative in the seed), `vendor11@payrail.demo` (KYC pending),
`vendor12@payrail.demo` (KYC rejected), or `finance@payrail.demo`.
`PAYRAIL_API_URL=http://127.0.0.1:4100 npm run dev` points the proxy at another backend.

## Tests
```bash
npm test                         # money helpers (node:test, no browser)
npx playwright install chromium  # once per machine
npm run test:e2e                 # browser smoke test (PAYRAIL_REBUILD_VIA_DOCKER=1 on Docker-only machines)
```
`test:e2e` rebuilds and seeds a **separate** database `payrail_e2e` (never your demo `payrail`), starts its own backend
(:4100) and Vite server (:5174), and drives Chromium through three files (11 tests):
- `e2e/customer.spec.js` — a two-vendor purchase paid at the gateway page (test UPI declined, non-test card refused, test
  card approved), an over-limit refund refused by the database, a valid partial refund, a same-key replay, a
  cross-customer access attempt, lost responses retried with the same key, and the finance gateway simulator.
- `e2e/reports.spec.js` — finance Reports R1–R6 show exactly the API's (SQL function's) values, incl. the R3 chart and its
  tooltip, filters (as-of, vendor/date window, month range); vendor Reports show only the vendor's own R4/R6; a customer
  cannot open them.
- `e2e/vendor-finance.spec.js` — vendor catalogue CRUD (incl. the refused delete of an ordered product); vendor → finance
  payout (same-key replay, overspend `PRF01`, failed → one reversal restores the funds, paid with a UTR); unverified
  (`PRV03`) and negative-balance vendors; customer → finance refund approve / reject; the sample settlement CSVs and
  reconciliation categories, including an unknown reference that posts once its payment appears.
Ledger effects are checked through the finance API with BigInt arithmetic. The settlement test expects the seeded state
(the default rebuild gives it; `PAYRAIL_E2E_SKIP_REBUILD=1` reruns would see duplicates).
It needs the admin connection from the root `.env` like the backend tests (`backend/test/_env.js`).

## Screens (APD W1–W4)
| Route | Screen | API |
|---|---|---|
| `/login` | sign in | `POST /api/auth/login`, `GET /api/auth/me` |
| `/shop` | storefront: search, vendor, price range, sort, paging | `GET /api/products`, `GET /api/vendors` |
| `/cart` | cart grouped by vendor, quantity ≤ 100 per product, place order | `POST /api/orders` |
| `/orders/:id/pay` | choose method, start a payment attempt, see the result when the gateway sends the customer back | `POST /api/orders/:id/payments` |
| `/gateway/checkout/:paymentId` | the simulated gateway's hosted page (outside the shop layout): pay with a test UPI ID / card / bank, or cancel | `GET`/`POST /api/mock-gateway/checkout/:id` |
| `/finance/gateway` | **finance only:** gateway simulator — success / failure / 3× duplicate / wrong-amount callbacks for any attempt | `GET /api/finance/payments`, `POST /api/mock-gateway/payments/:id/simulate` |
| `/orders`, `/orders/:id` | order history (status filter) and detail; per-line refund request | `GET /api/orders[/:id]`, `POST /api/orders/:id/refunds` |
| `/refunds` | the customer's refund requests | `GET /api/refunds` |
| `/vendor` | **vendor:** KYC, commission, ledger-derived balance, payouts in flight, recent sales (snapshot split) | `GET /api/vendor/me`, `/api/vendor/sales` |
| `/vendor/products` | create (active/draft), edit, archive / reactivate, delete never-ordered products | `GET/POST/PATCH/DELETE /api/vendor/products` |
| `/vendor/statement` | ledger lines with window-function running balance, IST date filter, opening/closing | `GET /api/vendor/statement` |
| `/vendor/payouts` | request a payout (Idempotency-Key, same-key replay), history | `POST/GET /api/vendor/payouts` |
| `/vendor/reports` | own balance decomposition (R6) and refund rate of own sales with a date window (R4) | `GET /api/vendor/reports/payables`, `/refund-risk` |
| `/finance/refunds` | **finance:** refund queue, approve (shows the refund entry) / reject | `GET /api/finance/refunds`, `POST …/:id/approve|reject` |
| `/finance/payouts` | payout queue: paid (UTR) / failed (shows request + reversal entries); vendor balances | `GET /api/finance/payouts`, `POST …/:id/complete`, `GET /api/finance/vendors` |
| `/finance/settlements` | upload or paste a settlement CSV, per-row results, imported rows | `POST /api/finance/settlements/import` (text/csv), `GET /api/finance/settlements` |
| `/finance/reconciliation` | as-of date, run reconciliation, category summary, filtered detail | `POST /api/finance/reconcile`, `GET /api/finance/reconciliation` |
| `/finance/ledger` | trial balance (Σ D = Σ C) and latest journal entries by type | `GET /api/finance/trial-balance`, `/api/finance/journal-entries` |
| `/finance/reports?r=R1…R6` | named reports: trial balance (Dr/Cr columns, as-of), vendor statement, monthly performance (Recharts bar chart + table), refund risk, settlement aging, vendor payables. Loaded lazily (own chunk with Recharts) | `GET /api/finance/reports/*` |

## Rules the UI follows (DEC-003, DEC-034, DEC-037)
- **Money is never a JavaScript Number.** Paise arrive as decimal strings; `src/lib/money.js` formats and adds them with
  `BigInt` and parses typed rupees by string manipulation (`"1,250.5"` → `"125050"`).
- **The browser never sends prices, commission, totals or owner ids.** The cart remembers the catalogue price only to show
  an estimate; the order request is `{product_id, quantity}` and the database snapshots the rest.
- **One Idempotency-Key per logical action** (`src/lib/idempotency.js`). The key is tied to the payload (payment: order +
  method; refund: line + amount + reason) and kept in `sessionStorage`, so a retry after a network error, a double click
  or a refresh reuses it and the database returns the original row. A new key is made only after a success, a declined
  payment, or a changed payload.
- **The database has the last word.** The refund and payout forms check limits for convenience; a demo checkbox can
  skip the check to show the database refusing (`PRR01`, `PRF01`, `PRV03`). Errors show the API code and SQLSTATE.
- **Finance decisions are not keyed** (DEC-039): approve/reject and paid/failed act on an existing row whose state machine
  makes a repeat harmless (same row back, nothing posted) and a contradicting decision fail (`PRS01`).
- **Charts are display geometry only** (DEC-040): a bar's height uses `chartRupees(paise)` (whole rupees as a Number,
  refuses values beyond 2^53); every amount shown as text, including chart tooltips, is formatted exactly from the string.
  Reports never compute sums in the browser — totals and rates come from the SQL functions.
- Sample settlement CSVs: `../samples/settlements/` (see its README for the expected results).

## Layout
`src/lib/` (api client, money, idempotency, useApi) · `src/state/` (auth, cart) · `src/components/` (layout, shared UI) ·
`src/pages/` (one file per screen; `vendor/`, `finance/`) · `e2e/` (Playwright) · `playwright.config.js` · `vite.config.js`.
