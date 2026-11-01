# PayRail — Milestones

States: `TODO` · `IN_PROGRESS` · `BLOCKED` · `DONE` (only when acceptance criteria are evidenced in TEST_EVIDENCE.md).
Target dates are a suggested schedule against the GL §7 submission date (15 Nov 2026); adjust as needed.

| ID | Milestone | Depends on | Target | State |
|---|---|---|---|---|
| T0 | Repository audit and executable plan | — | 2 Nov | DONE |
| T1 | Reproducible foundation and core database | T0 | 3 Nov | DONE |
| T2 | Stored workflows, seed, database correctness | T1 | 5–6 Nov | TODO |
| T3 | Backend and authentication | T2 | 7–8 Nov | TODO |
| T4 | Customer workflow UI | T3 | 9–10 Nov | TODO |
| T5 | Vendor and finance workflow UI | T3 (parallel with T4) | 10–11 Nov | TODO |
| T6 | SQL reports and DBMS evidence | T2 (SQL), T4/T5 (UI exposure) | 12 Nov | TODO |
| T7 | Integration, regression tests, demo reliability | T4, T5, T6 | 13–14 Nov | TODO |
| T8 | README, final design PDF, DEMO, VIVA | T7 (contributions need team input) | 14–15 Nov | TODO |

---

## T0 — Audit and plan — DONE
- [x] Read GL, DBD, APD and project instructions
- [x] Inspect repo (README only) and environment
- [x] Probe PG behaviours the design relies on (E-001…E-005)
- [x] AUDIT.md, DECISIONS.md, REQUIREMENTS.md, TASKS.md, HANDOFF.md, TEST_EVIDENCE.md, CLAUDE.md
**Acceptance:** repo-grounded plan, explicit deviations, clear next task → met (see HANDOFF).

## T1 — Foundation and core database — DONE (2026-11-02)
- [x] `docker-compose.yml` (postgres:16, healthcheck `pg_isready` + schema present, named volume, port from `.env`, init hook) — verified on Parth's Mac: healthy + 135/135 tests (T1-11/12)
- [x] `.env.example`, `.gitignore`, `.nvmrc` (22)
- [x] `db/schema/00_roles.sql`, `01_schema.sql` — schema `payrail`, roles `payrail_owner` / `payrail_app`, `fn_now` (DEC-013, DEC-015)
- [x] `02_tables.sql` — 12 relations, keys and CHECKs incl. DEC-002/009/021 columns
- [x] `03_ledger.sql` — `created_xid` seal, deferred balance triggers on header + lines, append-only + TRUNCATE guards, `fn_post_entry` (DEC-006, DEC-022)
- [x] `04_helpers.sql` — `fn_round_half_up`, `fn_split_line`, `fn_refund_alloc`, `fn_inr`, `fn_normal_side`, `fn_account`, `fn_vendor_payable_account`
- [x] `05_guards.sql` — owner/customer roles, KYC, active product, snapshots, state machines, capture-amount check, immutable history; vendor payable trigger. `06_system_accounts.sql`
- [x] `30_views.sql` (`v_account_balances`, `v_order_line_allocation`, `v_order_summary`, `v_vendor_statement`), `31_indexes.sql`, `99_privileges.sql`
- [x] `db/build.sh` (non-destructive, single transaction), `db/reset_dev.sh` (`--yes` + name guard), `db/docker-init.sh`, `db/README.md`
- [x] Tests: `01_constraints`, `02_money`, `10_ledger`, `11_ledger_immutability`, `12_capture_example` + `run_sql_tests.sh` → 135 passed (TEST_EVIDENCE T1-07/08)
**Acceptance:** clean DB builds with documented commands ✔ (T1-01, T1-04, T1-06); constraint tests and deferred validation pass with real COMMIT, incl. zero-line, single-line and late insertion ✔ (T1-07); UPDATE/DELETE/TRUNCATE/INSERT on the ledger fail as a real `payrail_app` login ✔; hand-traceable capture + refund example balances ✔ (test 12). Compose verified on a team machine ✔ (T1-11, T1-12).

