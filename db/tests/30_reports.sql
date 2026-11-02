-- 30_reports.sql — named reports R1–R6 (32_reports.sql, Task 6) on a small,
-- HAND-CHECKABLE fixture built through the real workflow functions.
--
-- Vendors (fixtures.sql): A = Vik Traders 10% (Steel Bottle ₹499.99),
--                         B = Bela Crafts 2.5% (Handloom Saree ₹1,234.56), P = pending KYC.
-- Capture split (fn_split_line):  L       C = rhu(L·bps/1e4)  G = rhu(C·18%)  V = L − C − G
--   A × 1                         49 999      5 000              900            44 099
--   A × 2                         99 998     10 000            1 800            88 198
--   B × 1                        123 456      3 086              555           119 815
-- Refund ₹100 of the A × 1 line: ΔC = rhu(5000·10000/49999) = 1000, ΔG = 180, ΔV = 8 820.
--
-- Timeline (IST, payrail.clock):
--   09-10 o1  A×1 captured pay_RPT0000001                 09-12 o2  B×1 captured pay_RPT0000002
--   09-12 settlement of o1: gross 49 999, fee 1 000 (matched, posted)
--   09-14 settlement of o2 reported as 123 000 (amount_mismatch, NOT posted)
--   09-15 o3  A×2, first attempt FAILED                   09-20 payout A 20 000 (paid 09-21)
--   10-05 o3 second attempt captured pay_RPT0000003       10-06 refund 10 000 on o1 (approved)
--   10-07 refunds on o2: 5 000 (stays requested), 3 000 (rejected)
--   10-08 payout A 5 000 → FAILED (reversed); payout B 100 000 (requested); refund settled (matched)
--   10-09 o4  B×1 captured pay_RPT0000004; unknown ref pay_RPTGHOST01 settled (5 000, fee 100)
\ir _lib/assert.sql
\ir _lib/fixtures.sql
RESET ROLE;

-- ---------------------------------------------------------------- build the fixture
SET payrail.clock = '2026-09-10 10:00:00+05:30';
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 1))) AS o1 \gset
SELECT payment_id AS p1 FROM fn_initiate_payment(:customer_id, :o1, 'card', '90000000-0000-4000-8000-000000000001') \gset
SELECT fn_capture_payment(:p1, 'pay_RPT0000001', 49999) \gset

SET payrail.clock = '2026-09-12 10:00:00+05:30';
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_b, 'quantity', 1))) AS o2 \gset
SELECT payment_id AS p2 FROM fn_initiate_payment(:customer_id, :o2, 'upi', '90000000-0000-4000-8000-000000000002') \gset
SELECT fn_capture_payment(:p2, 'pay_RPT0000002', 123456) \gset
SET payrail.clock = '2026-09-12 18:00:00+05:30';
SELECT 1 AS _ok FROM fn_record_settlement(:fin_id, 'pay_RPT0000001', 'payment', 49999, 1000, '2026-09-12') \gset

SET payrail.clock = '2026-09-14 18:00:00+05:30';
SELECT 1 AS _ok FROM fn_record_settlement(:fin_id, 'pay_RPT0000002', 'payment', 123000, 2460, '2026-09-14') \gset

SET payrail.clock = '2026-09-15 10:00:00+05:30';
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 2))) AS o3 \gset
SELECT payment_id AS p3a FROM fn_initiate_payment(:customer_id, :o3, 'card', '90000000-0000-4000-8000-000000000003') \gset
SELECT 1 AS _ok FROM fn_fail_payment(:p3a, 'pay_RPT0000003F') \gset

SET payrail.clock = '2026-09-20 10:00:00+05:30';
SELECT payout_id AS po1 FROM fn_request_payout(:vik_id, 20000, '90000000-0000-4000-8000-000000000021') \gset
SET payrail.clock = '2026-09-21 10:00:00+05:30';
SELECT 1 AS _ok FROM fn_complete_payout(:fin_id, :po1, 'paid', 'UTRRPT000000001') \gset

SET payrail.clock = '2026-10-05 10:00:00+05:30';
SELECT payment_id AS p3 FROM fn_initiate_payment(:customer_id, :o3, 'upi', '90000000-0000-4000-8000-000000000004') \gset
SELECT fn_capture_payment(:p3, 'pay_RPT0000003', 99998) \gset

