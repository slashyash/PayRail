-- The last statement since try.sql must have failed with SQLSTATE :want.
-- Use only after the transaction has ended (COMMIT/ROLLBACK or autocommit).
\if :ERROR
\unset _match
SELECT (:'LAST_ERROR_SQLSTATE' = :'want') AS _match \gset
\if :{?_match}
\if :_match
\echo PASS :name '(' :want ')'
\else
\echo FAIL :name '-- expected' :want 'got' :LAST_ERROR_SQLSTATE :LAST_ERROR_MESSAGE
\endif
\else
\echo FAIL :name '-- could not evaluate (transaction still open?)'
\endif
\else
\echo FAIL :name '-- expected error' :want 'but the statement succeeded'
\endif
\set ON_ERROR_STOP 1
