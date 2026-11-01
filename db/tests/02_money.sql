-- 02_money.sql — exact money helpers: round-half-up, capture split (DEC-004),
-- cumulative refund allocation (DEC-005), INR display.
\ir _lib/assert.sql
SET search_path = payrail, public;

-- ================================================================ fn_round_half_up
\set name 'rhu: halves round up (2.5->3, 3.5->4, 1.5->2), others to nearest'
\ir _lib/try.sql
SELECT t_assert(fn_round_half_up(5, 1, 2) = 3 AND fn_round_half_up(7, 1, 2) = 4
            AND fn_round_half_up(3, 1, 2) = 2 AND fn_round_half_up(1, 1, 3) = 0
            AND fn_round_half_up(2, 1, 3) = 1 AND fn_round_half_up(0, 999, 7) = 0
            AND fn_round_half_up(149997, 1000, 10000) = 15000      -- 14999.7
            AND fn_round_half_up(3086, 18, 100) = 555,             -- 555.48
            'rounding table');
\ir _lib/expect_ok.sql

\set name 'rhu: no BIGINT overflow in the intermediate product (9e18 x 5000 / 10000)'
\ir _lib/try.sql
SELECT t_assert(fn_round_half_up(9000000000000000000, 5000, 10000) = 4500000000000000000, 'large operands');
\ir _lib/expect_ok.sql

\set name 'rhu: negative operand rejected'
\set want 22023
\ir _lib/try.sql
SELECT fn_round_half_up(-1, 1, 2);
\ir _lib/expect_error.sql

-- ================================================================ fn_split_line (hand-computed fixtures)
\set name 'split: 3 x 499.99 @ 10% -> L 149997, C 15000, G 2700, V 132297'
\ir _lib/try.sql
SELECT t_assert((line_total_paise, commission_paise, gst_paise, vendor_paise) = (149997, 15000, 2700, 132297), 'fixture A')
  FROM fn_split_line(3, 49999, 1000);
\ir _lib/expect_ok.sql

\set name 'split: 1 x 1234.56 @ 2.5% -> L 123456, C 3086, G 555, V 119815'
\ir _lib/try.sql
SELECT t_assert((line_total_paise, commission_paise, gst_paise, vendor_paise) = (123456, 3086, 555, 119815), 'fixture B')
  FROM fn_split_line(1, 123456, 250);
\ir _lib/expect_ok.sql

\set name 'split: tiny lines at 50% (1 paisa -> 1/0/0, 3 paise -> 2/0/1)'
\ir _lib/try.sql
SELECT t_assert((SELECT (commission_paise, gst_paise, vendor_paise) = (1, 0, 0) FROM fn_split_line(1, 1, 5000))
            AND (SELECT (commission_paise, gst_paise, vendor_paise) = (2, 0, 1) FROM fn_split_line(1, 3, 5000)),
                'tiny lines');
\ir _lib/expect_ok.sql

\set name 'split: largest line (100 x 1 crore @ 50%) exact'
\ir _lib/try.sql
SELECT t_assert((line_total_paise, commission_paise, gst_paise, vendor_paise)
                = (100000000000, 50000000000, 9000000000, 41000000000), 'max line')
  FROM fn_split_line(100, 1000000000, 5000);
\ir _lib/expect_ok.sql

\set name 'split: sweep bps 0..5000 x L 1..120 and 1e6..1e6+50: C+G+V = L and V >= 0'
\ir _lib/try.sql
SELECT t_assert(bool_and(s.commission_paise + s.gst_paise + s.vendor_paise = s.line_total_paise
                         AND s.vendor_paise >= 0 AND s.gst_paise <= s.commission_paise), 'sweep')
  FROM generate_series(0, 5000) bps
  CROSS JOIN (SELECT generate_series(1, 120) AS l UNION ALL SELECT generate_series(1000000, 1000050)) ls
  CROSS JOIN LATERAL fn_split_line(1, ls.l::bigint, bps) s;
\ir _lib/expect_ok.sql

\set name 'split: quantity 0 rejected'
\set want 22023
\ir _lib/try.sql
SELECT * FROM fn_split_line(0, 100, 100);
\ir _lib/expect_error.sql

-- ================================================================ fn_refund_alloc (cumulative, DEC-005)
-- Worked example on fixture A (L 149997, C 15000, G 2700, V 132297):
-- refunds 5000, 49999, 33333, then the remaining 61665.
--   R:      5000   54999   88332  149997
--   C_k:     500    5500    8833   15000   (rhu(15000·R/149997))
--   G_k:      90     990    1590    2700
--   deltas C 500, 5000, 3333, 6167 ; G 90, 900, 600, 1110 ; V = r − ΔC − ΔG
\set name 'refund alloc: worked example deltas match hand computation'
\ir _lib/try.sql
WITH steps(k, prev, r) AS (VALUES (1, 0, 5000), (2, 5000, 49999), (3, 54999, 33333), (4, 88332, 61665))
SELECT t_assert(array_agg(ARRAY[a.commission_delta, a.gst_delta, a.vendor_delta] ORDER BY k)
                = ARRAY[[500, 90, 4410], [5000, 900, 44099], [3333, 600, 29400], [6167, 1110, 54388]]::bigint[],
                'deltas')
  FROM steps CROSS JOIN LATERAL fn_refund_alloc(149997, 15000, 2700, prev, r) a;
