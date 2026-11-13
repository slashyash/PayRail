# PayRail — Handoff

_Last updated: 2026-11-13, session 9 (Task 7, closed after the team-Mac run)._

## Current milestone
**T7 DONE** (TEST_EVIDENCE T7-01…T7-10). On Parth's Mac with Docker, after three fixes found there (doctor false alarm on placeholder DB passwords, e2e sample path with a space in the folder name, admin password drift in the volume): SQL 304 · API 46 · concurrency 12 · unit 5 · build · e2e 11. Next: **T8 — submission pack** (README with contributions **confirmed by the team**, design PDF ≤ 5 pages + source, `docs/DEMO.md`, `docs/VIVA.md`, final checklist). GL §7 submission date: 15 Nov; demos 17–19 Nov.

The team's decision (13 Nov): a friend's separately modified version (shared as a zip in another chat) is **not** used. This line continues from `main` @ `b095d4f`, which includes the 3 Nov operations UI (PR #7) — kept.

## Working state
- Mac folder `/Users/parth/payrail-dbms project`: `main` @ `b095d4f`, clean before this session except the untracked `AGENTS.md` (not Claude's; left alone). Session 9 wrote its files there **uncommitted** (Claude does not commit).
- Files written by session 9:
  - new: `scripts/demo-reset.sh`, `scripts/test-all.sh`, `scripts/demo-race.mjs`, `backend/src/doctor.js`, `backend/test/api/operations.test.js`, `docs/RUNBOOK.md`
  - changed: `db/schema/20_wf_common.sql` (`fn_vendor_balance` lookup as a scalar subquery), `backend/src/server.js` (startup DB check), `backend/package.json` (`doctor` script), `backend/README.md` (Troubleshooting → doctor), `frontend/src/pages/{Orders,Refunds,Catalogue}.jsx`, `frontend/src/pages/finance/Reconciliation.jsx`, `frontend/src/pages/vendor/Statement.jsx` (functional URL-filter updates)
  - docs: `CLAUDE.md`, `docs/{TASKS,REQUIREMENTS,TEST_EVIDENCE,HANDOFF}.md` (Project copies kept in sync)
- Schema change: one function body (`fn_vendor_balance`); no table change. An existing Docker volume keeps the old body (still correct thanks to the index); `scripts/demo-reset.sh --yes` installs the new one.
- Suggested commit: branch `task7-integration`, `git add -A scripts backend db frontend docs CLAUDE.md` (not `AGENTS.md`), push, PR.

## Commands actually run (session 9, cloud sandbox, PG 16.15, node 22.23.4)
| Command | Result |
|---|---|
| `git clone` (= Mac `b095d4f`), baseline all suites | 304 · 40/40 · 12/12 · unit pass · build · e2e 11 |
| `node --test test/api/operations.test.js` (+2 mutations, reverted) | 6/6; both mutations caught |
| EXPLAIN with the balance index dropped (rolled back) | `InitPlan 1`, one lookup |
| `npm run doctor` in 4 failure modes | each FAIL with the right fix |
| fresh cluster + fresh clone: `.env.example` → doctor → `demo-reset.sh --yes` → doctor | placeholders caught; build+seed 1 s; all ok |
| `scripts/test-all.sh` (fresh clone and working copy) | 304 · 46/46 · 12/12 · 5/5 · build · e2e 11; demo DB untouched |
| two resets, fingerprint compare | identical |
| Playwright 22-page walk; timed W1–W4 dry run; `demo-race.mjs vendor1 5`; reset under a running backend | no console errors/5xx (except the intentional 409); 2 of 5 payouts accepted, exact balance; logins 200 after reset |

## Mac-specific notes (found in T7-09)
- The Mac `.env` still uses the example's placeholder DB passwords; they work (doctor warns). Do **not** change them in `.env` alone — the database keeps its stored passwords (ALTER ROLE needed).
- The admin (`postgres`) password was re-synced to `.env` with `ALTER ROLE` (non-destructive); the Node test suites need it.
- Chromium for Playwright is installed on the Mac now.
- Session-9 files (incl. `scripts/`, `backend/src/doctor.js`, `test-logs/` in `.gitignore`, `frontend/e2e/vendor-finance.spec.js`) are uncommitted in the Mac folder.

## What T7 demonstrates (viva notes)
- Reproducibility: deterministic seed (fixed clock `fn_now`, md5-keyed choices) → identical ledger after every reset; explicit as-of date for reconciliation.
- Operational safety: destructive commands need `--yes` and only accept `payrail`/`payrail_<suffix>`; tests never touch the demo DB; the app never runs as owner/superuser (the doctor checks it).
- Concurrency, live: `demo-race.mjs` — simultaneous payouts serialise on the vendor account row lock (`FOR UPDATE`), at most the affordable ones succeed.
- Query planning: a scalar subquery becomes an InitPlan evaluated once, instead of a per-row function call on a sequential scan.

## Known blockers / risks
- `explain_reports.sql` and a live human demo walk have only run in the sandbox.
- Node on the Mac was v26 at T3; `.nvmrc` says 22. Works so far; the doctor warns.
- PROPOSED decisions (DEC-002, DEC-005…DEC-022, DEC-035) implemented as defaults; flag objections before the PDF.
- Schedule: 2 days to 15 Nov. T8 needs the team for contributions.

## How the next session should start
1. Read `CLAUDE.md`, this file, `docs/TASKS.md`, `docs/DECISIONS.md` from the Mac folder; `git status` / `git log` there (expect the T7 files committed or still uncommitted).
2. Sandbox: `git clone` + copy any uncommitted Mac files; PG16 recipe from CLAUDE.md; `scripts/test-all.sh`.
3. T8.

## Next concrete action
T8: (1) ask the team for actual contributions per member; (2) rewrite `README.md` (still the midsem version) from the implemented system + `docs/RUNBOOK.md`; (3) updated design PDF ≤ 5 pages from the implemented schema (ER, relational schema, keys/constraints, normalization against real FDs, design decisions) with editable source; (4) `docs/DEMO.md` (10–12 min, based on the T7-08b dry run: order #370, over-refund PRR01, refund approve, payout failed → reversal, settlement import + reconciliation, reports, `demo-race.mjs`) and `docs/VIVA.md`; (5) final requirements checklist.
