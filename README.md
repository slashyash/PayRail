# PayRail — Double-Entry Payments & Settlement Engine

CS F212 Database Systems · Final project · **Group 13 (Team PayRail)**

PayRail is a simulated payments and settlement engine for a multi-vendor marketplace. A customer pays the platform once; the platform keeps its commission, sets aside 18 % GST on that commission, owes the rest to one or more vendors, processes line-level refunds, pays vendors out, and reconciles what the payment gateway actually settled.

Every money movement is a **double-entry journal entry** (Σ debits = Σ credits) in an **append-only ledger**. Balances are derived from the ledger, never stored. Each financial workflow is one atomic PostgreSQL stored function protected by constraints, triggers, row locks and idempotency keys. The gateway and the bank are simulated; no real money or credentials are involved.

**Final submission:** tag `final` · commit `________________`

## Team

| Member | Student ID |
|---|---|
| Aryan Saini | 2024A2PS1154H |
| K Harsha Vardhan | 2023B4AD1155H |
| Yash Jain | 2023B2A80958H |
| Aluri Venkata Sai Anirudh | 2023B2AD0824H |
| Parth Gupta | 2023B4AD0741H |

## Individual contributions

**All five members** worked together on the database design: problem analysis and requirements, the ER/EER model, the relational schema, keys and integrity constraints (PK, FK, UNIQUE, CHECK and business-rule triggers), normalization and the main design decisions (`db/schema/02_tables.sql`, `05_guards.sql`, `docs/design/PayRail_Database_Design.pdf`).

| Area | Member(s) | Scope | Main files |
|---|---|---|---|
| **Database workflows** | Yash Jain (2023B2A80958H), Aluri Venkata Sai Anirudh (2023B2AD0824H) | Stored functions for order placement, payment capture, refunds (cumulative allocation), payouts (with failure reversal) and settlement import; double-entry ledger with deferred balance checks and append-only protection; money rounding; row-locking order; idempotency keys; database roles and privileges | `db/schema/00_roles, 01_schema, 03_ledger, 04_helpers, 06_system_accounts, 20_wf_common, 21_wf_orders_payments, 22_wf_refunds, 23_wf_payouts, 24_wf_settlements, 99_privileges.sql` |
| **Backend / API** | K Harsha Vardhan (2023B4AD1155H) | Express API over the stored functions, login (bcrypt + JWT), role and ownership checks, Zod input validation, error and SQLSTATE mapping, simulated gateway with signed callbacks, settlement CSV parser | `backend/src/` (`app.js`, `auth.js`, `validate.js`, `errors.js`, `gateway.js`, `settlementCsv.js`, `routes/`) |
| **Frontend / UI** | Aryan Saini (2024A2PS1154H) | Customer shop, cart, checkout, orders and refunds; vendor products, statement and payouts; finance refunds, payouts, settlement import, reconciliation, ledger and reports pages | `frontend/src/` (`pages/`, `pages/vendor/`, `pages/finance/`, `components/`, `lib/`) |
| **Reports, testing, setup and documentation** | Parth Gupta (2023B4AD0741H) | SQL reports R1–R6, views, indexes and EXPLAIN evidence; SQL, API, concurrency and browser tests; Docker, build, seed and reset scripts, sample settlement files; README, Demo Sheet and design document | `db/schema/30_views, 31_indexes, 32_reports.sql`, `db/reports/`; `db/tests/`, `backend/test/`, `frontend/e2e/`; `docker-compose.yml`, `db/build.sh`, `db/reset_dev.sh`, `db/seed/`, `scripts/`, `samples/`; `README.md`, `docs/` |

## Technology stack

| Layer | Technology |
|---|---|
| Database | PostgreSQL 16 (Docker Compose `postgres:16`, health-checked), schema `payrail` |
| Backend | Node.js 22, Express 5, `pg` with parameterised SQL (no ORM), Zod, bcryptjs + JWT |
| Frontend | React 19, Vite 8, Tailwind CSS 4, Recharts |
| Tests | SQL test runner (psql), `node:test` + supertest, Playwright (Chromium) |

Architecture: **React UI ↔ Express API ↔ PostgreSQL**. The API logs in as the least-privilege role `payrail_app` and calls the stored workflow functions; all money is `BIGINT` paise and travels through the API as decimal strings.

## Setup and run

Prerequisites: Docker Desktop, Node.js 22 (`.nvmrc`; Node 26 also passed all tests), Git.

```bash
git clone https://github.com/slashyash/PayRail && cd PayRail
cp .env.example .env
# edit .env: set both passwords; DATABASE_URL must use the same APP_DB_PASSWORD and PGPORT;
# put `openssl rand -hex 32` output in JWT_SECRET and GATEWAY_WEBHOOK_SECRET
docker compose up -d db
docker compose ps                          # wait for "healthy" (first start builds the schema and loads the seed)
cd backend && npm ci && npm run doctor     # read-only startup check; every line should be "ok"
npm start                                  # API on http://127.0.0.1:4000
```
In a second terminal:
```bash
cd frontend && npm ci && npm run dev       # UI on http://127.0.0.1:5173
```

