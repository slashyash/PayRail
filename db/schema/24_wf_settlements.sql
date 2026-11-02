-- 24_wf_settlements.sql — Workflow W4: settlement import and reconciliation
-- (APD W4, DEC-007, DEC-009).
--
--   fn_record_settlement(finance_user, ref, type, gross, fee, settled_on)
--        → (settlement_id, result, entry_id)   result ∈ inserted | duplicate | conflict
--   fn_reconcile(finance_user, as_of)      → summary per category (and posts newly matching rows)
--   fn_reconciliation_report(as_of)        → one row per expected event / settlement row (read-only)
--
-- Simulation model (DEC-009):
--   * The gateway report lists PAYMENT rows (gross, fee) and REFUND rows
--     (amount deducted, fee 0), each keyed by the gateway reference
--     (payments.gateway_ref 'pay_…', refunds.gateway_ref 'rfnd_…').
--   * Every imported row is stored as received (no FK: unknown references
--     are kept). Only an EXACT match is posted, once (UNIQUE settlement_id):
--       payment row: D BANK gross − fee, D GATEWAY_FEE_EXPENSE fee, C GATEWAY_CLEARING gross
--       refund row:  D GATEWAY_CLEARING amount, C BANK amount
--     The day's net bank credit Σ(gross − fee) − Σ refunds is a derived value;
--     there is no separate payout-batch entity (disclosed simplification).
--   * Dates are Asia/Kolkata calendar dates. Expected settlement date of a
--     captured payment / processed refund = its event date + 2 days (T+2,
--     no holiday calendar).
--   * Categories at an explicit as_of date (rows settled after as_of and
--     events after as_of are ignored):
--       matched            ref, record type and amount agree (posted)
--       amount_mismatch    ref known but amount or record type differs (NOT posted)
--       unknown_reference  no captured payment / processed refund has the ref (NOT posted)
--       in_transit         no row yet and as_of ≤ expected date
--       overdue_missing    no row and as_of > expected date
--   * Re-import of an identical row → 'duplicate' (nothing stored or posted);
--     same ref with different values → 'conflict' (rejected, original kept).
--   * fn_reconcile re-examines unposted rows, so an unknown reference whose
--     payment callback arrives later is posted on the next run.

SET ROLE payrail_owner;
SET search_path = payrail;

-- ---------------------------------------------------------------- fn_try_post_settlement (internal)
-- Posts the settlement row if — and only if — it matches exactly. Returns the
-- entry id (new or existing) or NULL. The row lock makes two concurrent
-- attempts post at most once.
CREATE FUNCTION fn_try_post_settlement(p_settlement_id bigint) RETURNS bigint
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
DECLARE
  s       gateway_settlements;
  v_entry bigint;
  v_id    bigint;
  v_amt   bigint;
