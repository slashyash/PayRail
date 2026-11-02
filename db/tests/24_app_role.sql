-- 24_app_role.sql — the workflows as the REAL application login payrail_app
-- (a separate connection, not SET ROLE): the backend can run every business
-- workflow, cannot call the internal posting helpers, cannot backdate, and
-- the functions re-check the actor's role and ownership (Task 2, DEC-022).
\ir _lib/assert.sql
SELECT current_user AS admin_user \gset
\ir _lib/fixtures.sql
RESET ROLE;

\c - payrail_app
SET search_path = payrail, public;

\set name 'app: W1 end to end — place order, initiate, capture (clock ignored: stamped with real time)'
\ir _lib/try.sql
SET payrail.clock = '2020-01-01 00:00:00+05:30';
SELECT fn_place_order(:customer_id, jsonb_build_array(jsonb_build_object('product_id', :prod_a, 'quantity', 2))) AS o1 \gset
SELECT payment_id AS p1 FROM fn_initiate_payment(:customer_id, :o1, 'upi', '80000000-0000-4000-8000-000000000001') \gset
SELECT t_assert(status = 'captured' AND captured_at > '2026-01-01'::timestamptz, 'captured now')
  FROM fn_capture_payment(:p1, 'pay_APP0000001', 99998);
SELECT t_assert(created_at > '2026-01-01'::timestamptz, 'entry not backdated') FROM journal_entries WHERE payment_id = :p1;
RESET payrail.clock;
\ir _lib/expect_ok.sql
\set name 'app: W3 — refund request and finance approval'
\ir _lib/try.sql
SELECT refund_id AS r1 FROM fn_request_refund(:customer_id, :o1, 1, 10000, 'app test', '80000000-0000-4000-8000-000000000002') \gset
SELECT t_assert(status = 'processed', 'processed') FROM fn_approve_refund(:fin_id, :r1);
\ir _lib/expect_ok.sql
\set name 'app: W2 — payout request, completion as failed (reversal)'
\ir _lib/try.sql
SELECT payout_id AS po1 FROM fn_request_payout(:vik_id, 50000, '80000000-0000-4000-8000-000000000003') \gset
SELECT t_assert(status = 'failed', 'failed') FROM fn_complete_payout(:fin_id, :po1, 'failed', NULL);
SELECT t_assert(count(*) = 1, 'one reversal') FROM journal_entries WHERE entry_type = 'reversal';
\ir _lib/expect_ok.sql
\set name 'app: W4 — settlement import and reconciliation'
\ir _lib/try.sql
SELECT t_assert(result = 'inserted' AND entry_id IS NOT NULL, 'posted')
  FROM fn_record_settlement(:fin_id, 'pay_APP0000001', 'payment', 99998, 0, current_date);
SELECT t_assert(sum(items) >= 2, 'summary') FROM fn_reconcile(:fin_id, current_date);
SELECT t_assert(count(*) >= 2, 'report readable') FROM fn_reconciliation_report(current_date);
\ir _lib/expect_ok.sql

\set want PRA01
\set name 'app: a customer id cannot approve refunds (finance-only, checked in the database too)'
\ir _lib/try.sql
SELECT fn_approve_refund(:customer_id, :r1);
\ir _lib/expect_error.sql
\set want PRA01
\set name 'app: a vendor admin cannot complete its own payout'
\ir _lib/try.sql
SELECT fn_complete_payout(:vik_id, :po1, 'paid', 'UTR20261101001');
\ir _lib/expect_error.sql
\set want PRA01
\set name 'app: the finance admin cannot request a vendor payout'
\ir _lib/try.sql
SELECT fn_request_payout(:fin_id, 1, '80000000-0000-4000-8000-000000000004');
\ir _lib/expect_error.sql

\set want 42501
\set name 'app: internal fn_reverse_entry not executable'
\ir _lib/try.sql
SELECT fn_reverse_entry(1, 'x');
\ir _lib/expect_error.sql
\set name 'app: internal fn_try_post_settlement not executable'
\ir _lib/try.sql
SELECT fn_try_post_settlement(1);
\ir _lib/expect_error.sql
\set name 'app: internal fn_lock_vendor_accounts not executable'
\ir _lib/try.sql
SELECT fn_lock_vendor_accounts(ARRAY[1]::bigint[]);
\ir _lib/expect_error.sql
\set name 'app: internal fn_require_role not executable'
\ir _lib/try.sql
SELECT fn_require_role(1, 'customer');
\ir _lib/expect_error.sql
\set name 'app: still no direct INSERT into payouts (only through the workflow)'
\ir _lib/try.sql
INSERT INTO payouts (vendor_id, amount_paise, idempotency_key) VALUES (:vendor_a, 1, gen_random_uuid());
\ir _lib/expect_error.sql
\set name 'app: still no direct UPDATE of refunds'
\ir _lib/try.sql
UPDATE refunds SET status = 'processed' WHERE refund_id = :r1;
\ir _lib/expect_error.sql

\set name 'app: workflow functions are SECURITY DEFINER with a pinned search_path'
\ir _lib/try.sql
SELECT t_assert(bool_and(p.prosecdef AND p.proconfig @> ARRAY['search_path=payrail, pg_temp']), 'definer + search_path')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'payrail' AND p.proname IN ('fn_place_order', 'fn_initiate_payment', 'fn_capture_payment', 'fn_fail_payment',
       'fn_request_refund', 'fn_approve_refund', 'fn_reject_refund', 'fn_request_payout', 'fn_complete_payout',
       'fn_record_settlement', 'fn_reconcile');
SELECT t_assert(count(*) = 11, 'all eleven found (plus no other fn_ definer)')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'payrail' AND p.prosecdef AND p.proname LIKE 'fn\_%';
SELECT t_assert(sum(debit_paise) = sum(credit_paise), 'trial balance') FROM v_account_balances;
\ir _lib/expect_ok.sql

\c - :admin_user
