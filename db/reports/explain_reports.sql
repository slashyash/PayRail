-- db/reports/explain_reports.sql — EXPLAIN (ANALYZE, BUFFERS) of the six
-- reports on the SEEDED database, plus one index experiment (Task 6).
--
--   psql -X -d payrail -f db/reports/explain_reports.sql > explain.txt
--   (Docker: docker compose exec -T db psql -U postgres -X -d payrail -f /payrail/db/reports/explain_reports.sql)
--
-- Run as the administrator (needs LOAD 'auto_explain' and, for the index
-- experiment, DROP INDEX). The experiment runs inside BEGIN … ROLLBACK, so the
-- index is never really dropped; nothing in the database changes. While it
-- runs it holds an exclusive lock on ledger_lines — do not run during a demo.
-- Timings depend on the machine; compare plan shapes and buffer counts.
\set ON_ERROR_STOP 1
SET search_path = payrail;
ANALYZE;

\echo '=== R1 fn_report_trial_balance()'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM fn_report_trial_balance();

\echo '=== R2 fn_report_vendor_statement(3, 2026-10-01, 2026-10-15)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM fn_report_vendor_statement(3, '2026-10-01', '2026-10-15');

\echo '=== R3 fn_report_monthly_performance()'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM fn_report_monthly_performance();

\echo '=== R4 fn_report_vendor_refund_risk()'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM fn_report_vendor_refund_risk();

\echo '=== R5 fn_report_settlement_aging(2026-10-31) — outer query (inlined)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM fn_report_settlement_aging('2026-10-31');

\echo '=== R5 inner plan: fn_reconciliation_report has a pinned search_path, so it is not'
\echo '    inlined; auto_explain prints the plan of the statement it runs (LOG lines below)'
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_analyze = on;
SET auto_explain.log_buffers = on;
SET auto_explain.log_timing = off;
SET auto_explain.log_nested_statements = on;
SET client_min_messages = log;
SELECT count(*) AS reconciliation_rows FROM fn_reconciliation_report('2026-10-31');
RESET client_min_messages;
SET auto_explain.log_min_duration = -1;

\echo '=== R6 fn_report_vendor_payables(3)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM fn_report_vendor_payables(3);

\echo '=== Index experiment on ledger_lines_account_entry_idx (account_id, entry_id)'
\echo '    (a) R2 for one vendor and (b) the body of fn_vendor_balance(3) — the balance read'
\echo '    inside every payout / refund workflow — first WITHOUT the index (BEGIN … DROP INDEX'
\echo '    … ROLLBACK, so it is restored), then WITH it.'
BEGIN;
DROP INDEX ledger_lines_account_entry_idx;
\echo '--- (a) R2 without the index'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM fn_report_vendor_statement(3, '2026-10-01', '2026-10-15');
\echo '--- (b) balance query without the index'
EXPLAIN (ANALYZE, BUFFERS)
SELECT coalesce(sum(CASE WHEN l.direction = 'C' THEN l.amount_paise ELSE -l.amount_paise END), 0)
  FROM ledger_lines l WHERE l.account_id = fn_vendor_payable_account(3);
ROLLBACK;
\echo '--- (b) balance query with the index'
EXPLAIN (ANALYZE, BUFFERS)
SELECT coalesce(sum(CASE WHEN l.direction = 'C' THEN l.amount_paise ELSE -l.amount_paise END), 0)
  FROM ledger_lines l WHERE l.account_id = fn_vendor_payable_account(3);
SELECT count(*) AS index_still_present FROM pg_indexes WHERE indexname = 'ledger_lines_account_entry_idx';

\echo '=== Other secondary indexes on the API read paths (31_indexes.sql)'
\echo '--- customer order history: orders_customer_created_idx'
EXPLAIN (ANALYZE, BUFFERS) SELECT order_id, created_at FROM orders WHERE customer_id = 20 ORDER BY created_at DESC LIMIT 20;
\echo '--- finance refund queue: refunds_pending_idx (partial) — table is 1 page, a seq scan is expected'
EXPLAIN (ANALYZE, BUFFERS) SELECT refund_id FROM refunds WHERE status = 'requested' ORDER BY requested_at;
\echo '--- table sizes behind these plans'
SELECT relname, relpages, reltuples::bigint FROM pg_class
 WHERE relnamespace = 'payrail'::regnamespace AND relkind = 'r' ORDER BY relpages DESC;
