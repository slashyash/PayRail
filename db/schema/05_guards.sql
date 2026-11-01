-- 05_guards.sql — business-rule triggers for rules a CHECK cannot express
-- (DBD §7 T1, T5, T6; DEC-010, DEC-017). Workflow functions (Task 2) add the
-- rules that need locks (refund cap, payout balance).
--
-- SQLSTATE codes:
--   PRV01 vendor owner is not a vendor_admin   PRV02 order customer is not a customer
--   PRV03 vendor is not KYC-verified           PRV04 product is not active
--   PRV05 snapshot differs from catalogue      PRV06 row/column is immutable
--   PRO01 order already has a payment attempt (its lines are frozen)
--   PRS01 invalid status transition            PRP01 capture amount <> order total

SET ROLE payrail_owner;
SET search_path = payrail;

-- ---------------------------------------------------------------- generic: immutable row
CREATE FUNCTION trg_forbid_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (financial history is retained)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'PRV06';
END $$;

-- ---------------------------------------------------------------- users: exactly one, fixed role
CREATE FUNCTION trg_users_role_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'user % role cannot change (% -> %)', OLD.user_id, OLD.role, NEW.role
      USING ERRCODE = 'PRV06';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_users_role_fixed BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trg_users_role_fixed();

-- ---------------------------------------------------------------- vendors (DEC-017, DBD T1)
CREATE FUNCTION trg_vendors_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    RAISE EXCEPTION 'vendor % owner cannot change', OLD.vendor_id USING ERRCODE = 'PRV06';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE user_id = NEW.owner_user_id AND role = 'vendor_admin') THEN
    RAISE EXCEPTION 'vendor owner % must be an existing vendor_admin user', NEW.owner_user_id
      USING ERRCODE = 'PRV01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_vendors_owner BEFORE INSERT OR UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION trg_vendors_owner();

-- T1: every vendor gets exactly one payable (liability) account.
-- SECURITY DEFINER so it works whoever inserts the vendor; search_path pinned.
CREATE FUNCTION trg_vendors_create_payable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = payrail, pg_temp AS $$
BEGIN
  INSERT INTO accounts (code, owner_type, vendor_id, account_class)
  VALUES ('VENDOR_PAYABLE_' || NEW.vendor_id, 'vendor', NEW.vendor_id, 'liability');
  RETURN NULL;
END $$;
CREATE TRIGGER trg_vendors_create_payable AFTER INSERT ON vendors
  FOR EACH ROW EXECUTE FUNCTION trg_vendors_create_payable();

-- ---------------------------------------------------------------- accounts: retained and fixed
CREATE TRIGGER trg_accounts_immutable BEFORE UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();

-- ---------------------------------------------------------------- orders
CREATE FUNCTION trg_orders_customer() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE user_id = NEW.customer_id AND role = 'customer') THEN
    RAISE EXCEPTION 'order customer % must be an existing customer user', NEW.customer_id
      USING ERRCODE = 'PRV02';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_orders_customer BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION trg_orders_customer();
CREATE TRIGGER trg_orders_immutable BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();

-- ---------------------------------------------------------------- order_items (BR7, snapshots)
-- Only active products of verified vendors can be ordered. The price and
-- commission snapshots are taken from the catalogue here: if the caller
-- leaves them NULL they are filled in; if it supplies different values the
-- insert is rejected (a client can never choose its own price or rate).
CREATE FUNCTION trg_order_items_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
DECLARE
  v_price  bigint;
  v_active boolean;
  v_bps    integer;
  v_kyc    text;
BEGIN
  IF EXISTS (SELECT 1 FROM payments WHERE order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'order % already has a payment attempt; its lines are frozen', NEW.order_id
      USING ERRCODE = 'PRO01';
  END IF;

  SELECT p.price_paise, p.is_active, v.commission_bps, v.kyc_status
    INTO v_price, v_active, v_bps, v_kyc
    FROM products p JOIN vendors v USING (vendor_id)
   WHERE p.product_id = NEW.product_id;
  IF NOT FOUND THEN
    RETURN NEW;                                   -- the foreign key reports it
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'product % is not active', NEW.product_id USING ERRCODE = 'PRV04';
  END IF;
  IF v_kyc <> 'verified' THEN
    RAISE EXCEPTION 'product % belongs to a vendor that is not KYC-verified', NEW.product_id
      USING ERRCODE = 'PRV03';
  END IF;

  IF NEW.unit_price_paise IS NULL THEN
    NEW.unit_price_paise := v_price;
  ELSIF NEW.unit_price_paise <> v_price THEN
    RAISE EXCEPTION 'unit price % differs from catalogue price % for product %',
      NEW.unit_price_paise, v_price, NEW.product_id USING ERRCODE = 'PRV05';
  END IF;
  IF NEW.commission_bps IS NULL THEN
    NEW.commission_bps := v_bps;
  ELSIF NEW.commission_bps <> v_bps THEN
    RAISE EXCEPTION 'commission % bps differs from vendor rate % bps for product %',
      NEW.commission_bps, v_bps, NEW.product_id USING ERRCODE = 'PRV05';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_order_items_snapshot BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION trg_order_items_snapshot();

CREATE TRIGGER trg_order_items_immutable BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();

CREATE FUNCTION trg_order_items_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payments WHERE order_id = OLD.order_id) THEN
    RAISE EXCEPTION 'order % already has a payment attempt; its lines are frozen', OLD.order_id
      USING ERRCODE = 'PRO01';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_order_items_delete BEFORE DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION trg_order_items_delete();

