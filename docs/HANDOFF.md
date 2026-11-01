# PayRail — Handoff

_Last updated: 2026-11-02, end of session 3 (Task 2)._

## Current milestone
**T2 DONE** (acceptance evidenced in TEST_EVIDENCE T2-01…T2-10). Next: **T3 — backend and authentication.**

## Working state
- Mac folder `/Users/parth/payrail-dbms project` is a git clone of `slashyash/PayRail`, on `main` @ `13289b6` (Task 1 merged via PR #1 from branch `task1-core-db`). Everything from session 3 (Task 2) is **uncommitted** there; the team should review, commit (e.g. on a `task2-workflows` branch) and open a PR.
- Session 3 wrote into the folder (Project copies of the docs kept in sync):
  - new: `db/schema/20_wf_common.sql 21_wf_orders_payments.sql 22_wf_refunds.sql 23_wf_payouts.sql 24_wf_settlements.sql`
  - new: `db/seed/seed.sql`
  - new: `db/tests/20_orders_payments.sql 21_refunds.sql 22_payouts.sql 23_settlements.sql 24_app_role.sql 29_seed.sql`, `db/tests/_lib/expect_error_rollback.sql`
  - new: `backend/package.json`, `backend/package-lock.json`, `backend/test/concurrency/harness.js`, `backend/test/concurrency/workflows.test.js`
  - changed: `db/schema/03_ledger.sql` (DEC-026 fix: deferred balance triggers SECURITY DEFINER), `db/schema/99_privileges.sql` (grants), `db/README.md`
  - docs: `CLAUDE.md`, `docs/DECISIONS.md` (DEC-026…032), `docs/TASKS.md`, `docs/REQUIREMENTS.md`, `docs/TEST_EVIDENCE.md`, `docs/HANDOFF.md`
- Parth's Docker database was rebuilt with the Task 2 schema + seed and passes 273/273 in the real container (TEST_EVIDENCE T2-11/12; identical row counts and trial balance to the sandbox). Other members: run `docker compose exec -T db bash /payrail/db/reset_dev.sh --yes payrail` once if their volume predates Task 2. Commands must be run from the project folder (`cd ~/"payrail-dbms project"`).

## Commands actually run (session 3, cloud sandbox)
| Command | Result |
|---|---|
| `db/tests/run_sql_tests.sh` before changes | 135 passed (baseline) |
| `db/tests/run_sql_tests.sh` (TCP/scram and socket/trust) | 273 passed, 0 failed, both modes (T2-02, T2-04) |
| `db/docker-init.sh` on a fresh socket/trust cluster | schema (14 files) + seed, exit 0 (T2-03) |
| `cd backend && npm run test:concurrency` ×4 (+1 with `PAYRAIL_CONC_SKIP_REBUILD=1` on a seeded DB) | 12/12 each time (T2-05/06) |
| mutation: payout lock removed, payout race rerun, file restored | test failed as expected: 8/8 payouts succeeded (T2-10) |
| `db/reset_dev.sh --yes payrail_dev` | 5,769 rows; trial balance ₹80,14,286.31 both sides (T2-07/08) |

## What T2 demonstrates (viva notes)
- **Stored functions as transactions:** each workflow is one SECURITY DEFINER function; any error rolls back every row and posting (tests show unchanged payment, no entry).
- **Locking protocol (DEC-012/028):** order row → payment row (capture); order line → refund row → vendor account (refund); payout row → vendor account (completion); vendor account first for a payout request, then the balance is read in a new statement (READ COMMITTED sees what the lock holder committed). Removing that lock makes 8/8 concurrent payouts succeed — the test catches it.
- **Idempotency (DEC-011):** lock the domain row, look up the key (replay → original row, different data → `PRI01`), then `INSERT … ON CONFLICT DO NOTHING` for cross-row races; a failed call rolls back its insert so the key stays usable.
- **Exact refunds (DEC-005):** cumulative `rhu(C·R/L)` — worked example in `db/tests/21_refunds.sql` header (naive rounding would lose 1 paisa).
- **Reconciliation (DEC-009/029):** one row per expected event / report row; only exact matches post; unknowns kept; `fn_reconcile` revisits (late callback in the seed).
- **Negative balance:** vendor 3 in the seed (−₹38,676.98 → +₹5,712.18), vendor 7 ends at −₹16,039.42 with a pending payout request.
- **Deferred-trigger privilege bug (DEC-026):** a good viva story — deferred triggers run at COMMIT as the committing user, outside the SECURITY DEFINER function.

## Known blockers / risks
- Concurrency tests not yet run on a team machine; they need Node 22 + `npm ci` in `backend/` and admin `PG*` variables; without a local `psql`, rebuild `payrail_conc` via `docker compose exec` and set `PAYRAIL_CONC_SKIP_REBUILD=1` (documented in `harness.js`).
- PROPOSED decisions (DEC-002, DEC-005…DEC-022) are still implemented as defaults; flag objections.
- Schedule: 13 days to the GL §7 submission date (15 Nov).

## How the next session should start
1. Read `CLAUDE.md`, `docs/HANDOFF.md`, `docs/TASKS.md`, `docs/DECISIONS.md` from the Mac folder; `git status` / `git log` there.
2. Stage `db/`, `backend/`, `docs/` into the sandbox, start a PG16 cluster (CLAUDE.md recipe), run `db/tests/run_sql_tests.sh` (expect 273) and `cd backend && npm ci && npm run test:concurrency` (expect 12/12).
3. Implement T3, write changed files back, update docs.

## Next concrete action
T3 in `backend/`: add Express, Zod, `jsonwebtoken`, `bcryptjs`, `supertest` to `package.json`; `src/db.js` (pool as `payrail_app`, `int8` kept as strings, `withClient`/`withTransaction` on one checked-out client), `src/errors.js` (SQLSTATE → HTTP: `PRA01`→403, `PRN01`→404, `PRV0x`/`23514`→422, `PRI01`/`PRS0x`/`PRR0x`/`PRF01`/`PRO0x`/`PRP01`/`23505`/`23503`→409, `42501`→500), `src/auth` (login with bcrypt against `users.password_hash`, JWT with user id + role), role/ownership middleware, routes for W1–W4 calling the 11 workflow functions with the actor id **from the JWT**, product CRUD (archive, delete → 409 on `23503`), mock gateway callback with HMAC (`GATEWAY_WEBHOOK_SECRET`) and controllable success/failure/duplicate/amount mismatch; API integration tests against a seeded test DB.
