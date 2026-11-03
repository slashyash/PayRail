-- 32_reports.sql — the six named SQL reports (Task 6, DEC-040).
--
--   R1 fn_report_trial_balance(as_of)                    trial balance + global equality check
--   R2 fn_report_vendor_statement(vendor, from, to)      statement with window running balance
--   R3 fn_report_monthly_performance(from, to)           payments / refunds / commission per IST month
--   R4 fn_report_vendor_refund_risk(from, to, min_sales) refund rate per vendor (sales cohort)
--   R5 fn_report_settlement_aging(as_of)                 reconciliation categories × age buckets
--   R6 fn_report_vendor_payables(vendor)                 payable balance decomposed + payout cross-check
--
-- Design rules (see db/reports/README.md for the walkthrough):
--   * Read-only, SECURITY INVOKER, LANGUAGE sql, one SELECT, no SET clause:
--     PostgreSQL can INLINE such functions into the calling query, so
--     EXPLAIN shows the real plan and caller filters are pushed down. Because
--     there is no pinned search_path, every object is schema-qualified
--     (built-in operators live in pg_catalog, which is always searched first).
--   * Aggregate at the grain being reported BEFORE joining (one CTE per source),
--     so a join can never multiply rows and inflate a sum (join fan-out).
--   * Money stays BIGINT paise; rates are integer basis points rounded half-up
--     with fn_round_half_up. Business dates are Asia/Kolkata calendar dates.
--   * The application reads them as payrail_app (SELECT on the tables, EXECUTE
--     granted in 99_privileges.sql); vendor scoping is done by the API, which
--     passes the logged-in vendor's id.

SET ROLE payrail_owner;
SET search_path = payrail;

-- ================================================================ R1 trial balance
-- One row per account (debit total, credit total, balance in the Dr or Cr
-- column) plus ONE total row produced by GROUPING SETS. On the total row
-- `balanced` is true iff Σ debits = Σ credits AND Σ Dr balances = Σ Cr balances.
-- p_as_of: only entries posted on or before that IST date (NULL = everything).
CREATE FUNCTION fn_report_trial_balance(p_as_of date DEFAULT NULL)
RETURNS TABLE (account_id bigint, code text, account_class text, owner_type text, vendor_id bigint,
               vendor_name text, normal_side char(1), debit_paise bigint, credit_paise bigint,
               balance_paise bigint, debit_balance_paise bigint, credit_balance_paise bigint,
               is_total boolean, balanced boolean)
LANGUAGE sql STABLE AS $$
  WITH per_account AS (                     -- grain: account (lines aggregated first)
    SELECT l.account_id,
           sum(l.amount_paise) FILTER (WHERE l.direction = 'D') AS d,
           sum(l.amount_paise) FILTER (WHERE l.direction = 'C') AS c
      FROM payrail.ledger_lines l
      JOIN payrail.journal_entries e ON e.entry_id = l.entry_id
     WHERE p_as_of IS NULL OR (e.created_at AT TIME ZONE 'Asia/Kolkata')::date <= p_as_of
     GROUP BY l.account_id
  ), tb AS (                                -- every account, even one without lines
    SELECT a.account_id, a.code, a.account_class, a.owner_type, a.vendor_id, v.legal_name,
           payrail.fn_normal_side(a.account_class) AS normal_side,
           coalesce(t.d, 0) AS d, coalesce(t.c, 0) AS c
      FROM payrail.accounts a
      LEFT JOIN payrail.vendors v ON v.vendor_id = a.vendor_id
      LEFT JOIN per_account t ON t.account_id = a.account_id
  )
  SELECT tb.account_id, tb.code, tb.account_class, tb.owner_type, tb.vendor_id, tb.legal_name, tb.normal_side,
         sum(tb.d)::bigint,
         sum(tb.c)::bigint,
         CASE WHEN grouping(tb.account_id) = 0
              THEN sum(CASE WHEN tb.normal_side = 'D' THEN tb.d - tb.c ELSE tb.c - tb.d END)::bigint END,
         sum(greatest(tb.d - tb.c, 0))::bigint,
         sum(greatest(tb.c - tb.d, 0))::bigint,
         grouping(tb.account_id) = 1,
         CASE WHEN grouping(tb.account_id) = 1
              THEN sum(tb.d) = sum(tb.c)
                   AND sum(greatest(tb.d - tb.c, 0)) = sum(greatest(tb.c - tb.d, 0)) END
    FROM tb
   GROUP BY GROUPING SETS ((tb.account_id, tb.code, tb.account_class, tb.owner_type, tb.vendor_id,
                            tb.legal_name, tb.normal_side), ())
   ORDER BY grouping(tb.account_id), tb.account_id