## T2 — Stored workflows and correctness — TODO
Files: `db/schema/20_wf_orders_payments.sql`, `21_wf_refunds.sql`, `22_wf_payouts.sql`, `23_wf_settlements.sql` (SECURITY DEFINER, granted in `99_privileges.sql`, DEC-022); `db/seed/seed.sql`; tests `20_*`+ and Node concurrency tests.
- [ ] `fn_place_order` (verified vendor, active product, qty aggregate ≤ 100, snapshots)
- [ ] `fn_initiate_payment`, `fn_capture_payment` / failure path (DEC-010, DEC-011)
- [ ] `fn_request_refund`, `fn_approve_refund`, `fn_reject_refund` (DEC-005, DEC-012)
- [ ] `fn_request_payout`, `fn_complete_payout` (paid / failed→reversal) (DEC-008)
- [ ] `fn_import_settlement_row` / `fn_reconcile(as_of)` (DEC-009); `fn_reverse_entry`
- [ ] Deterministic seed via these functions with fixed clock; ≥500 rows; scenarios: failed payments, abandoned orders, partial+full refunds, negative vendor balance, failed payout, settlement matched/in-transit/overdue/mismatch/unknown, pending/rejected KYC vendors
- [ ] Tests: workflows, invalid ops, idempotent retries, key conflicts, rounding fixtures, rollback-on-error, **concurrent** payouts/refunds/duplicate keys (separate connections)
**Acceptance:** as PI Task 2; record actual row counts and trial-balance totals.

## T3 — Backend and authentication — TODO
- [ ] Express app, `pg` pool, transaction helper using one checked-out client
- [ ] Login (bcrypt + JWT), role middleware, ownership checks; Zod validation; uniform error format
- [ ] Endpoints for W1–W4, products CRUD, reports; pagination/filters
- [ ] Mock gateway: authenticated local callback (shared HMAC secret), stable event ids, controllable success/failure/duplicate/amount-mismatch
- [ ] API integration tests against a test database
**Acceptance:** as PI Task 3 (unauthenticated, cross-customer/vendor, finance-only, invalid input; server never trusts client prices/rates/ownership/balance; no secrets committed).

## T4 — Customer UI — TODO
Catalogue search/filter, cart, multi-vendor checkout, simulated payment (success/fail/duplicate), order history/detail, per-line refund request; loading/empty/error states; idempotency key reuse on retry.
**Acceptance:** seeded customer completes a real multi-vendor purchase and refund request; DB/ledger changes verified; failed/duplicate callback and invalid refund demonstrable; no mock arrays.

## T5 — Vendor & finance UI — TODO
Vendor: products CRUD/archive/delete-draft, balance + running statement, payout request/history. Finance: refund queue, payout paid/failed, settlement CSV upload (bounded, row-level validation, duplicates), reconciliation categories. Sample CSVs.
**Acceptance:** as PI Task 5.

## T6 — Reports and DBMS evidence — TODO
R1 trial balance · R2 vendor statement (window running balance) · R3 monthly performance · R4 vendor refund risk · R5 reconciliation & aging · R6 vendor payable/payout summary. Fixtures, correct aggregation grain, filters, EXPLAIN (ANALYZE, BUFFERS) on seeded DB, feature matrix.
**Acceptance:** as PI Task 6.

## T7 — Integration and demo reliability — TODO
Clean-install rehearsal (fresh clone + fresh DB), full test run, browser smoke tests where feasible, fixed demo as-of date, safe reset/recovery commands, fix found issues.
**Acceptance:** as PI Task 7.

## T8 — Submission pack — TODO
README (actual contributions **confirmed by team**), final design PDF ≤ 5 pages + editable source, DEMO.md (10–12 min), VIVA.md, final requirements checklist.
**Acceptance:** as PI Task 8. Claude does not push/submit.
