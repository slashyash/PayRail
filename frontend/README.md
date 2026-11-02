# PayRail frontend (Task 4: customer UI)

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
Log in as `customer1@payrail.demo` … `customer60@payrail.demo` (password `PayRail@2026`).
`PAYRAIL_API_URL=http://127.0.0.1:4100 npm run dev` points the proxy at another backend.
Vendor logins land on a placeholder page until Task 5; finance lands on the gateway simulator (the rest of finance is Task 5).

## Tests
```bash
npm test                         # money helpers (node:test, no browser)
npx playwright install chromium  # once per machine
npm run test:e2e                 # browser smoke test (PAYRAIL_REBUILD_VIA_DOCKER=1 on Docker-only machines)
```
`test:e2e` rebuilds and seeds a **separate** database `payrail_e2e` (never your demo `payrail`), starts its own backend
(:4100) and Vite server (:5174), and drives Chromium through `e2e/customer.spec.js`: a two-vendor purchase paid at the
gateway page (test UPI declined, non-test card refused, test card approved), an over-limit refund refused by the
database, a valid partial refund, a same-key replay, finance approval via the API, a cross-customer access attempt, lost
responses retried with the same key, and the finance gateway simulator (wrong amount refused, 3 duplicate deliveries →
one capture, late failure refused). Ledger effects are checked through the finance API with BigInt arithmetic.
It needs the admin connection from the root `.env` like the backend tests (`backend/test/_env.js`).

## Screens (APD W1, W3)
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

## Rules the UI follows (DEC-003, DEC-034, DEC-037)
- **Money is never a JavaScript Number.** Paise arrive as decimal strings; `src/lib/money.js` formats and adds them with
  `BigInt` and parses typed rupees by string manipulation (`"1,250.5"` → `"125050"`).
- **The browser never sends prices, commission, totals or owner ids.** The cart remembers the catalogue price only to show
  an estimate; the order request is `{product_id, quantity}` and the database snapshots the rest.
- **One Idempotency-Key per logical action** (`src/lib/idempotency.js`). The key is tied to the payload (payment: order +
  method; refund: line + amount + reason) and kept in `sessionStorage`, so a retry after a network error, a double click
  or a refresh reuses it and the database returns the original row. A new key is made only after a success, a declined
  payment, or a changed payload.
- **The database has the last word.** The refund form checks the refundable limit for convenience; a demo checkbox can
  skip that check to show the database refusing (`PRR01`). Errors show the API code and SQLSTATE.

## Layout
`src/lib/` (api client, money, idempotency, useApi) · `src/state/` (auth, cart) · `src/components/` (layout, shared UI) ·
`src/pages/` (one file per screen) · `e2e/` (Playwright) · `playwright.config.js` · `vite.config.js`.
