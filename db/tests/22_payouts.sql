-- 22_payouts.sql — W2 stored workflows: fn_request_payout, fn_complete_payout
-- (paid / failed → one reversal), negative vendor balance after a late refund
-- and its recovery (Task 2, DEC-007, DEC-008).
--
-- Vendor A (10%) earns V = 132297 from 3 × ₹499.99 (see 12_capture_example).
\ir _lib/assert.sql
\ir _lib/fixtures.sql
RESET ROLE;
SET payrail.clock = '2026-10-05 11:00:00+05:30';
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 3),
                                                      jsonb_build_object('product_id', :prod_b, 'quantity', 1))) AS o1 \gset
SELECT payment_id AS pay1 FROM fn_initiate_payment(:customer_id, :o1, 'upi', '60000000-0000-4000-8000-0000000000aa') \gset
SELECT fn_capture_payment(:pay1, 'pay_W2TEST0001', 273453) \gset
SET payrail.clock = '2026-10-06 09:00:00+05:30';

-- ================================================================ request: validation
\set want PRA01
\set name 'request: a customer cannot request a payout'
\ir _lib/try.sql
SELECT fn_request_payout(:customer_id, 1000, '61000000-0000-4000-8000-000000000001');
\ir _lib/expect_error.sql
\set want PRV03
\set name 'request: a vendor whose KYC is pending cannot request a payout'
\ir _lib/try.sql
SELECT fn_request_payout(:pend_id, 1000, '61000000-0000-4000-8000-000000000002');
\ir _lib/expect_error.sql
\set want PRV07
\set name 'request: zero amount rejected'
\ir _lib/try.sql
SELECT fn_request_payout(:vik_id, 0, '61000000-0000-4000-8000-000000000003');
\ir _lib/expect_error.sql
\set want PRF01
\set name 'request: more than the available balance (132297) rejected'
\ir _lib/try.sql
SELECT fn_request_payout(:vik_id, 132298, '61000000-0000-4000-8000-000000000004');
\ir _lib/expect_error.sql

\set name 'no poisoning: the same key then succeeds for a valid amount; entry D vendor / C BANK'
\ir _lib/try.sql
SELECT payout_id AS po1, vendor_id AS po1_vendor, status AS po1_status
  FROM fn_request_payout(:vik_id, 100000, '61000000-0000-4000-8000-000000000004') \gset
SELECT t_assert(:po1_vendor = :vendor_a AND :'po1_status' = 'requested', 'own vendor, requested');
SELECT t_assert(array_agg(a.code || ' ' || l.direction || ' ' || l.amount_paise ORDER BY l.line_no)
                = ARRAY['VENDOR_PAYABLE_' || :vendor_a || ' D 100000', 'BANK C 100000'], 'lines')
  FROM journal_entries e JOIN ledger_lines l USING (entry_id) JOIN accounts a USING (account_id) WHERE e.payout_id = :po1;
SELECT t_assert(fn_vendor_balance(:vendor_a) = 32297, 'funds reserved at request');
\ir _lib/expect_ok.sql
\set name 'idempotency: replay returns the same payout, still one entry'
\ir _lib/try.sql
SELECT t_assert(payout_id = :po1, 'replay') FROM fn_request_payout(:vik_id, 100000, '61000000-0000-4000-8000-000000000004');
SELECT t_assert(count(*) = 1, 'one entry') FROM journal_entries WHERE payout_id = :po1;
SELECT t_assert(fn_vendor_balance(:vendor_a) = 32297, 'not reserved twice');
\ir _lib/expect_ok.sql
\set want PRI01
\set name 'idempotency: same key with a different amount rejected'
\ir _lib/try.sql
SELECT fn_request_payout(:vik_id, 1000, '61000000-0000-4000-8000-000000000004');
\ir _lib/expect_error.sql
\set want PRI01
\set name 'idempotency: same key from another vendor rejected'
\ir _lib/try.sql
SELECT fn_request_payout(:bela_id, 100000, '61000000-0000-4000-8000-000000000004');
\ir _lib/expect_error.sql
\set name 'request: exactly the whole remaining balance is allowed'
\ir _lib/try.sql
SELECT payout_id AS po2 FROM fn_request_payout(:vik_id, 32297, '61000000-0000-4000-8000-000000000005') \gset
SELECT t_assert(fn_vendor_balance(:vendor_a) = 0, 'zero');
\ir _lib/expect_ok.sql
\set want PRF01
\set name 'request: one paisa more is overspending'
\ir _lib/try.sql
SELECT fn_request_payout(:vik_id, 1, '61000000-0000-4000-8000-000000000006');
\ir _lib/expect_error.sql