SET payrail.clock = '2026-10-06 10:00:00+05:30';
SELECT refund_id AS r1 FROM fn_request_refund(:customer_id, :o1, 1, 10000, 'dent', '90000000-0000-4000-8000-000000000031') \gset
SELECT gateway_ref AS r1_ref FROM fn_approve_refund(:fin_id, :r1) \gset

SET payrail.clock = '2026-10-07 10:00:00+05:30';
SELECT refund_id AS r2 FROM fn_request_refund(:customer_id, :o2, 1, 5000, 'colour', '90000000-0000-4000-8000-000000000032') \gset
SELECT refund_id AS r3 FROM fn_request_refund(:customer_id, :o2, 1, 3000, 'late', '90000000-0000-4000-8000-000000000033') \gset
SELECT 1 AS _ok FROM fn_reject_refund(:fin_id, :r3) \gset

SET payrail.clock = '2026-10-08 10:00:00+05:30';
SELECT payout_id AS po2 FROM fn_request_payout(:vik_id, 5000, '90000000-0000-4000-8000-000000000022') \gset
SELECT 1 AS _ok FROM fn_complete_payout(:fin_id, :po2, 'failed', NULL) \gset
SELECT payout_id AS po3 FROM fn_request_payout(:bela_id, 100000, '90000000-0000-4000-8000-000000000023') \gset
SELECT 1 AS _ok FROM fn_record_settlement(:fin_id, :'r1_ref', 'refund', 10000, 0, '2026-10-08') \gset

SET payrail.clock = '2026-10-09 10:00:00+05:30';
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_b, 'quantity', 1))) AS o4 \gset
SELECT payment_id AS p4 FROM fn_initiate_payment(:customer_id, :o4, 'netbanking', '90000000-0000-4000-8000-000000000005') \gset
SELECT fn_capture_payment(:p4, 'pay_RPT0000004', 123456) \gset
SELECT 1 AS _ok FROM fn_record_settlement(:fin_id, 'pay_RPTGHOST01', 'payment', 5000, 100, '2026-10-09') \gset
RESET payrail.clock;

-- ================================================================ R1 trial balance
\set name 'R1: per-account debit/credit totals and Dr/Cr balance columns match the hand computation'
\ir _lib/try.sql
SELECT t_assert(array_agg(code || ' ' || debit_paise || ' ' || credit_paise || ' ' || debit_balance_paise || ' ' || credit_balance_paise
                          ORDER BY account_id)
                = ARRAY['GATEWAY_CLEARING 406909 59999 346910 0',
                        'BANK 53999 135000 0 81001',             -- negative bank (no opening capital): shown in the Cr column
                        'COMMISSION_REVENUE 1000 21172 0 20172',
                        'GATEWAY_FEE_EXPENSE 1000 0 1000 0',
                        'GST_PAYABLE 180 3810 0 3630',
                        'VENDOR_PAYABLE_' || :vendor_a || ' 33820 137297 0 103477',
                        'VENDOR_PAYABLE_' || :vendor_b || ' 100000 239630 0 139630',
                        'VENDOR_PAYABLE_' || :vendor_p || ' 0 0 0 0'],
                array_agg(code || ' ' || debit_paise || ' ' || credit_paise || ' ' || debit_balance_paise || ' ' || credit_balance_paise
                          ORDER BY account_id)::text)
  FROM fn_report_trial_balance() WHERE NOT is_total;
\ir _lib/expect_ok.sql

\set name 'R1: exactly one total row; Σ D = Σ C = 596908 and Σ Dr balances = Σ Cr balances = 347910; balanced'
\ir _lib/try.sql
SELECT t_assert(count(*) = 1 AND min(debit_paise) = 596908 AND min(credit_paise) = 596908
                AND min(debit_balance_paise) = 347910 AND min(credit_balance_paise) = 347910
                AND bool_and(balanced), 'total row')
  FROM fn_report_trial_balance() WHERE is_total;
\ir _lib/expect_ok.sql

\set name 'R1: as_of 2026-09-30 counts only September postings (Σ D = Σ C = 243454; vendor A 24099)'
\ir _lib/try.sql
SELECT t_assert((SELECT debit_paise = 243454 AND credit_paise = 243454 AND balanced
                   FROM fn_report_trial_balance('2026-09-30') WHERE is_total)
            AND (SELECT balance_paise = 24099 FROM fn_report_trial_balance('2026-09-30') WHERE vendor_id = :vendor_a)
            AND (SELECT balance_paise = 123456 FROM fn_report_trial_balance('2026-09-30') WHERE code = 'GATEWAY_CLEARING'),
                'as of September');
