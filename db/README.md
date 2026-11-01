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
| `schema/20–29` | *(Task 2)* workflow functions |
| `schema/30_views.sql` | `v_account_balances`, `v_order_line_allocation`, `v_order_summary`, `v_vendor_statement` |
| `schema/31_indexes.sql` | secondary indexes |
| `schema/99_privileges.sql` | least-privilege grants for `payrail_app` |
| `tests/` | SQL tests (`run_sql_tests.sh`) |

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
db/reset_dev.sh --yes payrail       # DESTRUCTIVE: drop + build (+ seed once Task 2 adds it)
```

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
Standard codes also appear: `23505` unique, `23503` foreign key, `23514` check, `42501` permission denied, `22023` invalid helper argument.