-- ================================================================ completion
SET payrail.clock = '2026-10-07 12:00:00+05:30';
\set want PRA01
\set name 'complete: only finance'
\ir _lib/try.sql
SELECT fn_complete_payout(:vik_id, :po1, 'paid', 'UTR20261007001');
\ir _lib/expect_error.sql
\set want PRV07
\set name 'complete: paid needs a UTR'
\ir _lib/try.sql
SELECT fn_complete_payout(:fin_id, :po1, 'paid', NULL);
\ir _lib/expect_error.sql
\set want PRV07
\set name 'complete: failed must not carry a UTR'
\ir _lib/try.sql
SELECT fn_complete_payout(:fin_id, :po1, 'failed', 'UTR20261007001');
\ir _lib/expect_error.sql
\set want PRV07
\set name 'complete: unknown outcome'
\ir _lib/try.sql
SELECT fn_complete_payout(:fin_id, :po1, 'requested', NULL);
\ir _lib/expect_error.sql
\set want 23514
\set name 'complete: malformed UTR rejected by CHECK'
\ir _lib/try.sql
SELECT fn_complete_payout(:fin_id, :po1, 'paid', 'utr-1');
\ir _lib/expect_error.sql

\set name 'paid: records UTR and time; no second posting; replay harmless'
\ir _lib/try.sql
SELECT t_assert(status = 'paid' AND bank_utr = 'UTR20261007001'
                AND completed_at = '2026-10-07 12:00:00+05:30'::timestamptz, 'paid')
  FROM fn_complete_payout(:fin_id, :po1, 'paid', 'UTR20261007001');
SELECT t_assert(status = 'paid', 'replay') FROM fn_complete_payout(:fin_id, :po1, 'paid', 'UTR20261007001');
SELECT t_assert(count(*) = 1, 'only the request entry') FROM journal_entries WHERE payout_id = :po1;
SELECT t_assert(count(*) = 0, 'no reversal')
  FROM journal_entries WHERE reverses_entry_id = (SELECT entry_id FROM journal_entries WHERE payout_id = :po1);
\ir _lib/expect_ok.sql
\set want PRI01
\set name 'paid: replay with a different UTR rejected'
\ir _lib/try.sql
SELECT fn_complete_payout(:fin_id, :po1, 'paid', 'UTR20261007999');
\ir _lib/expect_error.sql
\set want PRS01
\set name 'paid: cannot become failed later'
\ir _lib/try.sql
SELECT fn_complete_payout(:fin_id, :po1, 'failed', NULL);
\ir _lib/expect_error.sql

\set name 'failed: exactly one reversal (D BANK / C vendor) restores the reserved funds'
\ir _lib/try.sql
SELECT t_assert(status = 'failed' AND bank_utr IS NULL AND completed_at IS NOT NULL, 'failed')
  FROM fn_complete_payout(:fin_id, :po2, 'failed', NULL);
SELECT entry_id AS e_po2 FROM journal_entries WHERE payout_id = :po2 \gset
SELECT t_assert(array_agg(a.code || ' ' || l.direction || ' ' || l.amount_paise ORDER BY l.line_no)
                = ARRAY['VENDOR_PAYABLE_' || :vendor_a || ' C 32297', 'BANK D 32297'], 'mirror lines')
  FROM journal_entries e JOIN ledger_lines l USING (entry_id) JOIN accounts a USING (account_id)
 WHERE e.reverses_entry_id = :e_po2 AND e.entry_type = 'reversal';
