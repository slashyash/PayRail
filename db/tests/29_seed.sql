-- 29_seed.sql — the deterministic seed (db/seed/seed.sql): size, ledger
-- integrity on realistic data, every demo scenario present, and
-- reproducibility (a second, independent build produces identical rows).
\ir _lib/assert.sql
\o /dev/null
\ir ../seed/seed.sql
\o
SET search_path = payrail, public;

\set name 'seed: at least 500 records in total, every relation populated'
\ir _lib/try.sql
SELECT t_assert(sum(n) >= 500 AND min(n) > 0, 'row counts') FROM (
  SELECT count(*) n FROM users UNION ALL SELECT count(*) FROM vendors UNION ALL SELECT count(*) FROM products
  UNION ALL SELECT count(*) FROM orders UNION ALL SELECT count(*) FROM order_items UNION ALL SELECT count(*) FROM payments
  UNION ALL SELECT count(*) FROM refunds UNION ALL SELECT count(*) FROM payouts UNION ALL SELECT count(*) FROM gateway_settlements
  UNION ALL SELECT count(*) FROM accounts UNION ALL SELECT count(*) FROM journal_entries UNION ALL SELECT count(*) FROM ledger_lines) c;
\ir _lib/expect_ok.sql

\set name 'ledger: Σdebit = Σcredit globally, and every entry has ≥ 2 lines and balances'
\ir _lib/try.sql
SELECT t_assert(sum(debit_paise) = sum(credit_paise), 'trial balance') FROM v_account_balances;
SELECT t_assert(count(*) = 0, 'no bad entry') FROM (
  SELECT e.entry_id FROM journal_entries e LEFT JOIN ledger_lines l USING (entry_id) GROUP BY e.entry_id
  HAVING count(l.line_no) < 2
      OR sum(l.amount_paise) FILTER (WHERE l.direction = 'D') IS DISTINCT FROM sum(l.amount_paise) FILTER (WHERE l.direction = 'C')) bad;
\ir _lib/expect_ok.sql

\set name 'captures: one capture entry per captured payment; payment amount = order total; none for failed'
\ir _lib/try.sql
SELECT t_assert(count(*) = (SELECT count(*) FROM payments WHERE status = 'captured'), 'one entry each')
  FROM journal_entries e JOIN payments p USING (payment_id) WHERE e.entry_type = 'capture' AND p.status = 'captured';
SELECT t_assert(count(*) = 0, 'no posting for non-captured') FROM journal_entries e JOIN payments p USING (payment_id) WHERE p.status <> 'captured';
SELECT t_assert(bool_and(p.amount_paise = fn_order_total(p.order_id)), 'amounts') FROM payments p WHERE p.status = 'captured';
\ir _lib/expect_ok.sql

\set name 'refunds: fully refunded lines reverse their exact commission, GST and vendor share'
\ir _lib/try.sql
WITH full_lines AS (
  SELECT order_id, line_no, commission_paise, gst_paise, vendor_paise FROM v_order_line_allocation
   WHERE refunded_paise = line_total_paise),
deltas AS (
  SELECT f.order_id, f.line_no,
         sum(l.amount_paise) FILTER (WHERE a.code = 'COMMISSION_REVENUE') AS c,
         sum(l.amount_paise) FILTER (WHERE a.code = 'GST_PAYABLE')        AS g,
         sum(CASE WHEN l.direction = 'D' THEN l.amount_paise ELSE -l.amount_paise END) FILTER (WHERE a.owner_type = 'vendor') AS v
    FROM refunds f JOIN journal_entries e USING (refund_id) JOIN ledger_lines l USING (entry_id) JOIN accounts a USING (account_id)
   GROUP BY f.order_id, f.line_no)
SELECT t_assert(count(*) > 0 AND bool_and(coalesce(d.c, 0) = fl.commission_paise AND coalesce(d.g, 0) = fl.gst_paise
                                         AND d.v = fl.vendor_paise), 'exact')
  FROM full_lines fl JOIN deltas d USING (order_id, line_no);
