-- Like expect_error.sql, but for a check made INSIDE an explicit transaction:
-- the statement since try.sql must have failed with SQLSTATE :want; the
-- (aborted) transaction is then rolled back and the result evaluated.
\if :ERROR
\set _txn_failed 1
\else
\set _txn_failed 0
\endif
ROLLBACK;
\if :_txn_failed
\unset _match
SELECT (:'LAST_ERROR_SQLSTATE' = :'want') AS _match \gset
\if :_match
\echo PASS :name '(' :want ')'
\else
\echo FAIL :name '-- expected' :want 'got' :LAST_ERROR_SQLSTATE :LAST_ERROR_MESSAGE
\endif
\else
\echo FAIL :name '-- expected error' :want 'but the statement succeeded'
\endif
\set ON_ERROR_STOP 1
