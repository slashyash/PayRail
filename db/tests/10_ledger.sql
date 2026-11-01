-- 10_ledger.sql — deferred balance validation with REAL COMMITs, the
-- transaction seal (no late appends), reference rules and fn_post_entry.
-- Runs as payrail_owner (the owner is still bound by the triggers).
\ir _lib/assert.sql
\ir _lib/fixtures.sql

-- Settlement rows used as harmless journal references (no FK prerequisites).
INSERT INTO gateway_settlements (gateway_ref, record_type, gross_paise, fee_paise, settled_on)
SELECT 'pay_LEDGERTEST' || lpad(g::text, 3, '0'), 'payment', 10000, 0, '2026-11-01'
  FROM generate_series(1, 30) g;
SELECT min(settlement_id) AS s0 FROM gateway_settlements \gset
-- s(n) below means settlement_id :s0 + n

-- ================================================================ balanced entries commit
\set name 'balanced 2-line entry commits; lines may be inserted one by one (temporarily unbalanced)'
\ir _lib/try.sql
BEGIN;
INSERT INTO journal_entries (entry_type, settlement_id, description)
VALUES ('settlement', :s0 + 0, 'balanced') RETURNING entry_id AS e_ok \gset
INSERT INTO ledger_lines VALUES (:e_ok, 1, :acct_bank, 'D', 10000);
SELECT t_assert(true, 'mid-transaction the entry is unbalanced and that is allowed');
INSERT INTO ledger_lines VALUES (:e_ok, 2, :acct_clearing, 'C', 10000);
COMMIT;
SELECT t_assert(count(*) = 2, 'two lines persisted') FROM ledger_lines WHERE entry_id = :e_ok;
\ir _lib/expect_ok.sql

-- ================================================================ rejected at COMMIT
\set name 'empty header (0 lines) rejected at COMMIT'
\set want PRL01
\ir _lib/try.sql
BEGIN;
INSERT INTO journal_entries (entry_type, settlement_id, description) VALUES ('settlement', :s0 + 1, 'empty');
COMMIT;
\ir _lib/expect_error.sql
\set name 'empty header left nothing behind'
\ir _lib/try.sql
SELECT t_assert(NOT EXISTS (SELECT 1 FROM journal_entries WHERE settlement_id = :s0 + 1), 'no header');
\ir _lib/expect_ok.sql

\set name 'single-line entry rejected at COMMIT'
\set want PRL01
\ir _lib/try.sql
BEGIN;
INSERT INTO journal_entries (entry_type, settlement_id, description)
VALUES ('settlement', :s0 + 2, 'one line') RETURNING entry_id AS e_one \gset
INSERT INTO ledger_lines VALUES (:e_one, 1, :acct_bank, 'D', 10000);
COMMIT;
\ir _lib/expect_error.sql

\set name 'unbalanced 2-line entry rejected at COMMIT'
\set want PRL01
\ir _lib/try.sql
BEGIN;
INSERT INTO journal_entries (entry_type, settlement_id, description)
VALUES ('settlement', :s0 + 3, 'unbalanced') RETURNING entry_id AS e_unb \gset
INSERT INTO ledger_lines VALUES (:e_unb, 1, :acct_bank, 'D', 10000), (:e_unb, 2, :acct_clearing, 'C', 9999);
COMMIT;
\ir _lib/expect_error.sql

\set name 'balance is per entry: two entries that only balance together are rejected'
\set want PRL01
\ir _lib/try.sql
BEGIN;
INSERT INTO journal_entries (entry_type, settlement_id, description)
VALUES ('settlement', :s0 + 4, 'X') RETURNING entry_id AS ex \gset
INSERT INTO journal_entries (entry_type, settlement_id, description)
VALUES ('settlement', :s0 + 5, 'Y') RETURNING entry_id AS ey \gset
INSERT INTO ledger_lines VALUES (:ex, 1, :acct_bank, 'D', 100), (:ex, 2, :acct_clearing, 'C', 50),
                                (:ey, 1, :acct_clearing, 'C', 30), (:ey, 2, :acct_clearing, 'C', 20);
