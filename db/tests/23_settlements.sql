-- 23_settlements.sql — W4 stored workflows: fn_record_settlement,
-- fn_reconcile, fn_reconciliation_report (Task 2, DEC-009).
--
-- Timeline (IST):                                         expected (T+2)
--   P1  captured 10-01  ₹499.99   settled 10-03, fee ₹10      10-03  → matched (posted)
--   P2  captured 10-01  ₹1234.56  settled 10-03 as ₹1230.00   10-03  → amount_mismatch (not posted)
--   P3  captured 10-01  ₹999.98   no settlement row           10-03  → overdue_missing at 10-05
--   P4  captured 10-04  ₹2469.12  no settlement row           10-06  → in_transit until 10-06
--   P5  captured 10-01  ₹1234.56  reported as a REFUND row    10-03  → amount_mismatch (record type)
--   R1  refund of ₹100 on P1 processed 10-02, settled 10-04   10-04  → matched (posted)
--   pay_GHOST0001  settled 10-03, no such payment                     → unknown_reference
--   pay_LATE0001   settled 10-04; its payment is captured only on 10-06 → unknown, then matched by fn_reconcile
\ir _lib/assert.sql
\ir _lib/fixtures.sql
SET ROLE payrail_owner;
INSERT INTO products (vendor_id, name, price_paise) VALUES (:vendor_a, 'Late Widget', 5000) RETURNING product_id AS prod_late \gset
RESET ROLE;

SET payrail.clock = '2026-10-01 10:00:00+05:30';
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 1))) AS o1 \gset
SELECT payment_id AS p1 FROM fn_initiate_payment(:customer_id, :o1, 'card', '70000000-0000-4000-8000-000000000001') \gset
SELECT fn_capture_payment(:p1, 'pay_W4P1000001', 49999) \gset
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_b, 'quantity', 1))) AS o2 \gset
SELECT payment_id AS p2 FROM fn_initiate_payment(:customer_id, :o2, 'upi', '70000000-0000-4000-8000-000000000002') \gset
SELECT fn_capture_payment(:p2, 'pay_W4P2000001', 123456) \gset
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 2))) AS o3 \gset
SELECT payment_id AS p3 FROM fn_initiate_payment(:customer_id, :o3, 'upi', '70000000-0000-4000-8000-000000000003') \gset
SELECT fn_capture_payment(:p3, 'pay_W4P3000001', 99998) \gset
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_b, 'quantity', 1))) AS o5 \gset
SELECT payment_id AS p5 FROM fn_initiate_payment(:customer_id, :o5, 'netbanking', '70000000-0000-4000-8000-000000000005') \gset
SELECT fn_capture_payment(:p5, 'pay_W4P5000001', 123456) \gset

SET payrail.clock = '2026-10-02 10:00:00+05:30';
SELECT refund_id AS r1 FROM fn_request_refund(:customer_id, :o1, 1, 10000, 'scratch', '70000000-0000-4000-8000-000000000011') \gset
SELECT gateway_ref AS r1_ref FROM fn_approve_refund(:fin_id, :r1) \gset

-- ================================================================ import on 10-03
SET payrail.clock = '2026-10-03 18:00:00+05:30';
\set name 'import: exact payment row is stored and posted at once: D BANK 48999, D fee 1000, C clearing 49999'
\ir _lib/try.sql
SELECT settlement_id AS s1, result AS res, entry_id AS e_s1
  FROM fn_record_settlement(:fin_id, 'pay_W4P1000001', 'payment', 49999, 1000, '2026-10-03') \gset
SELECT t_assert(:'res' = 'inserted' AND :'e_s1' <> '', 'inserted + posted');
SELECT t_assert(array_agg(a.code || ' ' || l.direction || ' ' || l.amount_paise ORDER BY l.line_no)
                = ARRAY['BANK D 48999', 'GATEWAY_FEE_EXPENSE D 1000', 'GATEWAY_CLEARING C 49999'], 'lines')
  FROM ledger_lines l JOIN accounts a USING (account_id) WHERE l.entry_id = :e_s1;
\ir _lib/expect_ok.sql
\set name 'import: short-paid row (₹1230.00 for ₹1234.56) is stored but NOT posted'
\ir _lib/try.sql
SELECT settlement_id AS s2, result AS res, coalesce(entry_id, 0) AS e_s2
  FROM fn_record_settlement(:fin_id, 'pay_W4P2000001', 'payment', 123000, 2460, '2026-10-03') \gset