SELECT t_assert(count(*) >= 1, 'a line with 3+ partial refunds exists')
  FROM (SELECT order_id, line_no FROM refunds WHERE status = 'processed' GROUP BY 1, 2 HAVING count(*) >= 3) m;
\ir _lib/expect_ok.sql

\set name 'payouts: each failed payout reversed exactly once, paid/requested ones never'
\ir _lib/try.sql
SELECT t_assert(bool_and((p.status = 'failed') = (r.n = 1)) AND max(r.n) <= 1, 'reversals')
  FROM payouts p JOIN journal_entries e USING (payout_id)
  CROSS JOIN LATERAL (SELECT count(*) AS n FROM journal_entries x WHERE x.reverses_entry_id = e.entry_id) r;
\ir _lib/expect_ok.sql

\set name 'scenario: vendor 3 went negative after a late refund and recovered; vendor 7 ends negative'
\ir _lib/try.sql
SELECT t_assert(min(running_balance_paise) < 0, 'v3 dipped') FROM v_vendor_statement WHERE vendor_id = 3;
SELECT t_assert(fn_vendor_balance(3) > 0, 'v3 recovered');
SELECT t_assert(fn_vendor_balance(7) < 0, 'v7 negative at the end');
SELECT t_assert(bool_and(s.last = fn_vendor_balance(s.vendor_id)), 'statement = balance')
  FROM (SELECT DISTINCT ON (vendor_id) vendor_id, running_balance_paise AS last FROM v_vendor_statement
         ORDER BY vendor_id, created_at DESC, entry_id DESC, line_no DESC) s;
\ir _lib/expect_ok.sql

\set name 'scenario: every reconciliation category is present at the demo date 2026-10-31; only matched rows are posted'
\ir _lib/try.sql
SELECT t_assert(array_agg(DISTINCT category ORDER BY category)
                = '{amount_mismatch,in_transit,matched,overdue_missing,unknown_reference}', 'categories')
  FROM fn_reconciliation_report('2026-10-31');
SELECT t_assert(bool_and((category = 'matched') = (posted_entry_id IS NOT NULL)), 'posting rule')
  FROM fn_reconciliation_report('2026-10-31') WHERE settlement_id IS NOT NULL;
SELECT t_assert(category = 'matched' AND posted_entry_id IS NOT NULL, 'late callback matched by fn_reconcile')
  FROM fn_reconciliation_report('2026-10-31') WHERE gateway_ref = 'pay_LATECB000001';
\ir _lib/expect_ok.sql

\set name 'scenario: all workflow states and catalogue cases are represented'
\ir _lib/try.sql
SELECT t_assert((SELECT array_agg(DISTINCT status ORDER BY status) FROM payments) = '{captured,failed,initiated}', 'payments');
SELECT t_assert((SELECT array_agg(DISTINCT status ORDER BY status) FROM refunds)  = '{processed,rejected,requested}', 'refunds');
SELECT t_assert((SELECT array_agg(DISTINCT status ORDER BY status) FROM payouts)  = '{failed,paid,requested}', 'payouts');
SELECT t_assert((SELECT array_agg(DISTINCT kyc_status ORDER BY kyc_status) FROM vendors) = '{pending,rejected,verified}', 'kyc');
SELECT t_assert((SELECT array_agg(DISTINCT status ORDER BY status) FROM v_order_summary)
                = '{paid,partially_refunded,pending_payment,refunded}', 'order statuses');
SELECT t_assert(EXISTS (SELECT 1 FROM products p WHERE NOT is_active AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.product_id)), 'archived, referenced product');
SELECT t_assert(EXISTS (SELECT 1 FROM products p WHERE NOT is_active AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.product_id)), 'deletable draft product');
SELECT t_assert(EXISTS (SELECT 1 FROM order_items WHERE quantity > 3), 'aggregated quantities');
SELECT t_assert((SELECT count(*) FROM (SELECT order_id FROM v_order_line_allocation GROUP BY 1 HAVING count(DISTINCT vendor_id) > 1) m) > 0, 'multi-vendor orders');
\ir _lib/expect_ok.sql

