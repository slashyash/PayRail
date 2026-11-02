-- 20_wf_common.sql — internal helpers shared by the workflow functions
-- (Task 2). None of these is granted to payrail_app (see 99_privileges.sql).
--
-- Every workflow function (21–24) is
--   * SECURITY DEFINER, owned by payrail_owner, SET search_path = payrail, pg_temp
--     (so a caller cannot redirect table or function names), and
--   * one atomic step: it runs inside the caller's transaction and either
--     completes every row change and posting or raises, leaving nothing.
-- The backend calls each one as a single statement in autocommit mode (or in
-- its own BEGIN…COMMIT on one checked-out client).
--
-- SQLSTATE codes added in Task 2 (see db/README.md):
--   PRA01 actor is not allowed (wrong role / not the owner)
--   PRN01 referenced object does not exist
--   PRV07 invalid workflow input (empty cart, bad quantity, future date, …)
--   PRI01 idempotency key reused with different data / conflicting retry
--   PRS02 order already has a captured payment
--   PRO02 order is not paid (no captured payment)
--   PRR01 refund exceeds the line's refundable amount
--   PRR02 refund below the ₹1 minimum (unless it is the whole remainder)
--   PRF01 payout exceeds the vendor's available balance
--   PRX01 funds-changing workflow called outside READ COMMITTED

SET ROLE payrail_owner;
SET search_path = payrail;

-- The locking protocol (DEC-012) relies on READ COMMITTED: after a row lock
-- is granted, the NEXT statement takes a fresh snapshot and therefore sees
-- the work committed by the transaction we waited for. Under REPEATABLE READ
-- the snapshot is fixed at the first statement, so a balance read after the
-- lock could be stale (two payouts could spend the same money). We refuse to
-- run in that mode instead of silently being wrong.
CREATE FUNCTION fn_require_read_committed() RETURNS void
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'PayRail workflows must run at READ COMMITTED (current: %)',
      current_setting('transaction_isolation') USING ERRCODE = 'PRX01';
  END IF;
END $$;

-- The actor must exist and have the given role.
CREATE FUNCTION fn_require_role(p_user_id bigint, p_role text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = payrail, pg_temp AS $$
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE user_id = p_user_id AND role = p_role) THEN
    RAISE EXCEPTION 'user % is not a % user', p_user_id, p_role USING ERRCODE = 'PRA01';
  END IF;
END $$;

-- Step 2 of the lock order (DEC-012): lock the payable accounts of the given
-- vendors in ascending account_id. Locking (FOR UPDATE) does not modify the
-- row, so the accounts' immutability trigger is not involved. System accounts
-- are never locked: they have no spending limit.
CREATE FUNCTION fn_lock_vendor_accounts(p_vendor_ids bigint[]) RETURNS void
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  PERFORM 1
     FROM accounts
    WHERE owner_type = 'vendor' AND vendor_id = ANY (p_vendor_ids)
    ORDER BY account_id
      FOR UPDATE;
END $$;

-- Available balance of a vendor = credit-normal balance of its payable
-- account, read from the ledger (never stored). Can be negative (DEC-007).
CREATE FUNCTION fn_vendor_balance(p_vendor_id bigint) RETURNS bigint
LANGUAGE sql STABLE SET search_path = payrail, pg_temp
RETURN (SELECT coalesce(sum(CASE WHEN l.direction = 'C' THEN l.amount_paise ELSE -l.amount_paise END), 0)::bigint
          FROM ledger_lines l
         WHERE l.account_id = fn_vendor_payable_account(p_vendor_id));

-- Derived order total = Σ quantity × snapshot price (DEC-016).
CREATE FUNCTION fn_order_total(p_order_id bigint) RETURNS bigint
LANGUAGE sql STABLE SET search_path = payrail, pg_temp
RETURN (SELECT sum(quantity::bigint * unit_price_paise)::bigint FROM order_items WHERE order_id = p_order_id);

-- fn_reverse_entry: post the mirror image of a posted entry (every line on
-- the opposite side), as entry_type 'reversal'. UNIQUE(reverses_entry_id)
-- makes a second reversal of the same entry impossible. Internal: only
-- fn_complete_payout uses it (a failed payout); the app cannot reverse
-- arbitrary entries.
CREATE FUNCTION fn_reverse_entry(p_entry_id bigint, p_description text) RETURNS bigint
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
DECLARE
  v_lines posting_line[];
BEGIN
  SELECT array_agg(ROW(account_id, CASE direction WHEN 'D' THEN 'C' ELSE 'D' END, amount_paise)::posting_line
                   ORDER BY line_no)
    INTO v_lines
    FROM ledger_lines WHERE entry_id = p_entry_id;
  IF v_lines IS NULL THEN
    RAISE EXCEPTION 'journal entry % does not exist', p_entry_id USING ERRCODE = 'PRN01';
  END IF;
  RETURN fn_post_entry('reversal', p_description, v_lines, p_reverses_entry_id => p_entry_id);
END $$;

RESET ROLE;
