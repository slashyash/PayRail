-- 02_tables.sql — the 12 relations (DBD §6) with keys and CHECK constraints.
-- Column additions vs the midsem design: users.password_hash (DEC-002),
-- refunds.gateway_ref, gateway_settlements.record_type / imported_at (DEC-009),
-- journal_entries.created_xid (DEC-006). See docs/DECISIONS.md DEC-021.
--
-- Conventions: money = BIGINT paise; surrogate keys = BIGINT identity;
-- timestamps = timestamptz defaulting to fn_now(); every column NOT NULL
-- unless it is genuinely optional.

SET ROLE payrail_owner;
SET search_path = payrail;

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  user_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name      text        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 100),
  email          text        NOT NULL UNIQUE
                 CHECK (email = lower(email)
                        AND email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  role           text        NOT NULL CHECK (role IN ('customer', 'vendor_admin', 'finance_admin')),
  -- bcrypt hash only ($2a$/$2b$/$2y$, cost, 53 chars): plaintext cannot fit.
  password_hash  text        NOT NULL CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'),
  created_at     timestamptz NOT NULL DEFAULT fn_now()
);

-- ---------------------------------------------------------------- vendors
CREATE TABLE vendors (
  vendor_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id  bigint      NOT NULL UNIQUE REFERENCES users (user_id),   -- 1:1 OWNS
  legal_name     text        NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  -- Indian GSTIN: 2-digit state, PAN (5 letters, 4 digits, letter), entity no., 'Z', checksum char.
  gstin          text        UNIQUE CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  commission_bps integer     NOT NULL CHECK (commission_bps BETWEEN 0 AND 5000),
  kyc_status     text        NOT NULL DEFAULT 'pending'
                 CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
  created_at     timestamptz NOT NULL DEFAULT fn_now()
);

-- ---------------------------------------------------------------- products
CREATE TABLE products (
  product_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id      bigint      NOT NULL REFERENCES vendors (vendor_id),       -- SELLS
  name           text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  -- ₹0.01 .. ₹1 crore; keeps quantity × price far inside BIGINT.
  price_paise    bigint      NOT NULL CHECK (price_paise BETWEEN 1 AND 1000000000),
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT fn_now(),
  UNIQUE (vendor_id, name)
);

-- ---------------------------------------------------------------- orders
CREATE TABLE orders (
  order_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id    bigint      NOT NULL REFERENCES users (user_id),         -- PLACES
  created_at     timestamptz NOT NULL DEFAULT fn_now()
);

-- ---------------------------------------------------------------- order_items (weak entity of orders)
CREATE TABLE order_items (
  order_id         bigint  NOT NULL REFERENCES orders (order_id) ON DELETE CASCADE,
  line_no          integer NOT NULL CHECK (line_no > 0),
  product_id       bigint  NOT NULL REFERENCES products (product_id),
  quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  -- purchase-time snapshots (filled/verified by trg_order_items_snapshot)
  unit_price_paise bigint  NOT NULL CHECK (unit_price_paise > 0),
  commission_bps   integer NOT NULL CHECK (commission_bps BETWEEN 0 AND 5000),
  PRIMARY KEY (order_id, line_no),
  UNIQUE (order_id, product_id)
);

-- ---------------------------------------------------------------- payments
CREATE TABLE payments (
  payment_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        bigint      NOT NULL REFERENCES orders (order_id),      -- PAID_BY (1:N attempts)
  amount_paise    bigint      NOT NULL CHECK (amount_paise > 0),
  method          text        NOT NULL CHECK (method IN ('upi', 'card', 'netbanking')),
  status          text        NOT NULL DEFAULT 'initiated'
                  CHECK (status IN ('initiated', 'captured', 'failed')),
  gateway_ref     text        UNIQUE CHECK (gateway_ref ~ '^pay_[A-Za-z0-9]{6,40}$'),
  idempotency_key uuid        NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT fn_now(),
  captured_at     timestamptz,
  CHECK ((status = 'captured') = (captured_at IS NOT NULL)),
  CHECK (status <> 'captured' OR gateway_ref IS NOT NULL)
);
-- BR3: at most one captured payment per order (failed retries allowed).
CREATE UNIQUE INDEX payments_one_capture_per_order
  ON payments (order_id) WHERE status = 'captured';

-- ---------------------------------------------------------------- refunds
CREATE TABLE refunds (
  refund_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        bigint      NOT NULL,
  line_no         integer     NOT NULL,
  amount_paise    bigint      NOT NULL CHECK (amount_paise > 0),
  reason          text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  status          text        NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested', 'processed', 'rejected')),
  idempotency_key uuid        NOT NULL UNIQUE,
  requested_at    timestamptz NOT NULL DEFAULT fn_now(),
  processed_at    timestamptz,
  gateway_ref     text        UNIQUE CHECK (gateway_ref ~ '^rfnd_[A-Za-z0-9]{6,40}$'),   -- DEC-009
  FOREIGN KEY (order_id, line_no) REFERENCES order_items (order_id, line_no),
  CHECK ((status = 'processed') = (processed_at IS NOT NULL)),
  CHECK ((status = 'processed') = (gateway_ref IS NOT NULL))
);

