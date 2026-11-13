# PayRail — Milestones

States: `TODO` · `IN_PROGRESS` · `BLOCKED` · `DONE` (only when acceptance criteria are evidenced in TEST_EVIDENCE.md).
Target dates are a suggested schedule against the GL §7 submission date (15 Nov 2026); adjust as needed.

| ID | Milestone | Depends on | Target | State |
|---|---|---|---|---|
| T0 | Repository audit and executable plan | — | 2 Nov | DONE |
| T1 | Reproducible foundation and core database | T0 | 3 Nov | DONE |
| T2 | Stored workflows, seed, database correctness | T1 | 5–6 Nov | DONE |
| T3 | Backend and authentication | T2 | 7–8 Nov | DONE |
| T4 | Customer workflow UI | T3 | 9–10 Nov | DONE (2026-11-02) |
| T5 | Vendor and finance workflow UI | T3 (parallel with T4) | 10–11 Nov | DONE (2026-11-02) |
| T6 | SQL reports and DBMS evidence | T2 (SQL), T4/T5 (UI exposure) | 12 Nov | DONE (2026-11-02) |
| T7 | Integration, regression tests, demo reliability | T4, T5, T6 | 13–14 Nov | DONE (2026-11-13; sandbox + team Mac T7-09) |
| T8 | README, final design PDF, DEMO, VIVA | T7 (contributions need team input) | 14–15 Nov | TODO |

---

## T0 — Audit and plan — DONE
- [x] Read GL, DBD, APD and project instructions
- [x] Inspect repo (README only) and environment
- [x] Probe PG behaviours the design relies on (E-001…E-005)
- [x] AUDIT.md, DECISIONS.md, REQUIREMENTS.md, TASKS.md, HANDOFF.md, TEST_EVIDENCE.md, CLAUDE.md
**Acceptance:** repo-grounded plan, explicit deviations, clear next task → met (see HANDOFF).

## T1 — Foundation and core database — DONE (2026-11-02)
- [x] `docker-compose.yml` (postgres:16, healthcheck `pg_isready` + schema present, named volume, port from `.env`, init hook) — verified on Parth's Mac: healthy + 135/135 tests (T1-11/12)
- [x] `.env.example`, `.gitignore`, `.nvmrc` (22)
- [x] `db/schema/00_roles.sql`, `01_schema.sql` — schema `payrail`, roles `payrail_owner` / `payrail_app`, `fn_now` (DEC-013, DEC-015)
- [x] `02_tables.sql` — 12 relations, keys and CHECKs incl. DEC-002/009/021 columns
- [x] `03_ledger.sql` — `created_xid` seal, deferred balance triggers on header + lines, append-only + TRUNCATE guards, `fn_post_entry` (DEC-006, DEC-022)
- [x] `04_helpers.sql` — `fn_round_half_up`, `fn_split_line`, `fn_refund_alloc`, `fn_inr`, `fn_normal_side`, `fn_account`, `fn_vendor_payable_account`
- [x] `05_guards.sql` — owner/customer roles, KYC, active product, snapshots, state machines, capture-amount check, immutable history; vendor payable trigger. `06_system_accounts.sql`
- [x] `30_views.sql` (`v_account_balances`, `v_order_line_allocation`, `v_order_summary`, `v_vendor_statement`), `31_indexes.sql`, `99_privileges.sql`
- [x] `db/build.sh` (non-destructive, single transaction), `db/reset_dev.sh` (`--yes` + name guard), `db/docker-init.sh`, `db/README.md`
- [x] Tests: `01_constraints`, `02_money`, `10_ledger`, `11_ledger_immutability`, `12_capture_example` + `run_sql_tests.sh` → 135 passed (TEST_EVIDENCE T1-07/08)
**Acceptance:** clean DB builds with documented commands ✔ (T1-01, T1-04, T1-06); constraint tests and deferred validation pass with real COMMIT, incl. zero-line, single-line and late insertion ✔ (T1-07); UPDATE/DELETE/TRUNCATE/INSERT on the ledger fail as a real `payrail_app` login ✔; hand-traceable capture + refund example balances ✔ (test 12). Compose verified on a team machine ✔ (T1-11, T1-12).

