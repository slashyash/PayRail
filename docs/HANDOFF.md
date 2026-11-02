# PayRail — Handoff

_Last updated: 2026-11-02, end of session 6 (Task 5)._

## Current milestone
**T5 DONE** (acceptance evidenced in TEST_EVIDENCE T5-01…T5-09). All four workflows now run end to end in the UI. Next: **T6 — named SQL reports and DBMS evidence** (critical path), then T7 integration/demo reliability.

## Working state
- Mac folder `/Users/parth/payrail-dbms project`: git clone of `slashyash/PayRail`, `main` @ `c77df2b` (Task 4 merged as PR #4). Session 6 wrote the T5 files into it **uncommitted** (Claude does not commit). An untracked `AGENTS.md` (a Codex copy of CLAUDE.md, not Claude's) was there before and was left untouched.
- Files written by session 6 (Project copies of the docs kept in sync):
  - new: `frontend/src/pages/vendor/{VendorHome,Products,Statement,Payouts}.jsx`, `frontend/src/pages/finance/{Refunds,Payouts,Settlements,Reconciliation,TrialBalance,LedgerEntries}.jsx`, `frontend/e2e/vendor-finance.spec.js`, `samples/settlements/{01_normal,02_reupload_duplicate_conflict,03_exceptions}.csv`, `samples/settlements/README.md`
  - changed: `frontend/src/App.jsx` (role routes), `frontend/src/components/Layout.jsx` (vendor/finance nav), `frontend/src/components/ui.jsx` (badges, `Stat`, `formatDate`, `Money` shows `—` for null), `frontend/src/lib/api.js` (`patch`, `del`, `postText`), `frontend/e2e/customer.spec.js` (finance now lands on `/finance/refunds`), `backend/src/settlementCsv.js` + `backend/src/routes/finance.js` (invalid CSV rows echo `gateway_ref`), `backend/test/api/finance.test.js` (+2 assertions), `backend/README.md`, `frontend/README.md`
  - **deleted:** `frontend/src/pages/StaffHome.jsx` (placeholder, no longer imported) — if it is still in the folder, `git rm frontend/src/pages/StaffHome.jsx`
  - docs: `CLAUDE.md`, `docs/{DECISIONS (DEC-039), TASKS, REQUIREMENTS, TEST_EVIDENCE, HANDOFF}.md`
- No schema, seed or dependency change → existing Docker volumes and `node_modules` are fine. **Restart the backend** to pick up the small import-response change.
- Suggested commit: branch `task5-vendor-finance-ui`, `git add -A frontend backend samples docs CLAUDE.md` (not `AGENTS.md` unless the team wants it), push, PR.

## Commands actually run (session 6, cloud sandbox, PG 16.15 TCP/scram, node 22.23.4)
| Command | Result |
|---|---|
| `git clone https://github.com/slashyash/PayRail` (= Mac `main` @ `c77df2b`) | ok |
| baseline: SQL tests; `npm run test:api`; `test:concurrency`; frontend `npm test`; `test:e2e` | 273; 33/33; 12/12; 3/3; 4 passed |
| sample CSVs via `curl` on a fresh `payrail` + `POST /reconcile` | T5-01/T5-02 (all expected outcomes) |
| `npm run test:e2e` ×3, then ×1 after the last UI change | 9 passed each time |
| mutations (payout key ignored; `as_of` ignored), reverted | each caught (T5-05) |
| `psql` on `payrail_e2e`: failed payout + reversal, balances, settlement postings | T5-06 |
| SQL tests; API; concurrency; unit; build; audit | 273; 33/33; 12/12; 3/3; built; 0 vulnerabilities |

## To try it on the Mac (not run there yet)
```bash
cd ~/"payrail-dbms project"
docker compose up -d db
cd backend && npm ci && npm start              # terminal 1 → http://127.0.0.1:4000
cd frontend && npm ci && npm run dev           # terminal 2 → http://127.0.0.1:5173
# vendor1@payrail.demo / finance@payrail.demo / customer1@payrail.demo — password PayRail@2026
npx playwright install chromium               # once
PAYRAIL_REBUILD_VIA_DOCKER=1 npm run test:e2e  # 9 tests, separate DB payrail_e2e
```
The sample CSVs match only a freshly seeded DB (`db/reset_dev.sh --yes payrail` — DESTRUCTIVE for that DB — or a new Docker volume).

## Demo path for T5 (~5 min)
1. **Vendor** (`vendor1`): Dashboard (ledger balance, sales split) → Products: add a draft, edit price, Reactivate, Archive, Delete it; Delete an "ordered" product → `23503` refused → Statement (pick a From date: opening balance + running balance) → Payouts: request ₹150.25 → "Send the same request again" (same id) → amount larger than the balance + demo checkbox → `PRF01`.
2. **Finance**: Payouts → Mark failed on that payout → request + reversal entries shown → "record failed again" (still 2 entries) → Mark paid… on another (UTR) → Refunds: approve one (balanced refund entry), reject one (nothing posted) → Settlements: upload `01_normal.csv` (4 posted), again (4 duplicates), `02…` (duplicate / conflict / new), `03_exceptions.csv` (not posted / rejected / invalid) → Reconciliation: Run → five categories; search `pay_S000999999` (unknown) → Ledger: Σ D = Σ C.
3. **Refusals**: `vendor11` (KYC pending) payout → `PRV03`; `vendor7` (negative balance) → `PRF01`.

## What T5 demonstrates (viva notes)
- **Derived balances:** every vendor balance is Σ credit − Σ debit on its payable account; the statement's running balance is a window function (`SUM … OVER (ORDER BY created_at, entry_id, line_no)`), the date filter is applied *after* the window so the first row's balance is still correct.
- **Locks + idempotency from the UI:** a payout request carries one key per logical request; the function locks the payable account, reads the balance and refuses overspend. A lost response or double click returns the same payout.
- **State machines instead of keys:** finance decisions are guarded by row state — repeating "failed" posts no second reversal; contradicting a final state is `PRS01`.
- **Referential integrity as a feature:** a product with order lines cannot be deleted (FK, `23503`); archive instead.
- **Bounded, row-level import:** one transaction, a SAVEPOINT per row; only exact matches post; duplicates are harmless; conflicts keep the original; unknown references are stored and post later when the payment appears (`fn_reconcile`).

## Known blockers / risks
- First Mac run (Parth, 2026-11-02): backend + DB came up after two local fixes — `.env` secrets were still placeholders, and the Docker volume's `payrail_app` password differed from `.env` (login/health 500; fixed with `ALTER ROLE`, see `backend/README.md` Troubleshooting). `/api/health` → `ok`, `db_user payrail_app`. UI checklist and `npm run test:e2e` on the Mac: not yet reported. T7 should make this failure obvious (e.g. a clearer startup check).
- PROPOSED decisions (DEC-002, DEC-005…DEC-022, DEC-035) are implemented as defaults; flag objections.
- Schedule: 13 days to the GL §7 submission date (15 Nov). T6 next (reports R1–R6 + EXPLAIN evidence + feature matrix), then T7, T8 (PDF ≤ 5 pages, README contributions **confirmed by the team**).

## How the next session should start
1. Read `CLAUDE.md`, `docs/HANDOFF.md`, `docs/TASKS.md`, `docs/DECISIONS.md` from the Mac folder; `git status` / `git log` there.
2. Get the code into the sandbox: `git clone -b <branch> https://github.com/slashyash/PayRail` if pushed, plus any uncommitted Mac files; start a PG16 cluster (CLAUDE.md recipe), write a sandbox root `.env`, run SQL tests (273), `npm run test:api` (33), `test:concurrency` (12), `cd frontend && npm ci && npm run test:e2e` (9).
3. Implement T6, write changed files back, update docs.

## Next concrete action
T6: create `db/reports/R1_trial_balance.sql` … `R6_vendor_payables.sql` (parameterised, aggregated at the right grain), small hand-checkable fixtures in `db/tests/` (new SQL test file), expose via `GET /api/finance/reports/:name` and vendor-scoped R2/R4 under `/api/vendor/reports/…`, add a finance **Reports** page (first Recharts chart: R3 monthly performance) and a vendor report view; collect `EXPLAIN (ANALYZE, BUFFERS)` on the seeded DB for R2/R5 and justify `31_indexes.sql`; write the feature matrix (transactions, views, triggers, functions, indexes → file + demo command).
