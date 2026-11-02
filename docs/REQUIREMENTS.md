# PayRail — Requirements Traceability

Paths are **planned** until the Status column says otherwise (updated after Task 3, 2026-11-02). Status: `TODO`, `IN_PROGRESS`, `DONE` (acceptance evidence recorded in TEST_EVIDENCE), `BLOCKED`.
Sources: **GL** = course guidelines PDF, **DBD** = database design PDF, **APD** = application design PDF, **PI** = project instructions, **DEC** = docs/DECISIONS.md.

## A. Course requirements (mandatory)

| ID | Requirement | Source | Implementation path | Test | Demo | Status |
|---|---|---|---|---|---|---|
| CR-01 | ER/EER model mapped to relational schema | GL §3A | final design PDF + `db/schema/02_tables.sql` | schema matches PDF (T8 check) | viva | TODO |
| CR-02 | PK, FK, UNIQUE, NOT NULL, CHECK enforced by DBMS | GL §3B | `db/schema/02_tables.sql`, `03_ledger.sql`, `05_guards.sql` | `db/tests/01_constraints.sql` (54 checks, T1-07) | integrity-failure demo | DONE (DB); demo T7 |
| CR-03 | Normalization examined and justified | GL §3B | AUDIT §5 → final PDF | review | viva | TODO |
| CR-04 | ~8–12 meaningful relations | GL §4 | 12 relations (DBD §6 + DEC-021 columns) | catalog count T1-05 | — | DONE |
| CR-05 | ≥500 records | GL §4 | `db/seed/seed.sql` (via workflow functions) | `29_seed.sql`; 5,769 rows (T2-07) | — | DONE |
| CR-06 | ≥3 end-to-end workflows (transaction / reporting / integrity) | GL §4 | W1–W4 (see DC-W*) | API tests ✔ (T3-01); UI tests T4/T5 | DEMO.md | IN_PROGRESS (DB + API done) |
| CR-07 | ≥5 non-trivial SQL queries | GL §4 | `db/reports/r1…r6` | fixture tests `db/tests/40_reports.sql` | finance UI reports | TODO |
| CR-08 | ≥3 additional DBMS features | GL §4 | transactions, triggers, stored functions, views, indexes | feature matrix (T6) | DEMO.md | TODO |
| CR-09 | Insert / modify / delete where appropriate | GL §3D | product CRUD (DEC-014): `backend/src/routes/vendor.js` | `backend/test/api/vendor.test.js` (create/update/archive/reactivate/delete draft/409 on referenced) ✔ | vendor UI (T5) | IN_PROGRESS (API done) |
| CR-10 | Search, filter, retrieval; multi-relation ops; reports | GL §3D | `GET /api/products?q…`, order history, statement, reconciliation; named reports T6 | `customer.test.js`, `vendor.test.js`, `finance.test.js` ✔ | UI | IN_PROGRESS |
| CR-11 | Front end ↔ backend ↔ RDBMS | GL §3D | `frontend/` ↔ `backend/` ↔ PostgreSQL | integration (T7) | live demo | TODO |
| CR-12 | Repo: app + config, DB scripts, sample data | GL §6 | whole repo | clean-install rehearsal (T7) | — | TODO |
| CR-13 | README: title, description, names/IDs, stack, setup, workflows, **actual** contributions | GL §6 | `README.md` | team review | — | TODO |
| CR-14 | Final DB design PDF ≤ 5 pages, consistent with implementation | GL §6 | `docs/design/` source + PDF | page count + schema diff | — | TODO |
| CR-15 | Reproducibility; repo = demonstrated version | GL §6 | build/seed scripts, lockfiles, fixed clock | T7 rehearsal | — | TODO |
| CR-16 | Every member can explain design (viva) | GL §4–5 | `docs/VIVA.md` | — | viva | TODO |

## B. Our design choices (from midsem PDFs, refined)

