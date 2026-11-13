# PayRail — Double-Entry Payments & Settlement Engine

CS F212 Database Systems · Final project · **Group 13 (Team PayRail)**

PayRail is a simulated payments and settlement engine for a multi-vendor marketplace. A customer pays the platform once; the platform keeps its commission, sets aside 18 % GST on that commission, owes the rest to one or more vendors, processes line-level refunds, pays vendors out, and reconciles what the payment gateway actually settled.

Every money movement is a **double-entry journal entry** (Σ debits = Σ credits) in an **append-only ledger**. Balances are derived from the ledger, never stored. Each financial workflow is one atomic PostgreSQL stored function protected by constraints, triggers, row locks and idempotency keys. The gateway and the bank are simulated; no real money or credentials are involved.

**Final submission:** tag `final` · commit `________________` *(filled in after tagging; see “Submitting” below)*

## Team

| Member | Student ID |
|---|---|
| Aluri Venkata Sai Anirudh | 2023B2AD0824H |
| Yash Jain | 2023B2A80958H |
| Aryan Saini | 2024A2PS1154H |
| Parth Gupta | 2023B4AD0741H |
| Harsha Vardhan | 2023B4AD1155H |

## Individual contributions

The project is divided into five parts. Each part runs from the database to the API to the UI, so its owner can trace it end to end in the demo and viva.

| Part | Scope | Main files | Name | ID |
|---|---|---|---|---|
| **1. Data model, integrity and access control** | 12 tables, keys, CHECK/UNIQUE/FK constraints, business-rule triggers, database roles and privileges, login (bcrypt + JWT) and role/ownership checks, product create/edit/archive/delete | `db/schema/00_roles, 01_schema, 02_tables, 05_guards, 99_privileges.sql`; `backend/src/{auth,validate,errors}.js`, `routes/catalogue.js`; `frontend/src/pages/Login.jsx`, `vendor/Products.jsx`; tests `db/tests/01_constraints.sql`, `24_app_role.sql`, `backend/test/api/auth.test.js` | | |
| **2. Double-entry ledger, money and setup** | Journal tables, deferred balance triggers, append-only protection and seal, paise arithmetic and rounding, balance views, trial balance (R1) and vendor statement (R2), Docker, build, seed and reset scripts | `db/schema/03_ledger, 04_helpers, 06_system_accounts, 30_views.sql`; R1/R2 in `32_reports.sql`; `db/seed/seed.sql`; `docker-compose.yml`, `db/build.sh`, `scripts/demo-reset.sh`; `pages/finance/TrialBalance.jsx`, `vendor/Statement.jsx`; tests `02_money`, `10_ledger`, `11_ledger_immutability`, `12_capture_example` | | |
| **3. Checkout, payments and gateway (W1)** | Order placement with snapshots, payment attempts, capture/failure, simulated gateway with signed callbacks, idempotency, customer UI | `db/schema/20_wf_common, 21_wf_orders_payments.sql`; `backend/src/gateway.js`, `routes/{customer,gateway}.js`; `pages/{Catalogue,Cart,Pay,GatewayCheckout,Orders,OrderDetail}.jsx`, `finance/GatewaySimulator.jsx`; tests `20_orders_payments`, `customer.test.js`, `gateway.test.js`, `e2e/customer.spec.js` | | |
| **4. Refunds, payouts and concurrency (W2, W3)** | Refund request/approve/reject with cumulative allocation, payout request/paid/failed with reversal, negative vendor balances, locking order, concurrency tests | `db/schema/22_wf_refunds, 23_wf_payouts.sql`; refund/payout routes in `routes/{customer,vendor,finance}.js`; `pages/Refunds.jsx`, `vendor/Payouts.jsx`, `finance/{Refunds,Payouts}.jsx`; `backend/test/concurrency/`, `scripts/demo-race.mjs`; tests `21_refunds`, `22_payouts` | | |
| **5. Settlement, reconciliation, reports and performance (W4)** | Settlement CSV import, five reconciliation categories, reports R3–R6, indexes and EXPLAIN evidence, finance overview/trace pages, test runner and runbook | `db/schema/24_wf_settlements, 31_indexes.sql`; R3–R6 in `32_reports.sql`; `backend/src/settlementCsv.js`, `routes/reports.js`; `pages/finance/{Settlements,Reconciliation,Reports,Overview}.jsx`; `samples/settlements/`; `docs/evidence/`, `docs/FEATURE_MATRIX.md`, `docs/RUNBOOK.md`; tests `23_settlements`, `30_reports`, `reports.test.js` | | |

*Name and ID columns are filled in by the team with each member's actual work.*

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
Troubleshooting and recovery: `docs/RUNBOOK.md` (the doctor prints the fix for each failure it finds).

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
- **DBMS features**: transactions with `SELECT … FOR UPDATE` row locks, deferred constraint triggers (balanced entries checked at COMMIT), append-only ledger triggers, state-machine triggers, views for derived data, partial unique index, indexes justified with `EXPLAIN (ANALYZE, BUFFERS)` (`docs/evidence/T6_explain_seed.txt`), SECURITY DEFINER functions and role privileges. Full list with file paths and tests: `docs/FEATURE_MATRIX.md`.
- **Data**: 12 tables, 5,769 records from a deterministic seed that uses the same stored functions as the app. Trial balance ₹80,14,286.31 on both sides.

## Tests

```bash
cd frontend && npx playwright install chromium && cd ..    # once
scripts/test-all.sh                                        # SQL 304 · API 46 · concurrency 12 · unit 5 · build · e2e 11
```
Each suite uses its own test database; the demo database is not touched. Full output is kept in `test-logs/`. Observed results: `docs/TEST_EVIDENCE.md`.

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
docs/             design/ (design PDF + source), submission/ (demo sheet), DEMO.md, VIVA.md, RUNBOOK.md,
                  FEATURE_MATRIX.md, DECISIONS.md, REQUIREMENTS.md, TEST_EVIDENCE.md
```

## Documents

- Database design document (≤ 5 pages): `docs/design/PayRail_Database_Design.pdf` (source `design.html`, `er.dot`; rebuild with `docs/design/build.sh`)
- Demo sheet: `docs/submission/PayRail_Demo_Sheet.pdf` (editable `.docx`); `scripts/check-demo-sheet.sh` verifies its file:line references
- Demo script: `docs/DEMO.md` · viva notes: `docs/VIVA.md` · design decisions and deviations from the mid-semester design: `docs/DECISIONS.md`

## Limitations

- Gateway and bank are simulated (hosted test checkout, signed callbacks, CSV settlement files); no real payment integration.
- Single currency (INR); GST only on commission; no shipping, stock, GST on goods or TCS.
- Settlement is expected T+2 calendar days (IST); there is no holiday calendar.
- A payout credits BANK when it is accepted; marking it paid only records the UTR (`docs/DECISIONS.md` DEC-008).
- Mismatched settlement rows are reported for investigation; there is no manual-resolution workflow.
- No self-registration; demo accounts are seeded. Database owner/superuser accounts are trusted.

## Submitting

A commit cannot contain its own hash, so the hash is recorded in a README-only commit that becomes the tagged one:
1. Commit the finished code; check `scripts/test-all.sh` and `scripts/check-demo-sheet.sh` pass. Note its hash: `git rev-parse --short HEAD`.
2. Put that hash in the “Final submission” line above and in the Demo Sheet, commit the README change only, push.
3. Tag that commit and push the tag: `git tag final && git push origin final`. The tagged commit differs from the recorded code commit only in this README line.
