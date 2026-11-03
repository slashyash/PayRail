# PayRail — DBMS feature matrix (Task 6)

Course requirement GL §4: at least 5 non-trivial SQL queries and at least 3 additional DBMS features. Each row points to the implementation, the test that proves it, and how to show it. Commands assume the admin libpq variables (see CLAUDE.md) or the Docker container (`docker compose exec -T db psql -U postgres -X -d payrail …`). Counts were read from the catalog of a freshly built database on 2026-11-02.

## A. Non-trivial SQL queries (CR-07)

| # | Query | Techniques | Implementation | Tests | Demo |
|---|---|---|---|---|---|
| R1 | Trial balance + global check | per-account CTE, `FILTER`, `LEFT JOIN`, `GROUPING SETS` total row, date filter | `fn_report_trial_balance` — `db/schema/32_reports.sql` | `db/tests/30_reports.sql` (4), `31_reports_seed.sql` (1), `reports.test.js` | Finance → Reports → R1; `db/reports/run_reports.sql` |
| R2 | Vendor statement with running balance | window `SUM … OVER (PARTITION BY … ORDER BY …)`, filter pushed below the window, date filter above it, `UNION ALL` opening/closing, `row_number()` | `fn_report_vendor_statement` + view `v_vendor_statement` | `30` (4), `31` (2), `reports.test.js`, `vendor.test.js` | Finance → Reports → R2; Vendor → Statement |
| R3 | Monthly payment / refund / commission performance | `generate_series` months, five month-grain CTEs, `LEFT JOIN`s, conditional aggregation over the ledger, cumulative window | `fn_report_monthly_performance` | `30` (4), `31` (1), `reports.test.js` | Finance → Reports → R3 (chart + table) |
| R4 | Vendor refund risk (cohort) | line-grain CTEs before vendor aggregation (no fan-out), `rank() OVER (PARTITION BY …)`, explicit numerator/denominator, threshold | `fn_report_vendor_refund_risk` | `30` (4 incl. fan-out demo), `31` (1), `reports.test.js` | Finance → Reports → R4; Vendor → Reports |
| R5 | Settlement reconciliation + aging | reference matching (`LEFT JOIN` on `gateway_ref`, `UNION ALL … NOT EXISTS`), per-category age, `GROUPING SETS` subtotals | `fn_report_settlement_aging` over `fn_reconciliation_report` | `30` (4), `31` (1), `23_settlements.sql`, `reports.test.js` | Finance → Reports → R5; Finance → Reconciliation |
| R6 | Vendor payables / payouts | ledger decomposition by entry type, `CROSS JOIN LATERAL`, cross-relation consistency check (ledger vs payouts) | `fn_report_vendor_payables` | `30` (2), `31` (1), `reports.test.js` | Finance → Reports → R6; Vendor → Reports |

Walkthrough of each query, grains and EXPLAIN findings: `db/reports/README.md`.

## B. Additional DBMS features (CR-08)

| Feature | What exactly | Where | Proof (tests) | Demo command / UI path |
|---|---|---|---|---|
| **Transactions (ACID)** | each workflow function is one atomic step; settlement import = one transaction with a SAVEPOINT per row; READ COMMITTED required (`PRX01`) | `db/schema/2*_wf_*.sql`; `backend/src/db.js` `withTransaction`; `backend/src/routes/finance.js` import | `12_capture_example.sql`, `20_orders_payments.sql` (rollback cases), `finance.test.js` (import) | Finance → Settlements: upload `samples/settlements/03_exceptions.csv` (rejected rows rolled back alone) |
| **Deferred constraint triggers** | Σ debit = Σ credit and ≥ 2 lines per entry, checked at COMMIT on both ledger tables | `03_ledger.sql` `trg_journal_entries_balanced`, `trg_ledger_lines_balanced` | `10_ledger.sql` (24 checks incl. empty header / single line at real COMMIT) | `psql`: `BEGIN; INSERT` an unbalanced entry as owner; `COMMIT;` → `PRL01` (`10_ledger.sql` shows the statements) |
| **Row triggers (24 in total)** | append-only ledger (no UPDATE/DELETE/TRUNCATE), entry seal (`created_xid`), purchase-time snapshots, state machines for payments/refunds/payouts, immutable orders/accounts/settlements, vendor payable account creation, fixed user role | `03_ledger.sql`, `05_guards.sql` | `11_ledger_immutability.sql` (32), `01_constraints.sql` (54), `21`, `22` | `UPDATE ledger_lines …` → `PRL02`; late line into a posted entry → `PRL03` |
| **Stored functions** | 11 workflow functions (SECURITY DEFINER, pinned `search_path`, actor re-check), 6 report functions (SECURITY INVOKER, inlinable), exact-money helpers | `20`–`24_wf_*.sql`, `04_helpers.sql`, `32_reports.sql` | `20`–`24`, `30`, `31`; API tests 40 | every UI action calls one; `db/reports/run_reports.sql` |
| **Views** | `v_account_balances`, `v_order_line_allocation`, `v_order_summary` (derived status), `v_vendor_statement` (window) — balances and order status are never stored | `30_views.sql` | `12`, `21`, `29`, `30`, `31` | Vendor → Dashboard balance; customer order status |
| **Indexes** | 12 primary keys, 19 UNIQUE constraints (incl. the `NULLS NOT DISTINCT` account slot) + the partial unique index `payments_one_capture_per_order`, 10 secondary indexes (3 partial) | `02_tables.sql`, `31_indexes.sql` | uniqueness tests in `01`, `20`; `EXPLAIN` evidence | `psql -f db/reports/explain_reports.sql` → `docs/evidence/T6_explain_seed.txt` |
| **Constraints** | 48 CHECK, 16 FOREIGN KEY, 19 UNIQUE, 12 PRIMARY KEY, 2 constraint triggers (catalog count) | `02_tables.sql` | `01_constraints.sql` | Vendor → Products: delete an ordered product → `23503` |
| **Roles and privileges** | `payrail_owner` owns objects; app logs in as `payrail_app` with SELECT + product writes + EXECUTE on workflows only; internal helpers never granted | `00_roles.sql`, `99_privileges.sql` | `24_app_role.sql`, `11_ledger_immutability.sql`, `30_reports.sql` (app role) | `/api/health` shows `db_user payrail_app` |
| **Concurrency control** | row locks (`FOR UPDATE`) in a fixed order, idempotency via UNIQUE + `ON CONFLICT` | `20_wf_common.sql` `fn_lock_vendor_accounts`; workflow files | `backend/test/concurrency/*.test.js` (12, independent connections) | `cd backend && npm run test:concurrency` |

## C. Query evidence

- `EXPLAIN (ANALYZE, BUFFERS)` of R1–R6 on the seeded database, an index experiment and two other API read paths: `docs/evidence/T6_explain_seed.txt` (regenerate with `db/reports/explain_reports.sql`).
- Index finding in one line: on the balance query that every payout/refund workflow runs under its lock, `ledger_lines_account_entry_idx` reduces the work from 2,765 to 26 shared buffers on the seed (a sequential scan would evaluate the account-lookup function for every ledger row). Other secondary indexes are not chosen at seed size; no speed-up is claimed for them.
