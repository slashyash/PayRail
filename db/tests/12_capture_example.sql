-- 12_capture_example.sql — a hand-traceable financial example (Task 1
-- acceptance). Workflow functions arrive in Task 2, so the owner performs the
-- steps manually here, using the same helpers they will use, and every
-- resulting number is checked against hand arithmetic.
--
-- Order (customer Asha), clock 2026-10-05 11:00 IST:
--   line 1  Steel Bottle    3 × ₹499.99   vendor A @ 10.00%  L 149997
--   line 2  Handloom Saree  1 × ₹1234.56  vendor B @  2.50%  L 123456
--   line 1: C = rhu(14999.7) = 15000, G = rhu(2700.0) = 2700, V = 132297
--   line 2: C = rhu(3086.4)  =  3086, G = rhu(555.48) =  555, V = 119815
--   total 273453 = 132297 + 119815 + (15000 + 3086) + (2700 + 555)
--
-- Capture entry (DEC-007):  D GATEWAY_CLEARING 273453
--                           C VENDOR_PAYABLE_A 132297, C VENDOR_PAYABLE_B 119815
--                           C COMMISSION_REVENUE 18086, C GST_PAYABLE 3255
-- Partial refund ₹500.00 (50000) on line 1, cumulative method (DEC-005):
--   ΔC = rhu(15000·50000/149997) = rhu(5000.1) = 5000
--   ΔG = rhu(2700·50000/149997)  = rhu(900.02) =  900,  ΔV = 50000 − 5900 = 44100
-- Refund entry: D VENDOR_PAYABLE_A 44100, D COMMISSION_REVENUE 5000,
--               D GST_PAYABLE 900, C GATEWAY_CLEARING 50000
\ir _lib/assert.sql
\ir _lib/fixtures.sql
SET payrail.clock = '2026-10-05 11:00:00+05:30';

\set name 'clock: fn_now() follows payrail.clock for the administrator login'
\ir _lib/try.sql
SELECT t_assert(fn_now() = '2026-10-05 11:00:00+05:30'::timestamptz, 'controlled clock');
\ir _lib/expect_ok.sql

-- ---------------------------------------------------------------- order
INSERT INTO orders (customer_id) VALUES (:customer_id) RETURNING order_id AS o1 \gset
INSERT INTO order_items (order_id, line_no, product_id, quantity) VALUES
  (:o1, 1, :prod_a, 3), (:o1, 2, :prod_b, 1);

\set name 'order: derived total 273453, status pending_payment'
\ir _lib/try.sql
SELECT t_assert(total_paise = 273453 AND status = 'pending_payment' AND line_count = 2, 'summary')
  FROM v_order_summary WHERE order_id = :o1;
\ir _lib/expect_ok.sql

\set name 'order lines: allocation view matches hand computation'
\ir _lib/try.sql
SELECT t_assert(array_agg(ARRAY[line_total_paise, commission_paise, gst_paise, vendor_paise] ORDER BY line_no)
                = ARRAY[[149997, 15000, 2700, 132297], [123456, 3086, 555, 119815]]::bigint[], 'allocation')
  FROM v_order_line_allocation WHERE order_id = :o1;
\ir _lib/expect_ok.sql

-- ---------------------------------------------------------------- capture (one transaction)
BEGIN;
INSERT INTO payments (order_id, amount_paise, method, idempotency_key)
VALUES (:o1, 273453, 'upi', '00000000-0000-4000-8000-000000000001') RETURNING payment_id AS pay1 \gset
UPDATE payments SET status = 'captured', gateway_ref = 'pay_DEMO00000001', captured_at = fn_now()
 WHERE payment_id = :pay1;
SELECT fn_post_entry('capture', 'Capture of order ' || :o1,
         ARRAY[ROW(fn_account('GATEWAY_CLEARING'), 'D', sum(line_total_paise))::posting_line]
         || (SELECT array_agg(ROW(fn_vendor_payable_account(vendor_id), 'C', v)::posting_line ORDER BY vendor_id)
               FROM (SELECT vendor_id, sum(vendor_paise)::bigint AS v
                       FROM v_order_line_allocation WHERE order_id = :o1 GROUP BY vendor_id) per_vendor)
         || ARRAY[ROW(fn_account('COMMISSION_REVENUE'), 'C', sum(commission_paise))::posting_line,
                  ROW(fn_account('GST_PAYABLE'),        'C', sum(gst_paise))::posting_line],
         p_payment_id => :pay1) AS e_cap
  FROM v_order_line_allocation WHERE order_id = :o1 \gset
COMMIT;

\set name 'capture entry: exactly the five hand-computed lines'
\ir _lib/try.sql
SELECT t_assert(array_agg(a.code || ' ' || l.direction || ' ' || l.amount_paise ORDER BY l.line_no)
                = ARRAY['GATEWAY_CLEARING D 273453',
                        'VENDOR_PAYABLE_' || :vendor_a || ' C 132297',
                        'VENDOR_PAYABLE_' || :vendor_b || ' C 119815',
                        'COMMISSION_REVENUE C 18086',
                        'GST_PAYABLE C 3255'], 'capture lines')
  FROM ledger_lines l JOIN accounts a USING (account_id) WHERE l.entry_id = :e_cap;