\ir _lib/expect_ok.sql

\set name 'R1: account balances agree with v_account_balances and the vendor balance with fn_vendor_balance'
\ir _lib/try.sql
SELECT t_assert(NOT EXISTS (
          SELECT 1 FROM fn_report_trial_balance() r JOIN v_account_balances b USING (account_id)
           WHERE NOT r.is_total AND (r.debit_paise, r.credit_paise, r.balance_paise) IS DISTINCT FROM
                                    (b.debit_paise, b.credit_paise, b.balance_paise))
            AND (SELECT balance_paise FROM fn_report_trial_balance() WHERE vendor_id = :vendor_a) = fn_vendor_balance(:vendor_a),
                'consistent');
\ir _lib/expect_ok.sql

-- ================================================================ R2 vendor statement
\set name 'R2: full statement of vendor A — six lines in posting order with the running balance'
\ir _lib/try.sql
SELECT t_assert(array_agg(entry_type || ' ' || credit_paise || '/' || debit_paise || ' = ' || running_balance_paise ORDER BY seq)
                = ARRAY['capture 44099/0 = 44099', 'payout 0/20000 = 24099', 'capture 88198/0 = 112297',
                        'refund 0/8820 = 103477', 'payout 0/5000 = 98477', 'reversal 5000/0 = 103477'],
                'lines')
  FROM fn_report_vendor_statement(:vendor_a) WHERE row_kind = 'line';
SELECT t_assert(array_agg(reference ORDER BY seq)
                = ARRAY['order ' || :o1, 'payout ' || :po1, 'order ' || :o3,
                        'refund ' || :r1 || ' (order ' || :o1 || ')', 'payout ' || :po2, 'reversal of payout ' || :po2],
                'references')
  FROM fn_report_vendor_statement(:vendor_a) WHERE row_kind = 'line';
\ir _lib/expect_ok.sql

\set name 'R2: date window 10-01..10-06 — opening 24099 (history before the window), closing 103477, window applied after the running sum'
\ir _lib/try.sql
SELECT t_assert(array_agg(row_kind || ' ' || coalesce(credit_paise::text, '-') || '/' || coalesce(debit_paise::text, '-')
                          || ' = ' || running_balance_paise ORDER BY seq)
                = ARRAY['opening -/- = 24099', 'line 88198/0 = 112297', 'line 0/8820 = 103477', 'closing 88198/8820 = 103477'],
                'window')
  FROM fn_report_vendor_statement(:vendor_a, '2026-10-01', '2026-10-06');
\ir _lib/expect_ok.sql

\set name 'R2: empty window — opening = closing = 103477, no lines'
\ir _lib/try.sql
SELECT t_assert(array_agg(row_kind || ' ' || running_balance_paise ORDER BY seq) = ARRAY['opening 103477', 'closing 103477'], 'empty')
  FROM fn_report_vendor_statement(:vendor_a, '2026-10-07', '2026-10-07');
\ir _lib/expect_ok.sql

\set name 'R2: vendor scoping — B sees only its own three lines; closing = last running balance = ledger balance'
\ir _lib/try.sql
SELECT t_assert(count(*) FILTER (WHERE row_kind = 'line') = 3
                AND max(running_balance_paise) FILTER (WHERE row_kind = 'closing') = fn_vendor_balance(:vendor_b)
                AND max(running_balance_paise) FILTER (WHERE row_kind = 'closing')
                    = (SELECT running_balance_paise FROM fn_report_vendor_statement(:vendor_b) WHERE row_kind = 'line'
                        ORDER BY seq DESC LIMIT 1), 'scoped')
  FROM fn_report_vendor_statement(:vendor_b);
\ir _lib/expect_ok.sql