$$;

-- ================================================================ R2 vendor statement
-- Rows: one 'opening' row, one 'line' row per ledger line on the vendor's
-- payable account inside [from, to], one 'closing' row.
-- The running balance comes from v_vendor_statement (SUM … OVER (PARTITION BY
-- vendor ORDER BY created_at, entry_id, line_no)) and is computed over the
-- vendor's WHOLE history; the date filter is applied afterwards. Filtering
-- first would restart the balance at 0 on the first shown day.
-- Invariant (tested): closing balance = opening + Σ(credit − debit) in range
--                   = running balance of the last line in range.
CREATE FUNCTION fn_report_vendor_statement(p_vendor_id bigint, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (row_kind text, seq bigint, entry_id bigint, line_no integer, created_at timestamptz,
               posted_on date, entry_type text, payment_id bigint, refund_id bigint, payout_id bigint,
               reverses_entry_id bigint, reference text, description text,
               credit_paise bigint, debit_paise bigint, running_balance_paise bigint)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT vs.*, (vs.created_at AT TIME ZONE 'Asia/Kolkata')::date AS on_date
      FROM payrail.v_vendor_statement vs
     WHERE vs.vendor_id = p_vendor_id      -- partition column: pushed below the window
  ), in_range AS (                         -- date filter AFTER the window
    SELECT s.*, row_number() OVER (ORDER BY s.created_at, s.entry_id, s.line_no) AS seq
      FROM s
     WHERE (p_from IS NULL OR s.on_date >= p_from) AND (p_to IS NULL OR s.on_date <= p_to)
  ), opening AS (
    SELECT coalesce(sum(s.credit_paise - s.debit_paise), 0)::bigint AS bal
      FROM s WHERE p_from IS NOT NULL AND s.on_date < p_from
  )
  SELECT 'opening', 0::bigint, NULL::bigint, NULL::integer, NULL::timestamptz, p_from, NULL::text,
         NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint, NULL::text,
         CASE WHEN p_from IS NULL THEN 'Opening balance' ELSE 'Balance before ' || p_from END,
         NULL::bigint, NULL::bigint, o.bal
    FROM opening o
  UNION ALL
  SELECT 'line', r.seq, r.entry_id, r.line_no, r.created_at, r.on_date, r.entry_type,
         r.payment_id, r.refund_id, r.payout_id, r.reverses_entry_id,
         CASE r.entry_type
           WHEN 'capture'  THEN 'order ' || p.order_id
           WHEN 'refund'   THEN 'refund ' || r.refund_id || ' (order ' || rf.order_id || ')'
           WHEN 'payout'   THEN 'payout ' || r.payout_id
           WHEN 'reversal' THEN 'reversal of payout ' || x.payout_id
         END,
         r.description, r.credit_paise, r.debit_paise, r.running_balance_paise
    FROM in_range r
    LEFT JOIN payrail.payments p        ON p.payment_id = r.payment_id
    LEFT JOIN payrail.refunds rf        ON rf.refund_id = r.refund_id
    LEFT JOIN payrail.journal_entries x ON x.entry_id   = r.reverses_entry_id
  UNION ALL
  SELECT 'closing', count(*) + 1, NULL, NULL, NULL, p_to, NULL, NULL, NULL, NULL, NULL, NULL,
         CASE WHEN p_to IS NULL THEN 'Closing balance' ELSE 'Balance at end of ' || p_to END,
         coalesce(sum(r.credit_paise), 0)::bigint, coalesce(sum(r.debit_paise), 0)::bigint,
         ((SELECT bal FROM opening) + coalesce(sum(r.credit_paise - r.debit_paise), 0))::bigint
    FROM in_range r
  ORDER BY 2
$$;

