# PayRail database

PostgreSQL 16, schema `payrail`. Plain ordered SQL files, no migration framework (DEC-018).

## Files
| File | Contents |
|---|---|
| `schema/00_roles.sql` | cluster roles `payrail_owner` (owns everything) and `payrail_app` (backend login) |
| `schema/01_schema.sql` | schema, `pgcrypto`, database time zone `Asia/Kolkata`, controlled clock `fn_now()` |
| `schema/02_tables.sql` | the 12 relations with PK / FK / UNIQUE / CHECK |
| `schema/03_ledger.sql` | seal, deferred balance triggers, append-only triggers, `fn_post_entry` |
| `schema/04_helpers.sql` | `fn_round_half_up`, `fn_split_line`, `fn_refund_alloc`, `fn_inr`, account lookups |
| `schema/05_guards.sql` | role/KYC/active-product/snapshot rules, state machines, immutable history |
| `schema/06_system_accounts.sql` | system chart of accounts (vendor payables are created by trigger) |
| `schema/20_wf_common.sql` | internal helpers: READ COMMITTED guard, role check, vendor-account locking, `fn_vendor_balance`, `fn_order_total`, `fn_reverse_entry` |
| `schema/21_wf_orders_payments.sql` | W1: `fn_place_order`, `fn_initiate_payment`, `fn_capture_payment`, `fn_fail_payment` |
| `schema/22_wf_refunds.sql` | W3: `fn_request_refund`, `fn_approve_refund`, `fn_reject_refund` |
| `schema/23_wf_payouts.sql` | W2: `fn_request_payout`, `fn_complete_payout` (paid / failed → reversal) |
| `schema/24_wf_settlements.sql` | W4: `fn_record_settlement`, `fn_reconcile`, `fn_reconciliation_report` |
| `schema/30_views.sql` | `v_account_balances`, `v_order_line_allocation`, `v_order_summary`, `v_vendor_statement` |
| `schema/31_indexes.sql` | secondary indexes |
| `schema/99_privileges.sql` | least-privilege grants for `payrail_app` |
| `seed/seed.sql` | deterministic demo data, generated **through the workflow functions** under the controlled clock (1 Sep – 31 Oct 2026) |
| `tests/` | SQL tests (`run_sql_tests.sh`); concurrency tests live in `backend/test/concurrency/` |

