-- 21_wf_orders_payments.sql — Workflow W1: checkout and payment capture
-- (APD W1, DEC-004, DEC-010, DEC-011, DEC-012).
--
--   fn_place_order(customer, items)              → order_id
--   fn_initiate_payment(customer, order, method, key)  → payments row   (customer action, idempotent)
--   fn_capture_payment(payment, gateway_ref, amount)   → payments row   (gateway callback, idempotent)
--   fn_fail_payment(payment, gateway_ref)              → payments row   (gateway callback, idempotent)
--
-- Payment state machine: initiated → captured | failed (both terminal).
-- Idempotency (DEC-011): payments.idempotency_key identifies the customer's
-- payment ATTEMPT; gateway callback retries are identified by
-- (payment_id, outcome, gateway_ref). A replay with the same data returns the
-- original row; a replay asking for different data or the other outcome fails.

SET ROLE payrail_owner;
SET search_path = payrail;

-- ---------------------------------------------------------------- fn_cart_lines
-- One row per distinct product of an (already validated) items array, with
-- the quantities added up and the position of its first appearance.
CREATE FUNCTION fn_cart_lines(p_items jsonb)
RETURNS TABLE (product_id bigint, quantity integer, first_pos bigint)
LANGUAGE sql IMMUTABLE SET search_path = payrail, pg_temp AS $$
  SELECT (t.e ->> 'product_id')::bigint, sum((t.e ->> 'quantity')::int)::int, min(t.pos)
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, pos)
   GROUP BY 1
$$;

-- ---------------------------------------------------------------- fn_place_order
-- p_items: JSON array of {"product_id": <id>, "quantity": <1..100>} (numbers
-- or digit strings). The same product may appear several times; quantities
-- are added up into ONE line (cap 100). Lines are numbered in order of first
-- appearance. Prices and commission rates are NOT accepted from the caller:
-- trg_order_items_snapshot copies them from the catalogue (PRV05 otherwise),
-- and rejects inactive products (PRV04) and unverified vendors (PRV03).
-- Placing an order moves no money; it has no idempotency key (a duplicate
-- just leaves an unpaid order, reported as abandoned).
CREATE FUNCTION fn_place_order(p_customer_id bigint, p_items jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_order_id bigint;
  v_missing  bigint;
  v_too_many bigint;
BEGIN
  PERFORM fn_require_role(p_customer_id, 'customer');

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'items must be a JSON array with 1..50 entries' USING ERRCODE = 'PRV07';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) e
              WHERE jsonb_typeof(e) <> 'object'
                 OR coalesce(e ->> 'product_id', '') !~ '^[0-9]{1,18}$'
                 OR coalesce(e ->> 'quantity', '')   !~ '^[0-9]{1,3}$'
                 OR CASE WHEN coalesce(e ->> 'quantity', '') ~ '^[0-9]{1,3}$'
                         THEN (e ->> 'quantity')::int NOT BETWEEN 1 AND 100 END) THEN
    RAISE EXCEPTION 'each item needs a product_id and an integer quantity 1..100' USING ERRCODE = 'PRV07';
  END IF;

  SELECT c.product_id INTO v_missing
    FROM fn_cart_lines(p_items) c
   WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.product_id = c.product_id)
   ORDER BY c.product_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'product % does not exist', v_missing USING ERRCODE = 'PRN01';
  END IF;
  SELECT c.product_id INTO v_too_many FROM fn_cart_lines(p_items) c WHERE c.quantity > 100 ORDER BY 1 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'total quantity of product % exceeds 100', v_too_many USING ERRCODE = 'PRV07';
  END IF;

  INSERT INTO orders (customer_id) VALUES (p_customer_id) RETURNING order_id INTO v_order_id;
  INSERT INTO order_items (order_id, line_no, product_id, quantity)
  SELECT v_order_id, row_number() OVER (ORDER BY c.first_pos), c.product_id, c.quantity
    FROM fn_cart_lines(p_items) c;
  RETURN v_order_id;
