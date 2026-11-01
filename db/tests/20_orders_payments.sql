-- 20_orders_payments.sql — W1 stored workflows: fn_place_order,
-- fn_initiate_payment, fn_capture_payment, fn_fail_payment (Task 2).
-- Runs as the administrator; the workflow functions run as payrail_owner.
\ir _lib/assert.sql
\ir _lib/fixtures.sql
RESET ROLE;
SET payrail.clock = '2026-10-05 11:00:00+05:30';

-- ================================================================ fn_place_order
\set name 'place order: repeated product aggregates into one line, lines numbered by first appearance, snapshots taken'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, jsonb_build_array(
         jsonb_build_object('product_id', :prod_a, 'quantity', 2),
         jsonb_build_object('product_id', :'prod_b', 'quantity', '1'),      -- ids/quantities may be strings
         jsonb_build_object('product_id', :prod_a, 'quantity', 1))) AS o1 \gset
SELECT t_assert(array_agg(ARRAY[line_no, product_id, quantity, unit_price_paise, commission_bps] ORDER BY line_no)
                = ARRAY[[1, :prod_a, 3, 49999, 1000], [2, :prod_b, 1, 123456, 250]]::bigint[], 'lines')
  FROM order_items WHERE order_id = :o1;
SELECT t_assert(total_paise = 273453 AND status = 'pending_payment', 'summary') FROM v_order_summary WHERE order_id = :o1;
\ir _lib/expect_ok.sql

SELECT count(*) AS orders_before FROM orders \gset
\set want PRV07
\set name 'place order: aggregated quantity 60 + 50 > 100 rejected'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 60),
                                                      jsonb_build_object('product_id', :prod_a, 'quantity', 50)));
\ir _lib/expect_error.sql
\set name 'place order: empty cart rejected'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, '[]');
\ir _lib/expect_error.sql
\set name 'place order: quantity 0 rejected'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 0)));
\ir _lib/expect_error.sql
\set name 'place order: non-integer quantity rejected'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 1.5)));
\ir _lib/expect_error.sql
\set name 'place order: items must be a JSON array'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, '{"product_id": 1, "quantity": 1}');
\ir _lib/expect_error.sql
\set name 'place order: a client-supplied price is ignored — the catalogue price is snapshotted'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, jsonb_build_array(
         jsonb_build_object('product_id', :prod_a, 'quantity', 1, 'unit_price_paise', 1, 'commission_bps', 0))) AS o_cheat \gset
SELECT t_assert(unit_price_paise = 49999 AND commission_bps = 1000, 'catalogue values') FROM order_items WHERE order_id = :o_cheat;
\ir _lib/expect_ok.sql
SELECT count(*) AS orders_before FROM orders \gset

\set want PRN01
\set name 'place order: unknown product rejected'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, '[{"product_id": 999999, "quantity": 1}]');
\ir _lib/expect_error.sql
\set want PRV03
\set name 'place order: product of an unverified vendor rejected'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_p, 'quantity', 1)));
\ir _lib/expect_error.sql
SET ROLE payrail_owner;
UPDATE products SET is_active = false WHERE product_id = :prod_b;
RESET ROLE;
\set want PRV04
\set name 'place order: archived (inactive) product rejected'
\ir _lib/try.sql
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_b, 'quantity', 1)));
\ir _lib/expect_error.sql
SET ROLE payrail_owner;
UPDATE products SET is_active = true WHERE product_id = :prod_b;
RESET ROLE;
\set want PRA01
\set name 'place order: a vendor_admin cannot place orders'
\ir _lib/try.sql
SELECT fn_place_order(:vik_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 1)));
\ir _lib/expect_error.sql

\set name 'place order: rejected calls left no order rows behind'
\ir _lib/try.sql
SELECT t_assert(count(*) = :orders_before, 'no new orders') FROM orders;
\ir _lib/expect_ok.sql

-- ================================================================ fn_initiate_payment
\set name 'initiate: amount is the derived order total; replay with same key returns the same attempt'
\ir _lib/try.sql
SELECT payment_id AS pay1, amount_paise AS amt1, status AS st FROM
  fn_initiate_payment(:customer_id, :o1, 'upi', '10000000-0000-4000-8000-000000000001') \gset
