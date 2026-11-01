-- 99_privileges.sql — least privilege for the application role (DEC-013).
-- Applied last so it covers every object. payrail_app:
--   * may READ every table and view (login needs users.password_hash);
--   * may WRITE only the non-financial catalogue (products: create, edit
--     name/price/active flag, delete an unreferenced product — DEC-014);
--   * may EXECUTE pure helpers and, from Task 2, the workflow functions;
--   * has NO direct INSERT/UPDATE/DELETE/TRUNCATE on orders, payments,
--     refunds, payouts, settlements, accounts or the ledger.

SET ROLE payrail_owner;
SET search_path = payrail;

REVOKE ALL ON SCHEMA payrail FROM PUBLIC;
GRANT USAGE ON SCHEMA payrail TO payrail_app;

REVOKE ALL ON ALL TABLES    IN SCHEMA payrail FROM PUBLIC, payrail_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA payrail FROM PUBLIC, payrail_app;

GRANT SELECT ON ALL TABLES IN SCHEMA payrail TO payrail_app;      -- tables and views

GRANT INSERT (vendor_id, name, price_paise, is_active) ON products TO payrail_app;
GRANT UPDATE (name, price_paise, is_active)            ON products TO payrail_app;
GRANT DELETE                                           ON products TO payrail_app;

-- Read-only / pure helpers (also needed because views and column defaults call them).
GRANT EXECUTE ON FUNCTION
  fn_now(),
  fn_round_half_up(bigint, bigint, bigint),
  fn_split_line(integer, bigint, integer),
  fn_refund_alloc(bigint, bigint, bigint, bigint, bigint),
  fn_inr(bigint),
  fn_normal_side(text),
  fn_account(text),
  fn_vendor_payable_account(bigint)
TO payrail_app;

-- Deliberately NOT granted: fn_post_entry, fn_assert_entry_balanced, trigger functions.
-- Task 2 adds: GRANT EXECUTE ON FUNCTION fn_place_order(...), ... TO payrail_app;

RESET ROLE;
