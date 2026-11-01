-- 01_constraints.sql — keys, CHECKs and business-rule triggers on the
-- non-ledger relations. Runs as payrail_owner (the schema owner) so that the
-- DATABASE, not privileges, is what rejects bad data.
\ir _lib/assert.sql
\ir _lib/fixtures.sql

-- ================================================================ users
\set name 'users: e-mail must be lower-case and well-formed'
\set want 23514
\ir _lib/try.sql
INSERT INTO users (full_name, email, role, password_hash)
VALUES ('X', 'Bad@Example.com', 'customer', crypt('pw', gen_salt('bf', 4)));
\ir _lib/expect_error.sql

\set name 'users: e-mail is unique'
\set want 23505
\ir _lib/try.sql
INSERT INTO users (full_name, email, role, password_hash)
VALUES ('X', 'asha@test.local', 'customer', crypt('pw', gen_salt('bf', 4)));
\ir _lib/expect_error.sql

\set name 'users: role must be one of the three roles'
\set want 23514
\ir _lib/try.sql
INSERT INTO users (full_name, email, role, password_hash)
VALUES ('X', 'x1@test.local', 'superadmin', crypt('pw', gen_salt('bf', 4)));
\ir _lib/expect_error.sql

\set name 'users: plaintext password is rejected (bcrypt hash only)'
\set want 23514
\ir _lib/try.sql
INSERT INTO users (full_name, email, role, password_hash)
VALUES ('X', 'x2@test.local', 'customer', 'hunter2');
\ir _lib/expect_error.sql

\set name 'users: role cannot be changed (exactly one, fixed role)'
\set want PRV06
\ir _lib/try.sql
UPDATE users SET role = 'finance_admin' WHERE user_id = :customer_id;
\ir _lib/expect_error.sql

-- ================================================================ vendors and accounts
\set name 'vendors: owner must be a vendor_admin'
\set want PRV01
\ir _lib/try.sql
INSERT INTO vendors (owner_user_id, legal_name, commission_bps) VALUES (:customer_id, 'Bad', 100);
\ir _lib/expect_error.sql

\set name 'vendors: a user owns at most one vendor'
\set want 23505
\ir _lib/try.sql
INSERT INTO vendors (owner_user_id, legal_name, commission_bps) VALUES (:vik_id, 'Second', 100);
\ir _lib/expect_error.sql

\set name 'vendors: commission_bps must be 0..5000'
\set want 23514
\ir _lib/try.sql
INSERT INTO users (full_name, email, role, password_hash)
VALUES ('V3', 'v3@test.local', 'vendor_admin', crypt('pw', gen_salt('bf', 4)));
INSERT INTO vendors (owner_user_id, legal_name, commission_bps)
VALUES ((SELECT user_id FROM users WHERE email = 'v3@test.local'), 'Greedy', 5001);
\ir _lib/expect_error.sql

\set name 'vendors: malformed GSTIN rejected'
\set want 23514
\ir _lib/try.sql
INSERT INTO vendors (owner_user_id, legal_name, gstin, commission_bps)
VALUES ((SELECT user_id FROM users WHERE email = 'v3@test.local'), 'Bad GST', '36AABCV1234F1X5', 100);
\ir _lib/expect_error.sql

\set name 'vendors: each vendor got exactly one payable account (trigger)'
\ir _lib/try.sql
SELECT t_assert(count(*) = 3 AND bool_and(code = 'VENDOR_PAYABLE_' || vendor_id)
                AND bool_and(account_class = 'liability'), 'one payable per vendor')
  FROM accounts WHERE owner_type = 'vendor';
\ir _lib/expect_ok.sql

\set name 'accounts: second account in the same (owner, vendor, class) slot rejected'
\set want 23505
\ir _lib/try.sql
INSERT INTO accounts (code, owner_type, vendor_id, account_class)
VALUES ('VENDOR_PAYABLE_DUP', 'vendor', :vendor_a, 'liability');
\ir _lib/expect_error.sql

\set name 'accounts: NULL vendor_id slots are not distinct (second platform revenue)'
\set want 23505
\ir _lib/try.sql
INSERT INTO accounts (code, owner_type, vendor_id, account_class)
VALUES ('COMMISSION_REVENUE_2', 'platform', NULL, 'revenue');
\ir _lib/expect_error.sql

\set name 'accounts: vendor_id present iff owner_type = vendor'
\set want 23514
\ir _lib/try.sql
INSERT INTO accounts (code, owner_type, vendor_id, account_class)
VALUES ('BANK_2', 'bank', :vendor_a, 'asset');
\ir _lib/expect_error.sql