SELECT t_assert(:amt1 = 273453 AND :'st' = 'initiated', 'amount from order');
SELECT t_assert(payment_id = :pay1, 'replay') FROM fn_initiate_payment(:customer_id, :o1, 'upi', '10000000-0000-4000-8000-000000000001');
SELECT t_assert(count(*) = 1, 'one row') FROM payments WHERE order_id = :o1;
\ir _lib/expect_ok.sql

\set want PRI01
\set name 'initiate: same key with a different method is an idempotency conflict'
\ir _lib/try.sql
SELECT fn_initiate_payment(:customer_id, :o1, 'card', '10000000-0000-4000-8000-000000000001');
\ir _lib/expect_error.sql
\set want PRA01
\set name 'initiate: another user cannot pay this customer''s order'
\ir _lib/try.sql
SELECT fn_initiate_payment(:fin_id, :o1, 'upi', '10000000-0000-4000-8000-000000000002');
\ir _lib/expect_error.sql
\set want PRN01
\set name 'initiate: unknown order'
\ir _lib/try.sql
SELECT fn_initiate_payment(:customer_id, 999999, 'upi', '10000000-0000-4000-8000-000000000003');
\ir _lib/expect_error.sql
\set want 23514
\set name 'initiate: invalid method rejected by CHECK'
\ir _lib/try.sql
SELECT fn_initiate_payment(:customer_id, :o1, 'cash', '10000000-0000-4000-8000-000000000004');
\ir _lib/expect_error.sql

-- ================================================================ fn_capture_payment
\set want PRP01
\set name 'capture: callback amount ≠ order total rejected'
\ir _lib/try.sql
SELECT fn_capture_payment(:pay1, 'pay_W1TEST0001', 273452);
\ir _lib/expect_error.sql
\set name 'capture: after the mismatch the payment is still initiated and nothing was posted'
\ir _lib/try.sql
SELECT t_assert(status = 'initiated' AND gateway_ref IS NULL, 'unchanged') FROM payments WHERE payment_id = :pay1;
SELECT t_assert(count(*) = 0, 'no entries') FROM journal_entries;
\ir _lib/expect_ok.sql

\set want PRX01
\set name 'capture: refused under REPEATABLE READ (locking protocol needs READ COMMITTED)'
BEGIN ISOLATION LEVEL REPEATABLE READ;
\ir _lib/try.sql
SELECT fn_capture_payment(:pay1, 'pay_W1TEST0001', 273453);
\ir _lib/expect_error_rollback.sql

\set name 'capture: payment captured and ONE capture entry with the five hand-computed lines'
\ir _lib/try.sql
SELECT t_assert(status = 'captured' AND gateway_ref = 'pay_W1TEST0001'
                AND captured_at = '2026-10-05 11:00:00+05:30'::timestamptz, 'captured')
  FROM fn_capture_payment(:pay1, 'pay_W1TEST0001', 273453);
SELECT entry_id AS e_cap FROM journal_entries WHERE payment_id = :pay1 \gset
SELECT t_assert(array_agg(a.code || ' ' || l.direction || ' ' || l.amount_paise ORDER BY l.line_no)
                = ARRAY['GATEWAY_CLEARING D 273453',
                        'VENDOR_PAYABLE_' || :vendor_a || ' C 132297',
                        'VENDOR_PAYABLE_' || :vendor_b || ' C 119815',
                        'COMMISSION_REVENUE C 18086',
                        'GST_PAYABLE C 3255'], 'capture lines')
  FROM ledger_lines l JOIN accounts a USING (account_id) WHERE l.entry_id = :e_cap;
SELECT t_assert(status = 'paid', 'order paid') FROM v_order_summary WHERE order_id = :o1;
\ir _lib/expect_ok.sql