## Commands
All scripts use the standard libpq variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`) and connect as an **administrator**. The backend never does; it logs in as `payrail_app`.

With Docker (recommended):
```bash
cp .env.example .env                       # edit the passwords
docker compose up -d db                    # first start on an empty volume builds the schema
docker compose ps                          # wait until db is "healthy"
docker compose exec -T db bash /payrail/db/tests/run_sql_tests.sh      # SQL tests (uses payrail_test)
docker compose exec db psql                                            # shell on database payrail
docker compose exec -T db bash /payrail/db/reset_dev.sh --yes payrail  # DESTRUCTIVE rebuild
```

With a local PostgreSQL 16 (e.g. Homebrew, apt):
```bash
export PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=...   # an admin login
export APP_DB_PASSWORD=...                                            # password for payrail_app
db/build.sh payrail                 # non-destructive: creates the DB if missing, refuses if already built
db/tests/run_sql_tests.sh           # drops and rebuilds payrail_test before each test file
db/reset_dev.sh --yes payrail       # DESTRUCTIVE: drop + build + seed
cd backend && npm ci && npm run test:concurrency   # genuine multi-connection tests (rebuilds payrail_conc)
```
`db/build.sh` alone builds an empty schema; `reset_dev.sh` and the Docker init hook also load `seed/seed.sql`
(`PAYRAIL_SKIP_SEED=1` skips it). **Existing Docker volume from Task 1:** it has the Task 1 schema only; rebuild it once with
`docker compose exec -T db bash /payrail/db/reset_dev.sh --yes payrail` (drops the dev database — it holds no real data).

## Workflow functions (called by the backend as `payrail_app`)
All are `SECURITY DEFINER` (owner rights, `search_path = payrail, pg_temp`), atomic, and must run at READ COMMITTED.
Actors are passed explicitly and re-checked in the database (role / ownership).

| Function | Actor | Effect | Posting |
|---|---|---|---|
| `fn_place_order(customer, items jsonb)` → order_id | customer | order + lines (quantities aggregated, cap 100, catalogue snapshots) | — |
| `fn_initiate_payment(customer, order, method, key)` → payments | customer | payment attempt, amount = derived total; idempotent per key | — |
| `fn_capture_payment(payment, gateway_ref, amount)` → payments | gateway callback | initiated → captured | capture |
| `fn_fail_payment(payment, gateway_ref)` → payments | gateway callback | initiated → failed | — |
| `fn_request_refund(customer, order, line, amount, reason, key)` → refunds | customer | reserves amount on the line | — |
| `fn_approve_refund(finance, refund)` / `fn_reject_refund(finance, refund)` → refunds | finance | processed (cumulative allocation) / rejected (releases) | refund / — |
| `fn_request_payout(vendor_user, amount, key)` → payouts | vendor_admin | reserves funds (≤ balance) | payout |
| `fn_complete_payout(finance, payout, 'paid'\|'failed', utr)` → payouts | finance | paid (UTR) / failed | — / reversal |
| `fn_record_settlement(finance, ref, type, gross, fee, settled_on)` → (id, inserted\|duplicate\|conflict, entry) | finance | stores a report row; posts it only on an exact match | settlement |
| `fn_reconcile(finance, as_of)` → summary per category | finance | posts newly matching rows | settlement |
| `fn_reconciliation_report(as_of)` → rows | anyone with read access | matched / amount_mismatch / unknown_reference / in_transit / overdue_missing | — |

Retries: same key + same data → the original row; same key + different data → `PRI01`; a failed call leaves nothing behind, so its key can be reused.

## Demo data (seed)
Password for **every** seeded login: `PayRail@2026`. Named accounts: `finance@payrail.demo` (finance_admin),
`vendor1@payrail.demo` … `vendor12@payrail.demo` (vendor 11 KYC pending, 12 rejected), `customer1@payrail.demo` … `customer60@payrail.demo`.
Reconciliation demo date: `2026-10-31`. Observed counts and totals: `docs/TEST_EVIDENCE.md` (T2).

## SQLSTATE codes raised by PayRail
| Code | Meaning |
|---|---|
| `PRL01` | journal entry unbalanced or with fewer than 2 lines (at COMMIT) |
| `PRL02` | ledger is append-only (UPDATE / DELETE / TRUNCATE) |
| `PRL03` | entry already posted: lines cannot be added later |
| `PRL04` | invalid posting request / unknown account |
| `PRV01` | vendor owner is not a `vendor_admin` |
| `PRV02` | order customer is not a `customer` |
| `PRV03` | vendor not KYC-verified (ordering, payouts) |
| `PRV04` | product not active |
| `PRV05` | price / commission snapshot differs from the catalogue |
| `PRV06` | immutable row or column (financial history) |
| `PRO01` | order already has a payment attempt; its lines are frozen |
| `PRS01` | invalid status transition |
| `PRP01` | capture amount differs from the derived order total |
| `PRA01` | actor not allowed (wrong role / not the owner) |
| `PRN01` | referenced object does not exist |
| `PRV07` | invalid workflow input (empty cart, quantity, future settlement date, missing UTR, …) |
| `PRI01` | idempotency key reused with different data / conflicting retry |
| `PRS02` | order already has a captured payment |
| `PRO02` | order not paid (refund requested before capture) |
| `PRR01` | refund exceeds the line's refundable amount |
| `PRR02` | refund below ₹1.00 that is not the whole remainder |
| `PRF01` | payout exceeds the vendor's available balance |
| `PRX01` | funds-changing workflow called outside READ COMMITTED |
Standard codes also appear: `23505` unique, `23503` foreign key, `23514` check, `42501` permission denied, `22023` invalid helper argument.
