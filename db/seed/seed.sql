-- db/seed/seed.sql — deterministic demo data (Task 2, DEC-015).
--
-- Run by db/reset_dev.sh (and the Docker init hook) right after the schema is
-- built, as the administrator, in psql AUTOCOMMIT mode (the simulation commits
-- once per simulated day).
--
-- Reproducibility: no random() and no wall-clock time. "Random" choices come
-- from md5(<event key>), and every workflow call runs under the controlled
-- clock payrail.clock (fn_now(), honoured only for the administrator login).
-- The same files therefore always produce the same rows, ids and amounts.
--
-- Simulated period: Tue 2026-09-01 … Sat 2026-10-31 (Asia/Kolkata).
-- Demo "as of" date for reconciliation: 2026-10-31.
--
-- What is generated (master data by INSERT, everything financial ONLY via the
-- same workflow functions the backend calls):
--   * 2 finance admins, 12 vendors (10 verified, 1 KYC pending, 1 rejected),
--     60 customers — all with the demo password  PayRail@2026  (bcrypt).
--   * ~6 products per vendor; one product archived mid-period; one inactive
--     never-ordered draft product (can be hard-deleted in the CRUD demo).
--   * Daily checkout traffic: multi-vendor carts, repeated products
--     aggregated, ~4% abandoned, ~6% failed-then-retried, ~2% failed only,
--     ~1% left initiated.
--   * Refunds: full, partial, three-step partial (exact cumulative rounding),
--     rejected, and requests still pending at the end.
--   * Weekly payouts (80% of balance ≥ ₹2,000), ~10% failed → reversal; a
--     Saturday round left 'requested' for the finance queue.
--   * Daily gateway settlement import (T+2): fees by method, ~3% never
--     settled (overdue), ~2% short-paid (amount mismatch), two unknown
--     references, one late callback (unknown first, matched by fn_reconcile).
--   * Vendor 3 goes negative after withdrawing everything and a late refund,
--     then recovers from new sales; vendor 7 ends the period negative.

\set ON_ERROR_STOP 1
SET client_min_messages = warning;
SET ROLE payrail_owner;
SET search_path = payrail, public;

-- ---------------------------------------------------------------- deterministic helpers (session-local)
CREATE FUNCTION pg_temp.rnd(p_key text) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$ SELECT ('x' || substr(md5(p_key), 1, 12))::bit(48)::bigint $$;

CREATE FUNCTION pg_temp.at(p_day date, p_time time) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$ SELECT (p_day + p_time) AT TIME ZONE 'Asia/Kolkata' $$;

CREATE FUNCTION pg_temp.clock(p_ts timestamptz) RETURNS void
LANGUAGE sql AS $$ SELECT set_config('payrail.clock', p_ts::text, false); SELECT NULL::void $$;