BEGIN
  SELECT * INTO s FROM gateway_settlements WHERE settlement_id = p_settlement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement % does not exist', p_settlement_id USING ERRCODE = 'PRN01';
  END IF;
  SELECT entry_id INTO v_entry FROM journal_entries WHERE settlement_id = p_settlement_id;
  IF FOUND THEN
    RETURN v_entry;
  END IF;

  IF s.record_type = 'payment' THEN
    SELECT payment_id, amount_paise INTO v_id, v_amt
      FROM payments WHERE gateway_ref = s.gateway_ref AND status = 'captured';
    IF FOUND AND v_amt = s.gross_paise THEN
      RETURN fn_post_entry('settlement',
               format('Settlement %s of payment %s (%s)', s.settlement_id, v_id, s.gateway_ref),
               ARRAY[ROW(fn_account('BANK'),                'D', s.gross_paise - s.fee_paise),
                     ROW(fn_account('GATEWAY_FEE_EXPENSE'), 'D', s.fee_paise),
                     ROW(fn_account('GATEWAY_CLEARING'),    'C', s.gross_paise)]::posting_line[],
               p_settlement_id => s.settlement_id);
    END IF;
  ELSE
    SELECT refund_id, amount_paise INTO v_id, v_amt
      FROM refunds WHERE gateway_ref = s.gateway_ref AND status = 'processed';
    IF FOUND AND v_amt = s.gross_paise THEN
      RETURN fn_post_entry('settlement',
               format('Settlement %s of refund %s (%s)', s.settlement_id, v_id, s.gateway_ref),
               ARRAY[ROW(fn_account('GATEWAY_CLEARING'), 'D', s.gross_paise),
                     ROW(fn_account('BANK'),             'C', s.gross_paise)]::posting_line[],
               p_settlement_id => s.settlement_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------- fn_record_settlement
-- One row of an imported settlement report. Format errors are rejected by the
-- table's CHECKs (23514): ref format, gross > 0, 0 ≤ fee < gross, fee = 0 for
-- refunds. A settlement date later than today (IST) is rejected (PRV07).
CREATE FUNCTION fn_record_settlement(p_finance_user_id bigint, p_gateway_ref text, p_record_type text,
                                     p_gross_paise bigint, p_fee_paise bigint, p_settled_on date)
RETURNS TABLE (settlement_id bigint, result text, entry_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_row gateway_settlements;
BEGIN
  PERFORM fn_require_read_committed();
  PERFORM fn_require_role(p_finance_user_id, 'finance_admin');
  IF p_settled_on IS NULL OR p_settled_on > (fn_now() AT TIME ZONE 'Asia/Kolkata')::date THEN
    RAISE EXCEPTION 'settlement date % is missing or in the future', p_settled_on USING ERRCODE = 'PRV07';
  END IF;

  INSERT INTO gateway_settlements AS g (gateway_ref, record_type, gross_paise, fee_paise, settled_on)
  VALUES (p_gateway_ref, p_record_type, p_gross_paise, coalesce(p_fee_paise, 0), p_settled_on)
  ON CONFLICT (gateway_ref) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    settlement_id := v_row.settlement_id;
    result        := 'inserted';
    entry_id      := fn_try_post_settlement(v_row.settlement_id);
  ELSE
    SELECT * INTO v_row FROM gateway_settlements g WHERE g.gateway_ref = p_gateway_ref;
    settlement_id := v_row.settlement_id;
    result := CASE WHEN (v_row.record_type, v_row.gross_paise, v_row.fee_paise, v_row.settled_on)
                        = (p_record_type, p_gross_paise, coalesce(p_fee_paise, 0), p_settled_on)
                   THEN 'duplicate' ELSE 'conflict' END;
    SELECT je.entry_id INTO entry_id FROM journal_entries je WHERE je.settlement_id = v_row.settlement_id;
  END IF;
  RETURN NEXT;
END $$;

-- ---------------------------------------------------------------- fn_reconciliation_report
-- Read-only. Every captured payment / processed refund dated ≤ as_of appears
-- once; every settlement row settled ≤ as_of appears once.
CREATE FUNCTION fn_reconciliation_report(p_as_of date)
RETURNS TABLE (category text, detail text, record_type text, gateway_ref text,
               payment_id bigint, refund_id bigint, settlement_id bigint,
               event_on date, expected_on date, settled_on date,
               expected_paise bigint, settled_gross_paise bigint, fee_paise bigint,
               days_overdue integer, posted_entry_id bigint)
LANGUAGE sql STABLE SET search_path = payrail, pg_temp AS $$
  WITH ev AS (                       -- what we expect the gateway to settle
    SELECT 'payment'::text AS record_type, p.gateway_ref, p.payment_id, NULL::bigint AS refund_id,
           p.amount_paise AS expected_paise, (p.captured_at AT TIME ZONE 'Asia/Kolkata')::date AS event_on
      FROM payments p WHERE p.status = 'captured'
    UNION ALL
    SELECT 'refund', r.gateway_ref, NULL, r.refund_id,
           r.amount_paise, (r.processed_at AT TIME ZONE 'Asia/Kolkata')::date
      FROM refunds r WHERE r.status = 'processed'
  ), ev_asof AS (
    SELECT * FROM ev WHERE event_on <= p_as_of
  ), st AS (                         -- what the gateway reported, with its posting if any
    SELECT s.*, je.entry_id AS posted_entry_id
      FROM gateway_settlements s
      LEFT JOIN journal_entries je ON je.settlement_id = s.settlement_id
     WHERE s.settled_on <= p_as_of
  )
  SELECT CASE WHEN st.settlement_id IS NULL
              THEN CASE WHEN p_as_of <= e.event_on + 2 THEN 'in_transit' ELSE 'overdue_missing' END
              WHEN st.record_type = e.record_type AND st.gross_paise = e.expected_paise THEN 'matched'
              ELSE 'amount_mismatch' END,
         CASE WHEN st.settlement_id IS NULL
              THEN CASE WHEN p_as_of <= e.event_on + 2 THEN 'expected by ' || (e.event_on + 2)
                        ELSE 'not settled; expected on ' || (e.event_on + 2) END
              WHEN st.record_type <> e.record_type
              THEN 'reported as ' || st.record_type || ', recorded as ' || e.record_type
              WHEN st.gross_paise <> e.expected_paise
              THEN 'reported ' || fn_inr(st.gross_paise) || ', expected ' || fn_inr(e.expected_paise)
              ELSE 'ok' END,
         e.record_type, e.gateway_ref, e.payment_id, e.refund_id, st.settlement_id,
         e.event_on, e.event_on + 2, st.settled_on,
         e.expected_paise, st.gross_paise, st.fee_paise,
         CASE WHEN st.settlement_id IS NULL AND p_as_of > e.event_on + 2 THEN p_as_of - (e.event_on + 2) END,
         st.posted_entry_id
    FROM ev_asof e
    LEFT JOIN st ON st.gateway_ref = e.gateway_ref
  UNION ALL
  SELECT 'unknown_reference',
         CASE WHEN EXISTS (SELECT 1 FROM payments p WHERE p.gateway_ref = st.gateway_ref AND p.status <> 'captured')
              THEN 'reference belongs to a payment that is not captured'
              WHEN EXISTS (SELECT 1 FROM ev WHERE ev.gateway_ref = st.gateway_ref)
              THEN 'payment/refund recorded after the as-of date'
              ELSE 'no payment or refund has this reference' END,
         st.record_type, st.gateway_ref, NULL, NULL, st.settlement_id,
         NULL, NULL, st.settled_on, NULL, st.gross_paise, st.fee_paise, NULL, st.posted_entry_id
    FROM st
   WHERE NOT EXISTS (SELECT 1 FROM ev_asof e WHERE e.gateway_ref = st.gateway_ref)
   ORDER BY 1, 8, 10, 4
$$;

-- ---------------------------------------------------------------- fn_reconcile
-- Finance action: post every unposted settlement row (settled ≤ as_of) that
-- now matches exactly, then return counts and amounts per category.
CREATE FUNCTION fn_reconcile(p_finance_user_id bigint, p_as_of date)
RETURNS TABLE (category text, items bigint, expected_paise bigint, settled_gross_paise bigint,
               fee_paise bigint, posted_items bigint, newly_posted bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
DECLARE
  v_id  bigint;
  v_new bigint := 0;
BEGIN
  PERFORM fn_require_read_committed();
  PERFORM fn_require_role(p_finance_user_id, 'finance_admin');
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'as_of date is required' USING ERRCODE = 'PRV07';
  END IF;

  FOR v_id IN
    SELECT s.settlement_id FROM gateway_settlements s
     WHERE s.settled_on <= p_as_of
       AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.settlement_id = s.settlement_id)
     ORDER BY s.settlement_id
  LOOP
    IF fn_try_post_settlement(v_id) IS NOT NULL THEN
      v_new := v_new + 1;
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT r.category, count(*), sum(r.expected_paise)::bigint, sum(r.settled_gross_paise)::bigint,
         sum(r.fee_paise)::bigint, count(r.posted_entry_id),
         CASE WHEN r.category = 'matched' THEN v_new ELSE 0 END
    FROM fn_reconciliation_report(p_as_of) r
   GROUP BY r.category
   ORDER BY r.category;
END $$;

RESET ROLE;