-- ---------------------------------------------------------------- payments state machine (DEC-010)
--   initiated -> captured | failed ; both terminal.
CREATE FUNCTION trg_payments_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
DECLARE
  v_total bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'initiated' THEN
      RAISE EXCEPTION 'a payment must start as initiated, not %', NEW.status USING ERRCODE = 'PRS01';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = NEW.order_id) THEN
      RAISE EXCEPTION 'order % has no lines', NEW.order_id USING ERRCODE = 'PRO01';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> OLD.status AND NOT (OLD.status = 'initiated' AND NEW.status IN ('captured', 'failed')) THEN
    RAISE EXCEPTION 'payment % cannot move from % to %', OLD.payment_id, OLD.status, NEW.status
      USING ERRCODE = 'PRS01';
  END IF;

  IF (NEW.order_id, NEW.amount_paise, NEW.method, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM (OLD.order_id, OLD.amount_paise, OLD.method, OLD.idempotency_key, OLD.created_at)
     OR (OLD.gateway_ref IS NOT NULL AND NEW.gateway_ref IS DISTINCT FROM OLD.gateway_ref)
     OR (OLD.captured_at IS NOT NULL AND NEW.captured_at IS DISTINCT FROM OLD.captured_at) THEN
    RAISE EXCEPTION 'payment % : identifying fields and amount are immutable', OLD.payment_id
      USING ERRCODE = 'PRV06';
  END IF;

  IF NEW.status = 'captured' AND OLD.status = 'initiated' THEN
    SELECT sum(quantity::bigint * unit_price_paise) INTO v_total
      FROM order_items WHERE order_id = NEW.order_id;
    IF v_total IS DISTINCT FROM NEW.amount_paise THEN
      RAISE EXCEPTION 'payment % amount % does not equal order % total %',
        NEW.payment_id, NEW.amount_paise, NEW.order_id, v_total USING ERRCODE = 'PRP01';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payments_state BEFORE INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_payments_state();
CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();

-- ---------------------------------------------------------------- refunds state machine (DBD T6)
--   requested -> processed | rejected ; terminal ; amount/line/key immutable.
CREATE FUNCTION trg_refunds_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' THEN
      RAISE EXCEPTION 'a refund must start as requested, not %', NEW.status USING ERRCODE = 'PRS01';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> OLD.status AND NOT (OLD.status = 'requested' AND NEW.status IN ('processed', 'rejected')) THEN
    RAISE EXCEPTION 'refund % cannot move from % to %', OLD.refund_id, OLD.status, NEW.status
      USING ERRCODE = 'PRS01';
  END IF;
  IF (NEW.order_id, NEW.line_no, NEW.amount_paise, NEW.reason, NEW.idempotency_key, NEW.requested_at)
     IS DISTINCT FROM (OLD.order_id, OLD.line_no, OLD.amount_paise, OLD.reason, OLD.idempotency_key, OLD.requested_at)
     OR (OLD.status <> 'requested' AND (NEW.processed_at, NEW.gateway_ref)
                                       IS DISTINCT FROM (OLD.processed_at, OLD.gateway_ref)) THEN
    RAISE EXCEPTION 'refund % : amount, line and key are immutable', OLD.refund_id USING ERRCODE = 'PRV06';
  END IF;

  RETURN NEW;
END $$;
CREATE TRIGGER trg_refunds_state BEFORE INSERT OR UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION trg_refunds_state();
CREATE TRIGGER trg_refunds_no_delete BEFORE DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();

-- ---------------------------------------------------------------- payouts: KYC gate + state machine (DBD T5, T6)
--   requested -> paid | failed ; terminal.
CREATE FUNCTION trg_payouts_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' THEN
      RAISE EXCEPTION 'a payout must start as requested, not %', NEW.status USING ERRCODE = 'PRS01';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM vendors WHERE vendor_id = NEW.vendor_id AND kyc_status = 'verified') THEN
      RAISE EXCEPTION 'vendor % is not KYC-verified; payouts are not allowed', NEW.vendor_id
        USING ERRCODE = 'PRV03';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status <> OLD.status AND NOT (OLD.status = 'requested' AND NEW.status IN ('paid', 'failed')) THEN
    RAISE EXCEPTION 'payout % cannot move from % to %', OLD.payout_id, OLD.status, NEW.status
      USING ERRCODE = 'PRS01';
  END IF;
  IF (NEW.vendor_id, NEW.amount_paise, NEW.idempotency_key, NEW.requested_at)
     IS DISTINCT FROM (OLD.vendor_id, OLD.amount_paise, OLD.idempotency_key, OLD.requested_at)
     OR (OLD.status <> 'requested' AND (NEW.bank_utr, NEW.completed_at)
                                       IS DISTINCT FROM (OLD.bank_utr, OLD.completed_at)) THEN
    RAISE EXCEPTION 'payout % : vendor, amount and key are immutable', OLD.payout_id USING ERRCODE = 'PRV06';
  END IF;

  RETURN NEW;
END $$;
CREATE TRIGGER trg_payouts_state BEFORE INSERT OR UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION trg_payouts_state();
CREATE TRIGGER trg_payouts_no_delete BEFORE DELETE ON payouts
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();

-- ---------------------------------------------------------------- gateway_settlements: imported rows are kept as received
CREATE TRIGGER trg_gateway_settlements_immutable BEFORE UPDATE OR DELETE ON gateway_settlements
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_change();

RESET ROLE;