-- ================================================================ R3 monthly performance
\set name 'R3: September — 2 captures 173455, 3 final attempts (1 failed) = 6667 bps, commission 8086, GST 1455, fees 1000, net 7086'
\ir _lib/try.sql
SELECT t_assert((payments_captured, captured_gross_paise, attempts_final, attempts_failed, success_rate_bps,
                 refunds_processed, refunded_paise, refund_rate_bps, commission_net_paise, gst_net_paise,
                 gateway_fees_paise, platform_net_paise, cumulative_gross_paise)
                = (2::bigint, 173455::bigint, 3::bigint, 1::bigint, 6667::bigint, 0::bigint, 0::bigint, 0::bigint,
                   8086::bigint, 1455::bigint, 1000::bigint, 7086::bigint, 173455::bigint), 'september')
  FROM fn_report_monthly_performance() WHERE month = '2026-09-01';
\ir _lib/expect_ok.sql

\set name 'R3: October — 2 captures 223454, refund 10000 = rhu(447.52) = 448 bps, commission 12086 (net of 1000 reversed), cumulative 396909'
\ir _lib/try.sql
SELECT t_assert((payments_captured, captured_gross_paise, attempts_final, attempts_failed, success_rate_bps,
                 refunds_processed, refunded_paise, refund_rate_bps, commission_net_paise, gst_net_paise,
                 gateway_fees_paise, platform_net_paise, cumulative_gross_paise)
                = (2::bigint, 223454::bigint, 2::bigint, 0::bigint, 10000::bigint, 1::bigint, 10000::bigint, 448::bigint,
                   12086::bigint, 2175::bigint, 0::bigint, 12086::bigint, 396909::bigint), 'october')
  FROM fn_report_monthly_performance() WHERE month = '2026-10-01';
\ir _lib/expect_ok.sql

\set name 'R3: explicit range Aug..Nov gives 4 months; empty months are zero, not missing; Σ commission = R1 commission balance'
\ir _lib/try.sql
SELECT t_assert(count(*) = 4
                AND bool_and(payments_captured = 0 AND success_rate_bps IS NULL) FILTER (WHERE month IN ('2026-08-01', '2026-11-01'))
                AND max(cumulative_gross_paise) = 396909
                AND sum(commission_net_paise) = (SELECT credit_balance_paise FROM fn_report_trial_balance() WHERE code = 'COMMISSION_REVENUE')
                AND sum(gst_net_paise) = (SELECT credit_balance_paise FROM fn_report_trial_balance() WHERE code = 'GST_PAYABLE'),
                'range')
  FROM fn_report_monthly_performance('2026-08-15', '2026-11-02');
\ir _lib/expect_ok.sql

-- ================================================================ R4 vendor refund risk
\set name 'R4: all-time cohort — A 10000 / 149997 = 667 bps (watch, rank 1); B 0 bps with 5000 pending, 1 rejected (rank 2); P no sales'
\ir _lib/try.sql
SELECT t_assert(array_agg(vendor_id || ' ' || lines_sold || ' ' || sales_paise || ' ' || refund_requests || ' ' || refunds_rejected
                          || ' ' || lines_refunded || ' ' || refunded_paise || ' ' || pending_refund_paise || ' '
                          || coalesce(refund_rate_bps::text, '-') || ' ' || coalesce(rate_rank::text, '-') || ' ' || risk_band
                          ORDER BY vendor_id)
                = ARRAY[:vendor_a || ' 2 149997 1 0 1 10000 0 667 1 watch',
                        :vendor_b || ' 2 246912 2 1 0 0 5000 0 2 normal',
                        :vendor_p || ' 0 0 0 0 0 0 0 - - no_sales'],
                'risk')
  FROM fn_report_vendor_refund_risk();
\ir _lib/expect_ok.sql

\set name 'R4: cohort from 10-01 — only o3/o4 lines count; the refund of the September sale is excluded (A 0 bps)'
\ir _lib/try.sql
SELECT t_assert(array_agg(vendor_id || ' ' || sales_paise || ' ' || refunded_paise || ' ' || pending_refund_paise ORDER BY vendor_id)
                = ARRAY[:vendor_a || ' 99998 0 0', :vendor_b || ' 123456 0 0', :vendor_p || ' 0 0 0'], 'cohort')
  FROM fn_report_vendor_refund_risk('2026-10-01', NULL);
\ir _lib/expect_ok.sql