\set name 'capture: duplicate callback (same ref, same amount) is harmless — still one entry'
\ir _lib/try.sql
SELECT t_assert(status = 'captured', 'replay') FROM fn_capture_payment(:pay1, 'pay_W1TEST0001', 273453);
SELECT t_assert(count(*) = 1, 'one capture entry') FROM journal_entries WHERE payment_id = :pay1;
\ir _lib/expect_ok.sql
\set want PRI01
\set name 'capture: retry with a different gateway ref after capture rejected'
\ir _lib/try.sql
SELECT fn_capture_payment(:pay1, 'pay_W1OTHER0001', 273453);
\ir _lib/expect_error.sql
\set want PRS01
\set name 'capture: a failure callback after capture cannot switch the outcome'
\ir _lib/try.sql
SELECT fn_fail_payment(:pay1, 'pay_W1TEST0001');
\ir _lib/expect_error.sql
\set want PRS02
\set name 'initiate: a new attempt on a paid order is rejected'
\ir _lib/try.sql
SELECT fn_initiate_payment(:customer_id, :o1, 'card', '10000000-0000-4000-8000-000000000005');
\ir _lib/expect_error.sql
\set name 'initiate: replaying the ORIGINAL key on the paid order still returns the captured attempt'
\ir _lib/try.sql
SELECT t_assert(payment_id = :pay1 AND status = 'captured', 'replay after capture')
  FROM fn_initiate_payment(:customer_id, :o1, 'upi', '10000000-0000-4000-8000-000000000001');
\ir _lib/expect_ok.sql

-- ================================================================ failure then retry
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 1))) AS o2 \gset
SELECT payment_id AS pay2a FROM fn_initiate_payment(:customer_id, :o2, 'card', '20000000-0000-4000-8000-000000000001') \gset

\set name 'fail: initiated → failed, no posting; a repeated failure callback is harmless'
\ir _lib/try.sql
SELECT t_assert(status = 'failed', 'failed') FROM fn_fail_payment(:pay2a, 'pay_W1FAIL0001');
SELECT t_assert(status = 'failed', 'replay') FROM fn_fail_payment(:pay2a, 'pay_W1FAIL0001');
SELECT t_assert(count(*) = 0, 'no posting') FROM journal_entries WHERE payment_id = :pay2a;
\ir _lib/expect_ok.sql
\set want PRS01
\set name 'fail: a success callback after failure cannot switch the outcome'
\ir _lib/try.sql
SELECT fn_capture_payment(:pay2a, 'pay_W1FAIL0001', 49999);
\ir _lib/expect_error.sql
\set name 'retry: a new attempt (new key) after a failure can be captured'
\ir _lib/try.sql
SELECT payment_id AS pay2b FROM fn_initiate_payment(:customer_id, :o2, 'upi', '20000000-0000-4000-8000-000000000002') \gset
SELECT t_assert(status = 'captured', 'captured') FROM fn_capture_payment(:pay2b, 'pay_W1RETRY0001', 49999);
SELECT t_assert(status = 'paid' AND captured_payment_id = :pay2b, 'order paid') FROM v_order_summary WHERE order_id = :o2;
\ir _lib/expect_ok.sql

-- ================================================================ two open attempts, one capture
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_b, 'quantity', 2))) AS o3 \gset
SELECT payment_id AS pay3a FROM fn_initiate_payment(:customer_id, :o3, 'upi',  '30000000-0000-4000-8000-000000000001') \gset
SELECT payment_id AS pay3b FROM fn_initiate_payment(:customer_id, :o3, 'card', '30000000-0000-4000-8000-000000000002') \gset
SELECT fn_capture_payment(:pay3a, 'pay_W1DOUBLE0001', 246912) \gset
\set want PRS02
\set name 'capture: second attempt of an already-paid order cannot be captured (one capture per order)'
\ir _lib/try.sql
SELECT fn_capture_payment(:pay3b, 'pay_W1DOUBLE0002', 246912);
\ir _lib/expect_error.sql
\set name 'capture: the losing attempt stays initiated and can be failed by the gateway'
\ir _lib/try.sql
SELECT t_assert(status = 'failed', 'failed') FROM fn_fail_payment(:pay3b, NULL);
SELECT t_assert(count(*) = 1, 'one captured') FROM payments WHERE order_id = :o3 AND status = 'captured';
\ir _lib/expect_ok.sql

