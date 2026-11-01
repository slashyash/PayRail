-- 04_helpers.sql — exact-money helpers (DEC-003, DEC-004, DEC-005) and
-- account lookups. All arithmetic is integer/NUMERIC; no floating point.

SET ROLE payrail_owner;
SET search_path = payrail;

-- fn_round_half_up(a, b, d) = round(a·b / d), halves rounded up.
-- Integer form: floor((2·a·b + d) / (2·d)). NUMERIC intermediates avoid
-- BIGINT overflow of a·b. Defined for a, b >= 0 and d > 0 only.
-- Examples: (5,1,2) = 2.5 → 3;  (7,1,2) = 3.5 → 4;  (14999,1,10) = 1499.9 → 1500.
CREATE FUNCTION fn_round_half_up(a bigint, b bigint, d bigint) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = payrail, pg_temp AS $$
BEGIN
  IF a < 0 OR b < 0 OR d <= 0 THEN
    RAISE EXCEPTION 'fn_round_half_up(%, %, %): operands must satisfy a >= 0, b >= 0, d > 0', a, b, d
      USING ERRCODE = '22023';
  END IF;
  RETURN div(2::numeric * a * b + d, 2::numeric * d)::bigint;
END $$;

-- fn_split_line: capture allocation of one order line (DEC-004).
--   L = quantity × unit price            (line total, what the customer pays)
--   C = rhu(L × bps / 10000)             (platform commission)
--   G = rhu(C × 18 / 100)                (GST: 18% of the rounded commission)
--   V = L − C − G                        (vendor share; >= 0 because bps <= 5000)
-- C + G + V = L exactly, by construction.
CREATE FUNCTION fn_split_line(p_quantity integer, p_unit_price_paise bigint, p_commission_bps integer,
  OUT line_total_paise bigint, OUT commission_paise bigint, OUT gst_paise bigint, OUT vendor_paise bigint)
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = payrail, pg_temp AS $$
BEGIN
  IF p_quantity NOT BETWEEN 1 AND 100 OR p_unit_price_paise <= 0
     OR p_commission_bps NOT BETWEEN 0 AND 5000 THEN
    RAISE EXCEPTION 'fn_split_line: invalid input (qty %, price %, bps %)',
      p_quantity, p_unit_price_paise, p_commission_bps USING ERRCODE = '22023';
  END IF;
  line_total_paise := p_quantity::bigint * p_unit_price_paise;
  commission_paise := fn_round_half_up(line_total_paise, p_commission_bps, 10000);
  gst_paise        := fn_round_half_up(commission_paise, 18, 100);
  vendor_paise     := line_total_paise - commission_paise - gst_paise;
END $$;

-- fn_refund_alloc: how much of a refund comes back from commission, GST and
-- the vendor (DEC-005, cumulative method).
-- Inputs: the line's ORIGINAL allocation (L, C, G), the amount already
-- processed before this refund (R_prev) and this refund's amount r.
-- With R_new = R_prev + r:
--   C_k = rhu(C × R_k / L),  G_k = rhu(G × R_k / L)   for k = prev, new
--   ΔC = C_new − C_prev,  ΔG = G_new − G_prev,  ΔV = r − ΔC − ΔG
-- Summing the deltas over all refunds telescopes to (C_final, G_final), so a
-- line refunded in full returns exactly (C, G, V) — no cumulative drift.
-- ΔC, ΔG >= 0 always (rounding is monotone); ΔV can be slightly negative for
-- tiny refunds — fn_post_entry then posts it on the opposite side.
CREATE FUNCTION fn_refund_alloc(p_line_total_paise bigint, p_commission_paise bigint, p_gst_paise bigint,
  p_prev_refunded_paise bigint, p_refund_paise bigint,
  OUT commission_delta bigint, OUT gst_delta bigint, OUT vendor_delta bigint)
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = payrail, pg_temp AS $$
DECLARE
  v_new bigint;
BEGIN
  v_new := p_prev_refunded_paise + p_refund_paise;
  IF p_line_total_paise <= 0 OR p_commission_paise < 0 OR p_gst_paise < 0
     OR p_commission_paise + p_gst_paise > p_line_total_paise
     OR p_prev_refunded_paise < 0 OR p_refund_paise <= 0 OR v_new > p_line_total_paise THEN
    RAISE EXCEPTION 'fn_refund_alloc: invalid input (L %, C %, G %, prev %, refund %)',
      p_line_total_paise, p_commission_paise, p_gst_paise, p_prev_refunded_paise, p_refund_paise
      USING ERRCODE = '22023';
  END IF;
  commission_delta := fn_round_half_up(p_commission_paise, v_new, p_line_total_paise)
                    - fn_round_half_up(p_commission_paise, p_prev_refunded_paise, p_line_total_paise);
  gst_delta        := fn_round_half_up(p_gst_paise, v_new, p_line_total_paise)
                    - fn_round_half_up(p_gst_paise, p_prev_refunded_paise, p_line_total_paise);
  vendor_delta     := p_refund_paise - commission_delta - gst_delta;
END $$;

-- fn_inr: display helper for psql reports, Indian digit grouping.
-- fn_inr(4516201842) = '₹4,51,62,018.42'. Never used for arithmetic.
CREATE FUNCTION fn_inr(p_paise bigint) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = payrail, pg_temp AS $$
DECLARE
  v_abs    numeric := abs(p_paise::numeric);
  v_rupees text    := div(v_abs, 100)::text;
  v_paise  text    := lpad(mod(v_abs, 100)::text, 2, '0');
  v_head   text;
BEGIN
  IF length(v_rupees) > 3 THEN
    v_head   := left(v_rupees, length(v_rupees) - 3);
    v_head   := regexp_replace(v_head, '(\d)(?=(\d\d)+$)', '\1,', 'g');
    v_rupees := v_head || ',' || right(v_rupees, 3);
  END IF;
  RETURN CASE WHEN p_paise < 0 THEN '-' ELSE '' END || '₹' || v_rupees || '.' || v_paise;
END $$;

-- Normal side of an account class: assets/expenses are debit-normal.
CREATE FUNCTION fn_normal_side(p_account_class text) RETURNS char(1)
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = payrail, pg_temp
RETURN CASE WHEN p_account_class IN ('asset', 'expense') THEN 'D' ELSE 'C' END;

-- Account lookups (raise instead of returning NULL so a posting can never
-- silently target a missing account).
CREATE FUNCTION fn_account(p_code text) RETURNS bigint
LANGUAGE plpgsql STABLE STRICT
SET search_path = payrail, pg_temp AS $$
DECLARE
  v_id bigint;
BEGIN
  SELECT account_id INTO v_id FROM accounts WHERE code = p_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account % does not exist', p_code USING ERRCODE = 'PRL04';
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION fn_vendor_payable_account(p_vendor_id bigint) RETURNS bigint
LANGUAGE plpgsql STABLE STRICT
SET search_path = payrail, pg_temp AS $$
DECLARE
  v_id bigint;
BEGIN
  SELECT account_id INTO v_id FROM accounts
   WHERE owner_type = 'vendor' AND vendor_id = p_vendor_id AND account_class = 'liability';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor % has no payable account', p_vendor_id USING ERRCODE = 'PRL04';
  END IF;
  RETURN v_id;
END $$;

RESET ROLE;
