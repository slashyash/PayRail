-- 31_reports_seed.sql — the six reports on the deterministic SEED: each report
-- must agree with an independent count/sum over the base tables (Task 6).
-- Expected values are derived in the test from the raw rows, not hard-coded,
-- except the trial-balance total already recorded for the seed (T2-07).
\ir _lib/assert.sql
\o /dev/null
\ir ../seed/seed.sql
\o
SET search_path = payrail, public;

\set name 'seed R1: balanced; Σ D = Σ C = 801428631 paise (₹80,14,286.31, as recorded in T2-07); one row per account + total'
\ir _lib/try.sql
SELECT t_assert(debit_paise = 801428631 AND credit_paise = 801428631 AND balanced
                AND (SELECT count(*) FROM fn_report_trial_balance()) = (SELECT count(*) FROM accounts) + 1, 'R1')
  FROM fn_report_trial_balance() WHERE is_total;
\ir _lib/expect_ok.sql

\set name 'seed R2: for every vendor, closing balance = last running balance = fn_vendor_balance; lines = ledger lines on its account'
\ir _lib/try.sql
SELECT t_assert(bool_and(ok), 'R2') FROM (
  SELECT v.vendor_id,
         (SELECT running_balance_paise FROM fn_report_vendor_statement(v.vendor_id) WHERE row_kind = 'closing')
           = fn_vendor_balance(v.vendor_id)
         AND (SELECT count(*) FROM fn_report_vendor_statement(v.vendor_id) WHERE row_kind = 'line')
           = (SELECT count(*) FROM ledger_lines WHERE account_id = fn_vendor_payable_account(v.vendor_id))
         AND coalesce((SELECT running_balance_paise FROM fn_report_vendor_statement(v.vendor_id) WHERE row_kind = 'line'
                        ORDER BY seq DESC LIMIT 1), 0) = fn_vendor_balance(v.vendor_id) AS ok
    FROM vendors v) x;
\ir _lib/expect_ok.sql

\set name 'seed R2: a mid-period window (10-01..10-15) — opening + Σ(credit − debit) = closing, for every vendor'
\ir _lib/try.sql
SELECT t_assert(bool_and(o.running_balance_paise + coalesce(l.net, 0) = c.running_balance_paise), 'R2 window') FROM vendors v
  CROSS JOIN LATERAL (SELECT running_balance_paise FROM fn_report_vendor_statement(v.vendor_id, '2026-10-01', '2026-10-15') WHERE row_kind = 'opening') o
  CROSS JOIN LATERAL (SELECT sum(credit_paise - debit_paise) AS net FROM fn_report_vendor_statement(v.vendor_id, '2026-10-01', '2026-10-15') WHERE row_kind = 'line') l
  CROSS JOIN LATERAL (SELECT running_balance_paise FROM fn_report_vendor_statement(v.vendor_id, '2026-10-01', '2026-10-15') WHERE row_kind = 'closing') c;
\ir _lib/expect_ok.sql

\set name 'seed R3: Σ over months = captured payments, processed refunds, and the R1 balances of commission / GST / fees'
\ir _lib/try.sql
SELECT t_assert(sum(payments_captured) = (SELECT count(*) FROM payments WHERE status = 'captured')
                AND sum(captured_gross_paise) = (SELECT sum(amount_paise) FROM payments WHERE status = 'captured')
                AND sum(refunded_paise) = (SELECT sum(amount_paise) FROM refunds WHERE status = 'processed')
                AND sum(attempts_failed) = (SELECT count(*) FROM payments WHERE status = 'failed')
                AND sum(commission_net_paise) = (SELECT balance_paise FROM v_account_balances WHERE code = 'COMMISSION_REVENUE')
                AND sum(gst_net_paise)        = (SELECT balance_paise FROM v_account_balances WHERE code = 'GST_PAYABLE')
                AND sum(gateway_fees_paise)   = (SELECT balance_paise FROM v_account_balances WHERE code = 'GATEWAY_FEE_EXPENSE')
                AND max(cumulative_gross_paise) = sum(captured_gross_paise), 'R3')
  FROM fn_report_monthly_performance();
\ir _lib/expect_ok.sql

\set name 'seed R4: Σ sales = Σ line totals of paid orders; Σ refunded = all processed refunds; Σ pending = requests of paid lines'
\ir _lib/try.sql
SELECT t_assert(sum(sales_paise) = (SELECT sum(quantity::bigint * unit_price_paise) FROM order_items oi
                                     WHERE EXISTS (SELECT 1 FROM payments p WHERE p.order_id = oi.order_id AND p.status = 'captured'))
                AND sum(refunded_paise) = (SELECT sum(amount_paise) FROM refunds WHERE status = 'processed')
                AND sum(pending_refund_paise) = (SELECT sum(amount_paise) FROM refunds WHERE status = 'requested')
                AND sum(refund_requests) = (SELECT count(*) FROM refunds)
                AND count(*) = (SELECT count(*) FROM vendors), 'R4')
  FROM fn_report_vendor_refund_risk();
\ir _lib/expect_ok.sql

\set name 'seed R5 (as of 2026-10-31): grand total = row count of fn_reconciliation_report; subtotals add up; all five categories present'
\ir _lib/try.sql
SELECT t_assert((SELECT items FROM fn_report_settlement_aging('2026-10-31') WHERE is_total)
                  = (SELECT count(*) FROM fn_reconciliation_report('2026-10-31'))
            AND (SELECT sum(items) FROM fn_report_settlement_aging('2026-10-31') WHERE is_subtotal)
                  = (SELECT items FROM fn_report_settlement_aging('2026-10-31') WHERE is_total)
            AND (SELECT count(*) FROM fn_report_settlement_aging('2026-10-31') WHERE is_subtotal) = 5
            AND (SELECT net_cash_paise FROM fn_report_settlement_aging('2026-10-31') WHERE is_total)
                  = (SELECT sum(CASE l.direction WHEN 'D' THEN l.amount_paise ELSE -l.amount_paise END)
                       FROM ledger_lines l JOIN journal_entries e USING (entry_id)
                      WHERE e.entry_type = 'settlement' AND l.account_id = fn_account('BANK')), 'R5');
\ir _lib/expect_ok.sql

\set name 'seed R6: identity sales − refunds − payouts + reversals = balance; payouts table agrees with the ledger; vendor 7 negative'
\ir _lib/try.sql
SELECT t_assert(bool_and(sales_paise - refunds_paise - payouts_paise + reversals_paise = balance_paise
                         AND balance_paise = fn_vendor_balance(vendor_id) AND ledger_consistent)
                AND sum(in_flight_paise) = (SELECT sum(amount_paise) FROM payouts WHERE status = 'requested')
                AND bool_or(status = 'negative'), 'R6')
  FROM fn_report_vendor_payables();
\ir _lib/expect_ok.sql
