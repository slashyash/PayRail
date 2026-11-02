-- 21_refunds.sql — W3 stored workflows: fn_request_refund, fn_approve_refund,
-- fn_reject_refund (Task 2): reservation, idempotency, state machine and the
-- exact cumulative allocation (DEC-005).
--
-- Rounding fixture, order o1 line 1 = 3 × ₹499.99 at 10%:
--   L = 149997, C = 15000, G = 2700, V = 132297
--   refunds r = 10001, 25000, 33333, then the remainder 81663 (cumulative R = 10001, 35001, 68334, 149997)
--   C_k = rhu(15000·R/149997) = rhu(1000.12, 3500.17, 6833.54, 15000) = 1000, 3500, 6834, 15000
--                                                → ΔC = 1000, 2500, 3334, 8166   (Σ 15000)
--   G_k = rhu( 2700·R/149997) = rhu(180.02, 630.03, 1230.03, 2700)   =  180,  630, 1230,  2700
--                                                → ΔG =  180,  450,  600, 1470   (Σ  2700)
--   ΔV = r − ΔC − ΔG          = 8821, 22050, 29399, 72027                         (Σ 132297)
--   Naive per-refund rounding of the commission, rhu(15000·r/149997) per refund, gives
--   1000 + 2500 + 3333 + 8166 = 14999 ≠ 15000 (one paisa of drift).
\ir _lib/assert.sql
\ir _lib/fixtures.sql
RESET ROLE;
SET payrail.clock = '2026-10-05 11:00:00+05:30';

SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 3),
                                                      jsonb_build_object('product_id', :prod_b, 'quantity', 1))) AS o1 \gset

-- ================================================================ before payment
\set want PRO02
\set name 'request: an unpaid order cannot be refunded'
\ir _lib/try.sql
SELECT fn_request_refund(:customer_id, :o1, 1, 1000, 'early', '50000000-0000-4000-8000-000000000001');
\ir _lib/expect_error.sql

SELECT payment_id AS pay1 FROM fn_initiate_payment(:customer_id, :o1, 'upi', '50000000-0000-4000-8000-0000000000aa') \gset
SELECT fn_capture_payment(:pay1, 'pay_W3TEST0001', 273453) \gset
SET payrail.clock = '2026-10-07 10:00:00+05:30';

-- ================================================================ validation
\set want PRA01
\set name 'request: only the order''s customer may request a refund'
\ir _lib/try.sql
SELECT fn_request_refund(:fin_id, :o1, 1, 1000, 'not mine', '50000000-0000-4000-8000-000000000002');
\ir _lib/expect_error.sql
\set want PRN01
\set name 'request: unknown line'
\ir _lib/try.sql
SELECT fn_request_refund(:customer_id, :o1, 9, 1000, 'no line', '50000000-0000-4000-8000-000000000003');
\ir _lib/expect_error.sql
\set want PRR01
\set name 'request: more than the line total rejected'
\ir _lib/try.sql
SELECT fn_request_refund(:customer_id, :o1, 1, 149998, 'too much', '50000000-0000-4000-8000-000000000004');
\ir _lib/expect_error.sql
\set want PRR02
\set name 'request: below ₹1.00 rejected unless it is the whole remainder'
\ir _lib/try.sql
SELECT fn_request_refund(:customer_id, :o1, 1, 99, 'tiny', '50000000-0000-4000-8000-000000000005');
\ir _lib/expect_error.sql
\set want PRV07
\set name 'request: zero amount rejected'
\ir _lib/try.sql
SELECT fn_request_refund(:customer_id, :o1, 1, 0, 'zero', '50000000-0000-4000-8000-000000000006');
\ir _lib/expect_error.sql
\set want 23514
\set name 'request: blank reason rejected by CHECK'
\ir _lib/try.sql
SELECT fn_request_refund(:customer_id, :o1, 1, 1000, '  ', '50000000-0000-4000-8000-000000000007');
\ir _lib/expect_error.sql

