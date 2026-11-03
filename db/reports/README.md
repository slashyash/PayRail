# PayRail named reports R1–R6 (Task 6)

The SQL lives in **`db/schema/32_reports.sql`** (built with the schema; EXECUTE granted to `payrail_app` in `99_privileges.sql`). This folder holds the psql runners:

| File | What it does |
|---|---|
| `run_reports.sql` | prints all six reports with rupee formatting — `psql -X -d payrail -v vendor=3 -v as_of=2026-10-31 -f db/reports/run_reports.sql` |
| `explain_reports.sql` | `EXPLAIN (ANALYZE, BUFFERS)` of every report on the seeded DB + an index experiment inside `BEGIN … ROLLBACK` — output kept in `docs/evidence/T6_explain_seed.txt` |

Docker: `docker compose exec -T db psql -U postgres -X -d payrail -f /payrail/db/reports/run_reports.sql` (same for `explain_reports.sql`).

Where they appear: finance UI **Reports** (`/finance/reports?r=R1…R6`), vendor UI **Reports** (own R4 + R6) and **Statement** (R2). API: `GET /api/finance/reports/{trial-balance,vendor-statement,monthly-performance,refund-risk,settlement-aging,vendor-payables}`, `GET /api/vendor/statement`, `GET /api/vendor/reports/{refund-risk,payables}` (see `backend/README.md`).

Tests: `db/tests/30_reports.sql` (24 checks on a hand-checkable fixture — every expected number is computed in the file header), `db/tests/31_reports_seed.sql` (7 checks: each report agrees with independent sums over the seeded base tables), `backend/test/api/reports.test.js` (7 API tests), `frontend/e2e/reports.spec.js` (2 browser tests).

## Rules all six follow

1. **Aggregate at the reported grain before joining.** Every source (ledger lines, payments, refunds, payouts) is summed in its own CTE at the grain of the report (account, vendor, month, order line) and only then joined. Joining raw rows first multiplies rows: in the fixture, vendor B's sales come out as ₹3,703.68 instead of ₹2,469.12 if `order_items ⋈ refunds` is summed directly, because one line has two refund requests (test `R4: join fan-out`).
2. **Money is BIGINT paise; rates are integer basis points** rounded half-up with `fn_round_half_up` (the same helper as the allocation code). The UI shows 448 bps as `4.48%` using string arithmetic.
3. **Dates are IST calendar dates** (`created_at AT TIME ZONE 'Asia/Kolkata'`). A capture at 00:30 IST on 1 Nov is a November sale even though it is still 31 Oct in UTC (tested).
4. **Read-only, SECURITY INVOKER, `LANGUAGE sql`, no `SET` clause** → PostgreSQL **inlines** the function into the calling query: `EXPLAIN` shows the real plan and a caller's `WHERE` can be pushed down. Without a pinned `search_path`, every object is schema-qualified (`payrail.ledger_lines`); built-in operators come from `pg_catalog`, which is always searched first.
5. **One source of truth.** The API's older endpoints now call the reports: `/api/finance/trial-balance` = R1, `/api/vendor/statement` = R2.

## R1 — Trial balance `fn_report_trial_balance(as_of date = NULL)`
- **Question:** does Σ debits = Σ credits, and what is every account's balance?
- **SQL:** CTE `per_account` sums lines per account (`FILTER (WHERE direction = 'D')`), `LEFT JOIN` from `accounts` so empty accounts appear, then `GROUP BY GROUPING SETS ((account columns), ())` — the empty grouping set produces the **total row** (`grouping(account_id) = 1`). The balance goes in the Dr or Cr column (`greatest(d − c, 0)`); `balanced` on the total row checks both Σ D = Σ C and Σ Dr balances = Σ Cr balances.
- **Filter:** `as_of` keeps entries posted on or before that IST date (joins `journal_entries` for the date).
- **Seed result:** Σ D = Σ C = ₹80,14,286.31; Σ Dr balances = Σ Cr balances = ₹3,47,206.10.
- **Note:** vendor 7's payable shows a **Dr** balance (₹16,039.42) — a negative vendor balance after a late refund (DEC-007).