## T2 — Stored workflows and correctness — DONE (2026-11-02)
Files: `db/schema/20_wf_common.sql`, `21_wf_orders_payments.sql`, `22_wf_refunds.sql`, `23_wf_payouts.sql`, `24_wf_settlements.sql` (SECURITY DEFINER, granted in `99_privileges.sql`); fix in `03_ledger.sql` (DEC-026); `db/seed/seed.sql`; tests `20`–`24`, `29`, `_lib/expect_error_rollback.sql`; `backend/test/concurrency/` (+ `backend/package.json`, lockfile).
- [x] `fn_place_order` (verified vendor, active product, qty aggregate ≤ 100, snapshots, client price ignored)
- [x] `fn_initiate_payment`, `fn_capture_payment`, `fn_fail_payment` (DEC-010, DEC-011, DEC-027)
- [x] `fn_request_refund`, `fn_approve_refund`, `fn_reject_refund` (DEC-005, DEC-012)
- [x] `fn_request_payout`, `fn_complete_payout` (paid / failed → one reversal via internal `fn_reverse_entry`) (DEC-008)
- [x] `fn_record_settlement`, `fn_reconcile(as_of)`, `fn_reconciliation_report(as_of)` (DEC-009, DEC-029)
- [x] Deterministic seed via these functions with fixed clock: 5,769 rows; failed/abandoned/initiated payments, partial + full + three-step + rejected + pending refunds, negative vendor balance (recovered and at end), failed payouts, all five reconciliation categories incl. late callback, pending/rejected KYC, archived + draft products
- [x] Tests: 138 new SQL checks + 12 concurrency races with independent connections; mutation check shows the payout race test detects a missing lock
**Acceptance (PI Task 2):** SQL-level workflows ✔ (T2-02, 24 as `payrail_app`); invalid operations fail cleanly ✔; duplicate retries harmless / conflicting keys fail ✔; partial-refund rounding exact ✔; genuine concurrent payout and refund tests ✔ (T2-05/06/10); failed transaction rolls back all effects ✔; negative vendor balance, failed payout reversed once, capture amount mismatch, account creation/uniqueness ✔; actual row counts and trial balance recorded ✔ (T2-07/08). Not yet run in the real Docker image on a team Mac (see TEST_EVIDENCE "Not run yet").

## T3 — Backend and authentication — DONE (2026-11-02)
Files: `backend/src/` (`app.js`, `server.js`, `config.js`, `db.js`, `errors.js`, `validate.js`, `auth.js`, `gateway.js`, `settlementCsv.js`, `routes/{catalogue,customer,vendor,finance,gateway}.js`), `backend/test/api/` (`_setup.js` + 5 files), `backend/README.md`, `backend/package.json` + lockfile (express 5.3.0, zod 4.6.7, jsonwebtoken 9.0.3, bcryptjs 2.4.3, supertest 7.3.1 dev; `npm audit`: 0 vulnerabilities), `.env.example`.
- [x] Express app, `pg` pool as `payrail_app` (int8/date kept as strings), `withTransaction` on one checked-out client (settlement import, SAVEPOINT per row)
- [x] Login (bcrypt + HS256 JWT), role guards, ownership scoping; Zod strict validation; uniform error format with SQLSTATE mapping (DEC-034, DEC-035)
- [x] Endpoints for W1–W4, product CRUD, ledger views (trial balance, vendor statement, journal entries, reconciliation report); pagination/filters — named T6 reports still to come
- [x] Mock gateway: HMAC-signed callback (±5 min), stable refs/event ids, controllable success/failure/duplicate deliveries/amount mismatch (DEC-033)
- [x] Settlement import as CSV or JSON with row-level results (DEC-036)
- [x] API integration tests against a rebuilt, seeded test database: 32 tests (T3-01…T3-04)
**Acceptance (PI Task 3):** API tests exercise the database ✔, all four workflows ✔, invalid input ✔, unauthenticated / forged / expired tokens ✔, cross-customer and cross-vendor access ✔, finance-only actions ✔ (T3-01). Financial endpoints never accept client prices, commission rates, ownership or balances (strict schemas, actor from the JWT; tested) ✔. Real HTTP server smoke test ✔ (T3-05). No secrets committed (only `.env.example` placeholders; the server refuses `CHANGE…` values) ✔. Verified on Parth's Mac with Docker: server + login, API tests 32/32, concurrency tests 12/12 (T3-07, T3-08, T3-11; ran on Node v26 — Node 22 run still pending).