-- ================================================================ atomicity inside the function
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 4))) AS o4 \gset
SELECT payment_id AS pay4 FROM fn_initiate_payment(:customer_id, :o4, 'upi', '40000000-0000-4000-8000-000000000001') \gset
SELECT count(*) AS entries_before FROM journal_entries \gset
\set want 23505
\set name 'atomicity: capture with a gateway ref already used by another payment fails as a whole'
\ir _lib/try.sql
SELECT fn_capture_payment(:pay4, 'pay_W1TEST0001', 199996);
\ir _lib/expect_error.sql
\set name 'atomicity: … payment still initiated, no entry, no lines'
\ir _lib/try.sql
SELECT t_assert(status = 'initiated', 'unchanged') FROM payments WHERE payment_id = :pay4;
SELECT t_assert(count(*) = :entries_before, 'no new entry') FROM journal_entries;
\ir _lib/expect_ok.sql
\set want 22012
\set name 'atomicity: a successful capture followed by an error in the same transaction'
BEGIN;
SELECT status AS st4 FROM fn_capture_payment(:pay4, 'pay_W1ATOMIC0001', 199996) \gset
SELECT t_assert(:'st4' = 'captured' AND (SELECT count(*) FROM journal_entries) = :entries_before + 1, 'captured inside the txn');
\ir _lib/try.sql
SELECT 1 / 0;
\ir _lib/expect_error_rollback.sql
\set name 'atomicity: … nothing of the capture survived'
\ir _lib/try.sql
SELECT t_assert(status = 'initiated' AND gateway_ref IS NULL, 'unchanged') FROM payments WHERE payment_id = :pay4;
SELECT t_assert(count(*) = :entries_before, 'no new entry') FROM journal_entries;
SELECT t_assert(fn_vendor_balance(:vendor_a) = 132297 + 44099, 'vendor A balance unchanged');
\ir _lib/expect_ok.sql

-- ================================================================ accounts
\set name 'accounts: a new vendor gets exactly one payable account, found by fn_vendor_payable_account'
\ir _lib/try.sql
SET ROLE payrail_owner;
INSERT INTO users (full_name, email, role, password_hash)
VALUES ('New Vendor', 'newv@test.local', 'vendor_admin', crypt('pw', gen_salt('bf', 4))) RETURNING user_id AS newv_user \gset
INSERT INTO vendors (owner_user_id, legal_name, commission_bps, kyc_status)
VALUES (:newv_user, 'New Vendor Co', 0, 'verified') RETURNING vendor_id AS vendor_n \gset
RESET ROLE;
SELECT t_assert(count(*) = 1 AND min(code) = 'VENDOR_PAYABLE_' || :vendor_n, 'one account')
  FROM accounts WHERE vendor_id = :vendor_n;
SELECT t_assert(fn_vendor_payable_account(:vendor_n) = (SELECT account_id FROM accounts WHERE vendor_id = :vendor_n), 'lookup');
SELECT t_assert(fn_vendor_balance(:vendor_n) = 0, 'zero balance');
\ir _lib/expect_ok.sql
\set want 23505
\set name 'accounts: a second payable account for the same vendor rejected (UNIQUE NULLS NOT DISTINCT slot)'
\ir _lib/try.sql
SET ROLE payrail_owner;
INSERT INTO accounts (code, owner_type, vendor_id, account_class) VALUES ('VENDOR_PAYABLE_X', 'vendor', :vendor_n, 'liability');
\ir _lib/expect_error.sql
RESET ROLE;
\set want PRL04
\set name 'accounts: lookup of a missing account raises instead of returning NULL'
\ir _lib/try.sql
SELECT fn_account('NO_SUCH_ACCOUNT');
\ir _lib/expect_error.sql

\set name 'ledger: Σdebit = Σcredit after all W1 operations'
\ir _lib/try.sql
SELECT t_assert(sum(debit_paise) = sum(credit_paise), 'trial balance') FROM v_account_balances;
\ir _lib/expect_ok.sql
