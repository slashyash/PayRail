# PayRail — Handoff

_Last updated: 2026-11-02, end of session 5 (Task 4)._

## Current milestone
**T4 DONE** (acceptance evidenced in TEST_EVIDENCE T4-01…T4-11; revised in the same session per DEC-038 — customers now pay on a separate gateway page, and the fault-injection buttons are finance-only). Next: **T5 — vendor and finance UI** (critical path), then T6 reports.

## Working state
- Mac folder `/Users/parth/payrail-dbms project`: git clone of `slashyash/PayRail`. `main` @ `3f00944` includes Task 3 (PR #3 merged; branch `task3-backend` deleted). **Task 4 committed and pushed** on branch **`task4-customer-ui` @ `d7c2e3c`** (45 files, branched from `main` @ `3f00944`); next: open/merge its PR (https://github.com/slashyash/PayRail/pull/new/task4-customer-ui). This HANDOFF line is the only change after that commit.
- Session 5 wrote into the folder (Project copies of the docs kept in sync):
  - new: `frontend/` — `package.json`, `package-lock.json`, `vite.config.js`, `playwright.config.js`, `index.html`, `README.md`, `src/main.jsx`, `src/App.jsx`, `src/index.css`, `src/lib/{api,money,money.test,idempotency,useApi}.js`, `src/state/{auth,cart}.jsx`, `src/components/{Layout,ui,DeliveryResults}.jsx`, `src/pages/{Login,Catalogue,Cart,Pay,GatewayCheckout,GatewaySimulator,Orders,OrderDetail,Refunds,StaffHome}.jsx`, `e2e/customer.spec.js`
  - changed (DEC-038 revision): `backend/src/gateway.js` (test instruments, `decideCheckout`), `backend/src/routes/gateway.js` (hosted checkout; `simulate` finance-only), `backend/src/routes/finance.js` (`GET /payments`), `backend/test/api/{_setup.js,auth.test.js,customer.test.js,finance.test.js}`, `backend/README.md`
  - changed: `.gitignore` (+ `test-results/`, `playwright-report/`)
  - docs: `CLAUDE.md`, `docs/DECISIONS.md` (DEC-037), `docs/TASKS.md`, `docs/REQUIREMENTS.md`, `docs/TEST_EVIDENCE.md`, `docs/HANDOFF.md`
- No schema or seed change → existing Docker volumes are fine. **Restart the backend** (`npm start`) to pick up the new gateway routes.

## Commands actually run (session 5, cloud sandbox, PG 16.15 TCP/scram, node 22.23.4)
| Command | Result |
|---|---|
| `git clone -b task3-backend https://github.com/slashyash/PayRail` (same commit as the Mac) | `0077331` |
| `db/tests/run_sql_tests.sh`; `cd backend && npm ci && npm run test:api && npm run test:concurrency` (before changes) | 273 passed; 32/32; 12/12 |
| `cd frontend && npm test` | 3/3 |
| `rm -rf node_modules && npm ci && npm run build && npm audit` | build OK, 0 vulnerabilities |
| `npm run test:e2e` (rebuilds `payrail_e2e`) | 3 passed, 3 full runs green (T4-03) |
| mutation: new key on every call → `npx playwright test -g "lost response"`; restored | caught (Expected 1, Received 2); then 3 passed (T4-04) |
| `psql` on `payrail_e2e`: UI-created order 370, its ledger, trial balance | hand-checked split and refund allocation (T4-05) |
| manual Playwright: backend stopped / restarted | error states + Retry recovery (T4-06) |
| `cd backend && npm run test:api` (after the first version) | 32/32 (T4-07) |
| DEC-038 revision: `npm run test:api` (`API_TEST_LOG=1`) | 33/33, no 500s (T4-08) |
| `npm run test:e2e` ×3 | 4 passed each (T4-09) |
| mutations: checkout accepts any instrument; new key per call (both reverted) | each caught (T4-10) |
| SQL tests; API; concurrency; e2e; unit; build | 273; 33; 12; 4; 3; built (T4-11) |

## To try it on the Mac (not run there yet)
```bash
cd ~/"payrail-dbms project"
docker compose up -d db
cd backend && npm ci && npm start              # terminal 1 → http://127.0.0.1:4000
cd frontend && npm ci && npm run dev           # terminal 2 → open http://127.0.0.1:5173
# log in as customer1@payrail.demo / PayRail@2026
# browser smoke test (separate DB payrail_e2e, own servers on :4100/:5174 — stop nothing):
npx playwright install chromium
PAYRAIL_REBUILD_VIA_DOCKER=1 npm run test:e2e
```
Node: Vite 8 needs ≥ 22.12 (Node 26 works but prints `EBADENGINE`). zsh: do not paste `# comments` unless `setopt interactivecomments`.

## Demo path (~4 min)
Customer: Shop → filter by a vendor, add 2 products from 2 vendors → Cart shows "multi-vendor order" → Place order → **Continue to pay** → redirected to the **MockPay Gateway (TEST MODE)** page → click `failure@payrail` → Pay → back at the shop: "Payment not completed", attempt `failed` → choose Card → Continue → click test card `4111 1111 1111 1111` → Pay → "Payment successful" → View order → Request refund on a line: more than refundable + demo box → database refuses (`PRR01`); then ₹100.50 → `requested` → **Send the same request again** → same refund id.
Finance (`finance@payrail.demo`) → **Gateway simulator**: pick an `initiated` attempt (e.g. one a customer left at the gateway) → **Gateway error: callback reports a different amount** (409 `PRP01`, nothing posted) → **Success, delivered 3×** (one capture) → **Failure callback** (409 `PRS01`). Refund approval UI is T5 (for now: `POST /api/finance/refunds/:id/approve`).

## What T4 demonstrates (viva notes)
- **Three tiers, one source of truth:** every screen reads PostgreSQL views through the API (`v_order_summary`, `v_order_line_allocation`); order status and refundable amounts are derived, never computed in the browser.
- **Never trust the client:** the order request is `{product_id, quantity}`; price/commission are snapshotted by `trg_order_items_snapshot`; the payment amount is `fn_order_total`.
- **Idempotency from the user's side:** the key is created per logical action and reused on retry; a test drops the first response after the server committed it and shows one attempt / one refund, and a mutation (new key per click) makes it fail.
- **Two parties:** the shop never decides a payment's outcome; the gateway does (test instruments) and tells the backend through an HMAC-signed callback. Fault injection (duplicates, wrong amount, late failure) is a finance-only tool; the database accepts each outcome once and refuses the rest, with SQLSTATEs shown.
- **Exact money:** BigInt formatting/parsing; the test compares ledger sums as BigInt.

## Known blockers / risks
- T4 has not run on a team Mac yet (Playwright needs `npx playwright install chromium` there).
- PROPOSED decisions (DEC-002, DEC-005…DEC-022, DEC-035) are implemented as defaults; flag objections. DEC-037 lists UI limitations (JWT in localStorage, order placement not keyed, vendor placeholder page); DEC-038 notes that public test instruments still let a customer pick the simulated outcome, as in any gateway test mode.
- Schedule: 13 days to the GL §7 submission date (15 Nov); T5 is the critical path, then T6.

## How the next session should start
1. Read `CLAUDE.md`, `docs/HANDOFF.md`, `docs/TASKS.md`, `docs/DECISIONS.md` from the Mac folder; `git status` / `git log` there.
2. Get the code into the sandbox: if the team has pushed, `git clone -b <branch> https://github.com/slashyash/PayRail` (fast; worked this session) and copy over any uncommitted files from the Mac; otherwise stage the files. Start a PG16 cluster (CLAUDE.md recipe), write a sandbox root `.env`, run `db/tests/run_sql_tests.sh` (273), `cd backend && npm ci && npm run test:api` (32) and `test:concurrency` (12), `cd frontend && npm ci && npm run test:e2e` (4).
3. Implement T5, write changed files back, update docs.

## Next concrete action
T5 in `frontend/`: route by role (replace `StaffHome.jsx`). Vendor: products list/create/edit/archive/reactivate/delete-draft (`/api/vendor/products`), balance + running statement with date filter (`/api/vendor/me`, `/statement`), payout request with `useIdempotencyKey` + history (`/api/vendor/payouts`). Finance (keep the existing Gateway simulator screen and add nav items): refund queue approve/reject, payout queue paid (UTR)/failed, settlement CSV upload (`text/csv`, show per-row results) + `samples/settlements/*.csv` (normal, duplicate, conflict, mismatch, unknown ref, future date), reconcile + reconciliation categories, trial balance. Add Playwright specs for vendor → finance payout (incl. failed payout restoring funds once, overspend refused, unverified vendor refused) and customer → finance refund.
