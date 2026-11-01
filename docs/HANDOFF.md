# PayRail — Handoff

_Last updated: 2026-11-02, end of session 2 (Task 1)._

## Current milestone
**T1 DONE** (acceptance evidenced in TEST_EVIDENCE T1-01…T1-12, including real Docker Compose on Parth's Mac). Next: **T2 — stored workflows, seed, database correctness.**

## Working state
- Mac folder `/Users/parth/payrail-dbms project` is a git clone of `slashyash/PayRail` (`main` @ `65c50bb`, same as GitHub at session start — no teammate changes to reconcile). Sessions 1–2 were committed by Parth as `e92486b` on branch **`task1-core-db`** and pushed to GitHub (2026-11-02); a pull request into `main` is the next step for the team. Later edits in the folder (like this note) are uncommitted until the next commit.
- Session 2 wrote these files into the folder (and kept the docs' Project copies in sync):
  - new: `docker-compose.yml`, `.env.example`, `.gitignore`, `.nvmrc`
  - new: `db/README.md`, `db/build.sh`, `db/reset_dev.sh`, `db/docker-init.sh`
  - new: `db/schema/00_roles.sql 01_schema.sql 02_tables.sql 03_ledger.sql 04_helpers.sql 05_guards.sql 06_system_accounts.sql 30_views.sql 31_indexes.sql 99_privileges.sql`
  - new: `db/tests/run_sql_tests.sh`, `db/tests/_lib/{assert,fixtures,try,expect_ok,expect_error}.sql`, `db/tests/01_constraints.sql 02_money.sql 10_ledger.sql 11_ledger_immutability.sql 12_capture_example.sql`
  - updated: `CLAUDE.md`, `docs/DECISIONS.md` (DEC-021…025), `docs/TASKS.md`, `docs/REQUIREMENTS.md`, `docs/TEST_EVIDENCE.md`, `docs/HANDOFF.md`
- Shell scripts need the executable bit (`chmod +x db/*.sh db/tests/*.sh`); it was set from Claude's shell after writing.

## Commands actually run (session 2)
| Command | Result |
|---|---|
| `git log`, `git ls-remote origin` (Mac folder) | local and remote `main` both `65c50bb` |
| `docker pull postgres:16` (sandbox) | Forbidden — Docker Hub blocked by sandbox egress |
| `db/build.sh payrail_dev` ×2, reset guards, `db/reset_dev.sh --yes payrail_dev` | as expected (T1-01…04) |
| `db/docker-init.sh` on a fresh socket/trust cluster | built (T1-06) |
| `db/tests/run_sql_tests.sh` (TCP/scram and socket/trust) | 135 passed, 0 failed, both modes (T1-07/08) |
| `docker compose config` | OK (T1-09) |

## What T1 demonstrates (viva notes)
- **Keys & constraints:** 12 PKs (two composite for weak entities), 16 FKs, 19 UNIQUE (incl. `UNIQUE NULLS NOT DISTINCT` account slots and partial unique index for one capture per order), 48 CHECKs. `db/tests/01_constraints.sql` triggers each one.
- **Triggers:** deferred constraint triggers (balance checked at COMMIT because lines arrive one by one), BEFORE triggers for append-only ledger, state machines, KYC/role rules and price snapshots; an AFTER trigger creates each vendor's payable account.
- **Transaction seal:** `journal_entries.created_xid = pg_current_xact_id()`; a line can only be added in the same transaction → nobody can append to a posted entry later, even with balanced lines.
- **Privileges:** the app login can read, run helpers and edit products only; every ledger write path returns `42501`. Owner is stopped by triggers (`PRL02/PRL03`). Superusers are trusted.
- **Exact money:** `rhu(a,b,d) = ⌊(2ab+d)/(2d)⌋`; capture split C/G/V sums to L by construction; cumulative refund allocation telescopes to the original split (random test: naive rounding drifted on 1961/5000 lines, cumulative on 0).
- **Worked example:** test 12 and TEST_EVIDENCE (₹2,734.53 order → five capture lines; ₹500 refund → four lines; trial balance ₹3,234.53 both sides).
- Run it: see `db/README.md` (Docker or local PostgreSQL).

## Known blockers / risks
- Compose verified on Parth's Mac (T1-11/12). His `.env` (generated passwords, git-ignored) exists only in his folder; other members create their own from `.env.example`.
- PROPOSED decisions (DEC-002, DEC-005…DEC-022) are being implemented as defaults; flag objections before T2 lands.
- Schedule: 13 days to the GL §7 date.

## How the next session should start
1. Read `CLAUDE.md`, `docs/HANDOFF.md`, `docs/TASKS.md`, `docs/DECISIONS.md` from the Mac folder; `git status` / `git log` there (via `device_bash`) to see what the team committed.
2. Stage `db/` and `docs/` into the sandbox, start a PG16 cluster (recipe in CLAUDE.md), run `db/tests/run_sql_tests.sh` to confirm the baseline (expect 135 passed).
3. Implement T2, write changed files back, update docs.

## Next concrete action
T2, in order: `db/schema/20_wf_orders_payments.sql` — `fn_place_order(customer, items jsonb/array, idempotency?)` (aggregate quantities ≤ 100, line numbers, snapshots via trigger), `fn_initiate_payment`, `fn_capture_payment` / `fn_fail_payment` (SECURITY DEFINER, DEC-010/011/012, posts via `fn_post_entry` as in test 12) + grants in `99_privileges.sql`; then refunds (`21`), payouts (`22`), settlements/reconciliation (`23`), seed, and Node concurrency tests with independent connections.