\set name 'accounts: owner/class pair must be in the chart (vendor asset rejected)'
\set want 23514
\ir _lib/try.sql
INSERT INTO accounts (code, owner_type, vendor_id, account_class)
VALUES ('VENDOR_ASSET_1', 'vendor', :vendor_a, 'asset');
\ir _lib/expect_error.sql

\set name 'accounts: cannot be deleted or changed'
\set want PRV06
\ir _lib/try.sql
DELETE FROM accounts WHERE code = 'BANK';
\ir _lib/expect_error.sql

-- ================================================================ products
\set name 'products: price must be positive'
\set want 23514
\ir _lib/try.sql
INSERT INTO products (vendor_id, name, price_paise) VALUES (:vendor_a, 'Free', 0);
\ir _lib/expect_error.sql

\set name 'products: name unique per vendor'
\set want 23505
\ir _lib/try.sql
INSERT INTO products (vendor_id, name, price_paise) VALUES (:vendor_a, 'Steel Bottle', 100);
\ir _lib/expect_error.sql

\set name 'products: same name allowed for a different vendor'
\ir _lib/try.sql
INSERT INTO products (vendor_id, name, price_paise) VALUES (:vendor_b, 'Steel Bottle', 100);
\ir _lib/expect_ok.sql

-- ================================================================ orders and order_items
\set name 'orders: customer must have role customer'
\set want PRV02
\ir _lib/try.sql
INSERT INTO orders (customer_id) VALUES (:vik_id);
\ir _lib/expect_error.sql

INSERT INTO orders (customer_id) VALUES (:customer_id) RETURNING order_id AS o1 \gset

\set name 'order_items: snapshots are filled from the catalogue when omitted'
\ir _lib/try.sql
INSERT INTO order_items (order_id, line_no, product_id, quantity) VALUES (:o1, 1, :prod_a, 3);
SELECT t_assert(unit_price_paise = 49999 AND commission_bps = 1000, 'snapshot = catalogue')
  FROM order_items WHERE order_id = :o1 AND line_no = 1;
\ir _lib/expect_ok.sql

\set name 'order_items: client-chosen price is rejected'
\set want PRV05
\ir _lib/try.sql
INSERT INTO order_items (order_id, line_no, product_id, quantity, unit_price_paise)
VALUES (:o1, 2, :prod_b, 1, 1);
\ir _lib/expect_error.sql

\set name 'order_items: client-chosen commission rate is rejected'
\set want PRV05
\ir _lib/try.sql
INSERT INTO order_items (order_id, line_no, product_id, quantity, commission_bps)
VALUES (:o1, 2, :prod_b, 1, 0);
\ir _lib/expect_error.sql

\set name 'order_items: a product appears once per order'
\set want 23505
\ir _lib/try.sql
INSERT INTO order_items (order_id, line_no, product_id, quantity) VALUES (:o1, 2, :prod_a, 1);
\ir _lib/expect_error.sql

\set name 'order_items: quantity capped at 100'
\set want 23514
\ir _lib/try.sql
INSERT INTO order_items (order_id, line_no, product_id, quantity) VALUES (:o1, 2, :prod_b, 101);
\ir _lib/expect_error.sql

\set name 'order_items: product of an unverified vendor cannot be ordered'
\set want PRV03
\ir _lib/try.sql
INSERT INTO order_items (order_id, line_no, product_id, quantity) VALUES (:o1, 2, :prod_p, 1);
\ir _lib/expect_error.sql

UPDATE products SET is_active = false WHERE product_id = :prod_b;
\set name 'order_items: inactive (archived) product cannot be ordered'
\set want PRV04
\ir _lib/try.sql
INSERT INTO order_items (order_id, line_no, product_id, quantity) VALUES (:o1, 2, :prod_b, 1);
\ir _lib/expect_error.sql
UPDATE products SET is_active = true WHERE product_id = :prod_b;
INSERT INTO order_items (order_id, line_no, product_id, quantity) VALUES (:o1, 2, :prod_b, 1);

\set name 'order_items: lines are immutable (UPDATE rejected)'
\set want PRV06
\ir _lib/try.sql
UPDATE order_items SET quantity = 5 WHERE order_id = :o1 AND line_no = 1;
\ir _lib/expect_error.sql