| ID | Requirement | Source | Implementation path | Test | Status |
|---|---|---|---|---|---|
| DC-01 | Exactly one role per user; ownership enforced on backend | DBD §2–3, PI | `users.role` CHECK + fixed-role trigger; `backend/src/auth.js` (guards), SQL scoping in `routes/*`, `PRA01` in functions | `auth.test.js`, `customer.test.js` (cross-customer), `vendor.test.js` (cross-vendor) ✔ | DONE (API) |
| DC-02 | Only verified vendors sell / get payouts; only active products purchasable | DBD BR7 | snapshot trigger via `fn_place_order`; `fn_request_payout` + payout trigger | `20_orders_payments.sql`, `22_payouts.sql` ✔ | DONE (DB) |
| DC-03 | One line per product per order; qty aggregates, cap 100; price + commission snapshots | DBD §8, README | `order_items` UNIQUE + CHECK + `trg_order_items_snapshot`; aggregation in `fn_place_order` | `01_constraints.sql`, `20_orders_payments.sql` ✔ | DONE (DB) |
| DC-04 | Commission 0–5000 bps; GST 18% of commission only | DBD §3 | CHECK; `fn_split_line` (DEC-004) | `02_money.sql` ✔ | DONE |
| DC-05 | Balances and order status derived, never stored | DBD D8 | `30_views.sql`, `fn_vendor_balance` | `12`, `21`, `22`, `29` ✔; report fixtures (T6) | IN_PROGRESS |
| DC-06 | Partial line refunds with reservation; rejected releases | APD W3, DEC-005 | `22_wf_refunds.sql` | `21_refunds.sql`, concurrency ✔ | DONE (DB) |
| DC-07 | Payout reserves funds at request; failed transfer reversed once | APD W2, DEC-008 | `23_wf_payouts.sql` | `22_payouts.sql`, concurrency ✔ | DONE (DB) |
| DC-08 | Late refund may make vendor negative; later sales recover; no overspend | DBD §3 | balance check under account lock in `fn_request_payout` | `22_payouts.sql`, `29_seed.sql`, concurrency ✔ | DONE (DB) |
| DC-09 | Reconciliation keeps unknown refs, no fabricated postings | DBD D9, DEC-009 | `fn_record_settlement`, `fn_reconcile`, `fn_reconciliation_report`; Report 5 (T6) | `23_settlements.sql` ✔; sample CSVs (T5) | IN_PROGRESS (DB done) |
| DC-W1 | Checkout + payment capture | APD W1 | customer UI (T4) → `POST /api/orders`, `/api/orders/:id/payments`, `/api/mock-gateway/…/simulate` → `/api/gateway/callback` → `fn_place_order`, `fn_initiate_payment`, `fn_capture_payment`/`fn_fail_payment` | `customer.test.js`, `gateway.test.js` ✔; UI T4 | IN_PROGRESS (API done) |
| DC-W2 | Vendor payout | APD W2 | vendor/finance UI (T5) → `POST /api/vendor/payouts`, `POST /api/finance/payouts/:id/complete` → `fn_request_payout`, `fn_complete_payout` | `vendor.test.js`, `finance.test.js` ✔; UI T5 | IN_PROGRESS (API done) |
| DC-W3 | Refund request + approval | APD W3 | customer/finance UI → `POST /api/orders/:id/refunds`, `POST /api/finance/refunds/:id/approve|reject` → refund functions | `customer.test.js`, `finance.test.js` ✔; UI T4/T5 | IN_PROGRESS (API done) |
| DC-W4 | Settlement import, reconciliation, reports | APD W4 | finance UI (T5) → `POST /api/finance/settlements/import` (CSV/JSON), `/api/finance/reconcile`, `/api/finance/reconciliation`, `/api/finance/trial-balance`; named reports T6 | `finance.test.js` ✔; UI T5, reports T6 | IN_PROGRESS (API done) |
| DC-10 | Auth with hashed passwords, JWT | APD §2, DEC-002, DEC-035 | `users.password_hash`, `backend/src/auth.js` | `auth.test.js` ✔ | DONE (API) |
| DC-11 | Mock gateway: callbacks with retries + controllable outcome, settlement CSV | APD §3, DEC-033, DEC-036 | `backend/src/gateway.js`, `routes/gateway.js`, `settlementCsv.js` | `gateway.test.js`, `customer.test.js`, `finance.test.js` ✔; sample CSV files T5 | IN_PROGRESS (API done) |