-- ================================================================ reservation
\set name 'reservation: a pending request reserves its amount'
\ir _lib/try.sql
SELECT refund_id AS rq_big FROM fn_request_refund(:customer_id, :o1, 2, 100000, 'saree torn', '51000000-0000-4000-8000-000000000001') \gset
SELECT t_assert(refundable_paise = 23456 AND refund_pending_paise = 100000, 'reserved')
  FROM v_order_line_allocation WHERE order_id = :o1 AND line_no = 2;
\ir _lib/expect_ok.sql
\set want PRR01
\set name 'reservation: a second request over the remaining refundable amount rejected'
\ir _lib/try.sql
SELECT fn_request_refund(:customer_id, :o1, 2, 50000, 'more', '51000000-0000-4000-8000-000000000002');
\ir _lib/expect_error.sql
\set name 'idempotency: same key and same data returns the original refund'
\ir _lib/try.sql
SELECT t_assert(refund_id = :rq_big, 'replay')
  FROM fn_request_refund(:customer_id, :o1, 2, 100000, 'saree torn', '51000000-0000-4000-8000-000000000001');
SELECT t_assert(count(*) = 1, 'one row') FROM refunds WHERE idempotency_key = '51000000-0000-4000-8000-000000000001';
\ir _lib/expect_ok.sql
\set want PRI01
\set name 'idempotency: same key with a different amount rejected'
\ir _lib/try.sql
SELECT fn_request_refund(:customer_id, :o1, 2, 90000, 'saree torn', '51000000-0000-4000-8000-000000000001');
\ir _lib/expect_error.sql
\set want PRA01
\set name 'reject: only finance may decide'
\ir _lib/try.sql
SELECT fn_reject_refund(:customer_id, :rq_big);
\ir _lib/expect_error.sql
\set name 'reject: requested → rejected releases the reservation; repeated rejection harmless; nothing posted'
\ir _lib/try.sql
SELECT t_assert(status = 'rejected' AND processed_at IS NULL AND gateway_ref IS NULL, 'rejected') FROM fn_reject_refund(:fin_id, :rq_big);
SELECT t_assert(status = 'rejected', 'replay') FROM fn_reject_refund(:fin_id, :rq_big);
SELECT t_assert(refundable_paise = 123456 AND refund_pending_paise = 0, 'released')
  FROM v_order_line_allocation WHERE order_id = :o1 AND line_no = 2;
SELECT t_assert(count(*) = 0, 'no refund entry') FROM journal_entries WHERE refund_id = :rq_big;
\ir _lib/expect_ok.sql
\set want PRS01
\set name 'approve: a rejected refund cannot be approved'
\ir _lib/try.sql
SELECT fn_approve_refund(:fin_id, :rq_big);
\ir _lib/expect_error.sql

\set name 'no poisoning: a key whose request failed (PRR01) can be reused for a valid request'
\ir _lib/try.sql
SELECT refund_id AS rq_ok FROM fn_request_refund(:customer_id, :o1, 2, 50000, 'more', '51000000-0000-4000-8000-000000000002') \gset
SELECT t_assert(status = 'requested' AND amount_paise = 50000, 'stored') FROM refunds WHERE refund_id = :rq_ok;
\ir _lib/expect_ok.sql

-- ================================================================ exact cumulative allocation (line 1)
\set name 'approve #1 (₹100.01): D vendor 8821, D commission 1000, D GST 180, C clearing 10001'
\ir _lib/try.sql
SELECT refund_id AS rf1 FROM fn_request_refund(:customer_id, :o1, 1, 10001, 'r1', '52000000-0000-4000-8000-000000000001') \gset
SELECT t_assert(status = 'processed' AND gateway_ref = 'rfnd_R' || lpad(:rf1::text, 9, '0')
                AND processed_at = '2026-10-07 10:00:00+05:30'::timestamptz, 'processed')
  FROM fn_approve_refund(:fin_id, :rf1);