END $$;

-- ---------------------------------------------------------------- fn_initiate_payment
-- The customer starts a payment attempt for its own unpaid order. The amount
-- is the derived order total — never supplied by the client. Several
-- attempts per order are allowed (e.g. after a failure); the first attempt
-- freezes the order lines (PRO01).
CREATE FUNCTION fn_initiate_payment(p_customer_id bigint, p_order_id bigint, p_method text,
                                    p_idempotency_key uuid) RETURNS payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_owner bigint;
  v_row   payments;
BEGIN
  PERFORM fn_require_read_committed();
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency key is required' USING ERRCODE = 'PRV07';
  END IF;

  -- lock order (DEC-012 step 1): serialises attempts and captures of one order
  SELECT customer_id INTO v_owner FROM orders WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % does not exist', p_order_id USING ERRCODE = 'PRN01';
  END IF;
  IF v_owner IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION 'order % does not belong to user %', p_order_id, p_customer_id USING ERRCODE = 'PRA01';
  END IF;

  -- replay of an earlier attempt (committed before we got the lock)?
  SELECT * INTO v_row FROM payments WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF (v_row.order_id, v_row.method) IS DISTINCT FROM (p_order_id, p_method) THEN
      RAISE EXCEPTION 'idempotency key % was already used for a different payment', p_idempotency_key
        USING ERRCODE = 'PRI01';
    END IF;
    RETURN v_row;
  END IF;

  IF EXISTS (SELECT 1 FROM payments WHERE order_id = p_order_id AND status = 'captured') THEN
    RAISE EXCEPTION 'order % is already paid', p_order_id USING ERRCODE = 'PRS02';
  END IF;

  INSERT INTO payments (order_id, amount_paise, method, idempotency_key)
  VALUES (p_order_id, fn_order_total(p_order_id), p_method, p_idempotency_key)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    -- the same key was committed concurrently for ANOTHER order (same-order
    -- duplicates are serialised by the order lock and handled above)
    RAISE EXCEPTION 'idempotency key % was already used for a different payment', p_idempotency_key
      USING ERRCODE = 'PRI01';
  END IF;
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------- fn_capture_payment
-- Gateway success callback. Atomically: payment → captured, and ONE capture
-- entry (DEC-007): D GATEWAY_CLEARING Σ L; C each VENDOR_PAYABLE Σ V,
-- C COMMISSION_REVENUE Σ C, C GST_PAYABLE Σ G (allocation per line, DEC-004).
-- Rejected without any change: amount ≠ order total (PRP01), payment already
-- failed (PRS01), another payment of the order already captured (PRS02).
-- A retry with the same gateway_ref and amount returns the captured row.
CREATE FUNCTION fn_capture_payment(p_payment_id bigint, p_gateway_ref text, p_amount_paise bigint)
RETURNS payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_order_id bigint;
  v_row      payments;
  v_vendors  bigint[];
  v_lines    posting_line[];
