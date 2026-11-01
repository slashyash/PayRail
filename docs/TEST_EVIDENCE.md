# PayRail — Test Evidence

Only observed results are recorded. Result: **PASS**, **FAIL**, **NOT RUN**, or **INFO** (environment observation).
Each entry: date, environment, exact command (or script path), observed output.

## Task 0 — environment and design probes (cloud sandbox, 2026-11-01/02)

These probes ran on a **throwaway** cluster (`initdb` in `/var/tmp/pgprobe`, port 55432, deleted afterwards). They validate PostgreSQL behaviour that the design relies on; they are **not** tests of PayRail code (none exists yet).

| ID | What | Command / script | Observed | Result |
|---|---|---|---|---|
| E-001 | Toolchain | `psql --version; node -v; npm -v; docker info` | psql 16.15; server `PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)`; node v22.23.4; npm 10.9.9; docker: `failed to connect to the docker API at unix:///var/run/docker.sock` (dockerd binary present, daemon not running) | INFO |
| E-002 | `pg_current_xact_id()` inside a PL/pgSQL exception block returns the top-level xid; differs in a later txn (basis of DEC-006 seal) | header row with `xid8 DEFAULT pg_current_xact_id()`, compared inside `BEGIN … EXCEPTION` block and in a later transaction | `probe1 header_xid=732 subtxn_current=732 equal=t`; `row2 xid equals row1 xid: true`; `later txn differs: true` | PASS |
| E-003 | Deferred constraint trigger on the **header** rejects an empty entry at real COMMIT | `BEGIN; INSERT INTO h(id) VALUES (10); COMMIT;` with `CONSTRAINT TRIGGER … AFTER INSERT ON h DEFERRABLE INITIALLY DEFERRED` | `ERROR: entry 10 has <2 lines`; afterwards `exists(...) = false` | PASS |
| E-003b | `UNIQUE NULLS NOT DISTINCT` rejects a second `(platform, NULL, revenue)` account | insert twice | `duplicate NULL slot rejected` (unique_violation) | PASS |
| E-004 | Integer round-half-up formula `(2ab + d) / (2d)` | `select (5*1*2+2)/(2*2), (7*2+2)/4` | `3`, `4` (2.5→3, 3.5→4) | PASS |
| E-005 | Cumulative refund allocation (DEC-005), Python model of the planned SQL | `scratchpad/alloc_probe.py` (seed 7, 200,000 random lines, L ≤ 5,000,000 paise, bps 0–5000, random partial-refund sequences) | `cumulative exact=all`; negative vendor delta in 18,730 refunds when 1–7 paise refunds allowed (0 on the final refund); naive per-refund rounding drifted in 192,509 trials. With ₹1 minimum (except final remainder): **0** negative deltas, cumulative exact = all; naive drift 195,017 trials | PASS (model only; must be re-tested in SQL in T2) |

The probe script is not in the repo (scratch). Its logic will be re-implemented as SQL fixture tests in T2 (`db/tests/`).

## Task 1 — foundation and core database (cloud sandbox, 2026-11-02)

Environment: PostgreSQL 16.15 (Ubuntu build) clusters created with `initdb` in the sandbox; node v22.23.4. Two connection modes were exercised:
- **TCP + scram-sha-256** (`PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGPASSWORD=…`): the runner writes a temporary pgpass so the `payrail_app` connection in test 11 authenticates with its own password.
- **Docker-like local socket + trust** (`env -i PGUSER=postgres PGDATABASE=payrail`, socket `/var/run/postgresql`, port 5432, `db/` reachable at `/payrail/db`): mimics `docker compose exec db …` and the image's init hook.

