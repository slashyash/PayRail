-- 99_privileges.sql — least privilege for the application role (DEC-013).
-- Applied last so it covers every object. payrail_app:
--   * may READ every table and view (login needs users.password_hash);
--   * may WRITE only the non-financial catalogue (products: create, edit
--     name/price/active flag, delete an unreferenced product — DEC-014);
--   * may EXECUTE pure helpers and the workflow functions (Task 2);
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

-- Business workflows (Task 2). All SECURITY DEFINER with a pinned search_path;
-- each checks the actor's role / ownership itself (DEC-022).
GRANT EXECUTE ON FUNCTION
  fn_place_order(bigint, jsonb),
  fn_initiate_payment(bigint, bigint, text, uuid),
  fn_capture_payment(bigint, text, bigint),
  fn_fail_payment(bigint, text),
  fn_request_refund(bigint, bigint, integer, bigint, text, uuid),
  fn_approve_refund(bigint, bigint),
  fn_reject_refund(bigint, bigint),
  fn_request_payout(bigint, bigint, uuid),
  fn_complete_payout(bigint, bigint, text, text),
  fn_record_settlement(bigint, text, text, bigint, bigint, date),
  fn_reconcile(bigint, date)
TO payrail_app;

-- Read-only helpers used by reports and the backend.
GRANT EXECUTE ON FUNCTION
  fn_cart_lines(jsonb),
  fn_vendor_balance(bigint),
  fn_order_total(bigint),
  fn_reconciliation_report(date)
TO payrail_app;

-- Named reports R1–R6 (32_reports.sql, Task 6). SECURITY INVOKER: they read
-- with the caller's SELECT privileges; vendor scoping is the API's job.
GRANT EXECUTE ON FUNCTION
  fn_report_trial_balance(date),
  fn_report_vendor_statement(bigint, date, date),
  fn_report_monthly_performance(date, date),
  fn_report_vendor_refund_risk(date, date, bigint),
  fn_report_settlement_aging(date),
  fn_report_vendor_payables(bigint)
TO payrail_app;

-- Deliberately NOT granted (internal building blocks; granting them would let
-- the app post arbitrary entries or skip the workflow checks):
--   fn_post_entry, fn_reverse_entry, fn_try_post_settlement, fn_lock_vendor_accounts,
--   fn_require_role, fn_require_read_committed, fn_assert_entry_balanced, trigger functions.

RESET ROLE;