\set name 'R4: minimum sample (₹2,000) — A (₹1,499.97 of sales) is low_volume and unranked; B ranks 1'
\ir _lib/try.sql
SELECT t_assert((SELECT risk_band = 'low_volume' AND rate_rank IS NULL FROM fn_report_vendor_refund_risk(NULL, NULL, 200000) WHERE vendor_id = :vendor_a)
            AND (SELECT rate_rank = 1 FROM fn_report_vendor_refund_risk(NULL, NULL, 200000) WHERE vendor_id = :vendor_b), 'threshold');
\ir _lib/expect_ok.sql

\set name 'R4: join fan-out — a naive lines⋈refunds sum counts B''s line twice (370368); the report aggregates refunds per line first (246912)'
\ir _lib/try.sql
SELECT sum(oi.quantity::bigint * oi.unit_price_paise) AS naive_b
  FROM order_items oi JOIN products pr USING (product_id)
  LEFT JOIN refunds r ON r.order_id = oi.order_id AND r.line_no = oi.line_no
 WHERE pr.vendor_id = :vendor_b \gset
SELECT t_assert(:naive_b = 370368 AND sales_paise = 246912, 'fan-out avoided')
  FROM fn_report_vendor_refund_risk() WHERE vendor_id = :vendor_b;
\ir _lib/expect_ok.sql

-- ================================================================ R5 settlement aging
\set name 'R5: as of 10-10 — one item per category in the expected age bucket'
\ir _lib/try.sql
SELECT t_assert(array_agg(category || ' ' || age_bucket || ' ' || items || ' ' || coalesce(expected_paise::text, '-') || ' '
                          || coalesce(settled_gross_paise::text, '-') || ' ' || coalesce(difference_paise::text, '-') || ' '
                          || net_cash_paise || ' ' || oldest_age_days ORDER BY category)
                = ARRAY['amount_mismatch 8-30 d 1 123456 123000 -456 0 26',   -- settled 09-14, open 26 days, NOT posted
                        'in_transit 0-2 d 1 123456 - - 0 1',                   -- captured 10-09, due 10-11
                        'matched 0-2 d 2 59999 59999 0 38999 2',               -- payment + refund, both T+2; cash 48999 − 10000
                        'overdue_missing 3-7 d 1 99998 - - 0 3',               -- captured 10-05, due 10-07
                        'unknown_reference 0-2 d 1 - 5000 - 0 1'],             -- pay_RPTGHOST01, not posted
                'buckets')
  FROM fn_report_settlement_aging('2026-10-10') WHERE NOT is_subtotal AND NOT is_total;
\ir _lib/expect_ok.sql

\set name 'R5: 5 subtotals + 1 grand total (6 items, expected 406909, settled 187999, fees 3560, cash 38999)'
\ir _lib/try.sql
SELECT t_assert((SELECT count(*) FROM fn_report_settlement_aging('2026-10-10') WHERE is_subtotal) = 5
            AND (SELECT (items, expected_paise, settled_gross_paise, fee_paise, net_cash_paise)
                        = (6::bigint, 406909::bigint, 187999::bigint, 3560::bigint, 38999::bigint)
                   FROM fn_report_settlement_aging('2026-10-10') WHERE is_total), 'totals');
\ir _lib/expect_ok.sql

\set name 'R5: net cash of posted rows = BANK debits − credits from settlement entries in the ledger'
\ir _lib/try.sql
SELECT t_assert(net_cash_paise = (SELECT sum(CASE l.direction WHEN 'D' THEN l.amount_paise ELSE -l.amount_paise END)
                                    FROM ledger_lines l JOIN journal_entries e USING (entry_id)
                                   WHERE e.entry_type = 'settlement' AND l.account_id = :acct_bank), 'cash')
  FROM fn_report_settlement_aging('2026-10-10') WHERE is_total;
\ir _lib/expect_ok.sql

\set name 'R5: as of 10-08 — later events and rows are ignored; o3 is overdue by 1 day (0-2 d)'
\ir _lib/try.sql
SELECT t_assert(array_agg(category || ' ' || age_bucket || ' ' || items || ' ' || oldest_age_days ORDER BY category)
                = ARRAY['amount_mismatch 8-30 d 1 24', 'matched 0-2 d 2 2', 'overdue_missing 0-2 d 1 1'], 'as of 10-08')
  FROM fn_report_settlement_aging('2026-10-08') WHERE NOT is_subtotal AND NOT is_total;
\ir _lib/expect_ok.sql

