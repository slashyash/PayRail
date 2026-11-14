# PayRail — Handoff

_Last updated: 2026-11-13, session 9 (Task 7 closed; Task 8 documents written)._

## Current milestone
**T8 — submission pack: documents done (13 Nov), team items open.** T0–T7 DONE. The course's final-submission guidelines (received 13 Nov) supersede the earlier assumptions: Google Classroom by **15 Nov 2026 11:59 PM** (GitHub link + design PDF ≤ 5 pages + one-page Demo Sheet PDF; tag `final`, hash in README and Demo Sheet); demo **17–19 Nov, 7 min + 3–5 min viva**, all members present.

The team's decision (13 Nov): the project is split into five parts (README contributions table); **Name/ID per part, Team ID / lab section and members on the Demo Sheet are left blank for the team to fill.** A friend's separately modified version (zip in another chat) is not used.

## Working state
- Mac folder: `main` @ `2fb6739` (PR #8 = Task 7 merged; branch deleted). Session 9's T8 files were written there **uncommitted**: `README.md`, `docs/{DEMO,VIVA,TASKS,REQUIREMENTS,TEST_EVIDENCE,HANDOFF}.md`, `CLAUDE.md`, `docs/design/*`, `docs/submission/*`, `scripts/check-demo-sheet.sh`.
- No code or schema change in T8.

## What is left for the team (in order)
1. Fill the Name/ID columns in `README.md` (Individual contributions) with each member's actual work.
2. Open `docs/submission/PayRail_Demo_Sheet.docx`, fill Team ID / lab section and Members, then export it as PDF over `PayRail_Demo_Sheet.pdf` (keep one page).
3. Run `scripts/test-all.sh` and `scripts/check-demo-sheet.sh`; commit; then follow README “Submitting” (hash into README + Demo Sheet, README-only commit, `git tag final`, push the tag).
4. Upload to Google Classroom: repo link, `docs/design/PayRail_Database_Design.pdf`, the Demo Sheet PDF.
5. Rehearse `docs/DEMO.md` twice with a timer (7:00 hard stop).

## Commands actually run (session 9, T8)
| Command | Result |
|---|---|
| fresh clone `main` @ `2fb6739`; `db/reset_dev.sh --yes payrail`; catalog queries | counts in TEST_EVIDENCE T8-00 |
| `docs/design/build.sh` | 5-page PDF; pages viewed |
| column check design §5 vs `information_schema` | 82/82 |
| `fill_demo` (python-docx on the course template) → LibreOffice PDF | 1 page; viewed |
| `scripts/check-demo-sheet.sh` | 22/22 ok |
| DEMO.md psql commands in the sandbox | expected errors (T8-04) |

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
- PROPOSED decisions (DEC-002, DEC-005…DEC-022, DEC-035) are implemented and described in the design PDF; nobody objected.
- Schedule: submission 15 Nov 11:59 PM. Open items are the team's (names/IDs, Team ID, tag).
- The design PDF's team table lists the five submitted names and IDs (from the project instructions); only the per-part ownership is blank.

## How the next session should start
1. Read `CLAUDE.md`, this file, `docs/TASKS.md`, `docs/DECISIONS.md` from the Mac folder; `git status` / `git log` there (expect the T8 files committed or still uncommitted).
2. Sandbox: `git clone` + copy any uncommitted Mac files; PG16 recipe from CLAUDE.md; `scripts/test-all.sh`.
3. Finish whatever is open in “What is left for the team”.

## Next concrete action
Team: steps 1–5 above. Claude (if asked): re-export the Demo Sheet after the team fills it, re-run `scripts/check-demo-sheet.sh` if any schema file changes, help with the final tag. Claude does not push, tag or submit.