CREATE FUNCTION pg_temp.key(p_text text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('payrail-seed:' || p_text)::uuid $$;

-- ---------------------------------------------------------------- master data (as of 2026-08-25)
SELECT pg_temp.clock('2026-08-25 10:00:00+05:30') \g /dev/null

CREATE TEMP TABLE seed_pw AS SELECT crypt('PayRail@2026', gen_salt('bf', 10)) AS h;

INSERT INTO users (full_name, email, role, password_hash)
SELECT v.full_name, v.email, v.role, (SELECT h FROM seed_pw)
  FROM (VALUES ('Farah Iqbal',   'finance@payrail.demo', 'finance_admin'),
               ('Rohan Mehta',   'audit@payrail.demo',   'finance_admin')) v(full_name, email, role);

CREATE TEMP TABLE seed_vendor_spec (n int PRIMARY KEY, owner_name text, legal_name text, bps int, kyc text,
                                    products text[], prices bigint[]);
INSERT INTO seed_vendor_spec VALUES
 (1,  'Kavya Rao',      'Kaveri Kitchenware',     1000, 'verified',
      '{"Steel Water Bottle","Cast Iron Tawa","Pressure Cooker 5L","Spice Box","Copper Jug","Chopping Board"}',
      '{49999,129900,249900,59900,89950,34999}'),
 (2,  'Imran Siddiqui', 'Charminar Handlooms',     800, 'verified',
      '{"Pochampally Saree","Cotton Dupatta","Ikat Cushion Cover","Handloom Stole","Kalamkari Kurta","Bedsheet Set"}',
      '{549900,89900,69900,119900,159900,229900}'),
 (3,  'Arjun Reddy',    'Deccan Electronics',      500, 'verified',
      '{"Bluetooth Speaker","Power Bank 20000mAh","USB-C Charger","Wireless Earbuds","Smart Plug","Noise-Cancelling Headphones"}',
      '{249900,179900,99900,349900,129900,1499900}'),
 (4,  'Meera Joshi',    'Golconda Books',         1200, 'verified',
      '{"Database System Concepts","Clean Code","Telugu Short Stories","Indian Polity","Atlas of India","Puzzle Book"}',
      '{89500,65000,29900,79900,49900,19900}'),
 (5,  'Vikram Singh',   'Hussain Sagar Sports',   1500, 'verified',
      '{"Cricket Bat (Kashmir Willow)","Football","Yoga Mat","Badminton Racquet","Skipping Rope","Cycling Helmet"}',
      '{189900,99900,79900,149900,29900,219900}'),
 (6,  'Ananya Das',     'Banjara Home Decor',     1000, 'verified',
      '{"Brass Diya Set","Wall Clock","Jute Rug","Ceramic Vase","Table Lamp","Photo Frame Set"}',
      '{69900,149900,299900,89900,179900,59900}'),
 (7,  'Sameer Khan',    'Ramoji Toys',            2000, 'verified',
      '{"Wooden Train Set","Building Blocks 500pc","Remote Control Car","Board Game","Soft Toy Elephant","Science Kit"}',
      '{159900,249900,349900,99900,79900,199900}'),
 (8,  'Lakshmi Iyer',   'Nizam Spices',            250, 'verified',
      '{"Hyderabadi Biryani Masala","Saffron 2g","Cardamom 200g","Pickle Combo","Dry Fruit Box","Tea Sampler"}',
      '{24900,49900,89900,69900,149900,39900}'),
 (9,  'Karthik Nair',   'Lumbini Footwear',        900, 'verified',
      '{"Kolhapuri Chappals","Running Shoes","Leather Sandals","Formal Shoes","Flip Flops","Kids Sneakers"}',
      '{129900,349900,179900,299900,39900,149900}'),
 (10, 'Divya Menon',    'Hitech Stationery',      1100, 'verified',
      '{"Fountain Pen","A5 Notebook Pack","Geometry Box","Desk Organiser","Sticky Notes Set","Scientific Calculator"}',
      '{79900,34900,19900,49900,14900,129900}'),
 (11, 'Rahul Varma',    'Secunderabad Gadgets',    700, 'pending',
      '{"Phone Stand","HDMI Cable","Webcam","Keyboard","Mouse","LED Strip"}',
      '{29900,39900,249900,149900,79900,99900}'),
 (12, 'Sana Mirza',     'Old City Perfumes',      1300, 'rejected',
      '{"Attar Rose","Attar Oudh","Gift Set","Incense Sticks","Rose Water","Musk Oil"}',
      '{99900,299900,199900,19900,14900,149900}');

INSERT INTO users (full_name, email, role, password_hash)
SELECT owner_name, 'vendor' || n || '@payrail.demo', 'vendor_admin', (SELECT h FROM seed_pw)
  FROM seed_vendor_spec ORDER BY n;
INSERT INTO vendors (owner_user_id, legal_name, gstin, commission_bps, kyc_status)
SELECT u.user_id, s.legal_name,
       CASE WHEN s.kyc = 'verified' THEN '36ABCDE' || lpad(s.n::text, 4, '0') || 'F1Z' || (s.n % 10) END,
       s.bps, s.kyc
  FROM seed_vendor_spec s JOIN users u ON u.email = 'vendor' || s.n || '@payrail.demo'
 ORDER BY s.n;
INSERT INTO products (vendor_id, name, price_paise)
SELECT v.vendor_id, s.products[i], s.prices[i]
  FROM seed_vendor_spec s
  JOIN users u ON u.email = 'vendor' || s.n || '@payrail.demo'
  JOIN vendors v ON v.owner_user_id = u.user_id
  CROSS JOIN generate_series(1, 6) i
 ORDER BY s.n, i;
-- a draft product that was never listed (inactive, never ordered → deletable in the CRUD demo)
INSERT INTO products (vendor_id, name, price_paise, is_active)
SELECT v.vendor_id, 'Copper Kettle (draft)', 199900, false
  FROM vendors v JOIN users u ON u.user_id = v.owner_user_id WHERE u.email = 'vendor1@payrail.demo';

INSERT INTO users (full_name, email, role, password_hash)
SELECT f.first[1 + (i - 1) % 20] || ' ' || f.last[1 + (i * 7) % 15],
       'customer' || i || '@payrail.demo', 'customer', (SELECT h FROM seed_pw)
  FROM generate_series(1, 60) i,
       (SELECT '{Asha,Bharat,Chitra,Dev,Esha,Farhan,Gauri,Harsh,Isha,Jai,Kiran,Leela,Manav,Nisha,Om,Pooja,Qadir,Ritu,Sahil,Tara}'::text[] AS first,
               '{Reddy,Sharma,Patel,Naidu,Gupta,Khan,Iyer,Rao,Das,Verma,Joshi,Shetty,Kulkarni,Bose,Menon}'::text[] AS last) f
 ORDER BY i;

-- plan of refund events, filled when an order is captured
CREATE TEMP TABLE seed_refund_plan (
  plan_id     serial PRIMARY KEY,
  order_id    bigint NOT NULL,
  line_no     int    NOT NULL,
  amount      bigint,          -- NULL = whatever is still refundable at request time
  req_day     date   NOT NULL,
  decide_day  date   NOT NULL,
  decision    text   NOT NULL CHECK (decision IN ('approve', 'reject')),
  refund_id   bigint
);

-- ---------------------------------------------------------------- the simulation
DO $seed$
DECLARE
  v_fin        bigint := (SELECT user_id FROM users WHERE email = 'finance@payrail.demo');
  v_customers  bigint[] := (SELECT array_agg(user_id ORDER BY user_id) FROM users WHERE role = 'customer');
  v_vendors    bigint[] := (SELECT array_agg(vendor_id ORDER BY vendor_id) FROM vendors WHERE kyc_status = 'verified');
  v_methods    text[]   := '{upi,upi,upi,card,card,netbanking}';
  v_day        date;
  v_j          int;
  v_n          int;
  v_k          text;
  v_x          bigint;
  v_cust       bigint;
  v_items      jsonb;
  v_vendor     bigint;
  v_prods      bigint[];
  v_nv         int;
  v_used       bigint[];
  v_order      bigint;
  v_pid        bigint;
  v_amt        bigint;
  v_t          timestamptz;
  v_gross      bigint;
  v_fee        bigint;
  v_bal        bigint;
  v_line       record;
  r            record;
  v_late_pid   bigint;
  v_late_amt   bigint;
  v_rid        bigint;
BEGIN
  FOR v_day IN SELECT d::date FROM generate_series(date '2026-09-01', date '2026-10-31', interval '1 day') d LOOP

    -- (a) 08:30 — gateway settlement report for v_day (T+2 of captures / refunds)
    PERFORM pg_temp.clock(pg_temp.at(v_day, '08:30'));
    FOR r IN SELECT p.payment_id, p.gateway_ref, p.amount_paise, p.method
               FROM payments p
              WHERE p.status = 'captured'
                AND (p.captured_at AT TIME ZONE 'Asia/Kolkata')::date = v_day - 2
                AND NOT EXISTS (SELECT 1 FROM gateway_settlements s WHERE s.gateway_ref = p.gateway_ref)
              ORDER BY p.payment_id LOOP
      v_x := pg_temp.rnd('settle:' || r.payment_id) % 100;
      CONTINUE WHEN v_x < 3;                                         -- never arrives → overdue_missing
      v_gross := CASE WHEN v_x < 5 AND r.amount_paise > 5000 THEN r.amount_paise - 1000   -- short-paid by ₹10
                      ELSE r.amount_paise END;
      v_fee := CASE r.method WHEN 'card'       THEN fn_round_half_up(v_gross, 200, 10000)
                             WHEN 'netbanking' THEN fn_round_half_up(v_gross, 150, 10000)
                             ELSE 0 END;
      PERFORM fn_record_settlement(v_fin, r.gateway_ref, 'payment', v_gross, v_fee, v_day);
    END LOOP;
    FOR r IN SELECT f.refund_id, f.gateway_ref, f.amount_paise
               FROM refunds f
              WHERE f.status = 'processed'
                AND (f.processed_at AT TIME ZONE 'Asia/Kolkata')::date = v_day - 2
              ORDER BY f.refund_id LOOP
      CONTINUE WHEN pg_temp.rnd('settle-refund:' || r.refund_id) % 100 < 5;
      PERFORM fn_record_settlement(v_fin, r.gateway_ref, 'refund', r.amount_paise, 0, v_day);
    END LOOP;
    IF v_day = date '2026-10-12' THEN
      PERFORM fn_record_settlement(v_fin, 'pay_UNKNOWN0001', 'payment', 250000, 5000, v_day);
    ELSIF v_day = date '2026-10-22' THEN                             -- arrives before our capture callback
      PERFORM fn_record_settlement(v_fin, 'pay_LATECB000001', 'payment', v_late_amt, 0, v_day);
    ELSIF v_day = date '2026-10-27' THEN
      PERFORM fn_record_settlement(v_fin, 'pay_UNKNOWN0002', 'payment', 99900, 0, v_day);
    END IF;

    -- late-callback scenario: the success callback finally arrives on 10-23
    IF v_day = date '2026-10-23' THEN
      PERFORM pg_temp.clock(pg_temp.at(v_day, '09:00'));
      PERFORM fn_capture_payment(v_late_pid, 'pay_LATECB000001', v_late_amt);
    END IF;

    -- (b) Monday 09:00 — finance runs reconciliation for yesterday (posts late matches)
    IF extract(isodow FROM v_day) = 1 THEN
      PERFORM pg_temp.clock(pg_temp.at(v_day, '09:00'));
      PERFORM fn_reconcile(v_fin, v_day - 1);
    END IF;

    -- (c) 09:30 — bank results for payouts requested yesterday
    PERFORM pg_temp.clock(pg_temp.at(v_day, '09:30'));
    FOR r IN SELECT p.payout_id, p.vendor_id FROM payouts p
              WHERE p.status = 'requested' AND (p.requested_at AT TIME ZONE 'Asia/Kolkata')::date = v_day - 1
              ORDER BY p.payout_id LOOP
      IF pg_temp.rnd('payout:' || r.payout_id) % 10 = 0
         OR r.payout_id = (SELECT min(payout_id) FROM payouts WHERE vendor_id = v_vendors[2]) THEN
        PERFORM fn_complete_payout(v_fin, r.payout_id, 'failed', NULL);
      ELSE
        PERFORM fn_complete_payout(v_fin, r.payout_id, 'paid',
                                   'UTR' || to_char(v_day, 'YYYYMMDD') || lpad(r.payout_id::text, 6, '0'));
      END IF;
    END LOOP;

    -- (d) 10:00 — weekly payout round (Mondays) and a final Saturday round left pending
    IF extract(isodow FROM v_day) = 1 OR v_day = date '2026-10-31' THEN
      PERFORM pg_temp.clock(pg_temp.at(v_day, '10:00'));
      FOR r IN SELECT v.vendor_id, v.owner_user_id FROM vendors v
                WHERE v.kyc_status = 'verified' ORDER BY v.vendor_id LOOP
        v_bal := fn_vendor_balance(r.vendor_id);
        IF v_bal >= 200000 THEN
          PERFORM fn_request_payout(r.owner_user_id, (v_bal * 80 / 100) / 100 * 100,
                                    pg_temp.key('payout:' || r.vendor_id || ':' || v_day));
        END IF;
      END LOOP;
    END IF;

    -- (e) 11:00 — refund requests planned for today; 11:30 — finance decisions
    PERFORM pg_temp.clock(pg_temp.at(v_day, '11:00'));
    FOR r IN SELECT p.*, o.customer_id FROM seed_refund_plan p JOIN orders o USING (order_id)
              WHERE p.req_day = v_day ORDER BY p.plan_id LOOP
      v_amt := coalesce(r.amount, (SELECT refundable_paise FROM v_order_line_allocation
                                    WHERE order_id = r.order_id AND line_no = r.line_no));
      CONTINUE WHEN v_amt <= 0;
      SELECT refund_id INTO v_rid
        FROM fn_request_refund(r.customer_id, r.order_id, r.line_no, v_amt,
                               CASE r.decision WHEN 'reject' THEN 'changed my mind after use'
                                               ELSE 'item damaged or not as described' END,
                               pg_temp.key('refund:' || r.plan_id));
      UPDATE seed_refund_plan SET refund_id = v_rid WHERE plan_id = r.plan_id;
    END LOOP;
    PERFORM pg_temp.clock(pg_temp.at(v_day, '11:30'));
    FOR r IN SELECT * FROM seed_refund_plan WHERE decide_day = v_day AND refund_id IS NOT NULL ORDER BY plan_id LOOP
      IF r.decision = 'approve' THEN
        PERFORM fn_approve_refund(v_fin, r.refund_id);
      ELSE
        PERFORM fn_reject_refund(v_fin, r.refund_id);
      END IF;
    END LOOP;

    -- catalogue change: vendor 4 archives a product mid-period (non-financial CRUD)
    IF v_day = date '2026-10-15' THEN
      UPDATE products SET is_active = false
       WHERE product_id = (SELECT min(product_id) + 1 FROM products WHERE vendor_id = v_vendors[4]);
    END IF;

    -- (f) 12:00 onwards — customer checkouts
    v_n := 4 + (pg_temp.rnd('orders:' || v_day) % 5)::int;              -- 4..8 orders a day
    FOR v_j IN 0 .. v_n - 1 LOOP
      v_k   := v_day || ':' || v_j;
      v_t   := pg_temp.at(v_day, '12:00') + v_j * interval '65 minutes';
      PERFORM pg_temp.clock(v_t);
      v_cust := v_customers[1 + (pg_temp.rnd('cust:' || v_k) % 60)::int];
      v_x    := pg_temp.rnd('nv:' || v_k) % 100;
      v_nv   := CASE WHEN v_x < 50 THEN 1 WHEN v_x < 85 THEN 2 ELSE 3 END;
      v_items := '[]';
      v_used  := '{}';
      FOR i IN 1 .. v_nv LOOP
        v_vendor := v_vendors[1 + (pg_temp.rnd('vendor:' || v_k || ':' || i) % 10)::int];
        CONTINUE WHEN v_vendor = ANY (v_used);
        v_used := v_used || v_vendor;
        SELECT array_agg(product_id ORDER BY product_id) INTO v_prods
          FROM products WHERE vendor_id = v_vendor AND is_active;
        FOR m IN 1 .. 1 + (pg_temp.rnd('np:' || v_k || ':' || i) % 2)::int LOOP
          v_items := v_items || jsonb_build_object(
            'product_id', v_prods[1 + (pg_temp.rnd('p:' || v_k || ':' || i || ':' || m) % cardinality(v_prods))::int],
            'quantity',   1 + pg_temp.rnd('q:' || v_k || ':' || i || ':' || m) % 3);
        END LOOP;
      END LOOP;
      IF pg_temp.rnd('dup:' || v_k) % 12 = 0 THEN                     -- "added the same item again"
        v_items := v_items || jsonb_build_object('product_id', v_items -> 0 -> 'product_id', 'quantity', 1);
      END IF;
      v_order := fn_place_order(v_cust, v_items);

      v_x := pg_temp.rnd('pay:' || v_k) % 100;
      CONTINUE WHEN v_x < 4;                                            -- abandoned cart
      PERFORM pg_temp.clock(v_t + interval '2 minutes');
      SELECT payment_id, amount_paise INTO v_pid, v_amt
        FROM fn_initiate_payment(v_cust, v_order, v_methods[1 + (pg_temp.rnd('m1:' || v_k) % 6)::int],
                                 pg_temp.key('pay1:' || v_k));
      IF v_x < 12 THEN                                                  -- first attempt declined
        PERFORM pg_temp.clock(v_t + interval '3 minutes');
        PERFORM fn_fail_payment(v_pid, 'pay_F' || lpad(v_pid::text, 9, '0'));
        CONTINUE WHEN v_x >= 10;                                        -- customer gave up
        PERFORM pg_temp.clock(v_t + interval '10 minutes');
        SELECT payment_id INTO v_pid
          FROM fn_initiate_payment(v_cust, v_order, v_methods[1 + (pg_temp.rnd('m2:' || v_k) % 6)::int],
                                   pg_temp.key('pay2:' || v_k));
        PERFORM pg_temp.clock(v_t + interval '12 minutes');
      ELSIF v_x = 12 THEN
        CONTINUE;                                                       -- callback never arrived (initiated)
      ELSE
        PERFORM pg_temp.clock(v_t + interval '3 minutes');
      END IF;
      PERFORM fn_capture_payment(v_pid, 'pay_S' || lpad(v_pid::text, 9, '0'), v_amt);

      -- plan this order's refund story (line 1)
      v_x := pg_temp.rnd('refund-plan:' || v_order) % 100;
      IF v_x < 4 THEN
        INSERT INTO seed_refund_plan (order_id, line_no, amount, req_day, decide_day, decision)
        VALUES (v_order, 1, NULL, v_day + 3, v_day + 4, 'approve');
      ELSIF v_x < 8 THEN
        SELECT line_total_paise INTO v_amt FROM v_order_line_allocation WHERE order_id = v_order AND line_no = 1;
        INSERT INTO seed_refund_plan (order_id, line_no, amount, req_day, decide_day, decision)
        VALUES (v_order, 1, greatest(100, v_amt * (20 + pg_temp.rnd('pct:' || v_order) % 41) / 100 / 100 * 100),
                v_day + 2, v_day + 3, 'approve');
      ELSIF v_x < 10 THEN
        SELECT line_total_paise INTO v_amt FROM v_order_line_allocation WHERE order_id = v_order AND line_no = 1;
        INSERT INTO seed_refund_plan (order_id, line_no, amount, req_day, decide_day, decision)
        VALUES (v_order, 1, greatest(100, v_amt / 2 / 100 * 100), v_day + 2, v_day + 3, 'reject');
      ELSIF v_x < 11 THEN                                               -- 25% + 25% + remainder
        SELECT line_total_paise INTO v_amt FROM v_order_line_allocation WHERE order_id = v_order AND line_no = 1;
        INSERT INTO seed_refund_plan (order_id, line_no, amount, req_day, decide_day, decision) VALUES
          (v_order, 1, greatest(100, v_amt / 4 / 100 * 100), v_day + 2, v_day + 3, 'approve'),
          (v_order, 1, greatest(100, v_amt / 4 / 100 * 100), v_day + 4, v_day + 5, 'approve'),
          (v_order, 1, NULL,                                 v_day + 6, v_day + 7, 'approve');
      END IF;
    END LOOP;

    -- (g) scripted scenarios
    IF v_day = date '2026-10-14' THEN
      -- a big electronics order for vendor 3 (refunded late, see 10-20)
      PERFORM pg_temp.clock(pg_temp.at(v_day, '21:00'));
      v_order := fn_place_order(v_customers[9], jsonb_build_array(jsonb_build_object(
                   'product_id', (SELECT max(product_id) FROM products WHERE vendor_id = v_vendors[3]), 'quantity', 3)));
      SELECT payment_id, amount_paise INTO v_pid, v_amt
        FROM fn_initiate_payment(v_customers[9], v_order, 'card', pg_temp.key('scenario:big3'));
      PERFORM fn_capture_payment(v_pid, 'pay_S' || lpad(v_pid::text, 9, '0'), v_amt);
    ELSIF v_day = date '2026-10-19' THEN
      -- vendor 3 withdraws everything that is left after the weekly payout
      PERFORM pg_temp.clock(pg_temp.at(v_day, '21:00'));
      v_bal := fn_vendor_balance(v_vendors[3]);
      IF v_bal > 0 THEN
        PERFORM fn_request_payout((SELECT owner_user_id FROM vendors WHERE vendor_id = v_vendors[3]), v_bal,
                                  pg_temp.key('scenario:withdraw3'));
      END IF;
    ELSIF v_day = date '2026-10-20' THEN
      -- late full refund of the big order → vendor 3 balance negative; recovered by later sales
      PERFORM pg_temp.clock(pg_temp.at(v_day, '21:00'));
      SELECT o.order_id, o.customer_id, al.line_total_paise AS l INTO v_line
        FROM orders o JOIN payments p ON p.order_id = o.order_id AND p.idempotency_key = pg_temp.key('scenario:big3')
        JOIN v_order_line_allocation al ON al.order_id = o.order_id AND al.line_no = 1;
      SELECT refund_id INTO v_rid FROM fn_request_refund(v_line.customer_id, v_line.order_id, 1, v_line.l,
                                                         'arrived dead on arrival', pg_temp.key('scenario:refund3'));
      PERFORM pg_temp.clock(pg_temp.at(v_day, '21:30'));
      PERFORM fn_approve_refund(v_fin, v_rid);
      -- late-callback scenario: order whose success callback is delayed until 10-23
      PERFORM pg_temp.clock(pg_temp.at(v_day, '21:40'));
      v_order := fn_place_order(v_customers[5], jsonb_build_array(jsonb_build_object(
                   'product_id', (SELECT min(product_id) FROM products WHERE vendor_id = v_vendors[6]), 'quantity', 2)));
      SELECT payment_id, amount_paise INTO v_late_pid, v_late_amt
        FROM fn_initiate_payment(v_customers[5], v_order, 'upi', pg_temp.key('scenario:latecb'));
    ELSIF v_day = date '2026-10-31' THEN
      -- three refund requests left undecided for the finance queue
      PERFORM pg_temp.clock(pg_temp.at(v_day, '20:30'));
      FOR v_line IN SELECT al.order_id, o.customer_id, al.line_total_paise AS l
                      FROM v_order_line_allocation al JOIN orders o USING (order_id)
                     WHERE al.line_no = 1 AND al.refunded_paise = 0 AND al.refund_pending_paise = 0
                       AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = al.order_id AND p.status = 'captured')
                     ORDER BY al.order_id DESC LIMIT 3 LOOP
        PERFORM fn_request_refund(v_line.customer_id, v_line.order_id, 1, greatest(100, v_line.l / 2 / 100 * 100),
                                  'one item missing from the parcel', pg_temp.key('scenario:pending:' || v_line.order_id));
      END LOOP;
      -- vendor 7 withdraws everything (request still pending), then a late refund → ends negative
      PERFORM pg_temp.clock(pg_temp.at(v_day, '21:00'));
      v_bal := fn_vendor_balance(v_vendors[7]);
      IF v_bal > 0 THEN
        PERFORM fn_request_payout((SELECT owner_user_id FROM vendors WHERE vendor_id = v_vendors[7]), v_bal,
                                  pg_temp.key('scenario:withdraw7'));
      END IF;
      SELECT al.order_id, o.customer_id, al.line_no, al.refundable_paise AS l INTO v_line
        FROM v_order_line_allocation al JOIN orders o USING (order_id)
       WHERE al.vendor_id = v_vendors[7] AND al.refunded_paise = 0 AND al.refund_pending_paise = 0
         AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = al.order_id AND p.status = 'captured')
       ORDER BY al.line_total_paise DESC, al.order_id, al.line_no LIMIT 1;
      PERFORM pg_temp.clock(pg_temp.at(v_day, '21:30'));
      SELECT refund_id INTO v_rid FROM fn_request_refund(v_line.customer_id, v_line.order_id, v_line.line_no, v_line.l,
                                                         'wrong item delivered', pg_temp.key('scenario:refund7'));
      PERFORM pg_temp.clock(pg_temp.at(v_day, '21:45'));
      PERFORM fn_approve_refund(v_fin, v_rid);
      -- end of the simulated period: reconcile as of the demo date
      PERFORM pg_temp.clock(pg_temp.at(v_day, '23:00'));
      PERFORM fn_reconcile(v_fin, v_day);
    END IF;

    COMMIT;                                                             -- one simulated day = one transaction
  END LOOP;