COMMIT;
\ir _lib/expect_error.sql
\set name 'rejected transactions left no partial ledger state'
\ir _lib/try.sql
SELECT t_assert(count(*) = 1, 'only the balanced entry exists') FROM journal_entries;
SELECT t_assert(count(*) = 2, 'only its two lines exist') FROM ledger_lines;
\ir _lib/expect_ok.sql

-- ================================================================ seal: no late append
\set name 'late append: balanced extra lines into a committed entry are rejected'
\set want PRL03
\ir _lib/try.sql
INSERT INTO ledger_lines VALUES (:e_ok, 3, :acct_bank, 'D', 500), (:e_ok, 4, :acct_clearing, 'C', 500);
\ir _lib/expect_error.sql

\set name 'late append: a single extra line into a committed entry is rejected'
\set want PRL03
\ir _lib/try.sql
INSERT INTO ledger_lines VALUES (:e_ok, 3, :acct_bank, 'D', 500);
\ir _lib/expect_error.sql

\set name 'seal cannot be spoofed: a supplied created_xid is overwritten'
\ir _lib/try.sql
BEGIN;
INSERT INTO journal_entries (entry_type, settlement_id, description, created_xid)
VALUES ('settlement', :s0 + 6, 'spoof', '3'::xid8) RETURNING entry_id AS e_sp \gset
INSERT INTO ledger_lines VALUES (:e_sp, 1, :acct_bank, 'D', 1), (:e_sp, 2, :acct_clearing, 'C', 1);
COMMIT;
SELECT t_assert(created_xid <> '3'::xid8, 'created_xid forced to the real transaction id')
  FROM journal_entries WHERE entry_id = :e_sp;
\ir _lib/expect_ok.sql
\set name 'seal cannot be spoofed: late append still rejected'
\set want PRL03
\ir _lib/try.sql
INSERT INTO ledger_lines VALUES (:e_sp, 3, :acct_bank, 'D', 1), (:e_sp, 4, :acct_clearing, 'C', 1);
\ir _lib/expect_error.sql

-- ================================================================ references (BR10)
\set name 'entry_type must match its reference (capture with a settlement_id)'
\set want 23514
\ir _lib/try.sql
INSERT INTO journal_entries (entry_type, settlement_id, description) VALUES ('capture', :s0 + 7, 'wrong type');
\ir _lib/expect_error.sql

\set name 'exactly one reference (two references rejected)'
\set want 23514
\ir _lib/try.sql
INSERT INTO journal_entries (entry_type, settlement_id, reverses_entry_id, description)
VALUES ('settlement', :s0 + 7, :e_ok, 'two refs');
\ir _lib/expect_error.sql

\set name 'a settlement is journaled at most once'
\set want 23505
\ir _lib/try.sql
INSERT INTO journal_entries (entry_type, settlement_id, description) VALUES ('settlement', :s0 + 0, 'again');
\ir _lib/expect_error.sql

\set name 'reversal entry commits'
\ir _lib/try.sql
BEGIN;
SELECT fn_post_entry('reversal', 'reverse e_ok',
         ARRAY[ROW(:acct_clearing, 'D', 10000), ROW(:acct_bank, 'C', 10000)]::posting_line[],
         p_reverses_entry_id => :e_ok) AS e_rev \gset
COMMIT;
\ir _lib/expect_ok.sql

\set name 'an entry can be reversed at most once'
\set want 23505
\ir _lib/try.sql
INSERT INTO journal_entries (entry_type, reverses_entry_id, description) VALUES ('reversal', :e_ok, 'twice');
\ir _lib/expect_error.sql

