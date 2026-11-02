# PayRail — guide for Claude sessions

DBMS course project (Group 13, BITS Pilani Hyderabad): a simulated payments & settlement engine for a multi-vendor marketplace, built on a **double-entry, append-only ledger** in PostgreSQL. Database correctness > integration > reproducibility > visual polish.

## Read first, every session
1. `docs/HANDOFF.md` — current milestone, state, next action
2. `docs/TASKS.md` — milestones, acceptance criteria, states
3. `docs/DECISIONS.md` — deviations from the midsem PDFs (DEC-xxx)
4. `docs/REQUIREMENTS.md` — traceability; `docs/TEST_EVIDENCE.md` — observed results only; `docs/AUDIT.md` — Task 0 audit
Then `git status`. Update HANDOFF, TASKS, TEST_EVIDENCE (and others if affected) before ending a session.

## Architecture
React (Vite, Tailwind, Recharts) ↔ Express (Node 22, `pg`, Zod, JWT) ↔ PostgreSQL 16 (schema `payrail`).
Financial workflows are **stored functions** (atomic, one call = one transaction step); the backend calls them with parameterized SQL on a single checked-out client. No ORM. Mock gateway and bank are simulated (no real money/credentials). INR only.

12 relations: users, vendors, products, orders, order_items, payments, refunds, payouts, gateway_settlements, accounts, journal_entries, ledger_lines.

## Layout
`db/schema/NN_*.sql` (00 roles · 01 schema/clock · 02 tables · 03 ledger · 04 helpers · 05 guards · 06 system accounts · 20 workflow helpers · 21 orders/payments · 22 refunds · 23 payouts · 24 settlements · 30 views · 31 indexes · 99 privileges — DEC-031) · `db/tests/` · `db/seed/seed.sql` · `db/reports/` [T6] · `db/build.sh` · `db/reset_dev.sh` · `db/docker-init.sh` · `backend/` (Express API `src/`, `test/api/`, `test/concurrency/`; see `backend/README.md`) · `frontend/` [T4] · `samples/settlements/` [T5] · `docs/`. Details: `db/README.md` (also lists the PayRail SQLSTATE codes).

## Commands
Admin connection via libpq env (`PGHOST PGPORT PGUSER PGPASSWORD`); `APP_DB_PASSWORD` sets the `payrail_app` password.
- Build (non-destructive, creates DB if missing): `db/build.sh payrail`
- Reset (DESTRUCTIVE, guarded): `db/reset_dev.sh --yes payrail`
- SQL tests (rebuild `payrail_test` per file): `db/tests/run_sql_tests.sh [file…]` — `VERBOSE=1` lists every check
- Docker: `cp .env.example .env && docker compose up -d db`; tests `docker compose exec -T db bash /payrail/db/tests/run_sql_tests.sh`
- Seed: loaded by `reset_dev.sh` and the Docker init hook (`PAYRAIL_SKIP_SEED=1` skips); demo password `PayRail@2026`; demo as-of date `2026-10-31`
- Concurrency tests (independent `payrail_app` connections): `cd backend && npm ci && npm run test:concurrency` (rebuilds `payrail_conc`; `PAYRAIL_REBUILD_VIA_DOCKER=1` on Docker-only machines; tests read the root `.env` via `backend/test/_env.js`)
- Backend: root `.env` (from `.env.example`; `DATABASE_URL` as `payrail_app`, `JWT_SECRET`, `GATEWAY_WEBHOOK_SECRET` ≥ 32 chars) → `cd backend && npm ci && npm start` (port 4000). Endpoint table + SQLSTATE→HTTP map: `backend/README.md`
- API tests (supertest, app as `payrail_app`, rebuild + seed `payrail_apitest` per file): `cd backend && npm run test:api` (`PAYRAIL_REBUILD_VIA_DOCKER=1` rebuilds inside the compose container; `API_TEST_LOG=1` prints any 500s)
- Frontend: not yet (T4)
- Sandbox recipe used by Claude (no Docker Hub access): `initdb` a PG16 cluster as OS user `postgres` (`--auth-host=scram-sha-256`), start on port 5433, export `PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGPASSWORD=…`.

