-- 11_ledger_immutability.sql — posted ledger history cannot be changed.
-- Part 1 logs in as the REAL application role payrail_app (a separate
-- connection, not SET ROLE) and shows every write path to the ledger and the
-- other financial tables is refused by privileges.
-- Part 2 shows that even the schema owner is stopped by the append-only
-- triggers. A superuser can still disable triggers: trusted DBAs are outside
-- this guarantee (project rule 3) and the app never runs as one.
\ir _lib/assert.sql
SELECT current_user AS admin_user \gset
\ir _lib/fixtures.sql

-- One committed capture-like entry to attack, plus a referenced product.
INSERT INTO orders (customer_id) VALUES (:customer_id) RETURNING order_id AS o1 \gset
INSERT INTO order_items (order_id, line_no, product_id, quantity) VALUES (:o1, 1, :prod_a, 1);
INSERT INTO gateway_settlements (gateway_ref, record_type, gross_paise, fee_paise, settled_on)
VALUES ('pay_IMMUTABLE01', 'payment', 10000, 0, '2026-11-01') RETURNING settlement_id AS s1 \gset
BEGIN;
SELECT fn_post_entry('settlement', 'target entry',
         ARRAY[ROW(:acct_bank, 'D', 10000), ROW(:acct_clearing, 'C', 10000)]::posting_line[],
         p_settlement_id => :s1) AS e1 \gset
COMMIT;
RESET ROLE;

-- ================================================================ Part 1: as payrail_app
\c - payrail_app
SET search_path = payrail, public;

\set name 'app login: is payrail_app, not superuser, not a member of payrail_owner'
\ir _lib/try.sql
SELECT t_assert(session_user = 'payrail_app' AND current_user = 'payrail_app'
                AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
                AND NOT pg_has_role(current_user, 'payrail_owner', 'MEMBER'), 'identity');
\ir _lib/expect_ok.sql

\set name 'app: can read the ledger and the balance views'
\ir _lib/try.sql
SELECT t_assert(count(*) = 2, 'lines visible') FROM ledger_lines WHERE entry_id = :e1;
SELECT t_assert(sum(debit_paise) = sum(credit_paise), 'balances visible') FROM v_account_balances;
\ir _lib/expect_ok.sql

\set want 42501
\set name 'app: INSERT journal_entries denied'
\ir _lib/try.sql
INSERT INTO journal_entries (entry_type, settlement_id, description) VALUES ('settlement', :s1, 'x');
\ir _lib/expect_error.sql
\set name 'app: late append into a posted entry denied (INSERT ledger_lines)'
\ir _lib/try.sql
INSERT INTO ledger_lines VALUES (:e1, 3, :acct_bank, 'D', 1), (:e1, 4, :acct_clearing, 'C', 1);
\ir _lib/expect_error.sql
\set name 'app: UPDATE ledger_lines denied'
\ir _lib/try.sql
UPDATE ledger_lines SET amount_paise = 1 WHERE entry_id = :e1;
\ir _lib/expect_error.sql
\set name 'app: UPDATE journal_entries denied'
\ir _lib/try.sql
UPDATE journal_entries SET description = 'tampered' WHERE entry_id = :e1;
\ir _lib/expect_error.sql
\set name 'app: DELETE ledger_lines denied'
\ir _lib/try.sql
DELETE FROM ledger_lines WHERE entry_id = :e1;
\ir _lib/expect_error.sql
\set name 'app: DELETE journal_entries denied'
\ir _lib/try.sql
DELETE FROM journal_entries WHERE entry_id = :e1;
\ir _lib/expect_error.sql
\set name 'app: TRUNCATE ledger_lines denied'
\ir _lib/try.sql
TRUNCATE ledger_lines;
\ir _lib/expect_error.sql
\set name 'app: TRUNCATE journal_entries CASCADE denied'
\ir _lib/try.sql
TRUNCATE journal_entries CASCADE;
\ir _lib/expect_error.sql
\set name 'app: cannot call fn_post_entry (no arbitrary postings)'
\ir _lib/try.sql
SELECT fn_post_entry('settlement', 'x', ARRAY[ROW(:acct_bank, 'D', 1), ROW(:acct_clearing, 'C', 1)]::posting_line[],
                     p_settlement_id => :s1);