END
$seed$;

RESET payrail.clock;
RESET ROLE;

-- ---------------------------------------------------------------- summary (observed values go to docs/TEST_EVIDENCE.md)
\pset footer off
SELECT 'users' AS relation, count(*) AS rows FROM payrail.users
UNION ALL SELECT 'vendors', count(*) FROM payrail.vendors
UNION ALL SELECT 'products', count(*) FROM payrail.products
UNION ALL SELECT 'orders', count(*) FROM payrail.orders
UNION ALL SELECT 'order_items', count(*) FROM payrail.order_items
UNION ALL SELECT 'payments', count(*) FROM payrail.payments
UNION ALL SELECT 'refunds', count(*) FROM payrail.refunds
UNION ALL SELECT 'payouts', count(*) FROM payrail.payouts
UNION ALL SELECT 'gateway_settlements', count(*) FROM payrail.gateway_settlements
UNION ALL SELECT 'accounts', count(*) FROM payrail.accounts
UNION ALL SELECT 'journal_entries', count(*) FROM payrail.journal_entries
UNION ALL SELECT 'ledger_lines', count(*) FROM payrail.ledger_lines;
SELECT payrail.fn_inr(sum(debit_paise)::bigint) AS total_debits, payrail.fn_inr(sum(credit_paise)::bigint) AS total_credits
  FROM payrail.v_account_balances;