Reset the demo data to its known state at any time (drops and reseeds database `payrail` only):
```bash
scripts/demo-reset.sh --yes
```
Troubleshooting and recovery: `cd backend && npm run doctor` prints the fix for each failure it finds.

## Demo accounts

Password for every account: **`PayRail@2026`**

| Role | Accounts | Notes |
|---|---|---|
| Customer | `customer1@payrail.demo` … `customer60@payrail.demo` | |
| Vendor admin | `vendor1@payrail.demo` … `vendor12@payrail.demo` | vendor7 has a negative balance (late refund); vendor11 KYC pending, vendor12 rejected (cannot sell or be paid) |
| Finance admin | `finance@payrail.demo`, `audit@payrail.demo` | |

Reconciliation uses the demo as-of date **2026-10-31** (`PAYRAIL_DEMO_AS_OF`).

## Workflows

| # | Workflow | UI path | Database effect |
|---|---|---|---|
| W1 | Checkout and payment capture | Customer: Shop → Cart → Place order → Pay at the gateway page | `fn_place_order` snapshots price and commission per line; `fn_capture_payment` posts one balanced capture entry (Dr gateway clearing; Cr vendor payables, commission revenue, GST payable). Duplicate callbacks post once; wrong amount is refused. |
| W2 | Vendor payout | Vendor: Payouts → Request · Finance: Payouts → Mark paid / Mark failed | `fn_request_payout` locks the vendor account and checks the ledger balance (Dr payable, Cr bank); a failed transfer posts exactly one reversal. |
| W3 | Line refund | Customer: Order → Request refund · Finance: Refunds → Approve / Reject | Request reserves the amount (no posting); approval posts the cumulative commission/GST/vendor split; rejection releases it. Over-limit requests are refused (`PRR01`). |
| W4 | Settlement and reconciliation | Finance: Settlements → Import CSV · Reconciliation · Reports | Each CSV row is recorded under its own savepoint; only exact matches are posted. Categories: matched, amount mismatch, unknown reference, in transit (≤ T+2), overdue. |

Product CRUD (create, edit, archive, reactivate, delete a never-ordered product; deleting an ordered product is refused by the foreign key) is on Vendor → Products.

## SQL queries and DBMS features

- **Six named reports** (`db/schema/32_reports.sql`): R1 trial balance (GROUPING SETS), R2 vendor statement (window running balance), R3 monthly performance (generate_series, CTEs), R4 vendor refund risk (cohort, rank()), R5 settlement aging, R6 vendor payables. Finance → Reports; Vendor → Reports/Statement; or `psql -X -d payrail -f db/reports/run_reports.sql`. Walkthrough: `db/reports/README.md`.
- **DBMS features**: transactions with `SELECT … FOR UPDATE` row locks, deferred constraint triggers (balanced entries checked at COMMIT), append-only ledger triggers, state-machine triggers, views for derived data, partial unique index, indexes justified with `EXPLAIN (ANALYZE, BUFFERS)` (`db/reports/explain_reports.sql`), SECURITY DEFINER functions and role privileges. File paths and line numbers: the Demo Sheet (`docs/submission/`).
- **Data**: 12 tables, 5,769 records from a deterministic seed that uses the same stored functions as the app. Trial balance ₹80,14,286.31 on both sides.

## Tests

```bash
cd frontend && npx playwright install chromium && cd ..    # once
scripts/test-all.sh                                        # SQL 304 · API 46 · concurrency 12 · unit 12 · build · e2e 11
```
Each suite uses its own test database; the demo database is not touched. Full output is kept in `test-logs/`.

## Repository layout

```
db/schema/        00–06 roles, tables, ledger, helpers, guards · 20–24 workflow functions · 30 views · 31 indexes · 32 reports · 99 privileges
db/seed/          deterministic seed (seed.sql)
db/tests/         SQL tests (run_sql_tests.sh)
db/reports/       psql runners for the reports and EXPLAIN evidence
backend/          Express API (src/), API tests (test/api/), concurrency tests (test/concurrency/)
frontend/         React UI (src/pages/{customer pages, vendor/, finance/}), Playwright tests (e2e/)
samples/          settlement CSVs for the demo (normal, duplicate/conflict, exceptions)
scripts/          demo-reset.sh, test-all.sh, demo-race.mjs, check-demo-sheet.sh
docs/             design/ (database design PDF), submission/ (demo sheet)
```

## Limitations

- Gateway and bank are simulated (hosted test checkout, signed callbacks, CSV settlement files); no real payment integration.
- Single currency (INR); GST only on commission; no shipping, stock, GST on goods or TCS.
- Settlement is expected T+2 calendar days (IST); there is no holiday calendar.
- A payout credits BANK when it is accepted; marking it paid only records the UTR.
- Mismatched settlement rows are reported for investigation; there is no manual-resolution workflow.
- No self-registration; demo accounts are seeded. Database owner/superuser accounts are trusted.