\ir _lib/expect_error.sql
\set name 'app: cannot disable ledger triggers (not owner)'
\ir _lib/try.sql
ALTER TABLE ledger_lines DISABLE TRIGGER USER;
\ir _lib/expect_error.sql
\set name 'app: cannot switch off triggers via session_replication_role'
\ir _lib/try.sql
SET session_replication_role = replica;
\ir _lib/expect_error.sql
\set name 'app: cannot create objects in schema payrail (no function shadowing)'
\ir _lib/try.sql
CREATE TABLE payrail.evil (x int);
\ir _lib/expect_error.sql
\set name 'app: direct writes to payments denied'
\ir _lib/try.sql
UPDATE payments SET status = 'captured';
\ir _lib/expect_error.sql
\set name 'app: direct INSERT into orders denied'
\ir _lib/try.sql
INSERT INTO orders (customer_id) VALUES (:customer_id);
\ir _lib/expect_error.sql
\set name 'app: direct INSERT into payouts denied'
\ir _lib/try.sql
INSERT INTO payouts (vendor_id, amount_paise, idempotency_key) VALUES (:vendor_a, 1, gen_random_uuid());
\ir _lib/expect_error.sql
\set name 'app: direct INSERT into gateway_settlements denied'
\ir _lib/try.sql
INSERT INTO gateway_settlements (gateway_ref, record_type, gross_paise, settled_on) VALUES ('pay_X0000001', 'payment', 1, '2026-11-01');
\ir _lib/expect_error.sql
\set name 'app: direct INSERT into accounts denied'
\ir _lib/try.sql
INSERT INTO accounts (code, owner_type, account_class) VALUES ('EVIL', 'bank', 'asset');
\ir _lib/expect_error.sql
\set name 'app: cannot change user roles (no UPDATE on users)'
\ir _lib/try.sql
UPDATE users SET role = 'finance_admin' WHERE user_id = :customer_id;
\ir _lib/expect_error.sql
\set name 'app: cannot move a product to another vendor (column privilege)'
\ir _lib/try.sql
UPDATE products SET vendor_id = :vendor_b WHERE product_id = :prod_a;
\ir _lib/expect_error.sql

\set name 'app: controlled clock is ignored for the app login (cannot backdate)'
\ir _lib/try.sql
SET payrail.clock = '2020-01-01 00:00:00+05:30';
SELECT t_assert(fn_now() > '2026-01-01'::timestamptz, 'fn_now ignores payrail.clock for payrail_app');
RESET payrail.clock;
\ir _lib/expect_ok.sql

\set name 'app: product CRUD allowed (create, edit, archive, delete unreferenced)'
\ir _lib/try.sql
INSERT INTO products (vendor_id, name, price_paise) VALUES (:vendor_a, 'Draft Item', 999)
RETURNING product_id AS draft_id \gset
UPDATE products SET price_paise = 1099, name = 'Draft Item v2' WHERE product_id = :draft_id;
UPDATE products SET is_active = false WHERE product_id = :draft_id;
DELETE FROM products WHERE product_id = :draft_id;
SELECT t_assert(NOT EXISTS (SELECT 1 FROM products WHERE product_id = :draft_id), 'deleted');
\ir _lib/expect_ok.sql

\set name 'app: deleting a product referenced by an order is refused (FK)'
\set want 23503
\ir _lib/try.sql
DELETE FROM products WHERE product_id = :prod_a;
\ir _lib/expect_error.sql

-- ================================================================ Part 2: as the owner
\c - :admin_user
SET ROLE payrail_owner;
SET search_path = payrail, public;
\set want PRL02
\set name 'owner: UPDATE ledger_lines blocked by append-only trigger'
\ir _lib/try.sql
UPDATE ledger_lines SET amount_paise = 1 WHERE entry_id = :e1;
\ir _lib/expect_error.sql
\set name 'owner: UPDATE journal_entries blocked'
\ir _lib/try.sql
UPDATE journal_entries SET description = 'tampered' WHERE entry_id = :e1;
\ir _lib/expect_error.sql
\set name 'owner: DELETE ledger_lines blocked'
\ir _lib/try.sql
DELETE FROM ledger_lines WHERE entry_id = :e1;
\ir _lib/expect_error.sql
\set name 'owner: DELETE journal_entries blocked'
\ir _lib/try.sql
DELETE FROM journal_entries WHERE entry_id = :e1;
\ir _lib/expect_error.sql
\set name 'owner: TRUNCATE ledger_lines blocked'
\ir _lib/try.sql
TRUNCATE ledger_lines;
\ir _lib/expect_error.sql
\set name 'owner: TRUNCATE journal_entries CASCADE blocked'
\ir _lib/try.sql
TRUNCATE journal_entries CASCADE;
\ir _lib/expect_error.sql
\set name 'owner: late append blocked by the seal'
\set want PRL03
\ir _lib/try.sql
INSERT INTO ledger_lines VALUES (:e1, 3, :acct_bank, 'D', 1), (:e1, 4, :acct_clearing, 'C', 1);
\ir _lib/expect_error.sql

\set name 'ledger unchanged after all attempts'
\ir _lib/try.sql
SELECT t_assert(count(*) = 2 AND sum(amount_paise) = 20000, 'two original lines')
  FROM ledger_lines WHERE entry_id = :e1;
SELECT t_assert(description = 'target entry', 'header unchanged') FROM journal_entries WHERE entry_id = :e1;
\ir _lib/expect_ok.sql