## T4 — Customer UI — DONE (2026-11-02)
Files: `frontend/` (`package.json` + lockfile: react 19.3.1, react-router-dom 7.18.5, vite 8.3.5, tailwindcss 4.3.3, @playwright/test 1.63.0; `npm audit` 0 vulnerabilities), `src/lib/{api,money,idempotency,useApi}.js`, `src/state/{auth,cart}.jsx`, `src/components/{Layout,ui}.jsx`, `src/pages/{Login,Catalogue,Cart,Pay,Orders,OrderDetail,Refunds,StaffHome}.jsx`, `e2e/customer.spec.js`, `playwright.config.js`, `README.md`; root `.gitignore` (+ `test-results/`, `playwright-report/`). DEC-037.
- [x] Vite + React + Tailwind scaffold, `/api` dev proxy, fetch wrapper with `{error}` + SQLSTATE display, BigInt money helpers (unit tests)
- [x] Login / session restore (401 → login; server down → Retry, token kept); role routing (vendor/finance placeholder replaced in T5)
- [x] Storefront: search (debounced), vendor, price range (exact rupee parsing), sort, paging — all from `GET /api/products`
- [x] Cart per customer: aggregate per product, cap 100, grouped by vendor, multi-vendor notice; order request carries ids + quantities only
- [x] Payment page: attempt with Idempotency-Key tied to (order, method) in sessionStorage → redirect to the simulated gateway's hosted checkout (`GatewayCheckout.jsx`, test UPI / card / bank, cancel) → back to the shop with the result from the database; attempts table. No approve/decline controls for customers (DEC-038)
- [x] Finance-only gateway simulator (`GatewaySimulator.jsx`, `/finance/gateway`): success / failure / 3× duplicate / wrong-amount callbacks for any attempt; backend: hosted-checkout endpoints, `simulate` restricted to finance, `GET /api/finance/payments` (DEC-038)
- [x] Order history (status filter, paging), order detail (lines with refunded / pending / refundable, payments, refunds), per-line refund form (key tied to line+amount+reason, same-key replay button, demo bypass of the browser check), My refunds
- [x] Loading, empty, validation and failure states (incl. backend down via proxy 502)
- [x] Browser smoke test on a dedicated rebuilt `payrail_e2e`: 4 tests after the DEC-038 revision (T4-09); mutation checks (T4-04, T4-10)
**Acceptance (PI Task 4):** seeded customer completes a real two-vendor purchase and a refund request through the UI ✔; order status and ledger verified (one balanced capture entry with per-vendor / commission / GST credits equal to the line split; refund request posts nothing; after finance approval the derived status is `partially refunded` and a balanced refund entry credits clearing 10050) ✔ (T4-03, T4-05); declined payment at the gateway page, and (finance simulator) wrong-amount, 3× duplicate and late failure callbacks demonstrable ✔ (T4-09); invalid refund refused by the database (`PRR01`) ✔; same key reused on retry after a lost response → one attempt / one refund ✔; no mock arrays (every screen reads the API) ✔. Not yet run on a team Mac (see TEST_EVIDENCE "Not run yet").