SELECT t_assert(:'res' = 'inserted' AND :e_s2 = 0, 'stored, no entry');
\ir _lib/expect_ok.sql
\set name 'import: payment reported as a refund row is stored but NOT posted'
\ir _lib/try.sql
SELECT result AS res, coalesce(entry_id, 0) AS e_s5 FROM fn_record_settlement(:fin_id, 'pay_W4P5000001', 'refund', 123456, 0, '2026-10-03') \gset
SELECT t_assert(:'res' = 'inserted' AND :e_s5 = 0, 'stored, no entry');
\ir _lib/expect_ok.sql
\set name 'import: unknown reference is stored, NOT posted, and no payment is fabricated'
\ir _lib/try.sql
SELECT result AS res, coalesce(entry_id, 0) AS e_g FROM fn_record_settlement(:fin_id, 'pay_GHOST0001', 'payment', 5000, 100, '2026-10-03') \gset
SELECT t_assert(:'res' = 'inserted' AND :e_g = 0, 'stored, no entry');
SELECT t_assert(NOT EXISTS (SELECT 1 FROM payments WHERE gateway_ref = 'pay_GHOST0001'), 'no fabricated payment');
\ir _lib/expect_ok.sql
\set name 'import: identical re-import is a duplicate (nothing stored or posted again)'
\ir _lib/try.sql
SELECT count(*) AS rows_before FROM gateway_settlements \gset
SELECT t_assert(result = 'duplicate' AND settlement_id = :s1 AND entry_id = :e_s1, 'duplicate')
  FROM fn_record_settlement(:fin_id, 'pay_W4P1000001', 'payment', 49999, 1000, '2026-10-03');
SELECT t_assert(count(*) = :rows_before, 'no new row') FROM gateway_settlements;
SELECT t_assert(count(*) = 1, 'one posting') FROM journal_entries WHERE settlement_id = :s1;
\ir _lib/expect_ok.sql
\set name 'import: same ref with different values is a conflict; the original row is kept'
\ir _lib/try.sql
SELECT t_assert(result = 'conflict' AND settlement_id = :s2, 'conflict')
  FROM fn_record_settlement(:fin_id, 'pay_W4P2000001', 'payment', 123456, 2460, '2026-10-03');
SELECT t_assert(gross_paise = 123000, 'original kept') FROM gateway_settlements WHERE settlement_id = :s2;
SELECT t_assert(count(*) = 0, 'still not posted') FROM journal_entries WHERE settlement_id = :s2;
\ir _lib/expect_ok.sql

\set want PRV07
\set name 'import: a settlement date in the future (10-04 on 10-03) is rejected'
\ir _lib/try.sql
SELECT fn_record_settlement(:fin_id, 'pay_FUTURE0001', 'payment', 1000, 0, '2026-10-04');
\ir _lib/expect_error.sql
\set want 23514
\set name 'import: fee ≥ gross rejected'
\ir _lib/try.sql
SELECT fn_record_settlement(:fin_id, 'pay_BADFEE0001', 'payment', 1000, 1000, '2026-10-03');
\ir _lib/expect_error.sql
\set want 23514
\set name 'import: a refund row with a fee rejected'
\ir _lib/try.sql
SELECT fn_record_settlement(:fin_id, 'rfnd_BADFEE0001', 'refund', 1000, 10, '2026-10-03');
\ir _lib/expect_error.sql
\set want 23514
\set name 'import: malformed reference rejected'
\ir _lib/try.sql
SELECT fn_record_settlement(:fin_id, 'pay-W4;drop', 'payment', 1000, 0, '2026-10-03');
\ir _lib/expect_error.sql
\set want 23514
\set name 'import: unknown record type rejected'
\ir _lib/try.sql
SELECT fn_record_settlement(:fin_id, 'pay_TYPE0001', 'chargeback', 1000, 0, '2026-10-03');
\ir _lib/expect_error.sql
\set want PRA01
\set name 'import: only finance may import'
\ir _lib/try.sql
SELECT fn_record_settlement(:vik_id, 'pay_VENDOR0001', 'payment', 1000, 0, '2026-10-03');
\ir _lib/expect_error.sql