-- ================================================================ payments (DEC-010)
-- order o1 total = 3 × 49999 + 1 × 123456 = 273453
\set name 'payments: must start as initiated'
\set want PRS01
\ir _lib/try.sql
INSERT INTO payments (order_id, amount_paise, method, status, gateway_ref, idempotency_key, captured_at)
VALUES (:o1, 273453, 'upi', 'captured', 'pay_TESTCAP01', gen_random_uuid(), now());
\ir _lib/expect_error.sql

\set name 'payments: method must be upi/card/netbanking'
\set want 23514
\ir _lib/try.sql
INSERT INTO payments (order_id, amount_paise, method, idempotency_key)
VALUES (:o1, 273453, 'cash', gen_random_uuid());
\ir _lib/expect_error.sql

INSERT INTO payments (order_id, amount_paise, method, idempotency_key)
VALUES (:o1, 273453, 'upi', gen_random_uuid()) RETURNING payment_id AS pay1 \gset
INSERT INTO payments (order_id, amount_paise, method, idempotency_key)
VALUES (:o1, 273453, 'card', gen_random_uuid()) RETURNING payment_id AS pay2 \gset
INSERT INTO payments (order_id, amount_paise, method, idempotency_key)
VALUES (:o1, 100, 'card', gen_random_uuid()) RETURNING payment_id AS pay_bad \gset

\set name 'payments: idempotency key is unique'
\set want 23505
\ir _lib/try.sql
INSERT INTO payments (order_id, amount_paise, method, idempotency_key)
SELECT order_id, amount_paise, method, idempotency_key FROM payments WHERE payment_id = :pay1;
\ir _lib/expect_error.sql

\set name 'order_items: lines frozen once a payment attempt exists'
\set want PRO01
\ir _lib/try.sql
INSERT INTO order_items (order_id, line_no, product_id, quantity)
VALUES (:o1, 3, (SELECT product_id FROM products WHERE vendor_id = :vendor_b AND name = 'Steel Bottle'), 1);
\ir _lib/expect_error.sql

\set name 'payments: captured requires gateway_ref and captured_at'
\set want 23514
\ir _lib/try.sql
UPDATE payments SET status = 'captured', captured_at = now() WHERE payment_id = :pay1;
\ir _lib/expect_error.sql

\set name 'payments: capture amount must equal the derived order total'
\set want PRP01
\ir _lib/try.sql
UPDATE payments SET status = 'captured', captured_at = now(), gateway_ref = 'pay_TESTBAD01'
 WHERE payment_id = :pay_bad;
\ir _lib/expect_error.sql

\set name 'payments: valid capture succeeds'
\ir _lib/try.sql
UPDATE payments SET status = 'captured', captured_at = now(), gateway_ref = 'pay_TESTCAP01'
 WHERE payment_id = :pay1;
\ir _lib/expect_ok.sql

\set name 'payments: second capture for the same order rejected (partial unique index)'
\set want 23505
\ir _lib/try.sql
UPDATE payments SET status = 'captured', captured_at = now(), gateway_ref = 'pay_TESTCAP02'
 WHERE payment_id = :pay2;
\ir _lib/expect_error.sql

\set name 'payments: failed retry for the same order is allowed'
\ir _lib/try.sql
UPDATE payments SET status = 'failed' WHERE payment_id = :pay2;
\ir _lib/expect_ok.sql

\set name 'payments: final state cannot be switched (captured -> failed)'
\set want PRS01
\ir _lib/try.sql
UPDATE payments SET status = 'failed', captured_at = NULL WHERE payment_id = :pay1;
\ir _lib/expect_error.sql

\set name 'payments: amount is immutable'
\set want PRV06
\ir _lib/try.sql
UPDATE payments SET amount_paise = 1 WHERE payment_id = :pay1;
\ir _lib/expect_error.sql

\set name 'payments: cannot be deleted'
\set want PRV06
\ir _lib/try.sql
DELETE FROM payments WHERE payment_id = :pay2;
\ir _lib/expect_error.sql

-- ================================================================ refunds
\set name 'refunds: must reference an existing order line (composite FK)'
\set want 23503
\ir _lib/try.sql
INSERT INTO refunds (order_id, line_no, amount_paise, reason, idempotency_key)
VALUES (:o1, 9, 100, 'damaged', gen_random_uuid());
\ir _lib/expect_error.sql

INSERT INTO refunds (order_id, line_no, amount_paise, reason, idempotency_key)
VALUES (:o1, 1, 5000, 'damaged', gen_random_uuid()) RETURNING refund_id AS rf1 \gset