## T5 — Vendor & finance UI — DONE (2026-11-02)
Files: `frontend/src/pages/vendor/{VendorHome,Products,Statement,Payouts}.jsx`, `frontend/src/pages/finance/{Refunds,Payouts,Settlements,Reconciliation,TrialBalance,LedgerEntries}.jsx`, `frontend/src/{App.jsx,components/Layout.jsx,components/ui.jsx,lib/api.js}`, `frontend/e2e/vendor-finance.spec.js` (+ finance landing in `customer.spec.js`), `samples/settlements/{01_normal,02_reupload_duplicate_conflict,03_exceptions}.csv` + `README.md`; backend: `src/settlementCsv.js` + `routes/finance.js` (invalid CSV rows echo their reference), `test/api/finance.test.js`. `StaffHome.jsx` removed. DEC-039.
- [x] Role routing: vendor → `/vendor`, finance → `/finance/refunds`; role-specific nav
- [x] Vendor dashboard: KYC, commission, ledger-derived balance (negative shown + explained), payouts in flight, recent sales with snapshot split
- [x] Vendor products: create (active or draft), edit name/price, archive / reactivate, delete never-ordered product; delete of an ordered product refused by the FK (`23503`, shown)
- [x] Vendor statement: window-function running balance, IST date filter, opening/closing balance, paging
- [x] Vendor payouts: request with Idempotency-Key (same amount → same key; same-key replay button), browser check + demo bypass so PRF01/PRV03 are visible; history with status filter
- [x] Finance refunds: queue (status + vendor filters), approve → shows the balanced refund entry; reject → released, nothing posted
- [x] Finance payouts: mark paid (UTR, format-checked) / failed (confirm) → shows request + reversal entries; "failed again" demo shows exactly-once; vendor balances panel
- [x] Settlement import: file picker or paste, bounded (256 KB client check; server ≤ 1000 rows), per-row results (inserted/posted, duplicate, conflict, rejected + SQLSTATE, invalid + reasons), imported rows list
- [x] Reconciliation: as-of date (server demo default), run (newly posted), category summary + explanations, filter by category / reference, paging
- [x] Ledger: trial balance with global Σ D = Σ C check, latest entries by type
- [x] Sample CSVs for normal, duplicate/conflict and exceptional cases (results observed)
- [x] Browser tests: 5 new (catalogue CRUD; payout incl. replay, overspend, failed-once, paid; unverified + negative vendor; customer → finance refund approve/reject; settlement samples + reconciliation incl. unknown-ref revisit)
**Acceptance (PI Task 5):** customer → finance refund ✔ and vendor → finance payout ✔ end to end in the UI (T5-03); failed payouts restore funds exactly once ✔ (UI + ledger: 1 reversal, retry posts nothing, T5-03/T5-06); unverified vendor (`PRV03`) and overspending (`PRF01`, incl. a negative-balance vendor) refused ✔; catalogue create/edit/archive/reactivate/delete-draft and refused delete of referenced history ✔; settlement imports persist and explain each case; only exact matches are posted ✔ (T5-04). Not yet run on a team Mac.

## T6 — Reports and DBMS evidence — DONE (2026-11-02)
Files: `db/schema/32_reports.sql` (+ GRANTs in `99_privileges.sql`, comment in `31_indexes.sql`), `db/tests/30_reports.sql`, `db/tests/31_reports_seed.sql`, `db/reports/{README.md,run_reports.sql,explain_reports.sql}`; backend `src/routes/reports.js` (+ `finance.js` trial balance = R1, `vendor.js` statement = R2), `test/api/reports.test.js`; frontend `src/pages/finance/Reports.jsx`, `src/pages/vendor/Reports.jsx`, `src/{App.jsx,components/Layout.jsx,lib/money.js(+test)}`, `pages/vendor/Statement.jsx`, `pages/finance/TrialBalance.jsx` (comments / reference column), `e2e/reports.spec.js`, `package.json` + lock (recharts 3.10.1); docs `docs/FEATURE_MATRIX.md`, `docs/evidence/T6_explain_seed.txt`, `db/README.md`, `backend/README.md`, `frontend/README.md`. DEC-040.
- [x] R1 trial balance (per-account Dr/Cr, `GROUPING SETS` total + equality, as-of filter)
- [x] R2 vendor statement (window running balance over the full history, date filter after the window, opening/closing, references)
- [x] R3 monthly performance (IST months via `generate_series`, month-grain CTEs, explicit date bases, cumulative window; Recharts chart + table)
- [x] R4 vendor refund risk (sales cohort, explicit numerator/denominator, rank above a minimum sample, bands)
- [x] R5 settlement reconciliation & aging (reference matching from `fn_reconciliation_report`, per-category age buckets, subtotals, net cash of posted rows)
- [x] R6 vendor payables/payouts (ledger decomposition by entry type + payouts-table cross-check)
- [x] Aggregation at the correct grain (fan-out test), date/vendor filters, exact paise / basis points
- [x] Hand-checkable fixture (24 checks) + seed cross-checks (7) + mutation checks (T6-04)
- [x] API: `/api/finance/reports/*` (finance), `/api/vendor/reports/*` (own vendor), statement and trial balance reuse R2/R1; 7 API tests
- [x] UI: finance Reports page (6 tabs), vendor Reports page; 2 browser tests; screens viewed (T6-06)
- [x] `EXPLAIN (ANALYZE, BUFFERS)` on the seeded DB + index experiment; index justification without speed claims
- [x] Feature matrix (`docs/FEATURE_MATRIX.md`) with files, tests and demo paths; report walkthrough (`db/reports/README.md`)
**Acceptance (PI Task 6):** ≥ 5 named non-trivial reports ✔ (six); agree with small hand-checkable fixtures ✔ (T6-01, `30_reports.sql`) and seeded records ✔ (`31_reports_seed.sql`); finance UI shows all six, vendor UI shows vendor-scoped R2/R4/R6 ✔ (T6-03); no join fan-out (aggregated per grain, tested) ✔; date/vendor filters ✔; joins/grouping/CTEs/windows explained ✔ (`db/reports/README.md`); EXPLAIN (ANALYZE, BUFFERS) collected, indexes justified without invented speed-ups ✔ (T6-05); feature matrix with exact demo commands / UI paths ✔. Not yet run on a team Mac.

