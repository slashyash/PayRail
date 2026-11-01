-- 30_views.sql — derived attributes (DBD D8): nothing here is stored.
-- Each view aggregates at the grain it reports, in a subquery, before
-- joining, so joins cannot fan out and inflate sums.

SET ROLE payrail_owner;
SET search_path = payrail;

-- Account balances, expressed on each account's normal side.
-- balance_paise > 0 means "normal": e.g. money the platform owes a vendor.
CREATE VIEW v_account_balances AS
SELECT a.account_id,
       a.code,
       a.owner_type,
       a.vendor_id,
       a.account_class,
       fn_normal_side(a.account_class)            AS normal_side,
       coalesce(t.debit_paise, 0)::bigint         AS debit_paise,
       coalesce(t.credit_paise, 0)::bigint        AS credit_paise,
       (CASE WHEN fn_normal_side(a.account_class) = 'D'
             THEN coalesce(t.debit_paise, 0) - coalesce(t.credit_paise, 0)
             ELSE coalesce(t.credit_paise, 0) - coalesce(t.debit_paise, 0) END)::bigint AS balance_paise
  FROM accounts a
  LEFT JOIN (SELECT account_id,
                    sum(amount_paise) FILTER (WHERE direction = 'D') AS debit_paise,
                    sum(amount_paise) FILTER (WHERE direction = 'C') AS credit_paise
               FROM ledger_lines
              GROUP BY account_id) t USING (account_id);

-- Per order line: snapshot allocation (DEC-004) and refund reservation (DEC-005).
-- refundable_paise = line total − (requested + processed refunds); rejected
-- requests release their amount.
CREATE VIEW v_order_line_allocation AS
SELECT oi.order_id,
       oi.line_no,
       oi.product_id,
       p.vendor_id,
       oi.quantity,
       oi.unit_price_paise,
       oi.commission_bps,
       s.line_total_paise,
       s.commission_paise,
       s.gst_paise,
       s.vendor_paise,
       coalesce(r.processed_paise, 0)::bigint AS refunded_paise,
       coalesce(r.requested_paise, 0)::bigint AS refund_pending_paise,
       (s.line_total_paise - coalesce(r.processed_paise, 0) - coalesce(r.requested_paise, 0))::bigint
                                              AS refundable_paise
  FROM order_items oi
  JOIN products p USING (product_id)
  CROSS JOIN LATERAL fn_split_line(oi.quantity, oi.unit_price_paise, oi.commission_bps) s
  LEFT JOIN (SELECT order_id, line_no,
                    sum(amount_paise) FILTER (WHERE status = 'processed') AS processed_paise,
                    sum(amount_paise) FILTER (WHERE status = 'requested') AS requested_paise
               FROM refunds
              GROUP BY order_id, line_no) r USING (order_id, line_no);

-- Order total and derived status (DEC-016).
CREATE VIEW v_order_summary AS
SELECT o.order_id,
       o.customer_id,
       o.created_at,
       coalesce(li.line_count, 0)                AS line_count,
       coalesce(li.total_paise, 0)::bigint       AS total_paise,
       cp.payment_id                             AS captured_payment_id,
       cp.captured_at,
       coalesce(rf.refunded_paise, 0)::bigint    AS refunded_paise,
       coalesce(rf.pending_paise, 0)::bigint     AS refund_pending_paise,
       CASE WHEN cp.payment_id IS NULL                              THEN 'pending_payment'
            WHEN coalesce(rf.refunded_paise, 0) = 0                 THEN 'paid'
            WHEN rf.refunded_paise < li.total_paise                 THEN 'partially_refunded'
            ELSE 'refunded' END                  AS status
  FROM orders o
  LEFT JOIN (SELECT order_id, count(*) AS line_count,
                    sum(quantity::bigint * unit_price_paise) AS total_paise
               FROM order_items GROUP BY order_id) li ON li.order_id = o.order_id
  LEFT JOIN payments cp ON cp.order_id = o.order_id AND cp.status = 'captured'
  LEFT JOIN (SELECT order_id,
                    sum(amount_paise) FILTER (WHERE status = 'processed') AS refunded_paise,
                    sum(amount_paise) FILTER (WHERE status = 'requested') AS pending_paise
               FROM refunds GROUP BY order_id) rf ON rf.order_id = o.order_id;

-- Vendor statement with running balance (window function). Credits increase
-- what the platform owes the vendor; debits (refunds, payouts) reduce it.
-- Order is deterministic: posting time, then entry id, then line number.
CREATE VIEW v_vendor_statement AS
SELECT a.vendor_id,
       e.entry_id,
       l.line_no,
       e.created_at,
       e.entry_type,
       e.description,
       e.payment_id,
       e.refund_id,
       e.payout_id,
       e.reverses_entry_id,
       CASE WHEN l.direction = 'C' THEN l.amount_paise ELSE 0 END AS credit_paise,
       CASE WHEN l.direction = 'D' THEN l.amount_paise ELSE 0 END AS debit_paise,
       sum(CASE WHEN l.direction = 'C' THEN l.amount_paise ELSE -l.amount_paise END)
         OVER (PARTITION BY a.vendor_id
               ORDER BY e.created_at, e.entry_id, l.line_no
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::bigint AS running_balance_paise
  FROM ledger_lines l
  JOIN accounts a        ON a.account_id = l.account_id AND a.owner_type = 'vendor'
  JOIN journal_entries e ON e.entry_id = l.entry_id;

RESET ROLE;
