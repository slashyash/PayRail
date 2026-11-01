# PayRail — Decisions and Deviations

Each entry records: **original design** (midsem PDFs), **decision**, **reason**, **migration impact**, **docs to update**.
Status: `ACCEPTED` (implement as written), `PROPOSED` (default we will implement unless the team objects), `SUPERSEDED`.
Source abbreviations: **DBD** = `Group13_PayRail_Database_Design.pdf`, **APD** = `Group13_PayRail_Application_Design.pdf`, **GL** = `DBMS_Project_Guidelines 1.pdf`, **PI** = claude.ai project instructions.

---

## DEC-001 — Implementation starts from scratch; PDF figures are void — ACCEPTED (Task 0)
- **Original:** DBD §10–11 present a catalog-generated schema diagram, `06_seed.sql`, `./db/run_all.sh`, row counts (~32,200) and a trial balance of INR 4,51,62,018.42.
- **Decision:** Treat all of these as nonexistent. The repo (`slashyash/PayRail`, `main` @ `65c50bb`) contains only `README.md`. The team confirmed (2026-11-01) that no code exists and the figures should be disregarded.
- **Impact:** Every number in the final design PDF and README must come from the implemented database (`docs/TEST_EVIDENCE.md`).
- **Docs:** final DBD §10–11 rewritten in Task 8.

## DEC-002 — Password storage on `users` — PROPOSED
- **Original:** DBD §6 `users(user_id, full_name, email, role, created_at)` — no credential.
- **Decision:** Add `password_hash TEXT NOT NULL` (bcrypt, cost 10, via `bcryptjs` in the backend; the DB never sees plaintext). No separate credentials table.
- **Reason:** Login is a W1–W4 prerequisite. One column keeps 12 relations; `user_id → password_hash` is a key dependency, so normalization is unaffected.
- **Impact:** Seeded demo users get a documented demo password hashed at seed time (hash generated in SQL with `pgcrypto crypt(..., gen_salt('bf',10))`, which is bcrypt-compatible with `bcryptjs`). No public sign-up for `vendor_admin`/`finance_admin`; self-registration (if built) creates `customer` only.
- **Docs:** DBD §6, README demo accounts.

## DEC-003 — Money representation, rounding and API encoding — ACCEPTED
- **Decision:**
  - All money is `BIGINT` paise, `> 0` unless stated. No `float`/`real`/`double precision`/JS `Number` arithmetic on money anywhere.
  - Rounding helper `fn_round_half_up(a BIGINT, b BIGINT, d BIGINT) = (2·a·b + d) div (2·d)` for non-negative operands (computed in `NUMERIC` intermediates to avoid BIGINT overflow, result cast back to BIGINT). Deterministic round-half-up. Verified on PG 16: 2.5→3, 3.5→4 (see TEST_EVIDENCE E-004).
  - API: paise values and BIGINT ids travel as **decimal strings** (`"125050"`), validated by Zod regex `^[0-9]{1,18}$`; converted with `BigInt` only where the backend must compute (it should rarely need to — the DB computes). `pg` returns `int8` as strings by default; we keep that (no `parseInt` type parser).
  - Display formatting (₹1,250.50) happens in the frontend from the string via `BigInt`, never `Number`.
- **Docs:** CLAUDE.md invariants, VIVA worked examples.

## DEC-004 — Capture allocation per order line — ACCEPTED
- **Original:** DBD D2 `fn_split` with round-half-up; GST 18% of commission (DBD §3).
- **Decision:** For each line: `L = quantity × unit_price_paise`; `C = rhu(L, commission_bps, 10000)`; `G = rhu(C, 18, 100)`; `V = L − C − G`. Since commission ≤ 50% and GST = 18% of commission, `V ≥ 0.41·L − 1 ≥ 0` always (checked in 200k random cases, E-005). GST is computed on the **rounded** commission (the invoiced commission).
- **Posting:** one `capture` entry per captured payment; lines aggregated per account (one credit per vendor payable, one commission credit, one GST credit). Order total = Σ L.