## Invariants (never break)
- Money = `BIGINT` paise; round-half-up via `fn_round_half_up`; no floats; API sends paise and BIGINT ids as decimal strings (DEC-003).
- Every committed journal entry: ≥2 lines, Σdebit = Σcredit (deferred triggers on header **and** lines). Ledger is append-only; lines may only be added in the transaction that created the header (`created_xid` seal) (DEC-006).
- App runs as `payrail_app` (never owner/superuser); ledger writes only through SECURITY DEFINER workflow functions with pinned `search_path`; `fn_post_entry` is internal and never granted to the app (DEC-013, DEC-022). Every new function must be granted explicitly in `99_privileges.sql`.
- Balances and order status are derived (views), never stored.
- At most one captured payment per order; amount = derived order total; terminal states never change (DEC-010).
- Idempotency: UNIQUE key + `ON CONFLICT`; same payload → original result; different payload → conflict (DEC-011).
- Lock order: domain rows by PK → vendor payable accounts by `account_id` ascending → read balances → insert (DEC-012).
- Refund allocation is cumulative from original snapshots (DEC-005); posting matrix in DEC-007.
- Reconciliation never posts mismatched/unknown rows; dates in `Asia/Kolkata`; T+2 calendar days; explicit `as_of` (DEC-009).
- Seed and demo use the controlled clock `fn_now()` (DEC-015) so results are reproducible; the seed uses md5-keyed choices, never `random()` (DEC-030).
- Funds-changing workflows require READ COMMITTED (`PRX01`, DEC-028). Workflow functions take the actor id explicitly and re-check role/ownership (`PRA01`, DEC-027); internal helpers (`fn_post_entry`, `fn_reverse_entry`, `fn_try_post_settlement`, lock/role helpers) are never granted.
- Deferred constraint triggers fire at COMMIT as the committing login — anything they call must not depend on the caller's privileges (DEC-026).
- API (DEC-033/034/035): actor id **only** from the verified JWT (`req.user`); strict Zod schemas (no client prices, rates, owner ids, balances); ids/paise as decimal strings; money-creating POSTs need `Idempotency-Key`; reads scoped in SQL (others' rows → 404); one workflow call = one autocommit statement; multi-statement work uses `db.withTransaction` on one client. Gateway callback must stay HMAC-verified over the raw body.

## Conventions
- SQL: snake_case; functions `fn_*`, views `v_*`, triggers `trg_*`; each file idempotent only where noted — `build.sh` targets an empty DB.
- Never claim a test/count/screenshot without observing it; record in TEST_EVIDENCE.
- Material deviations from the PDFs → new DEC entry (original, reason, decision, impact, docs).
- Ask before destructive actions on existing data or major scope changes. Do not push, deploy or submit.
- Keep code small and explainable for a student viva.

## Where the work lives
- **Primary working copy (source of truth): Parth's Mac folder `/Users/parth/payrail-dbms project`** — a git clone of `slashyash/PayRail` (`main`). Claude has a shell there (`device_bash`, folder mounted at `$HOME/mnt/payrail-dbms project`) but it has **no PostgreSQL/Docker**; build and test in the cloud sandbox, then write changed files back.
- Deleting files in that folder needs the user's permission, so `git commit`/`pull` from Claude's shell leave `.lock` files — Claude does **not** commit; the team commits and pushes. If Claude's `git fetch` leaves a lock, move it aside under `.git/` (never under `.git/refs`).
- Cloud sandbox is ephemeral: never leave the only copy of work there.
- GitHub: `https://github.com/slashyash/PayRail` — the team pushes; Claude does not.
- claude.ai Project "DBMS PROJECT": backup copies of the context docs under `payrail-repo/`.
