-- The statement(s) since try.sql must have succeeded (assertions included).
\if :ERROR
\echo FAIL :name '--' :LAST_ERROR_SQLSTATE :LAST_ERROR_MESSAGE
\else
\echo PASS :name
\endif
\set ON_ERROR_STOP 1