SELECT t_assert(array_agg(a.code || ' ' || l.direction || ' ' || l.amount_paise ORDER BY l.line_no)
                = ARRAY['VENDOR_PAYABLE_' || :vendor_a || ' D 8821', 'COMMISSION_REVENUE D 1000',
                        'GST_PAYABLE D 180', 'GATEWAY_CLEARING C 10001'], 'lines')
  FROM ledger_lines l JOIN accounts a USING (account_id) JOIN journal_entries e USING (entry_id) WHERE e.refund_id = :rf1;
\ir _lib/expect_ok.sql
\set name 'approve: repeated approval is harmless — still one refund entry'
\ir _lib/try.sql
SELECT t_assert(status = 'processed', 'replay') FROM fn_approve_refund(:fin_id, :rf1);
SELECT t_assert(count(*) = 1, 'one entry') FROM journal_entries WHERE refund_id = :rf1;
\ir _lib/expect_ok.sql
\set want PRS01
\set name 'reject: a processed refund cannot be rejected'
\ir _lib/try.sql
SELECT fn_reject_refund(:fin_id, :rf1);
\ir _lib/expect_error.sql

\set name 'approve #2..#4 (25000, 33333, remainder 81663): deltas match the hand computation'
\ir _lib/try.sql
SELECT refund_id AS rf2 FROM fn_request_refund(:customer_id, :o1, 1, 25000, 'r2', '52000000-0000-4000-8000-000000000002') \gset
SELECT fn_approve_refund(:fin_id, :rf2) \gset
SELECT refund_id AS rf3 FROM fn_request_refund(:customer_id, :o1, 1, 33333, 'r3', '52000000-0000-4000-8000-000000000003') \gset
SELECT fn_approve_refund(:fin_id, :rf3) \gset
SELECT refundable_paise AS rest FROM v_order_line_allocation WHERE order_id = :o1 AND line_no = 1 \gset
SELECT t_assert(:rest = 81663, 'remainder');
SELECT refund_id AS rf4 FROM fn_request_refund(:customer_id, :o1, 1, :rest, 'r4', '52000000-0000-4000-8000-000000000004') \gset
SELECT fn_approve_refund(:fin_id, :rf4) \gset
SELECT t_assert(array_agg(ARRAY[v, c, g]::bigint[] ORDER BY refund_id)
                = ARRAY[[8821, 1000, 180], [22050, 2500, 450], [29399, 3334, 600], [72027, 8166, 1470]]::bigint[], 'deltas')
  FROM (SELECT e.refund_id,
               sum(l.amount_paise) FILTER (WHERE a.owner_type = 'vendor')          AS v,
               sum(l.amount_paise) FILTER (WHERE a.code = 'COMMISSION_REVENUE')    AS c,
               sum(l.amount_paise) FILTER (WHERE a.code = 'GST_PAYABLE')           AS g
          FROM journal_entries e JOIN ledger_lines l USING (entry_id) JOIN accounts a USING (account_id)
         WHERE e.refund_id IN (:rf1, :rf2, :rf3, :rf4) GROUP BY e.refund_id) d;
\ir _lib/expect_ok.sql

\set name 'exactness: Σ refund deltas of the fully refunded line = its capture allocation (15000 / 2700 / 132297)'
\ir _lib/try.sql
SELECT t_assert(sum(l.amount_paise) FILTER (WHERE a.code = 'COMMISSION_REVENUE') = 15000
            AND sum(l.amount_paise) FILTER (WHERE a.code = 'GST_PAYABLE') = 2700
            AND sum(l.amount_paise) FILTER (WHERE a.owner_type = 'vendor') = 132297
            AND sum(l.amount_paise) FILTER (WHERE a.code = 'GATEWAY_CLEARING') = 149997, 'exact reversal')
  FROM journal_entries e JOIN ledger_lines l USING (entry_id) JOIN accounts a USING (account_id)
 WHERE e.refund_id IN (:rf1, :rf2, :rf3, :rf4);