-- ================================================================ 10-04: refund row, late reference; P4 captured
SET payrail.clock = '2026-10-04 10:00:00+05:30';
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_b, 'quantity', 2))) AS o4 \gset
SELECT payment_id AS p4 FROM fn_initiate_payment(:customer_id, :o4, 'upi', '70000000-0000-4000-8000-000000000004') \gset
SELECT fn_capture_payment(:p4, 'pay_W4P4000001', 246912) \gset
SET payrail.clock = '2026-10-04 18:00:00+05:30';
\set name 'import: refund row matching the processed refund posts D clearing 10000 / C BANK 10000'
\ir _lib/try.sql
SELECT result AS res, entry_id AS e_r1 FROM fn_record_settlement(:fin_id, :'r1_ref', 'refund', 10000, 0, '2026-10-04') \gset
SELECT t_assert(array_agg(a.code || ' ' || l.direction || ' ' || l.amount_paise ORDER BY l.line_no)
                = ARRAY['GATEWAY_CLEARING D 10000', 'BANK C 10000'], 'lines')
  FROM ledger_lines l JOIN accounts a USING (account_id) WHERE l.entry_id = :e_r1;
SELECT fn_record_settlement(:fin_id, 'pay_LATE0001', 'payment', 5000, 0, '2026-10-04') \gset
\ir _lib/expect_ok.sql

-- ================================================================ categories
\set name 'report @10-05: every category with the expected members'
\ir _lib/try.sql
SELECT t_assert(array_agg(category || ':' || gateway_ref ORDER BY category, gateway_ref)
                = ARRAY['amount_mismatch:pay_W4P2000001', 'amount_mismatch:pay_W4P5000001',
                        'in_transit:pay_W4P4000001',
                        'matched:pay_W4P1000001', 'matched:' || :'r1_ref',
                        'overdue_missing:pay_W4P3000001',
                        'unknown_reference:pay_GHOST0001', 'unknown_reference:pay_LATE0001'], 'categories')
  FROM fn_reconciliation_report('2026-10-05');
SELECT t_assert(days_overdue = 2 AND expected_on = '2026-10-03', 'P3 two days overdue')
  FROM fn_reconciliation_report('2026-10-05') WHERE gateway_ref = 'pay_W4P3000001';
SELECT t_assert(detail = 'reported as refund, recorded as payment', 'type mismatch detail')
  FROM fn_reconciliation_report('2026-10-05') WHERE gateway_ref = 'pay_W4P5000001';
SELECT t_assert(bool_and((category = 'matched') = (posted_entry_id IS NOT NULL)), 'only matched rows are posted')
  FROM fn_reconciliation_report('2026-10-05') WHERE settlement_id IS NOT NULL;
\ir _lib/expect_ok.sql
\set name 'report: T+2 boundary — P4 (expected 10-06) in transit on 10-06, overdue by 1 day on 10-07'
\ir _lib/try.sql
SELECT t_assert(category = 'in_transit', '10-06') FROM fn_reconciliation_report('2026-10-06') WHERE gateway_ref = 'pay_W4P4000001';
SELECT t_assert(category = 'overdue_missing' AND days_overdue = 1, '10-07')
  FROM fn_reconciliation_report('2026-10-07') WHERE gateway_ref = 'pay_W4P4000001';
\ir _lib/expect_ok.sql
\set name 'report @10-02: rows settled later and events after as_of are ignored'
\ir _lib/try.sql
SELECT t_assert(array_agg(category || ':' || gateway_ref ORDER BY gateway_ref)
                = ARRAY['in_transit:pay_W4P1000001', 'in_transit:pay_W4P2000001', 'in_transit:pay_W4P3000001',
                        'in_transit:pay_W4P5000001', 'in_transit:' || :'r1_ref'], 'as of 10-02')
  FROM fn_reconciliation_report('2026-10-02');
\ir _lib/expect_ok.sql