## C. Financial correctness rules (PI 1–12)

| ID | Rule | Decision | Planned enforcement | Planned test | Status |
|---|---|---|---|---|---|
| FR-01 | BIGINT paise, exact round-half-up, lossless API strings | DEC-003, DEC-034 | `04_helpers.sql`; `backend/src/validate.js`, `db.js` | `db/tests/02_money.sql` ✔; `vendor.test.js` 2^53+1 reaches the DB exactly, 2^63 and JSON numbers refused ✔ | DONE |
| FR-02 | ≥2 lines, balanced, empty/single-line rejected at COMMIT | DEC-006 | `03_ledger.sql` deferred constraint triggers on header + lines | `db/tests/10_ledger.sql` (real COMMIT) ✔ | DONE |
| FR-03 | Posted ledger immutable as app role (UPDATE/DELETE/TRUNCATE/late append) | DEC-006, DEC-013, DEC-022 | `03_ledger.sql` triggers + seal, `99_privileges.sql` | `db/tests/11_ledger_immutability.sql` (real `payrail_app` login) ✔ | DONE |
| FR-04 | Atomic captures/approvals/payouts/reversals/settlements | DEC-010 | single-function transactions | rollback tests in `20_orders_payments.sql` ✔ | DONE (DB) |
| FR-05 | ≤1 capture per order; amount = total; state machines | DEC-010 | partial unique index, triggers, workflow checks | `20`, `21`, `22` + double-capture race ✔ | DONE (DB) |
| FR-06 | Idempotency under simultaneous duplicates; conflicts rejected; no poisoning | DEC-011, DEC-034 | UNIQUE + domain-row lock + ON CONFLICT + payload compare; `Idempotency-Key` header | SQL tests + 8-connection races ✔; API: simultaneous duplicate payment/refund/payout/callback requests, conflicts, no poisoning ✔ | DONE |
| FR-07 | Concurrent refunds within limit; cumulative exact allocation | DEC-005 | line lock + cumulative rhu | `21_refunds.sql` fixture, `29_seed.sql`, races ✔ | DONE |
| FR-08 | Consistent locking for vendor funds; no double spend | DEC-012, DEC-028 | lock order domain rows → accounts ascending; READ COMMITTED guard | races + mutation check (T2-05, T2-10) ✔ | DONE |
| FR-09 | Posting matrix defined before coding | DEC-007 | `06_system_accounts.sql`, `fn_post_entry`, workflows 21–24 | `12`, `20`–`23` (exact lines per event) ✔ | DONE |
| FR-10 | Settlement/refund relationship explicit | DEC-009 | `record_type`, `refunds.gateway_ref`, refund settlement posting | `23_settlements.sql` ✔ | DONE |
| FR-11 | Distinguishable reconciliation categories; T+2; duplicates; revisit unknowns | DEC-009, DEC-029 | `fn_reconciliation_report(as_of)`, `fn_reconcile`; Report 5 (T6) | `23_settlements.sql` ✔ | DONE (DB) |
| FR-12 | History intact; CRUD on non-financial records | DEC-014, DEC-021 | FK NO ACTION, immutability triggers, product grants; `routes/vendor.js` | SQL ✔ (01, 11); API: delete draft 204, referenced 409 + still present, price edit leaves snapshots ✔ | DONE (UI in T5) |

## D. Optional improvements (only if time remains after T7)
- OPT-01 Recharts dashboards beyond the required reports.
- OPT-02 Customer self-registration (customer role only).
- OPT-03 Playwright smoke tests for all three roles (critical path is T7; extra coverage optional).
- OPT-04 Holiday-aware settlement calendar (currently calendar T+2, disclosed).
