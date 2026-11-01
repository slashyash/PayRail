-- Shared fixture: run as payrail_owner on a freshly built database.
-- Two verified vendors (10% and 2.5% commission), one pending vendor,
-- one customer, one finance admin. Demo password hashes use bcrypt cost 4
-- (tests only). Sets psql variables for the ids.
SET ROLE payrail_owner;
SET search_path = payrail, public;

INSERT INTO users (full_name, email, role, password_hash) VALUES
  ('Asha Customer',  'asha@test.local',    'customer',      crypt('pw', gen_salt('bf', 4))),
  ('Vik Vendor',     'vik@test.local',     'vendor_admin',  crypt('pw', gen_salt('bf', 4))),
  ('Bela Vendor',    'bela@test.local',    'vendor_admin',  crypt('pw', gen_salt('bf', 4))),
  ('Pending Vendor', 'pend@test.local',    'vendor_admin',  crypt('pw', gen_salt('bf', 4))),
  ('Fin Admin',      'fin@test.local',     'finance_admin', crypt('pw', gen_salt('bf', 4)));
SELECT user_id AS customer_id FROM users WHERE email = 'asha@test.local' \gset
SELECT user_id AS vik_id      FROM users WHERE email = 'vik@test.local' \gset
SELECT user_id AS bela_id     FROM users WHERE email = 'bela@test.local' \gset
SELECT user_id AS pend_id     FROM users WHERE email = 'pend@test.local' \gset
SELECT user_id AS fin_id      FROM users WHERE email = 'fin@test.local' \gset

INSERT INTO vendors (owner_user_id, legal_name, gstin, commission_bps, kyc_status) VALUES
  (:vik_id,  'Vik Traders',  '36AABCV1234F1Z5', 1000, 'verified'),
  (:bela_id, 'Bela Crafts',  NULL,               250, 'verified'),
  (:pend_id, 'Pending Co',   NULL,               500, 'pending');
SELECT vendor_id AS vendor_a FROM vendors WHERE owner_user_id = :vik_id \gset
SELECT vendor_id AS vendor_b FROM vendors WHERE owner_user_id = :bela_id \gset
SELECT vendor_id AS vendor_p FROM vendors WHERE owner_user_id = :pend_id \gset

INSERT INTO products (vendor_id, name, price_paise) VALUES
  (:vendor_a, 'Steel Bottle', 49999),
  (:vendor_b, 'Handloom Saree', 123456),
  (:vendor_p, 'Pending Lamp', 1000);
SELECT product_id AS prod_a FROM products WHERE name = 'Steel Bottle' \gset
SELECT product_id AS prod_b FROM products WHERE name = 'Handloom Saree' \gset
SELECT product_id AS prod_p FROM products WHERE name = 'Pending Lamp' \gset
SELECT fn_vendor_payable_account(:vendor_a) AS acct_va,
       fn_vendor_payable_account(:vendor_b) AS acct_vb,
       fn_account('GATEWAY_CLEARING')       AS acct_clearing,
       fn_account('BANK')                   AS acct_bank,
       fn_account('COMMISSION_REVENUE')     AS acct_commission,
       fn_account('GST_PAYABLE')            AS acct_gst,
       fn_account('GATEWAY_FEE_EXPENSE')    AS acct_fee \gset