\ir _lib/expect_ok.sql

\set name 'refund alloc: partial refunds then final remainder reverse exactly (C, G, V)'
\ir _lib/try.sql
WITH steps(prev, r) AS (VALUES (0, 5000), (5000, 49999), (54999, 33333), (88332, 61665))
SELECT t_assert((sum(a.commission_delta), sum(a.gst_delta), sum(a.vendor_delta)) = (15000::numeric, 2700::numeric, 132297::numeric),
                'telescoping sum')
  FROM steps CROSS JOIN LATERAL fn_refund_alloc(149997, 15000, 2700, prev, r) a;
\ir _lib/expect_ok.sql

\set name 'refund alloc: one full refund returns exactly (C, G, V)'
\ir _lib/try.sql
SELECT t_assert((commission_delta, gst_delta, vendor_delta) = (15000, 2700, 132297), 'full')
  FROM fn_refund_alloc(149997, 15000, 2700, 0, 149997);
\ir _lib/expect_ok.sql

\set name 'refund alloc: refunding beyond the line total rejected'
\set want 22023
\ir _lib/try.sql
SELECT * FROM fn_refund_alloc(149997, 15000, 2700, 100000, 49998);
\ir _lib/expect_error.sql

-- Randomised property test (fixed seed): 5000 lines, random price/qty/bps,
-- each refunded in 1–6 random parts (>= ₹1 except the final remainder).
-- Asserts the cumulative method is exact for every line; counts how often
-- naive per-refund rounding would have drifted (informational only).
\set name 'refund alloc: randomised 5000 lines, cumulative method exact on every line'
\ir _lib/try.sql
DO $$
DECLARE
  i int; parts int; L bigint; C bigint; G bigint; V bigint; bps int;
  prev bigint; r bigint; remaining bigint;
  sc bigint; sg bigint; sv bigint; nc bigint; ng bigint;
  a record; naive_drift int := 0; neg_vendor int := 0;
BEGIN
  PERFORM setseed(0.42);
  FOR i IN 1..5000 LOOP
    bps := floor(random() * 5001)::int;
    SELECT s.line_total_paise, s.commission_paise, s.gst_paise, s.vendor_paise INTO L, C, G, V
      FROM payrail.fn_split_line(1 + floor(random() * 5)::int, 100 + floor(random() * 2000000)::bigint, bps) s;
    parts := 1 + floor(random() * 6)::int;
    prev := 0; sc := 0; sg := 0; sv := 0; nc := 0; ng := 0;
    FOR k IN 1..parts LOOP
      remaining := L - prev;
      IF k = parts OR remaining <= 100 THEN
        r := remaining;
      ELSE
        r := 100 + floor(random() * (remaining - 100))::bigint;  -- >= ₹1, < remaining
      END IF;
      SELECT * INTO a FROM payrail.fn_refund_alloc(L, C, G, prev, r);
      sc := sc + a.commission_delta; sg := sg + a.gst_delta; sv := sv + a.vendor_delta;
      IF a.vendor_delta < 0 THEN neg_vendor := neg_vendor + 1; END IF;
      nc := nc + payrail.fn_round_half_up(C, r, L);              -- naive: round each refund alone
      ng := ng + payrail.fn_round_half_up(G, r, L);
      prev := prev + r;
      EXIT WHEN prev = L;
    END LOOP;
    IF (sc, sg, sv) IS DISTINCT FROM (C, G, V) THEN
      RAISE EXCEPTION 'drift on line %: got (%,%,%) want (%,%,%)', i, sc, sg, sv, C, G, V USING ERRCODE = 'PT001';
    END IF;
    IF (nc, ng) IS DISTINCT FROM (C, G) THEN naive_drift := naive_drift + 1; END IF;
  END LOOP;
  PERFORM set_config('t.naive_drift', naive_drift::text, false);
  PERFORM set_config('t.neg_vendor', neg_vendor::text, false);
END $$;
\ir _lib/expect_ok.sql
SELECT current_setting('t.naive_drift') AS naive_drift, current_setting('t.neg_vendor') AS neg_vendor \gset
\echo INFO 'naive per-refund rounding would drift on' :naive_drift 'of 5000 lines; negative vendor deltas (cumulative):' :neg_vendor

-- ================================================================ fn_inr
\set name 'fn_inr: Indian digit grouping and sign'
\ir _lib/try.sql
SELECT t_assert(fn_inr(4516201842) = '₹4,51,62,018.42' AND fn_inr(5) = '₹0.05'
            AND fn_inr(100000) = '₹1,000.00' AND fn_inr(-12345678) = '-₹1,23,456.78'
            AND fn_inr(12345678901234) = '₹1,23,45,67,89,012.34' AND fn_inr(0) = '₹0.00',
                'formatting');
\ir _lib/expect_ok.sql