-- ---------------------------------------------------------------- payouts
CREATE TABLE payouts (
  payout_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id       bigint      NOT NULL REFERENCES vendors (vendor_id),    -- PAID_OUT_TO
  amount_paise    bigint      NOT NULL CHECK (amount_paise > 0),
  status          text        NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested', 'paid', 'failed')),
  bank_utr        text        UNIQUE CHECK (bank_utr ~ '^[A-Z0-9]{12,22}$'),
  idempotency_key uuid        NOT NULL UNIQUE,
  requested_at    timestamptz NOT NULL DEFAULT fn_now(),
  completed_at    timestamptz,
  CHECK ((status = 'paid') = (bank_utr IS NOT NULL)),
  CHECK ((status = 'requested') = (completed_at IS NULL))
);

-- ---------------------------------------------------------------- gateway_settlements
-- One row per line of the gateway's settlement report. Deliberately NO foreign
-- key to payments/refunds (DBD D9): unknown references must be storable.
CREATE TABLE gateway_settlements (
  settlement_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gateway_ref    text        NOT NULL UNIQUE CHECK (gateway_ref ~ '^[A-Za-z0-9_]{1,64}$'),
  record_type    text        NOT NULL CHECK (record_type IN ('payment', 'refund')),    -- DEC-009
  gross_paise    bigint      NOT NULL CHECK (gross_paise > 0),
  fee_paise      bigint      NOT NULL DEFAULT 0 CHECK (fee_paise >= 0),
  settled_on     date        NOT NULL,
  imported_at    timestamptz NOT NULL DEFAULT fn_now(),
  CHECK (fee_paise < gross_paise),
  CHECK (record_type = 'payment' OR fee_paise = 0)
);

-- ---------------------------------------------------------------- accounts (EER specialisation on owner_type)
CREATE TABLE accounts (
  account_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           text   NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  owner_type     text   NOT NULL CHECK (owner_type IN ('platform', 'vendor', 'gateway', 'tax', 'bank')),
  vendor_id      bigint REFERENCES vendors (vendor_id),                    -- HOLDS
  account_class  text   NOT NULL CHECK (account_class IN ('asset', 'liability', 'revenue', 'expense')),
  CHECK ((owner_type = 'vendor') = (vendor_id IS NOT NULL)),
  -- Allowed (owner_type, class) pairs of our chart of accounts (DEC-007).
  CHECK ((owner_type, account_class) IN (('vendor', 'liability'), ('gateway', 'asset'),
                                         ('bank', 'asset'), ('tax', 'liability'),
                                         ('platform', 'revenue'), ('platform', 'expense'))),
  -- DBD D10: one account per (owner, vendor, class) slot; NULL vendor_id counts as equal.
  CONSTRAINT accounts_one_per_slot UNIQUE NULLS NOT DISTINCT (owner_type, vendor_id, account_class)
);

-- ---------------------------------------------------------------- journal_entries (ledger header)
CREATE TABLE journal_entries (
  entry_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_type        text        NOT NULL
                    CHECK (entry_type IN ('capture', 'refund', 'payout', 'settlement', 'reversal')),
  payment_id        bigint UNIQUE REFERENCES payments (payment_id),
  refund_id         bigint UNIQUE REFERENCES refunds (refund_id),
  payout_id         bigint UNIQUE REFERENCES payouts (payout_id),
  settlement_id     bigint UNIQUE REFERENCES gateway_settlements (settlement_id),
  reverses_entry_id bigint UNIQUE REFERENCES journal_entries (entry_id),  -- REVERSES (at most once)
  description       text        NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  created_at        timestamptz NOT NULL DEFAULT fn_now(),
  -- Transaction seal (DEC-006): forced to pg_current_xact_id() by trigger.
  created_xid       xid8        NOT NULL DEFAULT pg_current_xact_id(),
  -- BR10: exactly one business reference, and it matches entry_type.
  CONSTRAINT journal_entries_one_reference CHECK (
    num_nonnulls(payment_id, refund_id, payout_id, settlement_id, reverses_entry_id) = 1
    AND CASE entry_type
          WHEN 'capture'    THEN payment_id IS NOT NULL
          WHEN 'refund'     THEN refund_id IS NOT NULL
          WHEN 'payout'     THEN payout_id IS NOT NULL
          WHEN 'settlement' THEN settlement_id IS NOT NULL
          WHEN 'reversal'   THEN reverses_entry_id IS NOT NULL
        END)
);

-- ---------------------------------------------------------------- ledger_lines (weak entity of journal_entries)
CREATE TABLE ledger_lines (
  entry_id      bigint  NOT NULL REFERENCES journal_entries (entry_id),   -- no cascade: never deleted
  line_no       integer NOT NULL CHECK (line_no > 0),
  account_id    bigint  NOT NULL REFERENCES accounts (account_id),        -- POSTED_TO
  direction     char(1) NOT NULL CHECK (direction IN ('D', 'C')),
  amount_paise  bigint  NOT NULL CHECK (amount_paise > 0),
  PRIMARY KEY (entry_id, line_no)
);

RESET ROLE;