\set name 'refunds: processed requires processed_at and gateway_ref'
\set want 23514
\ir _lib/try.sql
UPDATE refunds SET status = 'processed', processed_at = now() WHERE refund_id = :rf1;
\ir _lib/expect_error.sql

\set name 'refunds: amount is immutable'
\set want PRV06
\ir _lib/try.sql
UPDATE refunds SET amount_paise = 6000 WHERE refund_id = :rf1;
\ir _lib/expect_error.sql

UPDATE refunds SET status = 'rejected' WHERE refund_id = :rf1;
\set name 'refunds: rejected is final (rejected -> processed)'
\set want PRS01
\ir _lib/try.sql
UPDATE refunds SET status = 'processed', processed_at = now(), gateway_ref = 'rfnd_TEST0001'
 WHERE refund_id = :rf1;
\ir _lib/expect_error.sql

-- ================================================================ payouts (KYC gate, state machine)
\set name 'payouts: unverified vendor cannot request a payout'
\set want PRV03
\ir _lib/try.sql
INSERT INTO payouts (vendor_id, amount_paise, idempotency_key) VALUES (:vendor_p, 100, gen_random_uuid());
\ir _lib/expect_error.sql

INSERT INTO payouts (vendor_id, amount_paise, idempotency_key)
VALUES (:vendor_a, 1000, gen_random_uuid()) RETURNING payout_id AS po1 \gset

\set name 'payouts: paid requires a bank UTR'
\set want 23514
\ir _lib/try.sql
UPDATE payouts SET status = 'paid', completed_at = now() WHERE payout_id = :po1;
\ir _lib/expect_error.sql

UPDATE payouts SET status = 'failed', completed_at = now() WHERE payout_id = :po1;
\set name 'payouts: failed is final (failed -> paid)'
\set want PRS01
\ir _lib/try.sql
UPDATE payouts SET status = 'paid', bank_utr = 'UTR000000000001' WHERE payout_id = :po1;
\ir _lib/expect_error.sql

-- ================================================================ gateway_settlements
\set name 'settlements: fee must be below gross'
\set want 23514
\ir _lib/try.sql
INSERT INTO gateway_settlements (gateway_ref, record_type, gross_paise, fee_paise, settled_on)
VALUES ('pay_FEE00001', 'payment', 100, 100, '2026-11-01');
\ir _lib/expect_error.sql

\set name 'settlements: refund rows carry no fee'
\set want 23514
\ir _lib/try.sql
INSERT INTO gateway_settlements (gateway_ref, record_type, gross_paise, fee_paise, settled_on)
VALUES ('rfnd_FEE00001', 'refund', 100, 1, '2026-11-01');
\ir _lib/expect_error.sql

\set name 'settlements: unknown reference can be stored (no FK, DBD D9)'
\ir _lib/try.sql
INSERT INTO gateway_settlements (gateway_ref, record_type, gross_paise, fee_paise, settled_on)
VALUES ('pay_UNKNOWN999', 'payment', 5000, 100, '2026-11-01');
\ir _lib/expect_ok.sql

\set name 'settlements: reference is unique'
\set want 23505
\ir _lib/try.sql
INSERT INTO gateway_settlements (gateway_ref, record_type, gross_paise, fee_paise, settled_on)
VALUES ('pay_UNKNOWN999', 'payment', 5000, 100, '2026-11-02');
\ir _lib/expect_error.sql

\set name 'settlements: imported rows are immutable'
\set want PRV06
\ir _lib/try.sql
UPDATE gateway_settlements SET gross_paise = 1 WHERE gateway_ref = 'pay_UNKNOWN999';
\ir _lib/expect_error.sql

-- ================================================================ CRUD on products vs history (DEC-014)
\set name 'products: referenced product cannot be deleted (FK keeps history)'
\set want 23503
\ir _lib/try.sql
DELETE FROM products WHERE product_id = :prod_a;
\ir _lib/expect_error.sql

\set name 'products: unreferenced product can be deleted'
\ir _lib/try.sql
DELETE FROM products WHERE vendor_id = :vendor_b AND name = 'Steel Bottle';
SELECT t_assert(NOT EXISTS (SELECT 1 FROM products WHERE vendor_id = :vendor_b AND name = 'Steel Bottle'), 'deleted');
\ir _lib/expect_ok.sql

\set name 'orders: an order with payment history cannot be deleted (its lines are frozen)'
\set want PRO01
\ir _lib/try.sql
DELETE FROM orders WHERE order_id = :o1;
\ir _lib/expect_error.sql