## DEC-005 — Cumulative refund allocation (no rounding drift) — PROPOSED
- **Problem:** Rounding each partial refund independently drifts: in a 200k-trial simulation, independent per-refund rounding failed to reproduce the original commission/GST split in >95% of multi-refund lines (E-005).
- **Decision:** For a line with original allocation `(L, C, G, V)` and cumulative processed refund amount `R_k` after the k-th approval (approvals serialized by the line lock):
  `C_k = rhu(C, R_k, L)`, `G_k = rhu(G, R_k, L)`, `V_k = R_k − C_k − G_k`.
  The k-th refund entry posts the **deltas** `ΔC = C_k − C_{k−1}`, `ΔG`, `ΔV`. When `R_k = L` the totals equal `(C, G, V)` exactly, by construction.
- **Edge case:** `ΔC, ΔG ≥ 0` always (rounding is monotone), but `ΔV` can be −1/−2 paise for very small refunds (18,730 occurrences in the 200k-line simulation when 1–7 paise refunds were allowed; never on a line's final refund). Two rules:
  1. **Minimum refund amount ₹1 (100 paise)** unless the request is for the line's entire remaining refundable amount. With that rule, 200k trials produced zero negative deltas (E-005) — empirical, not a proof.
  2. The posting function still handles a negative delta defensively by posting that account on the opposite side (entry stays balanced, cumulative totals stay exact) rather than failing.
- **Reservation:** refundable remaining = `L − Σ(requested + processed refunds on the line)`. Rejected requests release their amount. Checked under `SELECT … FOR UPDATE` on the `order_items` row.
- **Docs:** VIVA worked example (3 partial refunds then final), DBD assumptions.

## DEC-006 — Ledger finalization ("sealing") and immutability — PROPOSED
- **Original:** DBD BR1/BR2/T2/T3: deferred balance trigger; BEFORE UPDATE/DELETE/TRUNCATE triggers. It does not say how to stop a *later* transaction from inserting extra (balanced) lines into an already-committed entry.
- **Decision (defence in depth):**
  1. **Transaction seal:** `journal_entries.created_xid xid8 NOT NULL`, forced by a BEFORE INSERT trigger to `pg_current_xact_id()`. A BEFORE INSERT trigger on `ledger_lines` rejects any line whose header's `created_xid ≠ pg_current_xact_id()`. An entry is therefore "posted" exactly when its creating transaction commits; afterwards nothing can be appended. Verified on PG 16 that `pg_current_xact_id()` returns the top-level xid inside PL/pgSQL exception blocks (subtransactions) and differs in later transactions (E-002).
  2. **Deferred validation:** `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on **both** `journal_entries` (AFTER INSERT) and `ledger_lines` (AFTER INSERT): at COMMIT each touched entry must have ≥ 2 lines and Σdebits = Σcredits. The header trigger is what rejects an empty header (verified, E-003).
  3. **Append-only:** BEFORE UPDATE/DELETE row triggers and BEFORE TRUNCATE statement triggers on both ledger tables raise exceptions.
  4. **Privileges:** the app role has `SELECT` only on ledger tables; all postings go through `SECURITY DEFINER` functions owned by `payrail_owner` with `SET search_path = payrail, pg_temp` and `EXECUTE` revoked from `PUBLIC`.
- **Reason:** (1) closes the late-append gap without an UPDATE-able status column on an immutable table.
- **Impact:** one extra metadata column on `journal_entries` (not a business attribute; noted in normalization review). Owner/superuser remain trusted (PI rule 3).

## DEC-007 — Chart of accounts and posting matrix — PROPOSED
System accounts (one each, created by bootstrap) plus one payable per vendor (created by trigger on vendor insert):

| code | owner_type | class | normal side |
|---|---|---|---|
| `GATEWAY_CLEARING` | gateway | asset | D |
| `BANK` | bank | asset | D |
| `COMMISSION_REVENUE` | platform | revenue | C |
| `GATEWAY_FEE_EXPENSE` | platform | expense | D |
| `GST_PAYABLE` | tax | liability | C |
| `VENDOR_PAYABLE_<vendor_id>` | vendor | liability | C |

| Event (entry_type) | Debit | Credit |
|---|---|---|
| Payment captured (`capture`) | GATEWAY_CLEARING Σ L | each VENDOR_PAYABLE Σ V; COMMISSION_REVENUE Σ C; GST_PAYABLE Σ G |
| Refund processed (`refund`) | VENDOR_PAYABLE ΔV; COMMISSION_REVENUE ΔC; GST_PAYABLE ΔG | GATEWAY_CLEARING r |
| Payout accepted (`payout`) | VENDOR_PAYABLE amount | BANK amount (see DEC-008) |
| Payout failed (`reversal` of the payout entry) | BANK amount | VENDOR_PAYABLE amount |
| Payment settlement row matched (`settlement`) | BANK gross − fee; GATEWAY_FEE_EXPENSE fee | GATEWAY_CLEARING gross |
| Refund settlement row matched (`settlement`) | GATEWAY_CLEARING amount | BANK amount |

- Vendor available balance = credit-normal balance of its payable account (may be negative after a late refund; payouts require `amount ≤ balance`).
- `fee` is omitted as a line when 0 (ledger amounts are `> 0`).
- Trial balance (Report 1) sums these; Σ debit = Σ credit globally and per entry.

## DEC-008 — Payout posts directly to BANK at request time — PROPOSED
- **Original:** DBD §3 "A payout debits the vendor when requested; if the bank transfer fails the entry is reversed." PI rule 9: "credit the chosen bank/clearing account".
- **Decision:** Credit `BANK` when the payout is accepted; marking it `paid` only sets `bank_utr`/`completed_at` (no second posting); `failed` creates exactly one `reversal` entry (`UNIQUE(reverses_entry_id)`).
- **Reason:** keeps `UNIQUE(payout_id)` on journal_entries (one entry per payout) and the matrix small. **Disclosed simplification:** BANK reflects committed outgoing transfers, so it can briefly differ from the real bank statement while a payout is `requested`. Alternative considered: a `PAYOUTS_IN_TRANSIT` liability with a second entry on `paid` — rejected as extra entry type for little demo value.

## DEC-009 — Settlement / refund modelling and reconciliation rules — PROPOSED
- **Gap:** DBD §3 says the gateway deducts refunds from future settlements, but `gateway_settlements` (DBD §6) has one row per *payment* reference with gross and fee only, so refund deductions cannot be represented and GATEWAY_CLEARING could never reach zero.
- **Decision (small schema adjustment):**
  - `refunds.gateway_ref TEXT NULL UNIQUE` — the simulated gateway refund id (`rfnd_…`), set when the refund is processed. CHECK: `(status='processed') = (gateway_ref IS NOT NULL)`.
  - `gateway_settlements.record_type ∈ {payment, refund}`; CHECK `record_type='refund' → fee_paise = 0`. `gateway_ref` stays globally UNIQUE (prefixes `pay_`/`rfnd_` differ). Still **no FK** (DBD D9) so unknown references can be stored.
  - The settlement CSV lists payment rows (gross, fee) and refund rows (amount) per `settled_on`; the bank credit for a day = Σ(gross − fee) − Σ refunds. We do **not** model a separate payout-batch entity; daily net is a derived report value.
- **Reconciliation definitions** (all dates in `Asia/Kolkata`; `as_of` is an explicit DATE parameter):
  - expected settlement date `= (captured_at or processed_at AT TIME ZONE 'Asia/Kolkata')::date + 2` (T+2 calendar days, no holiday calendar — disclosed).
  - Settlement rows with `settled_on > as_of` are ignored for that run.
  - **matched**: row's ref + record_type match a captured payment / processed refund and amounts equal → posted once (`journal_entries.settlement_id UNIQUE`).
  - **amount_mismatch**: ref known but gross (or fee validity, or record_type) differs → stored, **not posted**.
  - **unknown_reference**: no payment/refund with that ref → stored, not posted, no fabricated payment.
  - **in_transit**: captured/processed with no settlement row and `as_of ≤ expected`.
  - **overdue_missing**: no settlement row and `as_of > expected`.
- **Duplicate imports:** a row whose `gateway_ref` already exists with identical values → reported `duplicate`, skipped (idempotent re-upload). Same ref with different values → reported `conflict`, rejected; original kept.
- **Revisit:** `fn_reconcile(as_of)` re-examines unposted settlement rows and posts any that now match exactly (e.g., an unknown ref whose payment callback arrived late). Mismatches stay for investigation (no manual-override workflow — out of scope).
- **Docs:** DBD §6 schema, sample CSVs, Report 5.

## DEC-010 — State machines — PROPOSED
- **payments:** `initiated → captured | failed`; both terminal. Retried callback with the same final outcome returns the existing result; a callback asking for the *other* outcome after a final state is rejected. At most one `captured` per order (partial unique index + order row lock). Capture requires callback amount = derived order total; a mismatch is rejected with no state or ledger change (payment stays `initiated`; the mock gateway can then send a failure).
- **refunds:** `requested → processed | rejected`; terminal; amount, line and key immutable. Only lines of orders with a captured payment.
- **payouts:** `requested → paid | failed`; terminal; `failed` triggers exactly one reversal in the same transaction.
- Enforced by BEFORE UPDATE triggers (DBD T6) plus the stored functions.

## DEC-011 — Idempotency — PROPOSED
- **Scope:** keys are client-generated UUIDs; `UNIQUE(idempotency_key)` per table (payments, refunds, payouts) — global per operation type. Callback retries use the gateway's event identity: `(payment_id, gateway_ref)` + outcome.
- **Semantics:** same key + same logical payload (compared column-by-column: actor, target, amount, etc.) → return the original row; same key + different payload → error `idempotency_conflict`.
- **Concurrency:** functions use `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING`; on no row returned they read the existing committed row (ON CONFLICT waits for the in-flight duplicate to commit/roll back). A failed operation rolls back its insert, so the key is free for a retry (no poisoning).
- **Frontend:** reuse the key when retrying the same action; new key per new logical action.

## DEC-012 — Locking protocol — PROPOSED
All operations that change a vendor's available funds lock in this global order, at READ COMMITTED:
1. the domain row(s) being transitioned, by primary key ascending (`orders` for capture; `order_items` for refund request/approval; `payouts` for complete/fail);
2. affected `accounts` rows (vendor payables) with `SELECT … FOR UPDATE ORDER BY account_id`;
3. then read derived balances and insert ledger rows.
Payout request: lock vendor payable account → compute balance from `ledger_lines` → reject if `amount > balance` → insert payout + entry. Capture also locks the order's vendor accounts (ascending) for consistency. System accounts (BANK, CLEARING, …) are **not** locked — they have no spend limit — to avoid a global hotspot. Concurrency tests use separate connections (Node `pg` clients) with a barrier, not sequential calls.

## DEC-013 — Database roles — PROPOSED
- `payrail_owner` (NOLOGIN or migration login): owns schema `payrail`, all tables, functions.
- `payrail_app` (LOGIN, used by the backend): `USAGE` on schema; `SELECT` on tables/views it needs; `INSERT/UPDATE/DELETE` only on non-financial `products` (and `users` insert for customer self-registration if built); `EXECUTE` on the workflow functions; **no** direct write privileges on orders/payments/refunds/payouts/settlements/ledger tables. Never superuser, never owner.
- Tests assert that `payrail_app` gets `permission denied` / trigger errors for ledger UPDATE/DELETE/TRUNCATE/INSERT.

## DEC-014 — CRUD via products; financial history retained — PROPOSED
- Products: create, update name/price, archive (`is_active=false`), reactivate. **Hard delete** allowed only if no `order_items` reference it — enforced by the FK (`ON DELETE NO ACTION`); the API maps the FK violation to a clear 409. Price edits never touch historical lines (snapshots).
- Financial tables are never deleted/updated except the allowed status transitions.

## DEC-015 — Deterministic clock for seed and demo — PROPOSED
- `fn_now()` returns `current_setting('payrail.clock', true)::timestamptz` when set **and** `session_user` is the owner/seed role; otherwise `now()`. All workflow functions use `fn_now()`. The seed script sets the clock forward step by step, so seeded timestamps and reconciliation categories are reproducible; the backend role cannot backdate.
- Reconciliation and aging reports take an explicit `as_of` date (demo default documented in DEMO.md).

## DEC-016 — Derived order status — PROPOSED
`v_order_summary`: total = Σ line totals; status ∈ `pending_payment` (no capture), `paid`, `partially_refunded`, `refunded` (processed refunds = total). "Abandoned" is a report label (pending_payment older than 24 h at `as_of`), not stored.

## DEC-017 — Ownership rule for vendors — PROPOSED
`vendors.owner_user_id` must reference a user with role `vendor_admin` (trigger; a CHECK cannot see another table). Orders' `customer_id` must reference a `customer`. Finance actions require `finance_admin` (backend middleware + function argument checks where the actor is passed).

## DEC-018 — Bootstrap without a migration framework — PROPOSED
Ordered plain SQL files under `db/schema/` applied by `db/build.sh` to an **empty** database; `db/reset_dev.sh` (drop + rebuild + seed) is separate and refuses to run without `--yes` and a non-production database name. Rationale: no deployed data to migrate; plain SQL is easiest to inspect in the viva.

## DEC-019 — Test tooling — PROPOSED
- SQL tests: `db/tests/*.sql` run with `psql -v ON_ERROR_STOP=1`; assertions via `DO $$ … ASSERT …` and expected-error blocks; one script per invariant group.
- Concurrency + API tests: Node 22 built-in `node:test` with `pg` (independent clients) and `supertest`.
- Browser smoke tests (Task 7, if time): Playwright.
- No pgTAP dependency (keeps setup simple).

## DEC-020 — Docker vs local PostgreSQL — PROPOSED
Docker Compose (`postgres:16` with healthcheck) is the documented setup. The cloud dev sandbox has no running Docker daemon, so Claude sessions build/test against a local PostgreSQL 16.15 cluster; compose itself must be verified on a team machine (tracked in TEST_EVIDENCE as "not run" until then).

---
_Task 1 (2026-11-02): DEC-003, DEC-004, DEC-006, DEC-007 (system accounts), DEC-013, DEC-014 (DB side), DEC-015, DEC-017 and the trigger half of DEC-010 are now implemented and tested (TEST_EVIDENCE T1-07). Their status is unchanged until the team confirms; the entries below record refinements made while implementing._

## DEC-021 — Schema details added during implementation — PROPOSED
- **Original:** DBD §6/§7 column lists and constraint list.
- **Decision (all small, none changes an entity or relationship):**
  - Columns: `users.password_hash` (DEC-002), `refunds.gateway_ref` and `gateway_settlements.record_type` (DEC-009), `gateway_settlements.imported_at` (audit of when a report row arrived), `journal_entries.created_xid` (DEC-006).
  - Extra CHECKs: e-mail stored lower-case; `password_hash` must look like a bcrypt hash (plaintext cannot be stored); product price ₹0.01–₹1 crore (keeps 100 × price far inside BIGINT); `gateway_ref` formats `pay_…` / `rfnd_…`; `bank_utr` 12–22 upper-case alphanumerics; allowed `(owner_type, account_class)` pairs of the chart of accounts.
  - Extra triggers: a user's role cannot change; a vendor's owner cannot change; orders and order lines are immutable (lines frozen once a payment attempt exists, `PRO01`); order-line price/commission snapshots are filled from the catalogue or rejected if they differ (`PRV05`); payments/refunds/payouts must be inserted in their initial state and can never be deleted; a payment can become `captured` only if its amount equals the derived order total (`PRP01`, DB-level backstop for DEC-010); accounts and imported settlement rows are immutable.
- **Reason:** each closes a path by which history or money could be changed outside the workflows, or keeps the client from choosing prices.
- **Impact:** DBD §6–7 tables gain these columns/constraints in the final PDF (T8). Recount from the catalog: CHECK 48, FK 16, PK 12, UNIQUE 19 (T1-05) — not the midsem 34/16/18.

## DEC-022 — `fn_post_entry` is an internal helper, not an app entry point — PROPOSED (refines DEC-006 item 4)
- **Original:** DEC-006 said postings go through SECURITY DEFINER functions.
- **Decision:** `fn_post_entry` is SECURITY INVOKER and **not** executable by `payrail_app` (or PUBLIC). Only the Task 2 workflow functions (SECURITY DEFINER, owned by `payrail_owner`, `SET search_path = payrail, pg_temp`) call it. `ALTER DEFAULT PRIVILEGES FOR ROLE payrail_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` ensures new functions are private until `99_privileges.sql` grants them.
- **Reason:** if the app could call a generic posting function it could post arbitrary balanced entries; the guarantee must be "the app can only run business workflows".
- **Impact:** T2 functions must be SECURITY DEFINER and granted explicitly in `99_privileges.sql`. Test 11 asserts `42501` for the app.

## DEC-023 — PayRail SQLSTATE codes — ACCEPTED
- **Decision:** custom codes `PRL01–04` (ledger), `PRV01–06` (validation), `PRO01` (order frozen), `PRS01` (transition), `PRP01` (capture amount); list in `db/README.md`. Tests assert codes, not message text; the backend (T3) maps codes to HTTP statuses.

## DEC-024 — SQL file numbering — ACCEPTED (refines AUDIT §6)
- `00_roles` · `01_schema` · `02_tables` · `03_ledger` · `04_helpers` · `05_guards` · `06_system_accounts` · `20–29` workflow functions (T2) · `30_views` · `31_indexes` · `99_privileges`. `build.sh` applies `01…99` in one transaction after `00_roles`.

## DEC-025 — Build, reset and test mechanics — ACCEPTED (refines DEC-018, DEC-019, DEC-020)
- `db/build.sh [db]` creates the database if missing, refuses if schema `payrail` exists, applies all files in **one transaction**. `db/reset_dev.sh --yes [db]` only accepts `payrail` / `payrail_<suffix>` and never `*prod*`.
- Docker Compose builds the schema through `/docker-entrypoint-initdb.d` **only when the volume is empty**; the healthcheck waits for the `payrail` schema. Normal `docker compose up` never drops anything.
- SQL tests: `db/tests/run_sql_tests.sh` rebuilds `payrail_test` before each file; checks are psql scripts that print `PASS`/`FAIL` using the psql variables `ERROR` / `LAST_ERROR_SQLSTATE`, so deferred-trigger checks see a **real COMMIT**. Test 11 opens a genuine second connection as `payrail_app`.
- `payrail_app` gets `CONNECT` only on the database (no `TEMPORARY`), `USAGE` on the schema, `SELECT` on tables/views, column-limited `INSERT`/`UPDATE` and `DELETE` on `products`, and `EXECUTE` on pure helpers.

---
_Task 2 (2026-11-02): the workflow halves of DEC-005, DEC-008, DEC-009, DEC-010, DEC-011, DEC-012 are implemented and tested (TEST_EVIDENCE T2-xx). Status of those entries is unchanged until the team confirms; refinements made while implementing are below._

## DEC-026 — Deferred balance triggers run as the owner — ACCEPTED (bug fix to T1 `03_ledger.sql`)
- **Problem found in Task 2:** a deferred constraint trigger fires at COMMIT, *after* the SECURITY DEFINER workflow function has returned, so it runs with the privileges of the committing login. When `payrail_app` committed a capture, the trigger's call to `fn_assert_entry_balanced` failed with `42501` and the whole capture rolled back. T1 tests never committed a posting as the app, so this was latent.
- **Decision:** `trg_journal_entries_balanced` and `trg_ledger_lines_balanced` are SECURITY DEFINER with the pinned `search_path` (they only read and raise). `fn_assert_entry_balanced` stays ungranted.
- **Impact:** no schema change; test `24_app_role.sql` now runs W1–W4 end to end as a real `payrail_app` login.

## DEC-027 — Workflow function interface — ACCEPTED (refines DBD §10 function list)
- **Original:** DBD §10 names `fn_place_order, fn_capture_payment, fn_request_refund, fn_approve_refund, fn_request_payout, fn_complete_payout, fn_record_settlement, fn_reverse_entry`.
- **Decision:** all eight names kept. Added: `fn_initiate_payment`, `fn_fail_payment`, `fn_reject_refund`, `fn_reconcile`, `fn_reconciliation_report` (read-only). Signatures in `db/README.md`.
  - The **actor** (customer / vendor_admin / finance_admin user id) is an explicit argument and is re-checked in the database (`PRA01`); the backend (T3) passes the id from the verified JWT, never from the request body. Gateway callbacks (`fn_capture_payment`, `fn_fail_payment`) have no user actor; T3 authenticates them with the shared HMAC secret.
  - `fn_reverse_entry` exists but is **internal** (not granted): only `fn_complete_payout` uses it, so the app cannot reverse arbitrary entries.
  - `fn_place_order` takes `[{product_id, quantity}]` JSON; extra keys such as a client price are ignored (snapshot trigger fills catalogue values). Order placement moves no money and has **no idempotency key**; a duplicate leaves an unpaid order (shown as `pending_payment`). The payment attempt is the idempotent step.
  - `fn_capture_payment` rechecks the amount against both the attempt and the derived order total (`PRP01`) and rejects capturing a second attempt of a paid order (`PRS02`, the losing attempt can then be failed).
  - Refund approval assigns a deterministic simulated gateway refund id `rfnd_R<9-digit refund_id>`.
  - `fn_record_settlement` returns `inserted | duplicate | conflict` instead of raising for duplicates/conflicts, so a CSV import (T5) can report per row without aborting; format errors still raise (`23514`). A settlement date after today (IST) is rejected (`PRV07`). Matching rows are posted at import; `fn_reconcile` revisits the rest.
- **Reason:** keeps the submitted names; makes every rule enforceable in SQL independently of the backend.

## DEC-028 — Workflows require READ COMMITTED (`PRX01`) — ACCEPTED (refines DEC-012)
- **Problem:** the lock protocol relies on each statement after a row lock taking a fresh snapshot. Under REPEATABLE READ the snapshot is fixed at the first statement, so a payout could read a stale balance after waiting for the lock (locking an unmodified row raises no serialization error).
- **Decision:** every funds-changing workflow calls `fn_require_read_committed()` and raises `PRX01` otherwise. The backend uses the default isolation level.
- **Evidence:** a mutation run with the payout lock removed made all 8 concurrent payouts succeed (overspend); with the lock exactly 3 of 8 succeed (TEST_EVIDENCE T2-10).

## DEC-029 — Reconciliation details — ACCEPTED (refines DEC-009)
- A settlement row whose reference is known but whose **record type** differs (a payment reported as a refund row) is categorised `amount_mismatch` with detail `reported as refund, recorded as payment` — "known reference, reported data differs". Not posted.
- A row whose reference belongs to a payment that is **not captured** (failed / initiated) is `unknown_reference` with that detail: there is no settleable event for it. Not posted.
- `in_transit` while `as_of ≤ event date + 2`; `overdue_missing` from the day after; `days_overdue = as_of − expected date`.
- Every captured payment / processed refund dated ≤ `as_of` appears exactly once in the report, and every settlement row settled ≤ `as_of` appears exactly once (test 23).

## DEC-030 — Deterministic seed — ACCEPTED (implements DEC-015)
- `db/seed/seed.sql` simulates 1 Sep – 31 Oct 2026 day by day (one COMMIT per simulated day), calling only the workflow functions for anything financial; master data (users, vendors, products) is inserted directly.
- No `random()`: choices come from `md5(event key)`; all timestamps come from `payrail.clock`. Test 29 rebuilds a second database and checks an identical fingerprint of ledger, payments, refunds, payouts, settlements and order lines (bcrypt salts are the only random part).
- Demo password `PayRail@2026` for every seeded login (bcrypt cost 10). Demo reconciliation date `2026-10-31`.
- Note for statements/reports: `created_at` defaults to `fn_now()` = `now()` = **transaction start time** for the app. Two concurrent transactions can therefore commit in a different order than their timestamps; `entry_id` order reflects lock (serialization) order. Concurrency checks use `entry_id` order.

## DEC-031 — Workflow SQL file numbering — ACCEPTED (refines DEC-024)
`20_wf_common.sql` (internal helpers) · `21_wf_orders_payments.sql` · `22_wf_refunds.sql` · `23_wf_payouts.sql` · `24_wf_settlements.sql`. Each workflow function is granted explicitly in `99_privileges.sql`; internal helpers are not.

## DEC-032 — Concurrency tests live in `backend/` — ACCEPTED (refines DEC-019)
`backend/package.json` (+ lockfile, `pg` 8.13.1) is created now with only the concurrency tests (`npm run test:concurrency`); Task 3 adds the API to the same package. Workers are independent `payrail_app` connections released together by an advisory-lock barrier and hold their transaction open briefly, so overlaps are real; the harness records how many workers were observed waiting on a row lock.