SELECT t_assert(created_at = '2026-10-05 11:00:00+05:30'::timestamptz, 'entry stamped with controlled clock')
  FROM journal_entries WHERE entry_id = :e_cap;
\ir _lib/expect_ok.sql

\set name 'order: status paid after capture'
\ir _lib/try.sql
SELECT t_assert(status = 'paid' AND captured_payment_id = :pay1, 'paid') FROM v_order_summary WHERE order_id = :o1;
\ir _lib/expect_ok.sql

-- ---------------------------------------------------------------- partial refund on line 1
SET payrail.clock = '2026-10-07 15:30:00+05:30';
BEGIN;
INSERT INTO refunds (order_id, line_no, amount_paise, reason, idempotency_key)
VALUES (:o1, 1, 50000, 'one bottle dented', '00000000-0000-4000-8000-000000000002')
RETURNING refund_id AS rf1 \gset
UPDATE refunds SET status = 'processed', processed_at = fn_now(), gateway_ref = 'rfnd_DEMO00000001'
 WHERE refund_id = :rf1;
SELECT fn_post_entry('refund', 'Refund ' || :rf1 || ' on order ' || :o1 || ' line 1',
         ARRAY[ROW(fn_vendor_payable_account(al.vendor_id), 'D', ra.vendor_delta),
               ROW(fn_account('COMMISSION_REVENUE'),        'D', ra.commission_delta),
               ROW(fn_account('GST_PAYABLE'),               'D', ra.gst_delta),
               ROW(fn_account('GATEWAY_CLEARING'),          'C', 50000::bigint)]::posting_line[],
         p_refund_id => :rf1) AS e_ref
  FROM v_order_line_allocation al
  CROSS JOIN LATERAL fn_refund_alloc(al.line_total_paise, al.commission_paise, al.gst_paise, 0, 50000) ra
 WHERE al.order_id = :o1 AND al.line_no = 1 \gset
COMMIT;

\set name 'refund entry: D vendor 44100, D commission 5000, D GST 900, C clearing 50000'
\ir _lib/try.sql
SELECT t_assert(array_agg(a.code || ' ' || l.direction || ' ' || l.amount_paise ORDER BY l.line_no)
                = ARRAY['VENDOR_PAYABLE_' || :vendor_a || ' D 44100',
                        'COMMISSION_REVENUE D 5000', 'GST_PAYABLE D 900',
                        'GATEWAY_CLEARING C 50000'], 'refund lines')
  FROM ledger_lines l JOIN accounts a USING (account_id) WHERE l.entry_id = :e_ref;
\ir _lib/expect_ok.sql

\set name 'balances: clearing 223453, vendor A 88197, vendor B 119815, commission 13086, GST 2355'
\ir _lib/try.sql
SELECT t_assert(array_agg(code || '=' || balance_paise ORDER BY account_id)
                FILTER (WHERE balance_paise <> 0)
                = ARRAY['GATEWAY_CLEARING=223453', 'COMMISSION_REVENUE=13086', 'GST_PAYABLE=2355',
                        'VENDOR_PAYABLE_' || :vendor_a || '=88197',
                        'VENDOR_PAYABLE_' || :vendor_b || '=119815'], 'balances')
  FROM v_account_balances;
\ir _lib/expect_ok.sql

\set name 'order: partially_refunded, refunded 50000, line 1 refundable 99997'
\ir _lib/try.sql
SELECT t_assert(status = 'partially_refunded' AND refunded_paise = 50000, 'summary')
  FROM v_order_summary WHERE order_id = :o1;
SELECT t_assert(refundable_paise = 99997, 'refundable') FROM v_order_line_allocation WHERE order_id = :o1 AND line_no = 1;
\ir _lib/expect_ok.sql

\set name 'vendor A statement: +132297 then −44100, running balance 132297 → 88197'
\ir _lib/try.sql
SELECT t_assert(array_agg(ARRAY[credit_paise, debit_paise, running_balance_paise] ORDER BY created_at, entry_id, line_no)
                = ARRAY[[132297, 0, 132297], [0, 44100, 88197]]::bigint[], 'statement')
  FROM v_vendor_statement WHERE vendor_id = :vendor_a;
\ir _lib/expect_ok.sql

\set name 'trial balance: Σdebit = Σcredit = 323453'
\ir _lib/try.sql
SELECT t_assert(sum(debit_paise) = 323453 AND sum(credit_paise) = 323453, 'trial balance') FROM v_account_balances;
\ir _lib/expect_ok.sql

-- Human-readable evidence (printed when this file is run directly).
\pset footer off
SELECT e.entry_id, e.entry_type, e.created_at, a.code, l.direction AS dc, fn_inr(l.amount_paise) AS amount
  FROM ledger_lines l JOIN accounts a USING (account_id) JOIN journal_entries e USING (entry_id)
 ORDER BY e.entry_id, l.line_no;
SELECT code, normal_side, fn_inr(debit_paise) AS debits, fn_inr(credit_paise) AS credits, fn_inr(balance_paise) AS balance
  FROM v_account_balances WHERE debit_paise + credit_paise > 0 ORDER BY account_id;