-- ================================================================ R6 vendor payables
\set name 'R6: A = 132297 − 8820 − 25000 + 5000 = 103477 (1 paid, 1 failed); B = 239630 − 100000 (1 in flight); P blocked'
\ir _lib/try.sql
SELECT t_assert(array_agg(vendor_id || ' ' || sales_paise || ' ' || refunds_paise || ' ' || payouts_paise || ' ' || reversals_paise
                          || ' ' || balance_paise || ' ' || payouts_paid || '/' || paid_paise || ' ' || payouts_in_flight || '/'
                          || in_flight_paise || ' ' || payouts_failed || '/' || failed_paise || ' ' || ledger_consistent || ' ' || status
                          ORDER BY vendor_id)
                = ARRAY[:vendor_a || ' 132297 8820 25000 5000 103477 1/20000 0/0 1/5000 true payable',
                        :vendor_b || ' 239630 0 100000 0 139630 0/0 1/100000 0/0 true payable',
                        :vendor_p || ' 0 0 0 0 0 0/0 0/0 0/0 true payouts_blocked_kyc'],
                'payables')
  FROM fn_report_vendor_payables();
\ir _lib/expect_ok.sql

\set name 'R6: decomposition identity and agreement with R1 / fn_vendor_balance for every vendor'
\ir _lib/try.sql
SELECT t_assert(bool_and(sales_paise - refunds_paise - payouts_paise + reversals_paise = balance_paise
                         AND balance_paise = fn_vendor_balance(r6.vendor_id)
                         AND balance_paise = (SELECT balance_paise FROM fn_report_trial_balance() t WHERE t.vendor_id = r6.vendor_id)),
                'identity')
  FROM fn_report_vendor_payables() r6;
SELECT t_assert(count(*) = 1 AND min(vendor_id) = :vendor_b, 'single vendor') FROM fn_report_vendor_payables(:vendor_b);
\ir _lib/expect_ok.sql

-- ================================================================ IST month boundary
\set name 'R3/R4: a capture at 00:30 IST on 1 Nov (still 31 Oct in UTC) is a NOVEMBER sale (IST calendar, DEC-009)'
\ir _lib/try.sql
SET payrail.clock = '2026-11-01 00:30:00+05:30';
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_b, 'quantity', 1))) AS o5 \gset
SELECT payment_id AS p5 FROM fn_initiate_payment(:customer_id, :o5, 'upi', '90000000-0000-4000-8000-000000000006') \gset
SELECT fn_capture_payment(:p5, 'pay_RPT0000005', 123456) \gset
RESET payrail.clock;
SELECT t_assert((SELECT payments_captured = 1 AND captured_gross_paise = 123456 FROM fn_report_monthly_performance() WHERE month = '2026-11-01')
            AND (SELECT payments_captured = 2 FROM fn_report_monthly_performance() WHERE month = '2026-10-01')
            AND (SELECT sales_paise = 123456 FROM fn_report_vendor_refund_risk('2026-11-01', '2026-11-01') WHERE vendor_id = :vendor_b)
            AND (SELECT sales_paise = 0 FROM fn_report_vendor_refund_risk('2026-10-31', '2026-10-31') WHERE vendor_id = :vendor_b),
                'IST month');
\ir _lib/expect_ok.sql

-- ================================================================ as the application login
RESET ROLE;
\c - payrail_app
SET search_path = payrail, public;
\set name 'app role: payrail_app can run all six reports (SECURITY INVOKER over its SELECT grants)'
\ir _lib/try.sql
SELECT t_assert((SELECT count(*) FROM fn_report_trial_balance()) = 9
            AND (SELECT count(*) FROM fn_report_vendor_statement(:vendor_a)) = 8
            AND (SELECT count(*) FROM fn_report_monthly_performance()) = 3
            AND (SELECT count(*) FROM fn_report_vendor_refund_risk()) = 3
            AND (SELECT count(*) FROM fn_report_settlement_aging('2026-10-10')) = 11
            AND (SELECT count(*) FROM fn_report_vendor_payables()) = 3, 'readable');
\ir _lib/expect_ok.sql
\set name 'app role: reports are read-only — the app still cannot write the ledger'
\ir _lib/try.sql
INSERT INTO journal_entries (entry_type, payment_id, description) VALUES ('capture', :p1, 'x');
\set want 42501
\ir _lib/expect_error.sql