BEGIN
  PERFORM fn_require_read_committed();
  SELECT order_id INTO v_order_id FROM payments WHERE payment_id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment % does not exist', p_payment_id USING ERRCODE = 'PRN01';
  END IF;

  -- lock order (DEC-012 step 1), then the payment row
  PERFORM 1 FROM orders WHERE order_id = v_order_id FOR UPDATE;
  SELECT * INTO v_row FROM payments WHERE payment_id = p_payment_id FOR UPDATE;

  IF v_row.status = 'captured' THEN
    IF (v_row.gateway_ref, v_row.amount_paise) IS DISTINCT FROM (p_gateway_ref, p_amount_paise) THEN
      RAISE EXCEPTION 'payment % was already captured with different data', p_payment_id USING ERRCODE = 'PRI01';
    END IF;
    RETURN v_row;                                             -- duplicate callback: harmless
  ELSIF v_row.status = 'failed' THEN
    RAISE EXCEPTION 'payment % already failed; it cannot be captured', p_payment_id USING ERRCODE = 'PRS01';
  END IF;

  IF p_amount_paise IS DISTINCT FROM v_row.amount_paise
     OR p_amount_paise IS DISTINCT FROM fn_order_total(v_order_id) THEN
    RAISE EXCEPTION 'capture amount % does not equal order % total %',
      p_amount_paise, v_order_id, fn_order_total(v_order_id) USING ERRCODE = 'PRP01';
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE order_id = v_order_id AND status = 'captured') THEN
    RAISE EXCEPTION 'order % is already paid by another payment', v_order_id USING ERRCODE = 'PRS02';
  END IF;

  -- lock the vendors' payable accounts (DEC-012 step 2) before posting
  SELECT array_agg(DISTINCT vendor_id ORDER BY vendor_id) INTO v_vendors
    FROM v_order_line_allocation WHERE order_id = v_order_id;
  PERFORM fn_lock_vendor_accounts(v_vendors);

  UPDATE payments SET status = 'captured', gateway_ref = p_gateway_ref, captured_at = fn_now()
   WHERE payment_id = p_payment_id
  RETURNING * INTO v_row;

  SELECT ARRAY[ROW(fn_account('GATEWAY_CLEARING'), 'D', sum(al.line_total_paise))::posting_line]
         || (SELECT array_agg(ROW(fn_vendor_payable_account(pv.vendor_id), 'C', pv.v)::posting_line
                              ORDER BY pv.vendor_id)
               FROM (SELECT vendor_id, sum(vendor_paise)::bigint AS v
                       FROM v_order_line_allocation WHERE order_id = v_order_id
                      GROUP BY vendor_id) pv)
         || ARRAY[ROW(fn_account('COMMISSION_REVENUE'), 'C', sum(al.commission_paise))::posting_line,
                  ROW(fn_account('GST_PAYABLE'),        'C', sum(al.gst_paise))::posting_line]
    INTO v_lines
    FROM v_order_line_allocation al WHERE al.order_id = v_order_id;

  PERFORM fn_post_entry('capture',
                        format('Capture of payment %s for order %s', p_payment_id, v_order_id),
                        v_lines, p_payment_id => p_payment_id);
  RETURN v_row;
END $$;

-- ---------------------------------------------------------------- fn_fail_payment
-- Gateway failure callback: initiated → failed. No ledger posting (no money
-- moved). Retry → same row. Failing a captured payment is rejected (PRS01).
CREATE FUNCTION fn_fail_payment(p_payment_id bigint, p_gateway_ref text DEFAULT NULL) RETURNS payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_order_id bigint;
  v_row      payments;
BEGIN
  PERFORM fn_require_read_committed();
  SELECT order_id INTO v_order_id FROM payments WHERE payment_id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment % does not exist', p_payment_id USING ERRCODE = 'PRN01';
  END IF;
  PERFORM 1 FROM orders WHERE order_id = v_order_id FOR UPDATE;
  SELECT * INTO v_row FROM payments WHERE payment_id = p_payment_id FOR UPDATE;

  IF v_row.status = 'failed' THEN
    IF p_gateway_ref IS NOT NULL AND v_row.gateway_ref IS DISTINCT FROM p_gateway_ref THEN
      RAISE EXCEPTION 'payment % already failed with a different gateway reference', p_payment_id
        USING ERRCODE = 'PRI01';
    END IF;
    RETURN v_row;
  ELSIF v_row.status = 'captured' THEN
    RAISE EXCEPTION 'payment % is captured; it cannot fail', p_payment_id USING ERRCODE = 'PRS01';
  END IF;

  UPDATE payments SET status = 'failed', gateway_ref = p_gateway_ref
   WHERE payment_id = p_payment_id
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

RESET ROLE;
