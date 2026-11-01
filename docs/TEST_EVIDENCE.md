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

## Task 2 — stored workflows, seed, concurrency (cloud sandbox, 2026-11-02)

Environment: same PostgreSQL 16.15 / node v22.23.4 sandbox. Two clusters: TCP + scram-sha-256 on port 5433 (`PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGPASSWORD=…`) and a Docker-like socket + trust cluster with the repo reachable at `/payrail/db`. Baseline before any change: `db/tests/run_sql_tests.sh` → 135 passed (same as T1-07).

| ID | What | Command | Observed | Result |
|---|---|---|---|---|
| T2-01 | Build with workflow files | `db/reset_dev.sh --yes payrail_dev` | `schema built in database payrail_dev (14 files)`, then `seeding payrail_dev`, `done` (≈1.8 s) | PASS |
| T2-02 | Full SQL suite, TCP/scram | `db/tests/run_sql_tests.sh` | `01_constraints 54 · 02_money 15 · 10_ledger 24 · 11_ledger_immutability 32 · 12_capture_example 10 · 20_orders_payments 39 · 21_refunds 25 · 22_payouts 28 · 23_settlements 22 · 24_app_role 14 · 29_seed 10` → `TOTAL: 273 passed, 0 failed, 0 file(s) aborted` (20.9 s) | PASS |
| T2-03 | Docker-like init hook incl. seed | `env -i PATH=… POSTGRES_USER=postgres POSTGRES_DB=payrail bash /payrail/db/docker-init.sh` on a fresh socket/trust cluster | `schema built in database payrail (14 files)`, seed summary printed, exit 0 | PASS (simulated, not the real image) |
| T2-04 | Full SQL suite, socket/trust | `env -i PATH=… PGUSER=postgres PGDATABASE=payrail bash /payrail/db/tests/run_sql_tests.sh` | `TOTAL: 273 passed, 0 failed, 0 file(s) aborted` | PASS |
| T2-05 | Concurrency tests (independent `payrail_app` connections) | `cd backend && npm ci && npm run test:concurrency` | `# tests 12 · # pass 12 · # fail 0` (≈12 s); outcomes per race below | PASS |
| T2-06 | Concurrency repeatability | the same command 3 more times | `pass 12 fail 0` each time (4/4 runs) | PASS |
| T2-07 | Seed row counts (payrail_dev, after T2-01) | summary printed by `seed.sql` | users 74 · vendors 12 · products 73 · orders 369 · order_items 785 · payments 378 · refunds 44 · payouts 92 · gateway_settlements 357 · accounts 17 · journal_entries 826 · ledger_lines 2,742 → **5,769 rows** | INFO |
| T2-08 | Seed trial balance | `SELECT sum(debit_paise), sum(credit_paise) FROM v_account_balances` | **₹80,14,286.31 = ₹80,14,286.31** (801428631 paise each side) | PASS |
| T2-09 | Seed reproducibility | test 29 (second independent build) and the same fingerprint query on both sandbox clusters | fingerprint `6d5bccc886176f40a03e50adca2b3951` on payrail_test, payrail_test_seed2, payrail_dev (TCP cluster) and payrail (socket cluster) | PASS |
| T2-10 | Mutation check: is the payout race test discriminating? | temporarily removed `PERFORM fn_lock_vendor_accounts(...)` from `fn_request_payout`, ran `node --test --test-name-pattern="30% each" …`, then restored the file | without the lock: `outcomes {"ok":8}`, `max workers blocked on a lock: 0` → test **failed** (`expected 3, actual 8`: overspending). With the lock (T2-05): `{"ok":3,"PRF01":5}`, 7 workers blocked | PASS (the test detects the bug) |
| T2-11 | Rebuild + seed inside the real Docker image on Parth's MacBook Air (Docker Desktop, `postgres:16`), 2026-11-02 | `cd ~/"payrail-dbms project"` · `docker compose up -d db` (status `healthy`) · `docker compose exec -T db bash /payrail/db/reset_dev.sh --yes payrail` | `schema built in database payrail (14 files)`, seeding; row counts identical to T2-07 (users 74 … ledger_lines 2742); trial balance **₹80,14,286.31 = ₹80,14,286.31**; `reset_dev.sh: done` | PASS (observed from the user's terminal screenshot) |
| T2-12 | Full SQL suite inside the real container | `docker compose exec -T db bash /payrail/db/tests/run_sql_tests.sh` | `01 54 · 02 15 · 10 24 · 11 32 · 12 10 · 20 39 · 21 25 · 22 28 · 23 22 · 24 14 · 29 10` → `TOTAL: 273 passed, 0 failed, 0 file(s) aborted` | PASS (observed from the user's terminal screenshot) |

### T2-05 race outcomes (8 workers unless noted; "blocked" = max workers seen waiting on a row/transaction lock)
| Race | Outcome | Blocked |
|---|---|---|
| 8 payouts of 30% of the balance (different keys) | 3 ok, 5 `PRF01`; balance = start − 3 × amount ≥ 0 | 7 |
| 8 payouts, same key, same amount | 8 ok, one payout id, one posting | 7 |
| 8 payouts, same key, different amounts | 1 ok, 7 `PRI01` | 7 |
| 8 refund requests of ₹400 on a ₹1,499.97 line | 3 ok, 5 `PRR01`; refundable = 29,997 paise | 7 |
| 8 approvals of the same refund | 8 ok, status processed, one refund entry, vendor −35,280 paise once | 7 |
| 2 approvals of different refunds of one line | 2 ok; cumulative commission 12,000 / GST 2,160 (exact) | 1 |
| 8 "failed" completions of one payout | 8 ok, exactly one reversal, funds restored once | 7 |
| paid vs failed on one payout (2 workers) | 1 ok, 1 `PRS01`; reversal count matches final status | 1 |
| 8 captures across two attempts of one order | 4 ok (winner + 3 replays), 4 `PRS02`; one captured payment, one capture entry | 7 |
| 8 initiations with one key | 8 ok, one payment row | 7 |
| 1 late refund approval + 4 payouts of 45% (5 workers) | refund ok; 3 ok / 2 `PRF01` overall; no deadlock; replaying vendor B's account in `entry_id` order shows every payout ≤ balance at that point | 4 |
| 8 imports of the same settlement row | 1 `inserted`, 7 `duplicate`; one posting | 7 |
After all races: trial balance debits = credits (2,285,841 paise in the last run).

### What the 138 new SQL checks cover (acceptance mapping)
- **SQL-level workflows succeed** (20–23, and 24 as the real `payrail_app` login): order → payment → capture (5 hand-computed lines) → refund → payout → settlement → reconcile.
- **Invalid operations fail cleanly with codes:** empty cart, quantity 0 / 1.5 / aggregate > 100 (`PRV07`), unknown product (`PRN01`), unverified vendor (`PRV03`), inactive product (`PRV04`), wrong actor (`PRA01`), refund on unpaid order (`PRO02`), over-refund (`PRR01`), sub-₹1 partial (`PRR02`), overspending payout (`PRF01`), wrong state (`PRS01`/`PRS02`), future settlement date (`PRV07`), malformed refs/fees (`23514`); each followed by checks that no rows or postings were left behind.
- **Duplicate retries harmless / conflicting keys fail:** payment initiation, capture callback, failure callback, refund request, approval, rejection, payout request, payout completion, settlement import (`duplicate`); conflicts → `PRI01` / `conflict`.
- **No key poisoning:** a refund key and a payout key whose first use failed are reused successfully.
- **Capture amount mismatch:** `PRP01`, payment stays `initiated`, zero journal entries.
- **Rollback:** capture failing on a duplicate gateway ref inside the function, and a successful capture followed by an error in the same transaction → payment unchanged, no entry, balances unchanged. `REPEATABLE READ` → `PRX01`.
- **Exact partial-refund rounding** (21): 10001 + 25000 + 33333 + 81663 paise on L = 149997 (C 15000, G 2700) → deltas C 1000/2500/3334/8166, G 180/450/600/1470, V 8821/22050/29399/72027; sums equal the capture allocation exactly; naive per-refund rounding gives 14999 (checked in the test). Seeded data (29): every fully refunded line reverses its exact C/G/V, incl. a three-step line.
- **Negative vendor balance** (22): payout of everything, late refund → −44,100; payout of 1 paisa refused; new sales → −1 → 88,197; 88,198 refused; 88,197 allowed. Seed: vendor 3 dips to −₹38,676.98 and recovers to ₹5,712.18; vendor 7 ends at −₹16,039.42.
- **Failed payout reversal exactly once:** mirror lines D BANK / C vendor, replay does not reverse again, `paid` after `failed` → `PRS01`, a second reversal even by the owner → `23505`.
- **Accounts:** new vendor gets exactly one payable account, second payable for the same vendor → `23505`, missing account lookup → `PRL04`.
- **Reconciliation** (23): each of matched / amount_mismatch (amount and record type) / unknown_reference / in_transit / overdue_missing; T+2 boundary (in transit on the expected day, overdue the day after); rows after `as_of` ignored; duplicate vs conflict import; unknown reference posted by `fn_reconcile` once the late payment exists; second reconcile posts nothing; clearing identity holds; only matched rows posted.
- **Privileges** (24): workflows callable by `payrail_app`; internal helpers (`fn_reverse_entry`, `fn_try_post_settlement`, `fn_lock_vendor_accounts`, `fn_require_role`) → `42501`; app cannot backdate (clock ignored); all 11 workflow functions SECURITY DEFINER with pinned `search_path`.

### Seeded database at the demo date (payrail_dev after T2-01)
| Item | Observed |
|---|---|
| payments | captured 345 · failed 30 · initiated 3 |
| orders (derived status) | paid 317 · partially_refunded 21 · refunded 7 · pending_payment 24 |
| refunds | processed 30 (₹1,27,544.00) · rejected 10 · requested 4 |
| payouts | paid 69 · failed 12 (12 reversal entries) · requested 11 |
| journal entries | capture 345 · settlement 347 · payout 92 · refund 30 · reversal 12 |
| reconciliation @ 2026-10-31 | matched 347 (all posted) · amount_mismatch 8 · overdue_missing 7 · in_transit 13 · unknown_reference 2 (none posted) |
| system balances | GATEWAY_CLEARING ₹1,84,915.98 · BANK ₹1,27,432.07 · COMMISSION_REVENUE ₹2,31,742.71 · GATEWAY_FEE_EXPENSE ₹18,818.63 · GST_PAYABLE ₹41,713.69 |

## Not run yet
| Check | Reason |
|---|---|
| `npm run test:concurrency` on a team Mac | needs Node 22 + `npm ci` in `backend/` and admin `PG*` variables pointing at the compose database |
| API, UI, browser tests | Task 3+ |