-- ================================================================ revisit an unknown reference
SET payrail.clock = '2026-10-06 09:00:00+05:30';
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_late, 'quantity', 1))) AS o6 \gset
SELECT payment_id AS p6 FROM fn_initiate_payment(:customer_id, :o6, 'upi', '70000000-0000-4000-8000-000000000006') \gset
SELECT fn_capture_payment(:p6, 'pay_LATE0001', 5000) \gset
\set name 'revisit: once the late payment exists the stored row reports matched but unposted'
\ir _lib/try.sql
SELECT t_assert(category = 'matched' AND posted_entry_id IS NULL, 'matched, unposted')
  FROM fn_reconciliation_report('2026-10-06') WHERE gateway_ref = 'pay_LATE0001';
\ir _lib/expect_ok.sql
\set want PRA01
\set name 'reconcile: only finance'
\ir _lib/try.sql
SELECT fn_reconcile(:customer_id, '2026-10-06');
\ir _lib/expect_error.sql
\set name 'reconcile @10-06: posts exactly the newly matching row; mismatches and unknowns stay unposted'
\ir _lib/try.sql
SELECT t_assert(array_agg(category || ' items=' || items || ' posted=' || posted_items || ' new=' || newly_posted ORDER BY category)
                = ARRAY['amount_mismatch items=2 posted=0 new=0', 'in_transit items=1 posted=0 new=0',
                        'matched items=3 posted=3 new=1', 'overdue_missing items=1 posted=0 new=0',
                        'unknown_reference items=1 posted=0 new=0'], 'summary')
  FROM fn_reconcile(:fin_id, '2026-10-06');
SELECT t_assert(count(*) = 1, 'late row posted once')
  FROM journal_entries je JOIN gateway_settlements s USING (settlement_id) WHERE s.gateway_ref = 'pay_LATE0001';
\ir _lib/expect_ok.sql
\set name 'reconcile: running it again posts nothing new'
\ir _lib/try.sql
SELECT t_assert(sum(newly_posted) = 0, 'idempotent') FROM fn_reconcile(:fin_id, '2026-10-06');
SELECT t_assert(count(*) = 3, 'three settlement entries in total: P1, R1, LATE') FROM journal_entries WHERE entry_type = 'settlement';
\ir _lib/expect_ok.sql

-- ================================================================ ledger consistency
\set name 'ledger: clearing = captured − refunds − settled payment gross + settled refunds; Σdebit = Σcredit'
\ir _lib/try.sql
SELECT t_assert(
  (SELECT balance_paise FROM v_account_balances WHERE code = 'GATEWAY_CLEARING')
  = (SELECT sum(amount_paise) FROM payments WHERE status = 'captured')
  - (SELECT sum(amount_paise) FROM refunds WHERE status = 'processed')
  - (SELECT coalesce(sum(s.gross_paise), 0) FROM gateway_settlements s JOIN journal_entries je USING (settlement_id) WHERE s.record_type = 'payment')
  + (SELECT coalesce(sum(s.gross_paise), 0) FROM gateway_settlements s JOIN journal_entries je USING (settlement_id) WHERE s.record_type = 'refund'),
  'clearing identity');
SELECT t_assert(balance_paise = 1000, 'fee expense = posted fees only') FROM v_account_balances WHERE code = 'GATEWAY_FEE_EXPENSE';
SELECT t_assert(balance_paise = 48999 - 10000 + 5000, 'bank = net settled cash') FROM v_account_balances WHERE code = 'BANK';
SELECT t_assert(sum(debit_paise) = sum(credit_paise), 'trial balance') FROM v_account_balances;
\ir _lib/expect_ok.sql
\set name 'report @10-31: every captured payment and processed refund appears exactly once'
\ir _lib/try.sql
SELECT t_assert((SELECT count(*) FROM fn_reconciliation_report('2026-10-31') WHERE payment_id IS NOT NULL)
                = (SELECT count(*) FROM payments WHERE status = 'captured')
            AND (SELECT count(DISTINCT payment_id) FROM fn_reconciliation_report('2026-10-31'))
                = (SELECT count(*) FROM payments WHERE status = 'captured')
            AND (SELECT count(*) FROM fn_reconciliation_report('2026-10-31') WHERE refund_id IS NOT NULL)
                = (SELECT count(*) FROM refunds WHERE status = 'processed')
            AND (SELECT count(*) FROM fn_reconciliation_report('2026-10-31') WHERE settlement_id IS NOT NULL)
                = (SELECT count(*) FROM gateway_settlements), 'complete, no duplicates');
\ir _lib/expect_ok.sql