-- the naive alternative really would drift on this fixture
SELECT t_assert(fn_round_half_up(15000, 10001, 149997) + fn_round_half_up(15000, 25000, 149997)
              + fn_round_half_up(15000, 33333, 149997) + fn_round_half_up(15000, 81663, 149997) = 14999, 'naive drifts');
\ir _lib/expect_ok.sql

\set name 'after full refund of line 1: vendor A balance 0, line refundable 0'
\ir _lib/try.sql
SELECT t_assert(fn_vendor_balance(:vendor_a) = 0, 'vendor A back to zero');
SELECT t_assert(refundable_paise = 0 AND refunded_paise = 149997, 'line exhausted')
  FROM v_order_line_allocation WHERE order_id = :o1 AND line_no = 1;
\ir _lib/expect_ok.sql
\set want PRR01
\set name 'request: nothing left to refund on line 1'
\ir _lib/try.sql
SELECT fn_request_refund(:customer_id, :o1, 1, 100, 'again', '52000000-0000-4000-8000-000000000005');
\ir _lib/expect_error.sql

-- ================================================================ whole order
\set name 'order status: partially_refunded, then refunded when line 2 is refunded in full'
\ir _lib/try.sql
SELECT t_assert(status = 'partially_refunded' AND refund_pending_paise = 50000, 'partial') FROM v_order_summary WHERE order_id = :o1;
SELECT fn_approve_refund(:fin_id, :rq_ok) \gset
SELECT refund_id AS rf6 FROM fn_request_refund(:customer_id, :o1, 2, 73456, 'rest', '52000000-0000-4000-8000-000000000006') \gset
SELECT fn_approve_refund(:fin_id, :rf6) \gset
SELECT t_assert(status = 'refunded' AND refunded_paise = 273453, 'refunded') FROM v_order_summary WHERE order_id = :o1;
SELECT t_assert(fn_vendor_balance(:vendor_b) = 0, 'vendor B back to zero');
\ir _lib/expect_ok.sql
\set name 'ledger: commission and GST fully reversed; clearing holds 0 (nothing settled); Σdebit = Σcredit'
\ir _lib/try.sql
SELECT t_assert(array_agg(code || '=' || balance_paise ORDER BY code) FILTER (WHERE code IN ('COMMISSION_REVENUE', 'GST_PAYABLE', 'GATEWAY_CLEARING'))
                = ARRAY['COMMISSION_REVENUE=0', 'GATEWAY_CLEARING=0', 'GST_PAYABLE=0'], 'balances')
  FROM v_account_balances;
SELECT t_assert(sum(debit_paise) = sum(credit_paise), 'trial balance') FROM v_account_balances;
\ir _lib/expect_ok.sql

-- ================================================================ small whole-remainder refund is allowed
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 1))) AS o2 \gset
SELECT payment_id AS pay2 FROM fn_initiate_payment(:customer_id, :o2, 'card', '53000000-0000-4000-8000-000000000000') \gset
SELECT fn_capture_payment(:pay2, 'pay_W3TEST0002', 49999) \gset
\set name 'request: 50 paise is allowed when it is exactly the remaining amount'
\ir _lib/try.sql
SELECT refund_id AS rf7 FROM fn_request_refund(:customer_id, :o2, 1, 49949, 'most', '53000000-0000-4000-8000-000000000001') \gset
SELECT fn_approve_refund(:fin_id, :rf7) \gset
SELECT refund_id AS rf8 FROM fn_request_refund(:customer_id, :o2, 1, 50, 'last 50 paise', '53000000-0000-4000-8000-000000000002') \gset
SELECT t_assert(status = 'processed', 'tiny final refund') FROM fn_approve_refund(:fin_id, :rf8);
SELECT t_assert(sum(debit_paise) = sum(credit_paise), 'trial balance') FROM v_account_balances;
SELECT t_assert(fn_vendor_balance(:vendor_a) = 0, 'vendor A zero again');
\ir _lib/expect_ok.sql
