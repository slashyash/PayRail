-- db/reports/run_reports.sql — print the six named reports (Task 6) in psql,
-- with rupee formatting, for the demo / viva. Read-only.
--
--   psql -X -d payrail -v vendor=3 -v as_of=2026-10-31 -f db/reports/run_reports.sql
--   (Docker: docker compose exec -T db psql -U postgres -X -d payrail -v vendor=3 -v as_of=2026-10-31 -f /payrail/db/reports/run_reports.sql)
--
-- Works as the administrator or as payrail_app (EXECUTE is granted).
\set ON_ERROR_STOP 1
\if :{?vendor} \else \set vendor 3 \endif
\if :{?as_of}  \else \set as_of 2026-10-31 \endif
SET search_path = payrail;
\pset footer off

\echo '=== R1 Trial balance (all postings)'
SELECT coalesce(code, 'TOTAL') AS account, account_class AS class,
       fn_inr(debit_paise) AS debits, fn_inr(credit_paise) AS credits,
       CASE WHEN debit_balance_paise <> 0 THEN fn_inr(debit_balance_paise) END AS dr_balance,
       CASE WHEN credit_balance_paise <> 0 THEN fn_inr(credit_balance_paise) END AS cr_balance,
       balanced
  FROM fn_report_trial_balance() ORDER BY is_total, account_id;

\echo '=== R2 Vendor statement, vendor' :vendor ', October 1–15 (opening / lines / closing)'
SELECT row_kind, seq, posted_on, entry_type, reference,
       fn_inr(credit_paise) AS credit, fn_inr(debit_paise) AS debit, fn_inr(running_balance_paise) AS balance
  FROM fn_report_vendor_statement(:vendor, '2026-10-01', '2026-10-15') ORDER BY seq;

\echo '=== R3 Monthly performance (IST months)'
SELECT to_char(month, 'Mon YYYY') AS month, payments_captured AS captured, fn_inr(captured_gross_paise) AS gross,
       round(success_rate_bps / 100.0, 2) AS success_pct, refunds_processed AS refunds, fn_inr(refunded_paise) AS refunded,
       round(refund_rate_bps / 100.0, 2) AS refund_pct, fn_inr(commission_net_paise) AS commission,
       fn_inr(gst_net_paise) AS gst, fn_inr(gateway_fees_paise) AS fees, fn_inr(platform_net_paise) AS platform_net,
       fn_inr(cumulative_gross_paise) AS cumulative
  FROM fn_report_monthly_performance();

\echo '=== R4 Vendor refund risk (all sales; rank needs ≥ ₹1,000 of sales)'
SELECT rate_rank AS rank, vendor_id, legal_name, lines_sold, fn_inr(sales_paise) AS sales,
       refund_requests AS req, refunds_rejected AS rej, fn_inr(refunded_paise) AS refunded,
       fn_inr(pending_refund_paise) AS pending, round(refund_rate_bps / 100.0, 2) AS rate_pct, risk_band
  FROM fn_report_vendor_refund_risk();

\echo '=== R5 Settlement reconciliation and aging as of' :'as_of'
SELECT coalesce(category, 'TOTAL') AS category, coalesce(age_bucket, CASE WHEN is_subtotal THEN 'all' END) AS age,
       items, fn_inr(expected_paise) AS expected, fn_inr(settled_gross_paise) AS settled, fn_inr(fee_paise) AS fees,
       fn_inr(difference_paise) AS difference, fn_inr(net_cash_paise) AS net_cash, oldest_age_days AS oldest
  FROM fn_report_settlement_aging(:'as_of');

\echo '=== R6 Vendor payables and payouts'
SELECT vendor_id, legal_name, fn_inr(sales_paise) AS sales, fn_inr(refunds_paise) AS refunds,
       fn_inr(payouts_paise) AS payouts, fn_inr(reversals_paise) AS reversals, fn_inr(balance_paise) AS balance,
       payouts_paid AS paid, payouts_in_flight AS in_flight, payouts_failed AS failed, ledger_consistent AS ok, status
  FROM fn_report_vendor_payables();