## T7 — Integration and demo reliability — DONE (2026-11-13)
Files: new `scripts/{demo-reset.sh,test-all.sh,demo-race.mjs}`, `backend/src/doctor.js` (+ `npm run doctor`, startup check in `server.js`), `backend/test/api/operations.test.js`, `docs/RUNBOOK.md`; changed `db/schema/20_wf_common.sql` (`fn_vendor_balance` InitPlan), `frontend/src/pages/{Orders,Refunds,Catalogue}.jsx`, `finance/Reconciliation.jsx`, `vendor/Statement.jsx` (functional URL-filter updates), `backend/package.json`.
- [x] Baseline regression on `main` @ `b095d4f` (T7-01)
- [x] API tests for the 3 Nov operations endpoints, with mutation checks (T7-02)
- [x] T6 findings fixed: URL filters use functional updates on all pages; `fn_vendor_balance` lookup runs once even on a seq scan (T7-03)
- [x] Startup check naming `.env` / role-password / port / old-schema / privilege problems, also run at backend start (T7-04)
- [x] Safe demo reset (guarded, DB `payrail` only, Docker or local, re-syncs the app password) and recovery table (`docs/RUNBOOK.md`); reset with a running backend (T7-08d)
- [x] Clean-install rehearsal from a fresh clone + fresh cluster following the runbook (T7-05); full suite via `scripts/test-all.sh` (T7-06)
- [x] Fixed demo inputs: seed byte-identical across resets (T7-07); as-of 2026-10-31; first new order after a reset is #370
- [x] Demo path walk of all 22 pages, timed UI dry run of W1–W4, live concurrency script (T7-08, 08b, 08c): no console errors / 5xx except the intentional 409
- [x] Team Mac with Docker (T7-09a/b, T7-10, T7-09): found and fixed a doctor false alarm, an e2e path bug with spaces in the folder name, and an admin-password drift in the Docker volume; then all suites green there
**Acceptance (PI Task 7):** documented setup works from a fresh checkout/database ✔ (local path T7-05; Docker on a team Mac T7-09); every workflow reproducible ✔ (e2e + dry run on the reset demo DB); evidence separates executed checks from limitations ✔ (TEST_EVIDENCE T7, "Not run yet"); no unexplained console/API errors in the demo path ✔ (T7-08/08b).

## T8 — Submission pack — TODO
README (actual contributions **confirmed by team**), final design PDF ≤ 5 pages + editable source, DEMO.md (10–12 min), VIVA.md, final requirements checklist.
**Acceptance:** as PI Task 8. Claude does not push/submit.


## Operations UI update (2026-11-03)
Implemented read-only finance overview, reconciliation summary and differences, order/payout detail routes, and exact-record recovery after uncertain finance decisions. No financial schema or workflow changes. Validation results will be recorded after checks.