## R2 — Vendor statement `fn_report_vendor_statement(vendor, from = NULL, to = NULL)`
- **Rows:** `opening` (balance before `from`), one `line` per ledger line on the vendor's payable account, `closing`.
- **SQL:** reads `v_vendor_statement`, whose running balance is `SUM(credit − debit) OVER (PARTITION BY vendor_id ORDER BY created_at, entry_id, line_no ROWS UNBOUNDED PRECEDING)` — a deterministic order (ties broken by `entry_id`, `line_no`). The vendor filter is on the partition column, so the planner pushes it **below** the window (only that vendor's 59 lines are read, via `ledger_lines_account_entry_idx`); the **date** filter is applied **after** the window, so the first line in the range already carries the history before it. A `UNION ALL` adds opening/closing; the closing row uses a scalar subquery on the `opening` CTE.
- **Invariant (tested for every seeded vendor):** closing = opening + Σ(credit − debit) in range = last running balance = `fn_vendor_balance`.
- **Reference column:** `LEFT JOIN`s to `payments`, `refunds`, and the reversed `journal_entries` give "order 12", "refund 5 (order 12)", "payout 3", "reversal of payout 3".

## R3 — Monthly performance `fn_report_monthly_performance(from = NULL, to = NULL)`
- **Month series:** `generate_series` over IST months (default: first to last month with an order), so empty months are rows of zeros, not missing.
- **Measures and their date basis:**

| Measure | Source | Date basis |
|---|---|---|
| payments captured, captured gross | `payments` (status captured) | `captured_at` |
| attempts final / failed, success rate | `payments` captured or failed (initiated excluded) | `created_at` |
| refunds processed, refunded | `refunds` (status processed) | `processed_at` |
| commission net, GST net, gateway fees | ledger lines on COMMISSION_REVENUE / GST_PAYABLE / GATEWAY_FEE_EXPENSE | `journal_entries.created_at` |
| platform net | commission net − fees (GST is a liability) | — |
| cumulative gross | `SUM(gross) OVER (ORDER BY month)` | — |

- `refund_rate_bps` = refunded in the month ÷ captured gross in the same month. A refund may belong to an older sale; R4 avoids that mismatch with a cohort.
- **Consistency (tested):** Σ over months of commission / GST / fees = their R1 balances; Σ captured gross = Σ captured payments.
- UI: a Recharts bar chart (captured vs refunded) + the full table. Bar heights use whole rupees (`chartRupees`, display only); every amount shown as text is exact.

## R4 — Vendor refund risk `fn_report_vendor_refund_risk(from = NULL, to = NULL, min_sales_paise = 100000)`
- **Cohort:** order lines whose order was **captured** in [from, to] (IST).
- **Numerator:** processed refunds of those lines (whenever processed). **Denominator:** Σ line totals (quantity × snapshot price) of those lines. `refund_rate_bps = rhu(numerator × 10 000 / denominator)`.
- Also: pending (requested) amount, request and rejection counts, lines with a refund.
- **Rank:** `rank() OVER (PARTITION BY ranked ORDER BY rate DESC)` among vendors with ≥ `min_sales_paise` of sales; smaller samples are `low_volume`. Bands: high ≥ 10 %, watch ≥ 5 %.
- **Grain:** refunds → per line (`line_refunds`), cohort → per line, then per vendor. Vendors without sales still appear (`LEFT JOIN` from `vendors`, band `no_sales`).
- Vendor UI sees only its own row and no rank.

## R5 — Settlement reconciliation and aging `fn_report_settlement_aging(as_of)`
- Builds on `fn_reconciliation_report(as_of)` (24_wf_settlements.sql) which does the **reference matching**: expected events (captured payments, processed refunds dated ≤ as_of) `LEFT JOIN` settlement rows on `gateway_ref`, `UNION ALL` settlement rows with no event (`NOT EXISTS`) = `unknown_reference`.
- **Age per category:** matched = settled − event (lag; T+2 is on time); in_transit = as_of − event; overdue_missing = days past event + 2; amount_mismatch / unknown_reference = as_of − settled (days open). Buckets `0-2 d`, `3-7 d`, `8-30 d`, `>30 d`.
- `GROUPING SETS ((category, bucket), (category), ())` → detail, per-category subtotal (listed first) and grand total.
- `net_cash_paise` = what the bank received for **posted** rows (payment gross − fee, refund −amount). Tested equal to the BANK lines of settlement entries. Mismatched and unknown rows contribute 0 — they are never posted.
- Seed, as of 2026-10-31: 377 items — 347 matched, 13 in transit, 7 overdue, 8 amount mismatch, 2 unknown.

## R6 — Vendor payables and payouts `fn_report_vendor_payables(vendor = NULL)`
- **Ledger CTE (per vendor):** signed amounts on the payable account split by `journal_entries.entry_type`: sales (capture) − refunds − payouts + reversals = balance. Signed sums, so a tiny refund whose vendor share is posted on the opposite side (DEC-005) is still right.
- **Payouts CTE (per vendor):** counts and amounts by status, last paid date.
- **Cross-relation check `ledger_consistent`:** ledger payout debits − reversal credits = Σ payouts in status requested or paid (failed ones are reversed). True for every seeded vendor.
- **Status:** negative / payouts_blocked_kyc / nothing_payable / payable.

## EXPLAIN findings (seeded DB, `docs/evidence/T6_explain_seed.txt`)
- **Scale:** the largest table, `ledger_lines`, has 2,742 rows in 23 pages. At this size the planner rightly uses sequential scans and hash joins for whole-ledger reports (R1, R3: one pass over 23 pages). We make no speed claims.
- **All five inlinable reports are inlined:** the plans show the real joins, not a `Function Scan`. R5's inner function has a pinned `search_path`, so it is not inlined; `auto_explain` (nested statements) prints its plan.
- **Filter push-down below the window (R2, R6):** `vendor_id = 3` reaches `accounts`, and only that vendor's 59 lines are read through a **Bitmap Index Scan on `ledger_lines_account_entry_idx`**; the date filter stays above the `WindowAgg`.
- **Index experiment** (index dropped inside `BEGIN … ROLLBACK`):
  - R2 for one vendor: 39 vs 37 shared buffers for the statement CTE — no gain at this size (the whole table is 23 pages).
  - The balance query inside `fn_vendor_balance` (`WHERE account_id = fn_vendor_payable_account(3)`), which every payout and refund workflow runs under its lock: **without** the index a sequential scan evaluates the STABLE lookup function for all 2,742 rows (Rows Removed by Filter 2,683, **2,765 shared buffers**); **with** it the function is evaluated once as the index key (**26 buffers**). This is the main justification for `ledger_lines_account_entry_idx`, and it grows with the ledger.
- `orders_customer_created_idx` is used for a customer's order history (Bitmap Index Scan). The small partial queue indexes and `payouts_vendor_idx` / `gateway_settlements_settled_on_idx` are not chosen at seed size (1–5 page tables); they are kept for FK checks and growth, without claimed benefits.

## Viva questions this covers
- Why does filtering before the window function give a wrong running balance? (R2; test `R2: date window`; mutation evidence in TEST_EVIDENCE T6-04.)
- What is join fan-out and how do the reports avoid it? (R4 test; rule 1.)
- What do `GROUPING SETS` / `grouping()` produce? (R1 total row; R5 subtotals.)
- Why is the refund rate in R3 different from R4? (period vs cohort denominators.)
- How do you know the reports are right? (hand-computed fixture `30_reports.sql`; cross-checks against base tables `31_reports_seed.sql`; R1/R3/R6 agree with each other.)
- What does `EXPLAIN (ANALYZE, BUFFERS)` show, and when is an index worth it? (findings above.)
