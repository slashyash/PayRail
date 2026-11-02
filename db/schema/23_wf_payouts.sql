-- 23_wf_payouts.sql — Workflow W2: vendor payout (APD W2, DEC-007, DEC-008,
-- DEC-010, DEC-011, DEC-012).
--
--   fn_request_payout(vendor_user, amount, key)                 → payouts row
--   fn_complete_payout(finance_user, payout, outcome, bank_utr)  → payouts row
--
-- Payout state machine: requested → paid | failed (terminal).
-- Funds are reserved by POSTING at request time: D VENDOR_PAYABLE, C BANK
-- (DEC-008). 'paid' only records the bank UTR. 'failed' posts exactly one
-- reversal of the payout entry (UNIQUE reverses_entry_id), restoring funds.

SET ROLE payrail_owner;
SET search_path = payrail;

-- ---------------------------------------------------------------- fn_request_payout
-- Lock order (DEC-012): the vendor's payable account FIRST (there is no
-- existing domain row to lock), then read the balance from the ledger in a
-- NEW statement — which, at READ COMMITTED, sees every posting committed by a
-- transaction we waited for. Two concurrent payouts therefore cannot both
-- spend the same balance.
CREATE FUNCTION fn_request_payout(p_vendor_user_id bigint, p_amount_paise bigint, p_idempotency_key uuid)
RETURNS payouts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_vendor_id bigint;
  v_kyc       text;
  v_row       payouts;
  v_balance   bigint;
  v_entry     bigint;
BEGIN
  PERFORM fn_require_read_committed();
  PERFORM fn_require_role(p_vendor_user_id, 'vendor_admin');
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency key is required' USING ERRCODE = 'PRV07';
  END IF;

  SELECT vendor_id, kyc_status INTO v_vendor_id, v_kyc FROM vendors WHERE owner_user_id = p_vendor_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user % does not own a vendor', p_vendor_user_id USING ERRCODE = 'PRA01';
  END IF;

  PERFORM fn_lock_vendor_accounts(ARRAY[v_vendor_id]);

  SELECT * INTO v_row FROM payouts WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF (v_row.vendor_id, v_row.amount_paise) IS DISTINCT FROM (v_vendor_id, p_amount_paise) THEN
      RAISE EXCEPTION 'idempotency key % was already used for a different payout', p_idempotency_key
        USING ERRCODE = 'PRI01';
    END IF;
    RETURN v_row;
  END IF;

  IF v_kyc <> 'verified' THEN
    RAISE EXCEPTION 'vendor % is not KYC-verified; payouts are not allowed', v_vendor_id USING ERRCODE = 'PRV03';
  END IF;
  IF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
    RAISE EXCEPTION 'payout amount must be positive' USING ERRCODE = 'PRV07';
  END IF;

  v_balance := fn_vendor_balance(v_vendor_id);
  IF p_amount_paise > v_balance THEN
    RAISE EXCEPTION 'payout % exceeds the available balance % of vendor %', p_amount_paise, v_balance, v_vendor_id
      USING ERRCODE = 'PRF01';
  END IF;

  INSERT INTO payouts (vendor_id, amount_paise, idempotency_key)
  VALUES (v_vendor_id, p_amount_paise, p_idempotency_key)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    -- committed concurrently by ANOTHER vendor (same-vendor duplicates wait on the account lock)
    RAISE EXCEPTION 'idempotency key % was already used for a different payout', p_idempotency_key
      USING ERRCODE = 'PRI01';
  END IF;

  v_entry := fn_post_entry('payout', format('Payout %s to vendor %s', v_row.payout_id, v_vendor_id),
               ARRAY[ROW(fn_vendor_payable_account(v_vendor_id), 'D', p_amount_paise),
                     ROW(fn_account('BANK'),                      'C', p_amount_paise)]::posting_line[],
               p_payout_id => v_row.payout_id);
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------- fn_complete_payout
-- Result of the simulated bank transfer, recorded by finance.
--   p_outcome 'paid'   → requires p_bank_utr (12–22 upper-case alphanumerics)
--   p_outcome 'failed' → p_bank_utr must be NULL; one reversal entry is posted
-- Retry with the same outcome (and UTR) → same row, nothing posted again.
-- Asking for the other outcome after a terminal state → PRS01.
CREATE FUNCTION fn_complete_payout(p_finance_user_id bigint, p_payout_id bigint, p_outcome text,
                                   p_bank_utr text DEFAULT NULL) RETURNS payouts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_row   payouts;
  v_entry bigint;
BEGIN
  PERFORM fn_require_read_committed();
  PERFORM fn_require_role(p_finance_user_id, 'finance_admin');
  IF p_outcome IS NULL OR p_outcome NOT IN ('paid', 'failed') THEN
    RAISE EXCEPTION 'outcome must be paid or failed' USING ERRCODE = 'PRV07';
  END IF;
  IF (p_outcome = 'paid') <> (p_bank_utr IS NOT NULL) THEN
    RAISE EXCEPTION 'a bank UTR is required for paid and not allowed for failed' USING ERRCODE = 'PRV07';
  END IF;

  -- lock order: payout row (step 1), then the vendor's payable account (step 2)
  SELECT * INTO v_row FROM payouts WHERE payout_id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout % does not exist', p_payout_id USING ERRCODE = 'PRN01';
  END IF;
  PERFORM fn_lock_vendor_accounts(ARRAY[v_row.vendor_id]);

  IF v_row.status = p_outcome THEN
    IF v_row.bank_utr IS DISTINCT FROM p_bank_utr THEN
      RAISE EXCEPTION 'payout % was already paid with a different UTR', p_payout_id USING ERRCODE = 'PRI01';
    END IF;
    RETURN v_row;                                            -- duplicate completion: harmless
  ELSIF v_row.status <> 'requested' THEN
    RAISE EXCEPTION 'payout % is already %; it cannot become %', p_payout_id, v_row.status, p_outcome
      USING ERRCODE = 'PRS01';
  END IF;

  UPDATE payouts SET status = p_outcome, bank_utr = p_bank_utr, completed_at = fn_now()
   WHERE payout_id = p_payout_id
  RETURNING * INTO v_row;

  IF p_outcome = 'failed' THEN
    SELECT entry_id INTO v_entry FROM journal_entries WHERE payout_id = p_payout_id;
    PERFORM fn_reverse_entry(v_entry, format('Reversal of failed payout %s to vendor %s', p_payout_id, v_row.vendor_id));
  END IF;
  RETURN v_row;
END $$;

RESET ROLE;