-- ================================================================ R3 monthly performance
-- One row per IST calendar month from p_from's month to p_to's month
-- (defaults: first and last month with an order). Each measure is aggregated
-- in its own CTE at month grain and then LEFT JOINed to the month series, so
-- no source can multiply another.
--   Date bases (IST):  captured_* by payments.captured_at;
--                      attempts_* by payments.created_at (attempts that reached
--                        a final state: captured or failed; 'initiated' excluded);
--                      refunds_* by refunds.processed_at (status processed);
--                      commission / GST / fees from the LEDGER by
--                        journal_entries.created_at (same source as R1).
--   success_rate_bps = attempts captured / attempts final            (×10 000)
--   refund_rate_bps  = refunded in month / captured gross in month   (×10 000;
--                      a refund may belong to an earlier month's sale — R4 uses
--                      a sales cohort instead)
--   platform_net     = net commission − gateway fees (GST is a liability, not revenue)
--   cumulative_gross = running total of captured gross (window function)
CREATE FUNCTION fn_report_monthly_performance(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (month date, payments_captured bigint, captured_gross_paise bigint,
               attempts_final bigint, attempts_failed bigint, success_rate_bps bigint,
               refunds_processed bigint, refunded_paise bigint, refund_rate_bps bigint,
               commission_net_paise bigint, gst_net_paise bigint, gateway_fees_paise bigint,
               platform_net_paise bigint, cumulative_gross_paise bigint)
LANGUAGE sql STABLE AS $$
  WITH bounds AS (
    SELECT date_trunc('month', coalesce(p_from, min(o.created_at AT TIME ZONE 'Asia/Kolkata')::date))::date AS m0,
           date_trunc('month', coalesce(p_to,   max(o.created_at AT TIME ZONE 'Asia/Kolkata')::date))::date AS m1
      FROM payrail.orders o
  ), months AS (
    SELECT g::date AS month FROM bounds b, generate_series(b.m0, b.m1, interval '1 month') g
  ), cap AS (
    SELECT date_trunc('month', p.captured_at AT TIME ZONE 'Asia/Kolkata')::date AS month,
           count(*) AS n, sum(p.amount_paise) AS gross
      FROM payrail.payments p WHERE p.status = 'captured' GROUP BY 1
  ), att AS (
    SELECT date_trunc('month', p.created_at AT TIME ZONE 'Asia/Kolkata')::date AS month,
           count(*) FILTER (WHERE p.status IN ('captured', 'failed')) AS final,
           count(*) FILTER (WHERE p.status = 'captured') AS ok,
           count(*) FILTER (WHERE p.status = 'failed') AS failed
      FROM payrail.payments p GROUP BY 1
  ), ref AS (
    SELECT date_trunc('month', r.processed_at AT TIME ZONE 'Asia/Kolkata')::date AS month,
           count(*) AS n, sum(r.amount_paise) AS amt
      FROM payrail.refunds r WHERE r.status = 'processed' GROUP BY 1
  ), led AS (                              -- ledger: platform accounts only
    SELECT date_trunc('month', e.created_at AT TIME ZONE 'Asia/Kolkata')::date AS month,
           sum(CASE WHEN a.code = 'COMMISSION_REVENUE'
                    THEN CASE l.direction WHEN 'C' THEN l.amount_paise ELSE -l.amount_paise END END) AS commission,
           sum(CASE WHEN a.code = 'GST_PAYABLE'
                    THEN CASE l.direction WHEN 'C' THEN l.amount_paise ELSE -l.amount_paise END END) AS gst,
           sum(CASE WHEN a.code = 'GATEWAY_FEE_EXPENSE'
                    THEN CASE l.direction WHEN 'D' THEN l.amount_paise ELSE -l.amount_paise END END) AS fees
      FROM payrail.ledger_lines l
      JOIN payrail.accounts a        ON a.account_id = l.account_id
      JOIN payrail.journal_entries e ON e.entry_id = l.entry_id
     WHERE a.code IN ('COMMISSION_REVENUE', 'GST_PAYABLE', 'GATEWAY_FEE_EXPENSE')
     GROUP BY 1
  )
  SELECT m.month,
         coalesce(cap.n, 0), coalesce(cap.gross, 0)::bigint,
         coalesce(att.final, 0), coalesce(att.failed, 0),
         CASE WHEN att.final > 0 THEN payrail.fn_round_half_up(att.ok, 10000, att.final) END,
         coalesce(ref.n, 0), coalesce(ref.amt, 0)::bigint,
         CASE WHEN cap.gross > 0 THEN payrail.fn_round_half_up(coalesce(ref.amt, 0)::bigint, 10000, cap.gross::bigint) END,
         coalesce(led.commission, 0)::bigint, coalesce(led.gst, 0)::bigint, coalesce(led.fees, 0)::bigint,
         (coalesce(led.commission, 0) - coalesce(led.fees, 0))::bigint,
         sum(coalesce(cap.gross, 0)) OVER (ORDER BY m.month)::bigint
    FROM months m
    LEFT JOIN cap ON cap.month = m.month
    LEFT JOIN att ON att.month = m.month
    LEFT JOIN ref ON ref.month = m.month
    LEFT JOIN led ON led.month = m.month
   ORDER BY m.month
$$;

-- ================================================================ R4 vendor refund risk
-- Sales cohort: order lines of a vendor whose order was CAPTURED in [from, to]
-- (IST dates; NULL = unbounded). For those lines only:
--   numerator   refunded_paise = processed refunds of those lines (whenever processed)
--   denominator sales_paise    = Σ line totals (quantity × snapshot price)
--   refund_rate_bps = rhu(refunded × 10 000 / sales)
-- Also: pending (requested) refund amount, requests / rejections, lines with
-- any processed refund, and a rank (1 = highest rate) among vendors with at
-- least p_min_sales_paise of sales (smaller samples are not ranked: 'low_volume').
-- risk_band: high ≥ 1000 bps (10%), watch ≥ 500 bps, else normal.
CREATE FUNCTION fn_report_vendor_refund_risk(p_from date DEFAULT NULL, p_to date DEFAULT NULL,
                                             p_min_sales_paise bigint DEFAULT 100000)
RETURNS TABLE (vendor_id bigint, legal_name text, kyc_status text, lines_sold bigint, sales_paise bigint,
               refund_requests bigint, refunds_rejected bigint, lines_refunded bigint,
               refunded_paise bigint, pending_refund_paise bigint, refund_rate_bps bigint,
               rate_rank bigint, risk_band text)
LANGUAGE sql STABLE AS $$
  WITH cohort AS (                         -- grain: order line
    SELECT oi.order_id, oi.line_no, pr.vendor_id, oi.quantity::bigint * oi.unit_price_paise AS line_total
      FROM payrail.order_items oi
      JOIN payrail.products pr ON pr.product_id = oi.product_id
      JOIN payrail.payments p  ON p.order_id = oi.order_id AND p.status = 'captured'
     WHERE (p_from IS NULL OR (p.captured_at AT TIME ZONE 'Asia/Kolkata')::date >= p_from)
       AND (p_to   IS NULL OR (p.captured_at AT TIME ZONE 'Asia/Kolkata')::date <= p_to)
  ), line_refunds AS (                     -- grain: order line (refunds aggregated first)
    SELECT r.order_id, r.line_no,
           count(*)                                                    AS requests,
           count(*) FILTER (WHERE r.status = 'rejected')               AS rejected,
           coalesce(sum(r.amount_paise) FILTER (WHERE r.status = 'processed'), 0) AS processed,
           coalesce(sum(r.amount_paise) FILTER (WHERE r.status = 'requested'), 0) AS pending
      FROM payrail.refunds r GROUP BY r.order_id, r.line_no
  ), per_vendor AS (                       -- grain: vendor
    SELECT c.vendor_id,
           count(*)                                      AS lines_sold,
           sum(c.line_total)                             AS sales,
           coalesce(sum(lr.requests), 0)                 AS requests,
           coalesce(sum(lr.rejected), 0)                 AS rejected,
           count(*) FILTER (WHERE lr.processed > 0)      AS lines_refunded,
           coalesce(sum(lr.processed), 0)                AS refunded,
           coalesce(sum(lr.pending), 0)                  AS pending
      FROM cohort c
      LEFT JOIN line_refunds lr ON lr.order_id = c.order_id AND lr.line_no = c.line_no
     GROUP BY c.vendor_id
  ), rated AS (
    SELECT pv.*, payrail.fn_round_half_up(pv.refunded::bigint, 10000, pv.sales::bigint) AS rate,
           pv.sales >= p_min_sales_paise AS ranked
      FROM per_vendor pv
  )
  SELECT v.vendor_id, v.legal_name, v.kyc_status,
         coalesce(r.lines_sold, 0), coalesce(r.sales, 0)::bigint,
         coalesce(r.requests, 0)::bigint, coalesce(r.rejected, 0)::bigint, coalesce(r.lines_refunded, 0),
         coalesce(r.refunded, 0)::bigint, coalesce(r.pending, 0)::bigint,
         r.rate,
         CASE WHEN r.ranked THEN rank() OVER (PARTITION BY r.ranked ORDER BY r.rate DESC) END,
         CASE WHEN r.vendor_id IS NULL THEN 'no_sales'
              WHEN NOT r.ranked        THEN 'low_volume'
              WHEN r.rate >= 1000      THEN 'high'
              WHEN r.rate >= 500       THEN 'watch'
              ELSE 'normal' END
    FROM payrail.vendors v
    LEFT JOIN rated r ON r.vendor_id = v.vendor_id
   ORDER BY r.rate DESC NULLS LAST, v.vendor_id
$$;

-- ================================================================ R5 settlement reconciliation & aging
-- Builds on fn_reconciliation_report(as_of) (24_wf_settlements.sql), which does
-- the reference matching: every expected event (captured payment / processed
-- refund dated ≤ as_of) LEFT JOINed to the settlement row with the same
-- gateway_ref, plus every settlement row without such an event. This report
-- adds an AGE per category and buckets it:
--   matched            age = settled_on − event_on       (settlement lag; T+2 is on time)
--   in_transit         age = as_of − event_on            (0, 1 or 2 days old)
--   overdue_missing    age = days_overdue = as_of − (event_on + 2)
--   amount_mismatch    age = as_of − settled_on          (days open)
--   unknown_reference  age = as_of − settled_on          (days open)
-- Buckets: '0-2 d', '3-7 d', '8-30 d', '>30 d'. GROUPING SETS add a subtotal
-- per category (bucket NULL, listed first) and a grand total (category NULL, last).
-- difference_paise = settled gross − expected (only where both exist).
-- net_cash_paise   = what the bank received for posted rows:
--                    payment rows gross − fee, refund rows −gross.
CREATE FUNCTION fn_report_settlement_aging(p_as_of date)
RETURNS TABLE (category text, age_bucket text, items bigint, expected_paise bigint,
               settled_gross_paise bigint, fee_paise bigint, difference_paise bigint,
               net_cash_paise bigint, oldest_age_days integer, is_subtotal boolean, is_total boolean)
LANGUAGE sql STABLE AS $$
  WITH r AS (
    SELECT x.*,
           CASE x.category
             WHEN 'matched'         THEN x.settled_on - x.event_on
             WHEN 'in_transit'      THEN p_as_of - x.event_on
             WHEN 'overdue_missing' THEN x.days_overdue
             ELSE p_as_of - x.settled_on
           END AS age_days
      FROM payrail.fn_reconciliation_report(p_as_of) x
  ), b AS (
    SELECT r.*,
           CASE WHEN r.age_days <= 2 THEN '0-2 d' WHEN r.age_days <= 7 THEN '3-7 d'
                WHEN r.age_days <= 30 THEN '8-30 d' ELSE '>30 d' END AS bucket,
           CASE WHEN r.posted_entry_id IS NULL THEN 0
                WHEN r.record_type = 'payment' THEN r.settled_gross_paise - r.fee_paise
                ELSE -r.settled_gross_paise END AS net_cash
      FROM r
  )
  SELECT b.category, b.bucket, count(*),
         sum(b.expected_paise)::bigint, sum(b.settled_gross_paise)::bigint, sum(b.fee_paise)::bigint,
         sum(b.settled_gross_paise - b.expected_paise)::bigint,
         sum(b.net_cash)::bigint, max(b.age_days),
         grouping(b.bucket) = 1 AND grouping(b.category) = 0,
         grouping(b.category) = 1
    FROM b
   GROUP BY GROUPING SETS ((b.category, b.bucket), (b.category), ())
   ORDER BY grouping(b.category), b.category,
            grouping(b.bucket) DESC, array_position(ARRAY['0-2 d', '3-7 d', '8-30 d', '>30 d'], b.bucket)
$$;

-- ================================================================ R6 vendor payable / payout summary
-- One row per vendor (or just p_vendor_id). The payable balance is decomposed
-- by journal entry type from the LEDGER (credit-positive):
--   sales (capture) − refunds (refund) − payouts requested (payout) + reversals = balance
-- and cross-checked against the PAYOUTS table: for every vendor
--   ledger payout debits − reversal credits  =  Σ amount of payouts in status requested/paid
-- (failed payouts are fully reversed). `ledger_consistent` reports that check.
-- Ledger lines and payouts are aggregated separately per vendor, then joined.
CREATE FUNCTION fn_report_vendor_payables(p_vendor_id bigint DEFAULT NULL)
RETURNS TABLE (vendor_id bigint, legal_name text, kyc_status text, commission_bps integer,
               sales_paise bigint, refunds_paise bigint, payouts_paise bigint, reversals_paise bigint,
               balance_paise bigint, payouts_paid bigint, paid_paise bigint,
               payouts_in_flight bigint, in_flight_paise bigint, payouts_failed bigint, failed_paise bigint,
               last_paid_at timestamptz, ledger_consistent boolean, status text)
LANGUAGE sql STABLE AS $$
  WITH led AS (                            -- grain: vendor
    SELECT a.vendor_id,
           sum(CASE WHEN e.entry_type = 'capture'  THEN s.signed ELSE 0 END)  AS sales,
           -sum(CASE WHEN e.entry_type = 'refund'   THEN s.signed ELSE 0 END) AS refunds,
           -sum(CASE WHEN e.entry_type = 'payout'   THEN s.signed ELSE 0 END) AS payouts,
           sum(CASE WHEN e.entry_type = 'reversal' THEN s.signed ELSE 0 END)  AS reversals,
           sum(s.signed)                                                      AS balance
      FROM payrail.ledger_lines l
      JOIN payrail.accounts a        ON a.account_id = l.account_id AND a.owner_type = 'vendor'
      JOIN payrail.journal_entries e ON e.entry_id = l.entry_id
      CROSS JOIN LATERAL (SELECT CASE l.direction WHEN 'C' THEN l.amount_paise ELSE -l.amount_paise END AS signed) s
     WHERE p_vendor_id IS NULL OR a.vendor_id = p_vendor_id
     GROUP BY a.vendor_id
  ), po AS (                               -- grain: vendor
    SELECT p.vendor_id,
           count(*) FILTER (WHERE p.status = 'paid')      AS n_paid,
           coalesce(sum(p.amount_paise) FILTER (WHERE p.status = 'paid'), 0)      AS paid,
           count(*) FILTER (WHERE p.status = 'requested') AS n_flight,
           coalesce(sum(p.amount_paise) FILTER (WHERE p.status = 'requested'), 0) AS flight,
           count(*) FILTER (WHERE p.status = 'failed')    AS n_failed,
           coalesce(sum(p.amount_paise) FILTER (WHERE p.status = 'failed'), 0)    AS failed,
           max(p.completed_at) FILTER (WHERE p.status = 'paid') AS last_paid_at
      FROM payrail.payouts p
     WHERE p_vendor_id IS NULL OR p.vendor_id = p_vendor_id
     GROUP BY p.vendor_id
  )
  SELECT v.vendor_id, v.legal_name, v.kyc_status, v.commission_bps,
         coalesce(led.sales, 0)::bigint, coalesce(led.refunds, 0)::bigint,
         coalesce(led.payouts, 0)::bigint, coalesce(led.reversals, 0)::bigint,
         coalesce(led.balance, 0)::bigint,
         coalesce(po.n_paid, 0), coalesce(po.paid, 0)::bigint,
         coalesce(po.n_flight, 0), coalesce(po.flight, 0)::bigint,
         coalesce(po.n_failed, 0), coalesce(po.failed, 0)::bigint,
         po.last_paid_at,
         coalesce(led.payouts, 0) - coalesce(led.reversals, 0) = coalesce(po.paid, 0) + coalesce(po.flight, 0),
         CASE WHEN coalesce(led.balance, 0) < 0 THEN 'negative'
              WHEN v.kyc_status <> 'verified'   THEN 'payouts_blocked_kyc'
              WHEN coalesce(led.balance, 0) = 0 THEN 'nothing_payable'
              ELSE 'payable' END
    FROM payrail.vendors v
    LEFT JOIN led ON led.vendor_id = v.vendor_id
    LEFT JOIN po  ON po.vendor_id  = v.vendor_id
   WHERE p_vendor_id IS NULL OR v.vendor_id = p_vendor_id
   ORDER BY v.vendor_id
$$;

RESET ROLE;
