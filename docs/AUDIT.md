# PayRail — Task 0 Audit (2026-11-01/02)

## 1. What exists

| Item | Finding |
|---|---|
| Repository | `https://github.com/slashyash/PayRail`, branch `main` @ `65c50bb`, 5 commits, **one file: `README.md`** (89 lines). README states "Implementation has not started" and "There is no runnable application at this stage." |
| Code, SQL, seeds, tests, config | **None.** No `db/`, no `run_all.sh`, no `06_seed.sql`, no backend/frontend, no `docker-compose.yml`, no lockfile. |
| Design PDFs in repo | Not committed (README asks for them). Available only in the claude.ai Project. |
| DBD claims (§7 constraint counts, §10 "generated from the database catalog", §11 row counts and INR 4,51,62,018.42 trial balance, `./db/run_all.sh`) | **Unbacked.** Team confirmed no work exists; treated as void (DEC-001). |
| Local Mac folder `/Users/parth/payrail-dbms project` | Connected 2026-11-02, **empty**. No shell access to it from Claude (file write/read only). |

Safe checks attempted: clone (ok), `git status` (clean), toolchain probe, throwaway PostgreSQL cluster with behaviour probes (see TEST_EVIDENCE E-001…E-005). Nothing to build or run in the repo itself.

## 2. Environment

| Tool | Cloud sandbox | Needed |
|---|---|---|
| PostgreSQL | 16.15 server + psql (works; throwaway cluster started/stopped) | 16 |
| Node / npm | 22.23.4 / 10.9.9 | 22 |
| Docker | CLI + `dockerd` binaries present, **daemon not running** | Compose for team setup |
| Team Macs | unknown — compose/Node versions to be verified by the team | |

## 3. Requirements gap table

Status legend: **ABSENT** (nothing exists), **DESIGNED** (specified in PDFs, not built), **GAP** (PDF design incomplete/inconsistent → decision needed).

| # | Requirement (source) | Current state | Gap / action | Milestone |
|---|---|---|---|---|
| 1 | 8–12 meaningful relations (GL §4) | DESIGNED: 12 relations (DBD §6) | Build; keep 12 (no padding) | T1 |
| 2 | PK/FK/UNIQUE/NOT NULL/CHECK in DBMS (GL §3B) | DESIGNED | Build; recount actual constraints (DBD counts unverified) | T1 |
| 3 | ≥500 records (GL §4) | ABSENT | Seed via business functions, fixed clock (DEC-015) | T2 |
| 4 | ≥3 end-to-end workflows (GL §4) | DESIGNED: W1–W4 (APD §4) | Build all four UI→API→SQL→ledger | T2–T5 |
| 5 | ≥5 non-trivial SQL queries (GL §4) | DESIGNED (names only, APD W4) | 6 named reports with fixtures | T6 |
| 6 | ≥3 extra DBMS features (GL §4) | DESIGNED: triggers, functions, views, indexes, transactions | Build + feature matrix with demo paths | T1–T6 |
| 7 | Insert/modify/delete, search/filter (GL §3D) | DESIGNED partially | Product CRUD + archive + guarded delete (DEC-014); catalogue search | T3–T5 |
| 8 | Authentication (APD §2) | **GAP**: `users` has no credential | `password_hash` column (DEC-002) | T1/T3 |
| 9 | Ledger balance at COMMIT (DBD BR1, T2) | DESIGNED | Also reject empty header via header-side deferred trigger (DEC-006) | T1 |
| 10 | Append-only ledger (DBD BR2, T3) | **GAP**: late append of balanced lines to a committed entry not prevented | Transaction seal `created_xid` + privileges (DEC-006) | T1 |
| 11 | Refund cap (DBD BR5) | **GAP**: cap ignores pending requests; partial-refund rounding unspecified | Reservation + cumulative allocation (DEC-005) | T2 |
| 12 | Settlement vs refunds (DBD §3 vs §6) | **GAP**: refunds can't appear in payment-keyed settlement table | `refunds.gateway_ref`, `record_type` (DEC-009) | T1/T2 |
| 13 | Reconciliation categories (APD W4) | **GAP**: in-transit/overdue/mismatch undefined; no time zone | Definitions + `as_of` (DEC-009, DEC-015) | T2/T6 |
| 14 | Payment state machine (PI rule 5) | **GAP**: DBD BR8 covers refunds/payouts only | DEC-010 | T2 |
| 15 | Idempotency under concurrency (DBD BR4, PI 6) | DESIGNED (UNIQUE key) | Payload comparison + ON CONFLICT semantics (DEC-011) | T2 |
| 16 | Locking protocol (DBD D6, PI 8) | DESIGNED vaguely | Global order (DEC-012); real concurrent tests | T2 |
| 17 | Posting matrix (PI 9) | **GAP**: fee expense account and payout counter-account unnamed | DEC-007, DEC-008 | T1 |
| 18 | Vendor owner must be vendor_admin | **GAP** | Trigger (DEC-017) | T1 |
| 19 | DB roles / least privilege (DBD §1 mentions; PI 3) | **GAP**: no role design | DEC-013 | T1 |
| 20 | Reproducible setup (GL §6) | ABSENT | Compose + build/seed scripts + `.env.example` + lockfiles | T1, T7 |
| 21 | README with team + actual contributions (GL §6) | Midsem README has *planned* ownership only | Rewrite; team must confirm real contributions | T8 |
| 22 | Final DB design PDF ≤ 5 pages (GL §6) | Midsem PDF (outdated numbers) | Regenerate from implemented schema | T8 |

