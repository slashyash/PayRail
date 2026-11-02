-- 22_wf_refunds.sql — Workflow W3: refund request and finance decision
-- (APD W3, DEC-005, DEC-007, DEC-010, DEC-011, DEC-012).
--
--   fn_request_refund(customer, order, line, amount, reason, key) → refunds row
--   fn_approve_refund(finance_user, refund)                        → refunds row
--   fn_reject_refund(finance_user, refund)                         → refunds row
--
-- Refund state machine: requested → processed | rejected (terminal).
-- Reservation: a line's refundable amount = L − Σ(requested + processed);
-- a request reserves its amount immediately, a rejection releases it. The
-- check runs while holding the order_items row lock, so concurrent requests
-- on one line cannot together exceed L.
-- Allocation: cumulative method on the line's ORIGINAL snapshot
-- (fn_refund_alloc, DEC-005) — the sum of all refund postings of a fully
-- refunded line equals its capture allocation exactly.

SET ROLE payrail_owner;
SET search_path = payrail;

-- ---------------------------------------------------------------- fn_request_refund
CREATE FUNCTION fn_request_refund(p_customer_id bigint, p_order_id bigint, p_line_no integer,
                                  p_amount_paise bigint, p_reason text, p_idempotency_key uuid)
RETURNS refunds
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_owner      bigint;
  v_row        refunds;
  v_refundable bigint;
BEGIN
  PERFORM fn_require_read_committed();
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency key is required' USING ERRCODE = 'PRV07';
  END IF;

  SELECT customer_id INTO v_owner FROM orders WHERE order_id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % does not exist', p_order_id USING ERRCODE = 'PRN01';
  END IF;
  IF v_owner IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION 'order % does not belong to user %', p_order_id, p_customer_id USING ERRCODE = 'PRA01';
  END IF;

  -- lock the order line (DEC-012 step 1): serialises all refunds of this line
  PERFORM 1 FROM order_items WHERE order_id = p_order_id AND line_no = p_line_no FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % has no line %', p_order_id, p_line_no USING ERRCODE = 'PRN01';
  END IF;

  SELECT * INTO v_row FROM refunds WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF (v_row.order_id, v_row.line_no, v_row.amount_paise, v_row.reason)
       IS DISTINCT FROM (p_order_id, p_line_no, p_amount_paise, p_reason) THEN
      RAISE EXCEPTION 'idempotency key % was already used for a different refund', p_idempotency_key
        USING ERRCODE = 'PRI01';
    END IF;
    RETURN v_row;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM payments WHERE order_id = p_order_id AND status = 'captured') THEN
    RAISE EXCEPTION 'order % is not paid; nothing to refund', p_order_id USING ERRCODE = 'PRO02';
  END IF;
  IF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
    RAISE EXCEPTION 'refund amount must be positive' USING ERRCODE = 'PRV07';
  END IF;

  SELECT refundable_paise INTO v_refundable
    FROM v_order_line_allocation WHERE order_id = p_order_id AND line_no = p_line_no;
  IF p_amount_paise > v_refundable THEN
    RAISE EXCEPTION 'refund % exceeds the refundable amount % of order % line %',
      p_amount_paise, v_refundable, p_order_id, p_line_no USING ERRCODE = 'PRR01';
  END IF;
  IF p_amount_paise < 100 AND p_amount_paise <> v_refundable THEN
    RAISE EXCEPTION 'refunds below ₹1.00 are allowed only for the whole remaining amount (%)', v_refundable
      USING ERRCODE = 'PRR02';
  END IF;

  INSERT INTO refunds (order_id, line_no, amount_paise, reason, idempotency_key)
  VALUES (p_order_id, p_line_no, p_amount_paise, p_reason, p_idempotency_key)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    -- committed concurrently for another line (same-line duplicates wait on the line lock)
    RAISE EXCEPTION 'idempotency key % was already used for a different refund', p_idempotency_key
      USING ERRCODE = 'PRI01';
  END IF;
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------- fn_approve_refund
-- Finance approves: requested → processed, a simulated gateway refund id is
-- assigned, and ONE refund entry is posted (DEC-007):
--   D VENDOR_PAYABLE ΔV, D COMMISSION_REVENUE ΔC, D GST_PAYABLE ΔG; C GATEWAY_CLEARING r.
-- The vendor balance may become negative (late refund after a payout);
-- later captures recover it and payouts cannot overspend (fn_request_payout).
CREATE FUNCTION fn_approve_refund(p_finance_user_id bigint, p_refund_id bigint) RETURNS refunds
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_row  refunds;
  v_al   record;
  v_prev bigint;
  v_ra   record;