SELECT t_assert(fn_vendor_balance(:vendor_a) = 32297, 'funds restored');
\ir _lib/expect_ok.sql
\set name 'failed: a repeated failure callback does not reverse again'
\ir _lib/try.sql
SELECT t_assert(status = 'failed', 'replay') FROM fn_complete_payout(:fin_id, :po2, 'failed', NULL);
SELECT t_assert(count(*) = 1, 'one reversal') FROM journal_entries WHERE reverses_entry_id = :e_po2;
SELECT t_assert(fn_vendor_balance(:vendor_a) = 32297, 'restored exactly once');
\ir _lib/expect_ok.sql
\set want PRS01
\set name 'failed: cannot become paid later'
\ir _lib/try.sql
SELECT fn_complete_payout(:fin_id, :po2, 'paid', 'UTR20261007002');
\ir _lib/expect_error.sql
\set want 23505
\set name 'reversal: even the owner cannot reverse the same entry twice (UNIQUE reverses_entry_id)'
\ir _lib/try.sql
SET ROLE payrail_owner;
SELECT fn_reverse_entry(:e_po2, 'second reversal attempt');
\ir _lib/expect_error.sql
RESET ROLE;

-- ================================================================ negative balance after a late refund
SET payrail.clock = '2026-10-08 10:00:00+05:30';
\set name 'negative: vendor A pays out everything, then a late refund (V share 44100) is approved → balance −44100'
\ir _lib/try.sql
SELECT payout_id AS po3 FROM fn_request_payout(:vik_id, 32297, '62000000-0000-4000-8000-000000000001') \gset
SELECT t_assert(fn_vendor_balance(:vendor_a) = 0, 'zero');
SELECT refund_id AS rf1 FROM fn_request_refund(:customer_id, :o1, 1, 50000, 'late complaint', '62000000-0000-4000-8000-000000000002') \gset
SELECT fn_approve_refund(:fin_id, :rf1) \gset
SELECT t_assert(fn_vendor_balance(:vendor_a) = -44100, 'negative balance');
SELECT t_assert(balance_paise = -44100, 'view agrees') FROM v_account_balances WHERE vendor_id = :vendor_a;
\ir _lib/expect_ok.sql
\set want PRF01
\set name 'negative: no payout is possible while the balance is negative'
\ir _lib/try.sql
SELECT fn_request_payout(:vik_id, 1, '62000000-0000-4000-8000-000000000003');
\ir _lib/expect_error.sql
\set name 'recovery: a new sale (V 44099) brings the balance to −1; a second (V 88198) to 88197'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 1))) AS o2 \gset
SELECT payment_id AS pay2 FROM fn_initiate_payment(:customer_id, :o2, 'upi', '62000000-0000-4000-8000-000000000004') \gset
SELECT fn_capture_payment(:pay2, 'pay_W2TEST0002', 49999) \gset
SELECT t_assert(fn_vendor_balance(:vendor_a) = -1, 'still negative by 1 paisa');
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 2))) AS o3 \gset
SELECT payment_id AS pay3 FROM fn_initiate_payment(:customer_id, :o3, 'upi', '62000000-0000-4000-8000-000000000005') \gset
SELECT fn_capture_payment(:pay3, 'pay_W2TEST0003', 99998) \gset
SELECT t_assert(fn_vendor_balance(:vendor_a) = 88197, 'recovered');
\ir _lib/expect_ok.sql
\set want PRF01
\set name 'recovery: payouts still cannot overspend (88198 > 88197)'
\ir _lib/try.sql
SELECT fn_request_payout(:vik_id, 88198, '62000000-0000-4000-8000-000000000006');
\ir _lib/expect_error.sql
\set name 'recovery: paying out exactly the recovered balance works'
\ir _lib/try.sql
SELECT fn_request_payout(:vik_id, 88197, '62000000-0000-4000-8000-000000000006') \gset
SELECT t_assert(fn_vendor_balance(:vendor_a) = 0, 'zero');
\ir _lib/expect_ok.sql

\set name 'statement: the window-function running balance ends at the ledger balance for every vendor'
\ir _lib/try.sql
SELECT t_assert(bool_and(last_running = fn_vendor_balance(vendor_id)), 'running = balance')
  FROM (SELECT DISTINCT ON (vendor_id) vendor_id, running_balance_paise AS last_running
          FROM v_vendor_statement ORDER BY vendor_id, created_at DESC, entry_id DESC, line_no DESC) s;
SELECT t_assert(array_agg(running_balance_paise ORDER BY created_at, entry_id, line_no)
                = ARRAY[132297, 32297, 0, 32297, 0, -44100, -1, 88197, 0]::bigint[], 'vendor A path')
  FROM v_vendor_statement WHERE vendor_id = :vendor_a;
SELECT t_assert(sum(debit_paise) = sum(credit_paise), 'trial balance') FROM v_account_balances;
\ir _lib/expect_ok.sql
