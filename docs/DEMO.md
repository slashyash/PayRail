# PayRail — Lab demo script (7 minutes + 3–5 minutes viva)

Format from the course's final-submission guidelines: 7 minutes of live demonstration (stopped at 7:00), then questions. No slides — show the running application. All five members must be present.

Speakers are given by **project part** (see the README's contributions table): P1 data model & integrity · P2 ledger, money & setup · P3 checkout & payments · P4 refunds, payouts & concurrency · P5 settlement, reconciliation & reports.

## Before you are called (prepare 10 minutes earlier)

```bash
cd ~/"payrail-dbms project"
docker compose up -d db && docker compose ps        # healthy
scripts/demo-reset.sh --yes                         # known state; doctor must say "all checks passed"
cd backend && npm start                             # terminal 1
cd frontend && npm run dev                          # terminal 2
```
- Open **three separate browser windows** (the login is stored per browser profile): normal window → `customer1@payrail.demo`, private window → `vendor1@payrail.demo`, second browser (or another profile) → `finance@payrail.demo`. Password `PayRail@2026`, URL http://127.0.0.1:5173.
- Terminal 3 in the project folder for the psql / race commands below.
- Keep `docs/design/PayRail_Database_Design.pdf` open on page 2 (ER diagram) and page 3 (schema).
- After a reset the first new order is always **#370**, vendor1's balance is **₹8,230.04**, and the trial balance is **₹80,14,286.31** on both sides.

## Timeline

| Time | Who | Show | Say / expected result |
|---|---|---|---|
| 0:00–1:00 | P2 | Finance → Overview, then Ledger | **Problem:** a marketplace platform splits one customer payment between vendors, commission and GST, then refunds, pays out and reconciles with the gateway. **Approach:** every movement is a double-entry journal entry, the ledger is append-only, balances are derived. Ledger page: Σ debits = Σ credits = ₹80,14,286.31. |
| 1:00–2:30 | P1 | Design PDF page 2, then page 3 | 12 tables; weak entities ORDER_ITEM / LEDGER_LINE; ACCOUNT specialisation on `owner_type`; derived attributes are views; SETTLES is deliberately not a foreign key. Constraints: 12 PK, 16 FK, 19 UNIQUE, 48 CHECK, partial unique index “one capture per order”, 24 triggers. Normalization: snapshots on order_items do not depend on product_id alone → BCNF holds. |
| 2:30–3:30 | P3 | Customer window: Shop → vendor filter → add one product from two vendors → Cart → **Place order and pay** → **Continue to pay ₹…** → gateway page: choose `success@payrail` → **Pay** | Order #370, “paid”. Finance window → Ledger (latest entries) shows a new **capture** entry: Dr GATEWAY_CLEARING = order total; Cr two vendor payables + COMMISSION_REVENUE + GST_PAYABLE (balanced). Mention: price/commission are snapshots set by a trigger; the client never sends a price. |
| 3:30–4:15 | P4 | Customer: **View order and request refunds** → Request refund on line 1, amount larger than the line, tick “Demo: skip the browser check and let the database decide” → submit; then ₹50.00 “Lid was cracked” → submit. Finance: Refunds → Approve | **Integrity failure:** the database refuses: `refund_exceeds_refundable · SQLSTATE PRR01`, nothing stored. The ₹50 request only reserves (no posting). Approve → balanced refund entry with the exact commission/GST/vendor deltas; order becomes “partially refunded”. |
| 4:15–5:00 | P4 | Vendor window: Payouts → request ₹500.00. Finance: Payouts → **Mark failed** (confirm). Terminal: `node scripts/demo-race.mjs vendor1 5` | Payout entry Dr vendor payable / Cr BANK; failed → exactly one reversal, balance back. **Concurrency:** 5 simultaneous payout requests of 40 % of the balance → **2 accepted, 3 `insufficient_funds` (PRF01)**, final balance exact — the account row lock (`SELECT … FOR UPDATE`) serialises them. |
| 5:00–5:30 | P5 | Finance: Settlements → choose `samples/settlements/01_normal.csv` → Import; then Reconciliation (as-of 2026-10-31) | Per-row result (inserted / posted). Reconciliation shows all five categories; amount-mismatch and unknown-reference rows are stored but **never posted**. |
| 5:30–7:00 | P5 + P2 | Finance → Reports: R1, R2 (vendor 7), R3 chart, R4. Terminal: the psql line below | R1 GROUPING SETS total; R2 window running balance continuing from the opening balance (vendor 7 negative after a late refund); R3 `generate_series` months; R4 refund rate with explicit numerator/denominator. psql: an UPDATE on a posted ledger line is rejected even for the administrator (append-only trigger). |

psql line for 5:30–7:00 (copy into terminal 3 beforehand):
```bash
docker compose exec -T db psql -U postgres -d payrail -c "UPDATE payrail.ledger_lines SET amount_paise = 1 WHERE entry_id = 1 AND line_no = 1"
# → ERROR: UPDATE on payrail.ledger_lines is not allowed: the ledger is append-only (post a reversal instead)
```

## If asked during the viva (each takes < 30 s)

| Ask | Do |
|---|---|
| “Show the deferred balance check” | `docker compose exec -T -e VERBOSE=1 db bash /payrail/db/tests/run_sql_tests.sh 10_ledger.sql` → lists empty / single-line / unbalanced entries rejected at COMMIT (PRL01) and late append rejected (PRL03). Uses its own test database. |
| “Can the app role write the ledger?” | `docker compose exec -T db psql -U postgres -d payrail -c "SET ROLE payrail_app; DELETE FROM payrail.ledger_lines"` → `permission denied`. |
| “Show the query behind a screen” | `db/schema/32_reports.sql` (line numbers on the Demo Sheet); `psql -X -d payrail -f db/reports/run_reports.sql` via `docker compose exec -T db psql -U postgres -X -d payrail -f /payrail/db/reports/run_reports.sql`. |
| “Show an index being used” | `docs/evidence/T6_explain_seed.txt` — balance query: Bitmap Index Scan, 26 buffers, vs Seq Scan 2,765 buffers without the index. |
| “Delete a product” | Vendor → Products: delete a new draft (works); delete an ordered product → `referenced · SQLSTATE 23503` (foreign key keeps history). |
| “What happens on a duplicate gateway callback?” | Finance → Gateway simulator → pick an initiated attempt → **Success, delivered 3×** → three callbacks, one capture entry. |

## Reset and recovery

| Situation | Command |
|---|---|
| Before each rehearsal / after a messy run | `scripts/demo-reset.sh --yes` (≈2 s; backend keeps running; log in again) |
| Login fails or every page errors | `cd backend && npm run doctor` and follow the printed fix |
| “Could not reach the PayRail server” | start the backend: `cd backend && npm start` |
| Database container stopped | `docker compose up -d db` and wait for healthy |

Rehearse with a timer at least twice; the scripted version of steps 2:30–5:30 ran in the sandbox without console errors (TEST_EVIDENCE T7-08b).
