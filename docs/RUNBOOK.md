# PayRail — Runbook (start, check, test, reset, recover)

Task 7. Every command here was run from a fresh clone on a fresh PostgreSQL 16 cluster (local path) — see
TEST_EVIDENCE T7-05…T7-08. The Docker path uses the same scripts inside the compose container; it is **not yet
run on a team Mac with these T7 scripts** (T7-09).

## 1. First start (Docker — recommended)
```bash
cp .env.example .env            # replace every CHANGE… value; JWT_SECRET / GATEWAY_WEBHOOK_SECRET: openssl rand -hex 32
                                # DATABASE_URL password = APP_DB_PASSWORD, DATABASE_URL port = PGPORT
docker compose up -d db         # first start on an EMPTY volume builds the schema and loads the seed
docker compose ps               # wait for "healthy"
(cd backend && npm ci && npm run doctor)     # read-only startup check: every line "ok"
(cd backend && npm start)                    # terminal 1 → http://127.0.0.1:4000 (prints "database check: ok")
(cd frontend && npm ci && npm run dev)       # terminal 2 → http://127.0.0.1:5173
```
Local PostgreSQL instead of Docker: export `PGHOST PGPORT PGUSER PGPASSWORD` for an administrator, then
`scripts/demo-reset.sh --yes --local` builds and seeds database `payrail` (it refuses without `--yes`).

Demo accounts (password `PayRail@2026`): `customer1…customer60@payrail.demo`, `vendor1…vendor12@payrail.demo`,
`finance@payrail.demo` (also `audit@payrail.demo`, finance). Demo as-of date for reconciliation: `PAYRAIL_DEMO_AS_OF=2026-10-31`.

## 2. Startup check — `cd backend && npm run doctor`
Read-only; exit code 1 on any failure. The server runs the database part once at startup and prints the same
hints (it keeps running, so you can fix the database and retry without restarting it).

| Check | Typical failure | Fix printed |
|---|---|---|
| `.env` values | `CHANGE…` placeholder, secret < 32 chars | `openssl rand -hex 32` |
| `DATABASE_URL` | logs in as `postgres`; password ≠ `APP_DB_PASSWORD`; port ≠ `PGPORT` | use `payrail_app`, same password/port |
| database reachable | `ECONNREFUSED` | `docker compose up -d db`, wait for healthy |
| `payrail_app` login | `28P01` (password drifted from the volume, or DB never built) | `ALTER ROLE payrail_app PASSWORD …` (non-destructive) or `scripts/demo-reset.sh --yes` |
| schema up to date | functions missing (volume older than the code) | T6 upgrade command, or demo reset |
| least privilege / ledger append-only | app role is owner/superuser or can write the ledger | fix `DATABASE_URL`; re-apply `99_privileges.sql` |
| demo data, trial balance | empty DB; Σ D ≠ Σ C | demo reset; investigate |

## 3. Tests — `scripts/test-all.sh [--no-e2e]`
Runs SQL → API → concurrency → frontend unit → build → browser e2e and prints one line per suite; full output of each suite is kept in `test-logs/` (git-ignored), and a FAIL line names the fix for the common causes. Uses only the
dedicated test databases (`payrail_test`, `payrail_apitest`, `payrail_conc`, `payrail_e2e`); the demo database
`payrail` is never touched (checked: journal entry count unchanged, T7-06). With a running compose `db` it switches
to `PAYRAIL_REBUILD_VIA_DOCKER=1` by itself. First e2e run: `cd frontend && npx playwright install chromium`.
Expected (T7-06): SQL 304 · API 46 · concurrency 12 · unit 5 · build ok · e2e 11.

## 4. Demo reset — `scripts/demo-reset.sh --yes`
DESTRUCTIVE for database `payrail` only (guards of `db/reset_dev.sh` still apply). Drops it, rebuilds the schema,
loads the deterministic seed, re-sets the `payrail_app` password from `.env`, prints row counts + trial balance and
runs the doctor. ~2 s locally. Two consecutive resets produce byte-identical ledger/payment fingerprints (T7-07),
so ids are stable: the first new order after a reset is always **#370**.
The running backend does not need a restart (its pool reconnects; one "idle PostgreSQL client error: terminating
connection" log line is expected). Browser: log in again.

## 5. Live concurrency demo — `node scripts/demo-race.mjs [vendorN] [requests]`
With the backend running: sends N simultaneous payout requests of 40 % of the vendor's balance, each with its own
Idempotency-Key. At most two are accepted, the rest fail with `insufficient_funds` (PRF01); the final balance is
exactly `B − accepted × amount`. Changes the demo DB — undo with a demo reset. The rigorous version is
`npm run test:concurrency` (independent connections, barrier-synchronised, with a mutation check).

## 6. Recovery during the demo
| Symptom | Do this |
|---|---|
| Login fails / 500 on every page | `cd backend && npm run doctor` → follow the printed fix |
| Data got messy (extra orders, payouts) | `scripts/demo-reset.sh --yes`, log in again |
| "database check found problems" at backend start | as printed; usually the password `ALTER ROLE` line |
| Page says "Could not reach the PayRail server" | start the backend (`cd backend && npm start`) |
| Docker volume itself is broken | `docker compose down -v` (**deletes the volume**) then `docker compose up -d db` |
| Tests fail with `password authentication failed for user "postgres"` (app works) | the Docker volume keeps its first admin password; `npm run doctor` prints `docker compose exec -T db psql -U postgres -d postgres -c "ALTER ROLE postgres PASSWORD '…'"` (non-destructive) |
| e2e: "Executable doesn't exist" | once: `cd frontend && npx playwright install chromium` |
| Port 5432 already in use | set `PGPORT=5433` in `.env` (and in `DATABASE_URL`), `docker compose up -d db` |