| ID | What | Command | Observed | Result |
|---|---|---|---|---|
| T1-01 | Build into a new DB | `db/build.sh payrail_dev` | `creating database payrail_dev` · `schema built in database payrail_dev (9 files)` | PASS |
| T1-02 | Build is non-destructive | `db/build.sh payrail_dev` (again) | `already has the payrail schema; nothing done.` exit 1 | PASS |
| T1-03 | Reset guards | `db/reset_dev.sh payrail_dev` / `--yes payrail_prod` / `--yes postgres`; `db/build.sh bad-name` | each refused, exit 2, nothing dropped | PASS |
| T1-04 | Reset rebuilds | `db/reset_dev.sh --yes payrail_dev` | dropped, rebuilt, `done` | PASS |
| T1-05 | Catalog counts (schema `payrail`, after T1-04) | `pg_constraint` by `contype`; `pg_trigger` (non-internal); `pg_indexes`; `pg_proc`; `pg_views` | tables 12; CHECK 48, FK 16, PK 12, UNIQUE 19, constraint triggers 2; user triggers 24; indexes 42; functions 25; views 4; accounts rows 5 (system); DB `TimeZone` = `Asia/Kolkata` | INFO |
| T1-06 | Docker-like init hook | `env -i … POSTGRES_USER=postgres POSTGRES_DB=payrail bash db/docker-init.sh` on a fresh cluster | `schema built in database payrail (9 files)`, exit 0 | PASS (simulated, not the real image) |
| T1-07 | Full SQL suite, TCP/scram | `db/tests/run_sql_tests.sh` | `01_constraints 54 · 02_money 15 · 10_ledger 24 · 11_ledger_immutability 32 · 12_capture_example 10` → `TOTAL: 135 passed, 0 failed, 0 file(s) aborted`, exit 0, 9.0 s | PASS |
| T1-08 | Full SQL suite, socket/trust | `env -i PATH=… PGUSER=postgres PGDATABASE=payrail bash /payrail/db/tests/run_sql_tests.sh` | same five files, `TOTAL: 135 passed, 0 failed, 0 file(s) aborted` | PASS |
| T1-09 | `docker compose config` with `.env` copied from `.env.example` | `docker compose config` | parsed OK (compose v5.6.1) | PASS (syntax only) |
| T1-10 | `docker compose up` (sandbox attempt) | `docker pull postgres:16` | `Head "https://registry-1.docker.io/v2/library/postgres/manifests/16": Forbidden` (sandbox egress policy blocks Docker Hub) | NOT RUN in sandbox → superseded by T1-11 |
| T1-11 | Real Docker Compose on Parth's MacBook Air (Docker Desktop), 2026-11-02, `.env` from `.env.example` with generated passwords | `docker compose up -d db` → `docker compose ps` | image `postgres:16` Pulled; volume, network, container `payrail-dbmsproject-db-1` created/started; status `Up 35 seconds (healthy)`, port `0.0.0.0:5432->5432/tcp`. The healthcheck requires schema `payrail`, so the init hook (`db/docker-init.sh` → `build.sh`) ran successfully | PASS (observed from the user's terminal screenshot) |
| T1-12 | SQL suite inside the real container | `docker compose exec -T db bash /payrail/db/tests/run_sql_tests.sh` | `01_constraints 54 · 02_money 15 · 10_ledger 24 · 11_ledger_immutability 32 · 12_capture_example 10` → `TOTAL: 135 passed, 0 failed, 0 file(s) aborted` | PASS (observed from the user's terminal screenshot) |

### What the 135 checks cover (acceptance mapping)
- **Deferred validation at real COMMIT** (10_ledger): empty header → `PRL01`, single-line → `PRL01`, unbalanced → `PRL01`, two entries balancing only together → `PRL01`; afterwards no partial rows remain. Lines inserted one by one (temporarily unbalanced) commit fine.
- **Late insertion into a posted entry** (10, 11): balanced pair and single line → `PRL03`, also as owner; a caller-supplied `created_xid` is overwritten, so the seal cannot be spoofed.
- **Prohibited mutation as the application role** (11, real `payrail_app` login, not `SET ROLE`): INSERT/UPDATE/DELETE/TRUNCATE on both ledger tables, `fn_post_entry`, `ALTER TABLE … DISABLE TRIGGER`, `session_replication_role`, `CREATE` in the schema, direct writes to payments/orders/payouts/settlements/accounts/users → all `42501`. As owner, UPDATE/DELETE/TRUNCATE → `PRL02`. The controlled clock is ignored for `payrail_app`. Product CRUD works for the app; deleting a referenced product → `23503`.
- **Constraints** (01): 54 checks over all 12 relations — keys, CHECK domains, role/KYC/active/snapshot triggers, payment/refund/payout state machines, capture amount = derived total (`PRP01`), one capture per order, immutable history.
- **Money** (02): round-half-up table, overflow safety, hand fixtures for `fn_split_line`, a 5001 × 171-case sweep (C+G+V = L, V ≥ 0), the DEC-005 worked example, and a seeded 5000-line randomised test where the cumulative method was exact on every line. Informational output: `naive per-refund rounding would drift on 1961 of 5000 lines; negative vendor deltas (cumulative): 0`.
- **Hand-traceable example** (12): printed ledger after capture + ₹500 partial refund:
```
 entry | type    | code               | dc | amount
     1 | capture | GATEWAY_CLEARING   | D  | ₹2,734.53
     1 | capture | VENDOR_PAYABLE_1   | C  | ₹1,322.97
     1 | capture | VENDOR_PAYABLE_2   | C  | ₹1,198.15
     1 | capture | COMMISSION_REVENUE | C  | ₹180.86
     1 | capture | GST_PAYABLE        | C  | ₹32.55
     2 | refund  | VENDOR_PAYABLE_1   | D  | ₹441.00
     2 | refund  | COMMISSION_REVENUE | D  | ₹50.00
     2 | refund  | GST_PAYABLE        | D  | ₹9.00
     2 | refund  | GATEWAY_CLEARING   | C  | ₹500.00
balances: GATEWAY_CLEARING ₹2,234.53 · COMMISSION_REVENUE ₹130.86 · GST_PAYABLE ₹23.55 · VENDOR_PAYABLE_1 ₹881.97 · VENDOR_PAYABLE_2 ₹1,198.15; Σdebit = Σcredit = ₹3,234.53
```
  (The capture/refund steps are performed manually by the owner here; the real workflow functions come in Task 2.)

## Not run yet
| Check | Reason |
|---|---|
| Build on a team Mac with a local PostgreSQL | not attempted |
| Workflow, concurrency, idempotency, API, UI tests | Task 2+ |