BEGIN
  PERFORM fn_require_read_committed();
  PERFORM fn_require_role(p_finance_user_id, 'finance_admin');

  SELECT * INTO v_row FROM refunds WHERE refund_id = p_refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund % does not exist', p_refund_id USING ERRCODE = 'PRN01';
  END IF;
  -- lock order: line (step 1), refund row, vendor payable account (step 2)
  PERFORM 1 FROM order_items WHERE order_id = v_row.order_id AND line_no = v_row.line_no FOR UPDATE;
  SELECT * INTO v_row FROM refunds WHERE refund_id = p_refund_id FOR UPDATE;

  IF v_row.status = 'processed' THEN
    RETURN v_row;                                            -- repeated approval: harmless
  ELSIF v_row.status = 'rejected' THEN
    RAISE EXCEPTION 'refund % was rejected; it cannot be approved', p_refund_id USING ERRCODE = 'PRS01';
  END IF;

  SELECT * INTO v_al FROM v_order_line_allocation
   WHERE order_id = v_row.order_id AND line_no = v_row.line_no;
  PERFORM fn_lock_vendor_accounts(ARRAY[v_al.vendor_id]);

  v_prev := v_al.refunded_paise;                             -- processed before this one (line is locked)
  SELECT * INTO v_ra FROM fn_refund_alloc(v_al.line_total_paise, v_al.commission_paise, v_al.gst_paise,
                                          v_prev, v_row.amount_paise);

  UPDATE refunds
     SET status = 'processed', processed_at = fn_now(),
         gateway_ref = 'rfnd_R' || lpad(p_refund_id::text, 9, '0')     -- simulated gateway refund id
   WHERE refund_id = p_refund_id
  RETURNING * INTO v_row;

  PERFORM fn_post_entry('refund',
            format('Refund %s on order %s line %s', p_refund_id, v_row.order_id, v_row.line_no),
            ARRAY[ROW(fn_vendor_payable_account(v_al.vendor_id), 'D', v_ra.vendor_delta),
                  ROW(fn_account('COMMISSION_REVENUE'),         'D', v_ra.commission_delta),
                  ROW(fn_account('GST_PAYABLE'),                'D', v_ra.gst_delta),
                  ROW(fn_account('GATEWAY_CLEARING'),           'C', v_row.amount_paise)]::posting_line[],
            p_refund_id => p_refund_id);
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------- fn_reject_refund
-- requested → rejected: releases the reservation. No posting.
CREATE FUNCTION fn_reject_refund(p_finance_user_id bigint, p_refund_id bigint) RETURNS refunds
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_row refunds;
BEGIN
  PERFORM fn_require_read_committed();
  PERFORM fn_require_role(p_finance_user_id, 'finance_admin');
  SELECT * INTO v_row FROM refunds WHERE refund_id = p_refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund % does not exist', p_refund_id USING ERRCODE = 'PRN01';
  END IF;
  PERFORM 1 FROM order_items WHERE order_id = v_row.order_id AND line_no = v_row.line_no FOR UPDATE;
  SELECT * INTO v_row FROM refunds WHERE refund_id = p_refund_id FOR UPDATE;

  IF v_row.status = 'rejected' THEN
    RETURN v_row;
  ELSIF v_row.status = 'processed' THEN
    RAISE EXCEPTION 'refund % was already processed; it cannot be rejected', p_refund_id USING ERRCODE = 'PRS01';
  END IF;

  UPDATE refunds SET status = 'rejected' WHERE refund_id = p_refund_id RETURNING * INTO v_row;
  RETURN v_row;
END $$;

RESET ROLE;