\set name 'seed: demo logins use a bcrypt hash of the documented password'
\ir _lib/try.sql
SELECT t_assert(bool_and(password_hash = crypt('PayRail@2026', password_hash)), 'bcrypt') FROM users;
SELECT t_assert(count(*) = 3, 'one per role in the named demo accounts')
  FROM users WHERE email IN ('finance@payrail.demo', 'vendor1@payrail.demo', 'customer1@payrail.demo');
\ir _lib/expect_ok.sql

-- ---------------------------------------------------------------- reproducibility
-- Fingerprint of everything the seed produced that is not random by design
-- (bcrypt salts are random, so password hashes are excluded).
SELECT md5(string_agg(x, '|' ORDER BY x)) AS fp1 FROM (
  SELECT 'L' || entry_id || ':' || line_no || ':' || account_id || direction || amount_paise AS x FROM ledger_lines
  UNION ALL SELECT 'E' || entry_id || ':' || entry_type || ':' || created_at || ':' || description FROM journal_entries
  UNION ALL SELECT 'P' || payment_id || ':' || order_id || ':' || status || ':' || amount_paise || ':' || coalesce(gateway_ref, '') || ':' || idempotency_key FROM payments
  UNION ALL SELECT 'R' || refund_id || ':' || status || ':' || amount_paise || ':' || requested_at FROM refunds
  UNION ALL SELECT 'O' || payout_id || ':' || status || ':' || amount_paise || ':' || coalesce(bank_utr, '') FROM payouts
  UNION ALL SELECT 'S' || settlement_id || ':' || gateway_ref || ':' || gross_paise || ':' || fee_paise || ':' || settled_on FROM gateway_settlements
  UNION ALL SELECT 'I' || order_id || ':' || line_no || ':' || product_id || ':' || quantity FROM order_items) f \gset
SELECT current_database() AS db1 \gset
\! PAYRAIL_SKIP_SEED=1 ../reset_dev.sh --yes payrail_test_seed2 > /dev/null 2>&1
\c payrail_test_seed2
\ir _lib/assert.sql
\o /dev/null
\ir ../seed/seed.sql
\o
SET search_path = payrail, public;
\set name 'reproducibility: an independent second build + seed yields an identical fingerprint'
\ir _lib/try.sql
SELECT t_assert(md5(string_agg(x, '|' ORDER BY x)) = :'fp1', 'same rows') FROM (
  SELECT 'L' || entry_id || ':' || line_no || ':' || account_id || direction || amount_paise AS x FROM ledger_lines
  UNION ALL SELECT 'E' || entry_id || ':' || entry_type || ':' || created_at || ':' || description FROM journal_entries
  UNION ALL SELECT 'P' || payment_id || ':' || order_id || ':' || status || ':' || amount_paise || ':' || coalesce(gateway_ref, '') || ':' || idempotency_key FROM payments
  UNION ALL SELECT 'R' || refund_id || ':' || status || ':' || amount_paise || ':' || requested_at FROM refunds
  UNION ALL SELECT 'O' || payout_id || ':' || status || ':' || amount_paise || ':' || coalesce(bank_utr, '') FROM payouts
  UNION ALL SELECT 'S' || settlement_id || ':' || gateway_ref || ':' || gross_paise || ':' || fee_paise || ':' || settled_on FROM gateway_settlements
  UNION ALL SELECT 'I' || order_id || ':' || line_no || ':' || product_id || ':' || quantity FROM order_items) f;
\ir _lib/expect_ok.sql
\c :db1
DROP DATABASE payrail_test_seed2 WITH (FORCE);

-- Printed for docs/TEST_EVIDENCE.md when run directly
\echo seed fingerprint :fp1
