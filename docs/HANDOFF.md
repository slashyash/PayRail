# PayRail — Handoff

_Last updated: 2026-11-02, end of session 4 (Task 3)._

## Current milestone
**T3 DONE** (acceptance evidenced in TEST_EVIDENCE T3-01…T3-06). Next: **T4 — customer UI** (T5 vendor/finance UI can run in parallel).

## Working state
- Mac folder `/Users/parth/payrail-dbms project`: git clone of `slashyash/PayRail`, branch **`task2-workflows` @ `646dd0b`** (Task 2 committed and pushed; `main` is still @ `13289b6` — open/merge the Task 2 PR). Everything from session 4 is **uncommitted** on top of it; suggested: `git switch -c task3-backend`, review, commit, push, PR.
- Session 4 wrote into the folder (Project copies of the docs kept in sync):
  - new: `backend/src/{app,server,config,db,errors,validate,auth,gateway,settlementCsv}.js`, `backend/src/routes/{catalogue,customer,vendor,finance,gateway}.js`
  - new: `backend/test/api/{_setup,auth,customer,gateway,vendor,finance}.test.js` (`_setup.js` is the helper), `backend/test/_env.js` (shared test env: root `.env`, Docker rebuild), `backend/README.md`
  - changed: `backend/test/concurrency/harness.js` (uses `test/_env.js`)
  - changed: `backend/package.json` (scripts `start`, `dev`, `test`, `test:api`; deps express 5.3.0, zod 4.6.7, jsonwebtoken 9.0.3, bcryptjs 2.4.3; dev supertest 7.3.1), `backend/package-lock.json`, `.env.example` (backend section)
  - docs: `CLAUDE.md`, `docs/DECISIONS.md` (DEC-033…036), `docs/TASKS.md`, `docs/REQUIREMENTS.md`, `docs/TEST_EVIDENCE.md`, `docs/HANDOFF.md`
- No schema/seed change in T3 (the API uses the Task 2 functions and views as they are), so existing Docker volumes need no rebuild.
- Parth's root `.env` already has non-placeholder `DATABASE_URL` (payrail_app, password = `APP_DB_PASSWORD`), `JWT_SECRET` and `GATEWAY_WEBHOOK_SECRET` (64 chars each) — checked without printing values. Other members must fill these in their own `.env`.

## Commands actually run (session 4, cloud sandbox, PG 16.15 TCP/scram, node 22.23.4)
| Command | Result |
|---|---|
| `db/tests/run_sql_tests.sh`; `npm ci && npm run test:concurrency` (before changes) | 273 passed; 12/12 |
| `npm run test:api` (twice) | 32/32 both times (T3-01) |
| `API_TEST_LOG=1 npm run test:api` | no 500s logged (T3-02) |
| two mutations (ownership filter removed; signature check disabled), each reverted | caught by 1 failing test each; 14/14 after restore (T3-04) |
| `node src/server.js` + curl walkthrough on a fresh `payrail_dev` | W1 → W3 → ledger → reconcile as expected, hand-checked amounts (T3-05) |
| `db/tests/run_sql_tests.sh`; `npm run test:concurrency` (after) | 273 passed; 12/12 (T3-03) |
| `npm audit` | 0 vulnerabilities (T3-06) |

## To try it on the Mac (not run there yet)
```bash
cd ~/"payrail-dbms project"
docker compose up -d db                     # existing volume is fine
cd backend && npm ci && npm start           # → http://127.0.0.1:4000/api/health  (db_user payrail_app)
curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
     -d '{"email":"customer1@payrail.demo","password":"PayRail@2026"}'
# tests (rebuild payrail_apitest inside the container, admin login from .env):
PAYRAIL_REBUILD_VIA_DOCKER=1 npm run test:api
PAYRAIL_REBUILD_VIA_DOCKER=1 npm run test:concurrency
```
(zsh: do not paste `# comments` on command lines unless `setopt interactivecomments`.)

## What T3 demonstrates (viva notes)
- **Three-tier integration:** route → Zod → one parameterized call to a SECURITY DEFINER function as `payrail_app` → SQLSTATE → HTTP. The API holds no business rules the database does not also enforce; e.g. a cross-customer payment is refused by `PRA01` inside `fn_initiate_payment`.
- **Never trust the client:** strict schemas reject price/commission/owner/balance fields; actor id from the JWT; amounts derived in SQL (`fn_order_total`).
- **Idempotency end to end:** `Idempotency-Key` header → `UNIQUE` + `ON CONFLICT`; simultaneous duplicate HTTP requests return one row (tests use `Promise.all` over separate pool connections).
- **Authenticated callbacks:** HMAC over raw body + timestamp window; replays harmless because the DB keys callbacks by (payment, outcome, ref, amount); success vs failure race ends in one final state.
- **Savepoints:** settlement import = one transaction, SAVEPOINT per row → a rejected row is rolled back alone.
- **Lossless money:** 2^53+1 paise reaches PostgreSQL exactly (string path); JSON numbers refused.
- **Window function with filters:** vendor statement filters dates after the running-balance window, plus an opening balance.

## Known blockers / risks
- On Parth's Mac (T3-07/08): server + Docker DB work, API tests 32/32. Concurrency tests failed there because the harness ignored the root `.env`; fixed with `backend/test/_env.js` (T3-10); Mac rerun 12/12 (T3-11). The Mac ran Node v26 (project pins 22).
- PROPOSED decisions (DEC-002, DEC-005…DEC-022, DEC-035) are implemented as defaults; flag objections. DEC-035 lists disclosed auth limitations (no sign-up, no revocation/rate limit, no KYC endpoint).
- Named SQL reports (T6) not yet exposed; current finance read endpoints are trial balance, vendors, journal entries, reconciliation, order detail.
- Schedule: 13 days to the GL §7 submission date (15 Nov); T4 + T5 are the critical path.

## How the next session should start
1. Read `CLAUDE.md`, `docs/HANDOFF.md`, `docs/TASKS.md`, `docs/DECISIONS.md` from the Mac folder; `git status` / `git log` there.
2. Stage the repo (tar excluding `.git`, `node_modules`, `.env`) into the sandbox, start a PG16 cluster (CLAUDE.md recipe), run `db/tests/run_sql_tests.sh` (273), `cd backend && npm ci && npm run test:concurrency` (12/12) and `npm run test:api` (32/32).
3. Implement T4, write changed files back, update docs.

## Next concrete action
T4 in `frontend/`: Vite + React + Tailwind scaffold with a lockfile; Vite dev proxy `/api → http://127.0.0.1:4000` (no CORS needed); `src/api.js` (fetch wrapper: bearer token, `{error}` handling, never `Number()` on paise — format with `BigInt`), login page, catalogue (search/filter/paging from `GET /api/products`), cart (aggregate per product, cap 100), checkout → `POST /api/orders` → `POST /api/orders/:id/payments` with one `Idempotency-Key` per attempt kept across retries → mock-gateway page (`POST /api/mock-gateway/payments/:id/simulate`: success / failure / duplicate / wrong amount), order history/detail, per-line refund request. Then a browser smoke run against the seeded DB.
