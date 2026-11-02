# PayRail — Handoff

_Last updated: 2026-11-02, end of session 5 (Task 4)._

## Current milestone
**T4 DONE** (acceptance evidenced in TEST_EVIDENCE T4-01…T4-07). Next: **T5 — vendor and finance UI** (critical path), then T6 reports.

## Working state
- Mac folder `/Users/parth/payrail-dbms project`: git clone of `slashyash/PayRail`, branch **`task3-backend` @ `0077331`** (Task 3 committed and pushed; PR to `main` not merged yet). Everything from session 5 is **uncommitted** on top of it; suggested: `git switch -c task4-customer-ui`, review, commit, push, PR (after the Task 3 PR, or stacked on it).
- Session 5 wrote into the folder (Project copies of the docs kept in sync):
  - new: `frontend/` — `package.json`, `package-lock.json`, `vite.config.js`, `playwright.config.js`, `index.html`, `README.md`, `src/main.jsx`, `src/App.jsx`, `src/index.css`, `src/lib/{api,money,money.test,idempotency,useApi}.js`, `src/state/{auth,cart}.jsx`, `src/components/{Layout,ui}.jsx`, `src/pages/{Login,Catalogue,Cart,Pay,Orders,OrderDetail,Refunds,StaffHome}.jsx`, `e2e/customer.spec.js`
  - changed: `.gitignore` (+ `test-results/`, `playwright-report/`)
  - docs: `CLAUDE.md`, `docs/DECISIONS.md` (DEC-037), `docs/TASKS.md`, `docs/REQUIREMENTS.md`, `docs/TEST_EVIDENCE.md`, `docs/HANDOFF.md`
- No backend, schema or seed change in T4 → existing Docker volumes and the backend need nothing new.

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
| `cd backend && npm run test:api` (after) | 32/32 (T4-07) |

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

## Demo path (customer, ~3 min)
Shop → filter by a vendor, add 2 products from 2 vendors → Cart shows "multi-vendor order" → Place order → Pay → **Decline** (attempt failed, order still unpaid) → Pay again → **Gateway reports wrong amount** (409 `PRP01`, nothing posted) → **Approve, callback delivered 3×** (one capture) → **Send a late failure callback** (409 `PRS01`) → View order → Request refund on a line: type more than refundable, tick the demo box → database refuses (`PRR01`); then ₹100.50 → `requested`, pending shown → **Send the same request again** → same refund id. Finance approval UI is T5 (for now: `POST /api/finance/refunds/:id/approve`).

## What T4 demonstrates (viva notes)
- **Three tiers, one source of truth:** every screen reads PostgreSQL views through the API (`v_order_summary`, `v_order_line_allocation`); order status and refundable amounts are derived, never computed in the browser.
- **Never trust the client:** the order request is `{product_id, quantity}`; price/commission are snapshotted by `trg_order_items_snapshot`; the payment amount is `fn_order_total`.
- **Idempotency from the user's side:** the key is created per logical action and reused on retry; a test drops the first response after the server committed it and shows one attempt / one refund, and a mutation (new key per click) makes it fail.
- **Gateway callbacks:** duplicate deliveries → one capture entry; wrong amount and late failure refused by the database with SQLSTATEs shown in the UI.
- **Exact money:** BigInt formatting/parsing; the test compares ledger sums as BigInt.

## Known blockers / risks
- T4 has not run on a team Mac yet (Playwright needs `npx playwright install chromium` there).
- PROPOSED decisions (DEC-002, DEC-005…DEC-022, DEC-035) are implemented as defaults; flag objections. DEC-037 lists UI limitations (JWT in localStorage, order placement not keyed, staff placeholder page).
- Schedule: 13 days to the GL §7 submission date (15 Nov); T5 is the critical path, then T6.

## How the next session should start
1. Read `CLAUDE.md`, `docs/HANDOFF.md`, `docs/TASKS.md`, `docs/DECISIONS.md` from the Mac folder; `git status` / `git log` there.
2. Get the code into the sandbox: if the team has pushed, `git clone -b <branch> https://github.com/slashyash/PayRail` (fast; worked this session) and copy over any uncommitted files from the Mac; otherwise stage the files. Start a PG16 cluster (CLAUDE.md recipe), write a sandbox root `.env`, run `db/tests/run_sql_tests.sh` (273), `cd backend && npm ci && npm run test:api` (32) and `test:concurrency` (12), `cd frontend && npm ci && npm run test:e2e` (3).
3. Implement T5, write changed files back, update docs.

## Next concrete action
T5 in `frontend/`: route by role (replace `StaffHome.jsx`). Vendor: products list/create/edit/archive/reactivate/delete-draft (`/api/vendor/products`), balance + running statement with date filter (`/api/vendor/me`, `/statement`), payout request with `useIdempotencyKey` + history (`/api/vendor/payouts`). Finance: refund queue approve/reject, payout queue paid (UTR)/failed, settlement CSV upload (`text/csv`, show per-row results) + `samples/settlements/*.csv` (normal, duplicate, conflict, mismatch, unknown ref, future date), reconcile + reconciliation categories, trial balance. Add Playwright specs for vendor → finance payout (incl. failed payout restoring funds once, overspend refused, unverified vendor refused) and customer → finance refund.