## 4. Design review of the midsem DBD (beyond the gaps above)
- BR10 "journaled at most once" fits DEC-008 (one entry per payout; failure is a separate `reversal`).
- DBD's derived attributes (order total/status, balance) are correctly views — keep.
- `payments.idempotency_key`: DBD does not say whether it identifies the checkout attempt or the callback. Decision: it identifies the **attempt** (customer action); callback retries are identified by `(payment_id, gateway_ref, outcome)` (DEC-011).
- Constraint counts (34 CHECK, 18 UNIQUE, 16 FK) will be recounted from `pg_constraint` after T1, not copied.
- No time zone was defined; we fix `Asia/Kolkata` for all business dates (DEC-009).

## 5. Normalization review (actual dependencies, not just declared keys)
The midsem proof (DBD §8) shows BCNF only relative to F0 = {declared key → all}; it says so itself. Reviewing the domain dependencies we actually know:

| Relation | Dependencies beyond F0 considered | Verdict |
|---|---|---|
| users | `email → *`; `+password_hash` depends on `user_id` only | BCNF |
| vendors | `gstin → *` when present (nullable alternate key). `owner_user_id → *`. Cross-table rule "owner has role vendor_admin" is an inter-relational constraint (trigger), not an FD | BCNF (nullable key noted) |
| products | `(vendor_id, name) → *` | BCNF |
| orders | `customer_id` only; total/status derived (not stored) | BCNF |
| order_items | `(order_id, product_id) → *`. `unit_price_paise`, `commission_bps` do **not** depend on `product_id` alone (they are time-varying snapshots) — so no partial dependency. `product_id → vendor_id` holds but vendor_id is not stored | BCNF |
| payments | `gateway_ref → *` when present. **Real FD:** for captured rows, `order_id → amount_paise` and amount must equal the derived order total — controlled redundancy: amount is the gateway-reported fact verified at capture (DEC-010), not a stored derivation | BCNF on declared FDs; redundancy justified |
| refunds | `+gateway_ref → *` when present (DEC-009) | BCNF |
| payouts | `bank_utr → *` when present | BCNF |
| gateway_settlements | `gateway_ref → *` incl. `record_type`. Ref prefixes (`pay_`/`rfnd_`) correlate with record_type but are not relied on as an FD | BCNF |
| accounts | `code → *`; `(owner_type, vendor_id, account_class)` unique with NULLS NOT DISTINCT; `vendor_id → *` when not null; `account_class → normal_side` (normal side is **not stored**). `owner_type ↛ account_class` (platform has revenue and expense) | BCNF |
| journal_entries | each non-null reference (`payment_id`, `refund_id`, `payout_id`, `settlement_id`, `reverses_entry_id`) is unique → acts as a key on its rows. `entry_type` is constrained by *which* column is non-null — a CHECK on nullness, not an FD between attributes. `+created_xid` is technical metadata dependent on `entry_id` | BCNF (nullable keys noted) |
| ledger_lines | `(entry_id, line_no) → *`. `account_id ↛` anything else | BCNF |

Caveats to state in the final PDF: (a) BCNF with nullable alternate keys is argued on the rows where they are present; (b) cross-table business rules (KYC, roles, refund cap, balance cap) are enforced by triggers/functions, not by normalization; (c) payment amount vs order total is controlled redundancy.

## 6. Proposed directory layout
```
PayRail/
├─ CLAUDE.md  README.md  docker-compose.yml  .env.example  .nvmrc
├─ db/
│  ├─ schema/        01_roles_schema.sql 02_tables.sql 03_ledger.sql 04_helpers.sql
│  │                 05_wf_orders_payments.sql 06_wf_refunds.sql 07_wf_payouts.sql
│  │                 08_wf_settlements.sql 09_views.sql 10_indexes.sql 11_privileges.sql
│  ├─ seed/          seed.sql (fixed clock, calls workflow functions), demo_users.sql
│  ├─ tests/         NN_*.sql (psql, ON_ERROR_STOP)
│  ├─ reports/       r1_trial_balance.sql … r6_*.sql (+ EXPLAIN outputs in docs)
│  ├─ build.sh       apply schema to an empty DB (non-destructive)
│  └─ reset_dev.sh   destructive drop+build+seed, requires --yes
├─ backend/          package.json, package-lock.json, src/{server,app}.js,
│                    src/{db,auth,middleware,routes,validation,gateway}/, test/{api,concurrency}/
├─ frontend/         Vite React + Tailwind + Recharts; src/{api,components,pages/{customer,vendor,finance}}
├─ samples/settlements/  normal.csv, exceptions.csv, duplicates.csv
└─ docs/             AUDIT REQUIREMENTS TASKS DECISIONS HANDOFF TEST_EVIDENCE (+ DEMO VIVA, design PDF source in T8)
```

## 7. Milestones (dependency order)
T0 audit (this) → T1 foundation & core DB → T2 stored workflows + seed + concurrency → T3 backend/auth → T4 customer UI ∥ T5 vendor/finance UI → T6 reports & EXPLAIN → T7 integration/clean-install → T8 README, PDF, DEMO, VIVA. Details and acceptance criteria: `docs/TASKS.md`.

## 8. Open uncertainties (need team input or later verification)
1. Real contributions per member (T8) — must come from the team.
2. Docker Compose and Node versions on team machines — unverified.
3. Whether the team accepts the PROPOSED decisions (esp. DEC-005 minimum refund ₹1, DEC-008 payout→BANK, DEC-009 settlement schema change). Defaults will be implemented unless someone objects.
4. Course dates (15 Nov submission, 17–19 Nov demos) are from GL §7, not independently confirmed.
5. How the team wants code to flow back to GitHub (Claude does not push).
