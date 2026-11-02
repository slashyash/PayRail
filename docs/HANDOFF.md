# PayRail — Handoff

_Last updated: 2026-11-02, end of session 7 (Task 6)._

## Current milestone
**T6 DONE** (acceptance evidenced in TEST_EVIDENCE T6-01…T6-09). Six named reports R1–R6 run in SQL, the API, the finance and vendor UIs, and psql; EXPLAIN evidence and the feature matrix are written. Next: **T7 — integration, regression tests, demo reliability**, then T8 (README + contributions confirmed by the team, ≤ 5-page design PDF, DEMO.md, VIVA.md).

## Working state
- Mac folder `/Users/parth/payrail-dbms project`: git clone of `slashyash/PayRail`, `main` @ `d84123f` (Task 5 merged as PR #5). Session 7 wrote the T6 files into it **uncommitted** (Claude does not commit). The untracked `AGENTS.md` (a Codex copy of CLAUDE.md, not Claude's) was left untouched.
- Files written by session 7:
  - new: `db/schema/32_reports.sql`, `db/tests/30_reports.sql`, `db/tests/31_reports_seed.sql`, `db/reports/{README.md,run_reports.sql,explain_reports.sql}`, `backend/src/routes/reports.js`, `backend/test/api/reports.test.js`, `frontend/src/pages/finance/Reports.jsx`, `frontend/src/pages/vendor/Reports.jsx`, `frontend/e2e/reports.spec.js`, `docs/FEATURE_MATRIX.md`, `docs/evidence/T6_explain_seed.txt`
  - changed: `db/schema/99_privileges.sql` (GRANT block for the reports), `db/schema/31_indexes.sql` (comment only), `backend/src/routes/finance.js` (trial balance = R1, mounts `/reports`), `backend/src/routes/vendor.js` (statement = R2, mounts `/reports`), `frontend/package.json` + `package-lock.json` (**recharts 3.10.1**), `frontend/src/App.jsx` (lazy report routes), `frontend/src/components/Layout.jsx` (Reports nav), `frontend/src/lib/money.js` (+ `chartRupees`, `formatBps`) + `money.test.js`, `frontend/src/pages/vendor/Statement.jsx` (uses R2 `reference`), `frontend/src/pages/finance/TrialBalance.jsx` (comment), `db/README.md`, `backend/README.md`, `frontend/README.md`
  - docs: `CLAUDE.md`, `docs/{DECISIONS (DEC-040), TASKS, REQUIREMENTS, TEST_EVIDENCE, HANDOFF}.md` (Project copies kept in sync)
- **Schema change** (new functions only, no table change): either rebuild (`db/reset_dev.sh --yes payrail` — DESTRUCTIVE for that DB — or a new Docker volume), or add them to an existing DB without losing data:
  `docker compose exec -T db psql -U postgres -X -v ON_ERROR_STOP=1 -d payrail -f /payrail/db/schema/32_reports.sql -f /payrail/db/schema/99_privileges.sql` (verified on a T5-state copy, T6-07).
- **New frontend dependency:** `cd frontend && npm ci`. Restart the backend.
- Suggested commit: branch `task6-reports`, `git add -A db backend frontend docs CLAUDE.md` (not `AGENTS.md` unless the team wants it), push, PR.

## Commands actually run (session 7, cloud sandbox, PG 16.15 TCP/scram, node 22.23.4)
| Command | Result |
|---|---|
| `git clone https://github.com/slashyash/PayRail` (= Mac `main` @ `d84123f`) | ok |
| baseline: SQL tests; `npm run test:api` | 273; 33/33 |
| `db/tests/run_sql_tests.sh 30_reports.sql 31_reports_seed.sql` (+ 3 mutations, reverted) | 24 + 7 passed; mutations caught (one only after adding the IST month-boundary test) |
| `npm run test:api` | 40/40 |
| `npm run test:e2e` | 11 passed |
| `psql -f db/reports/explain_reports.sql` on a fresh seeded `payrail` | `docs/evidence/T6_explain_seed.txt` |
| upgrade path on a T5-state copy (`32_reports.sql` + `99_privileges.sql`) | applied, R1 balanced as `payrail_app` |
| full regression: SQL; API; concurrency; backend audit; frontend unit; build | 304; 40/40; 12/12; 0 vulns; 4/4; built |

## To try it on the Mac (not run there yet)
```bash
cd ~/"payrail-dbms project"
docker compose up -d db
docker compose exec -T db psql -U postgres -X -v ON_ERROR_STOP=1 -d payrail \
  -f /payrail/db/schema/32_reports.sql -f /payrail/db/schema/99_privileges.sql   # once, if the volume predates T6
docker compose exec -T db bash /payrail/db/tests/run_sql_tests.sh             # expect 304 passed
docker compose exec -T db psql -U postgres -X -d payrail -f /payrail/db/reports/run_reports.sql
cd backend && npm ci && npm start                                             # terminal 1
cd frontend && npm ci && npm run dev                                          # terminal 2 → /finance/reports, /vendor/reports
PAYRAIL_REBUILD_VIA_DOCKER=1 npm run test:e2e                                 # 11 tests
```

## Demo path for T6 (~3 min)
1. **Finance → Reports → R1:** Σ D = Σ C, Dr/Cr balance columns (vendor 7 in the Dr column = negative balance); set as-of 2026-09-30 → still balanced, smaller totals.
2. **R2:** vendor 7, from 2026-10-01 → opening ₹20,496.48 continues into the first running balance; explain "filter after the window".
3. **R3:** chart + table; hover a bar (exact tooltip); point out the date basis of each column and the cumulative window.
4. **R4:** vendor 7 high (14.18 %), explain cohort numerator/denominator and the fan-out trap.
5. **R5:** five categories with age buckets; total net cash = what the bank received for matched rows only.
6. **R6:** decomposition identity and "Ledger ✓" cross-check between payouts and the ledger.
7. **Vendor7 → Reports:** own R6 and R4 only. psql: `db/reports/run_reports.sql`; EXPLAIN: the index experiment at the end of `docs/evidence/T6_explain_seed.txt`.

## What T6 demonstrates (viva notes)
See `db/reports/README.md` (per-report SQL walkthrough, EXPLAIN findings, viva questions) and `docs/FEATURE_MATRIX.md`.
- Window function with partition push-down and post-window filtering (R2); `GROUPING SETS` totals/subtotals (R1, R5); `generate_series` + month-grain CTEs (R3); `rank()` with a sample threshold (R4); cross-relation consistency check (R6).
- Grain discipline: aggregate each source before joining; the fixture shows the naive join's wrong number.
- Inlined SQL functions → real EXPLAIN plans; the balance index cuts the workflow balance query from 2,765 to 26 buffers on the seed.

## Known blockers / risks / T7 candidates
- T6 not yet run on a team Mac (see TEST_EVIDENCE "Not run yet").
- **Found in T6, not fixed (T7 candidates):**
  - Other pages (`vendor/Statement.jsx`, `finance/Reconciliation.jsx`, …) update URL filters from a closure copy of the search params; two very quick changes can overwrite each other (the Reports pages use a functional update — fixed there after an e2e failure). Low impact for humans; worth aligning.
  - `fn_vendor_balance` evaluates `fn_vendor_payable_account()` per row if the planner ever chooses a sequential scan (seen with the index dropped, T6-05). The index prevents it; wrapping the lookup as `(SELECT fn_vendor_payable_account(...))` would make it robust. Workflow function → needs the concurrency suite re-run.
- First Mac run earlier needed `.env` secrets and an `ALTER ROLE` password fix (see `backend/README.md` Troubleshooting); T7 should make startup failures obvious.
- PROPOSED decisions (DEC-002, DEC-005…DEC-022, DEC-035) are implemented as defaults; flag objections.
- Schedule: 13 days to the GL §7 submission date (15 Nov). T7 next, then T8 (PDF ≤ 5 pages, README contributions **confirmed by the team**).

## How the next session should start
1. Read `CLAUDE.md`, `docs/HANDOFF.md`, `docs/TASKS.md`, `docs/DECISIONS.md` from the Mac folder; `git status` / `git log` there.
2. Get the code into the sandbox: `git clone -b <branch> https://github.com/slashyash/PayRail` if pushed, plus any uncommitted Mac files; start a PG16 cluster (CLAUDE.md recipe), write a sandbox root `.env`, run SQL tests (304), `npm run test:api` (40), `test:concurrency` (12), `cd frontend && npm ci && npm run test:e2e` (11).
3. Implement T7, write changed files back, update docs.

## Next concrete action
T7: clean-install rehearsal from a fresh clone and fresh DB (Docker path and local path), a one-command startup check that names the `.env` / role-password problem, a safe demo reset + recovery script, fix the two T6 findings above, then a full regression and a timed demo dry run that DEMO.md (T8) can follow.