-- ================================================================ fn_post_entry
\set name 'fn_post_entry: drops zero lines, flips negatives, merges same account+side'
\ir _lib/try.sql
BEGIN;
SELECT fn_post_entry('settlement', 'helper rules',
         ARRAY[ROW(:acct_bank, 'D', 700), ROW(:acct_bank, 'D', 300),        -- merged: BANK D 1000
               ROW(:acct_clearing, 'C', 1200),
               ROW(:acct_fee, 'D', 0),                                     -- dropped
               ROW(:acct_fee, 'C', -200)]::posting_line[],                 -- flipped: FEE D 200
         p_settlement_id => :s0 + 8) AS e_h \gset
COMMIT;
SELECT t_assert(array_agg(ROW(account_id, direction, amount_paise)::text ORDER BY line_no)
                = ARRAY[ROW(:acct_bank, 'D', 1000)::text, ROW(:acct_clearing, 'C', 1200)::text,
                        ROW(:acct_fee, 'D', 200)::text], 'normalised lines')
  FROM ledger_lines WHERE entry_id = :e_h;
\ir _lib/expect_ok.sql

\set name 'fn_post_entry: one non-zero line is still rejected at COMMIT'
\set want PRL01
\ir _lib/try.sql
BEGIN;
SELECT fn_post_entry('settlement', 'one line',
         ARRAY[ROW(:acct_bank, 'D', 500), ROW(:acct_clearing, 'C', 0)]::posting_line[],
         p_settlement_id => :s0 + 9);
COMMIT;
\ir _lib/expect_error.sql

\set name 'fn_post_entry: no lines rejected'
\set want PRL04
\ir _lib/try.sql
SELECT fn_post_entry('settlement', 'none', ARRAY[]::posting_line[], p_settlement_id => :s0 + 10);
\ir _lib/expect_error.sql

\set name 'fn_post_entry: missing account rejected'
\set want PRL04
\ir _lib/try.sql
SELECT fn_post_entry('settlement', 'null acct',
         ARRAY[ROW(NULL, 'D', 5), ROW(:acct_bank, 'C', 5)]::posting_line[], p_settlement_id => :s0 + 10);
\ir _lib/expect_error.sql

-- ================================================================ atomic rollback
-- A later statement fails after a balanced posting; the COMMIT then rolls back.
\ir _lib/try.sql
BEGIN;
SELECT fn_post_entry('settlement', 'doomed',
         ARRAY[ROW(:acct_bank, 'D', 5), ROW(:acct_clearing, 'C', 5)]::posting_line[],
         p_settlement_id => :s0 + 11);
SELECT 1 / 0;
COMMIT;
\set ON_ERROR_STOP 1
\set name 'atomicity: a later error in the same transaction removes the posted entry'
\ir _lib/try.sql
SELECT t_assert(NOT EXISTS (SELECT 1 FROM journal_entries WHERE settlement_id = :s0 + 11), 'rolled back');
\ir _lib/expect_ok.sql

\set name 'atomicity: error inside one function call leaves no header or lines'
\set want PT001
\ir _lib/try.sql
DO $$
DECLARE v_e bigint;
BEGIN
  v_e := payrail.fn_post_entry('settlement', 'doomed in function',
           ARRAY[ROW(payrail.fn_account('BANK'), 'D', 5),
                 ROW(payrail.fn_account('GATEWAY_CLEARING'), 'C', 5)]::payrail.posting_line[],
           p_settlement_id => (SELECT min(settlement_id) + 12 FROM payrail.gateway_settlements));
  PERFORM t_assert(false, 'simulated failure after posting');
END $$;
\ir _lib/expect_error.sql
\set name 'atomicity: function failure persisted nothing'
\ir _lib/try.sql
SELECT t_assert(NOT EXISTS (SELECT 1 FROM journal_entries WHERE settlement_id = :s0 + 12), 'rolled back');
\ir _lib/expect_ok.sql

-- ================================================================ global trial balance
\set name 'trial balance: total debits = total credits over the whole ledger'
\ir _lib/try.sql
SELECT t_assert(sum(debit_paise) = sum(credit_paise) AND sum(debit_paise) > 0, 'global equality')
  FROM v_account_balances;
\ir _lib/expect_ok.sql
