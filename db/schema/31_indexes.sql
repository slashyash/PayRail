-- 31_indexes.sql — secondary indexes. Primary keys and UNIQUE constraints
-- already create indexes (e.g. order_items(order_id, ...), products(vendor_id, name),
-- journal_entries' reference columns). Benefits are to be measured with
-- EXPLAIN (ANALYZE, BUFFERS) on the seeded database in Task 6 — no claims yet.

SET ROLE payrail_owner;
SET search_path = payrail;

-- Balances and vendor statements: all lines of one account, in posting order.
CREATE INDEX ledger_lines_account_entry_idx ON ledger_lines (account_id, entry_id);

-- Customer order history (newest first).
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);

-- FK-side indexes used by joins and by FK checks on delete.
CREATE INDEX order_items_product_idx ON order_items (product_id);   -- "is this product referenced?"
CREATE INDEX payments_order_idx      ON payments (order_id);
CREATE INDEX refunds_line_idx        ON refunds (order_id, line_no);
CREATE INDEX payouts_vendor_idx      ON payouts (vendor_id, requested_at);
CREATE INDEX accounts_vendor_idx     ON accounts (vendor_id) WHERE vendor_id IS NOT NULL;

-- Finance work queues (small partial indexes).
CREATE INDEX refunds_pending_idx ON refunds (requested_at) WHERE status = 'requested';
CREATE INDEX payouts_pending_idx ON payouts (requested_at) WHERE status = 'requested';

-- Reconciliation by settlement date.
CREATE INDEX gateway_settlements_settled_on_idx ON gateway_settlements (settled_on);

RESET ROLE;
