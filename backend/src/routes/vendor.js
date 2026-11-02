// Vendor routes — catalogue CRUD (DEC-014), ledger-derived balance and
// statement, W2 payout requests. Mounted behind requireAuth +
// requireRole('vendor_admin') + requireVendor. The vendor id ALWAYS comes from
// the vendor the logged-in user owns (req.user.vendor_id), never from input.
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, notFound } from '../errors.js';
import {
  dateString, idempotencyKey, idString, offset, pageOf, pageQuery, paiseString, parseBody, parseParams, parseQuery,
} from '../validate.js';

const productName = z.string().trim().min(1).max(200);
const createProduct = z.object({
  name: productName, price_paise: paiseString, is_active: z.boolean().default(true),
}).strict();
const updateProduct = z.object({
  name: productName.optional(), price_paise: paiseString.optional(), is_active: z.boolean().optional(),
}).strict().refine((o) => Object.keys(o).length > 0, 'nothing to update');

const PRODUCT_COLS = `product_id, vendor_id, name, price_paise, is_active, created_at,
  EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = products.product_id) AS has_orders`;

export function vendorRoutes({ db }) {
  const r = Router();

  r.get('/me', async (req, res) => {
    const v = await db.one(
      `SELECT v.vendor_id, v.legal_name, v.gstin, v.commission_bps, v.kyc_status, v.created_at,
              fn_vendor_balance(v.vendor_id) AS balance_paise,
              (SELECT coalesce(sum(amount_paise), 0) FROM payouts p
                WHERE p.vendor_id = v.vendor_id AND p.status = 'requested')::bigint AS payouts_in_flight_paise
         FROM vendors v WHERE v.vendor_id = $1`, [req.user.vendor_id]);
    res.json(v);
  });

  // ------------------------------------------------------------ products (CRUD on non-financial data)
  r.get('/products', async (req, res) => {
    const q = parseQuery(req, { ...pageQuery, include_archived: z.enum(['0', '1']).default('1') });
    const { rows } = await db.query(
      `SELECT ${PRODUCT_COLS}, count(*) OVER () AS total_count
         FROM products WHERE vendor_id = $1 AND ($2 OR is_active)
        ORDER BY name, product_id LIMIT $3 OFFSET $4`,
      [req.user.vendor_id, q.include_archived === '1', q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  r.post('/products', async (req, res) => {
    const b = parseBody(req, createProduct);
    const p = await db.one(
      `INSERT INTO products (vendor_id, name, price_paise, is_active) VALUES ($1, $2, $3, $4)
       RETURNING ${PRODUCT_COLS}`, [req.user.vendor_id, b.name, b.price_paise, b.is_active]);
    res.status(201).json(p);
  });

  // update name / price / archive (is_active=false) / reactivate. Past order lines
  // keep their snapshot price; only future orders see the new price.
  r.patch('/products/:id', async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const b = parseBody(req, updateProduct);
    const p = await db.one(
      `UPDATE products SET name        = coalesce($3, name),
                           price_paise = coalesce($4::bigint, price_paise),
                           is_active   = coalesce($5, is_active)
        WHERE product_id = $1 AND vendor_id = $2
       RETURNING ${PRODUCT_COLS}`,
      [id, req.user.vendor_id, b.name ?? null, b.price_paise ?? null, b.is_active ?? null]);
    if (!p) throw notFound('product');
    res.json(p);
  });

  // hard delete only while no order line references the product; otherwise the
  // FK (ON DELETE NO ACTION) refuses → 409 "referenced": archive it instead.
  r.delete('/products/:id', async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const { rowCount } = await db.query('DELETE FROM products WHERE product_id = $1 AND vendor_id = $2',
      [id, req.user.vendor_id]);
    if (!rowCount) throw notFound('product');
    res.status(204).end();
  });

  // ------------------------------------------------------------ statement (ledger-derived)
  // Running balance is computed by the window function in v_vendor_statement
  // over ALL of the vendor's lines; the date filter is applied afterwards, so
  // balances stay correct, and the opening balance is the balance before `from`.
  r.get('/statement', async (req, res) => {
    const q = parseQuery(req, { ...pageQuery, from: dateString.optional(), to: dateString.optional() });
    if (q.from && q.to && q.from > q.to) throw new ApiError(422, 'invalid_input', 'from must not be after to');
    const params = [req.user.vendor_id, q.from ?? null, q.to ?? null];
    const range = `vendor_id = $1
      AND ($2::date IS NULL OR (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $2)
      AND ($3::date IS NULL OR (created_at AT TIME ZONE 'Asia/Kolkata')::date <= $3)`;
    const [{ rows }, opening, closing] = await Promise.all([
      db.query(
        `SELECT entry_id, line_no, created_at, entry_type, description, payment_id, refund_id, payout_id,
                reverses_entry_id, credit_paise, debit_paise, running_balance_paise, count(*) OVER () AS total_count
           FROM v_vendor_statement WHERE ${range}
          ORDER BY created_at, entry_id, line_no LIMIT $4 OFFSET $5`, [...params, q.page_size, offset(q)]),
      db.one(
        `SELECT coalesce(sum(credit_paise - debit_paise), 0)::bigint AS b FROM v_vendor_statement
          WHERE vendor_id = $1 AND $2::date IS NOT NULL AND (created_at AT TIME ZONE 'Asia/Kolkata')::date < $2`,
        params.slice(0, 2)),
      db.one(`SELECT coalesce(sum(credit_paise - debit_paise), 0)::bigint AS b FROM v_vendor_statement WHERE ${range}`, params),
    ]);
    res.json({
      ...pageOf(rows, q),
      opening_balance_paise: opening.b,
      closing_balance_paise: (BigInt(opening.b) + BigInt(closing.b)).toString(),   // exact BigInt, no Number
    });
  });

  // lines of this vendor's products that were sold (paid orders), with the snapshot split
  r.get('/sales', async (req, res) => {
    const q = parseQuery(req, { ...pageQuery });
    const { rows } = await db.query(
      `SELECT a.order_id, a.line_no, pr.name AS product_name, a.quantity, a.unit_price_paise, a.commission_bps,
              a.line_total_paise, a.commission_paise, a.gst_paise, a.vendor_paise, a.refunded_paise,
              a.refund_pending_paise, s.captured_at, count(*) OVER () AS total_count
         FROM v_order_line_allocation a
         JOIN v_order_summary s USING (order_id)
         JOIN products pr USING (product_id)
        WHERE a.vendor_id = $1 AND s.captured_payment_id IS NOT NULL
        ORDER BY s.captured_at DESC, a.order_id DESC, a.line_no
        LIMIT $2 OFFSET $3`, [req.user.vendor_id, q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  // ------------------------------------------------------------ W2 payouts
  r.get('/payouts', async (req, res) => {
    const q = parseQuery(req, { ...pageQuery, status: z.enum(['requested', 'paid', 'failed']).optional() });
    const { rows } = await db.query(
      `SELECT payout_id, amount_paise, status, bank_utr, requested_at, completed_at, count(*) OVER () AS total_count
         FROM payouts WHERE vendor_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY requested_at DESC, payout_id DESC LIMIT $3 OFFSET $4`,
      [req.user.vendor_id, q.status ?? null, q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  // The balance check happens INSIDE fn_request_payout under the account lock;
  // the client never supplies a balance.
  r.post('/payouts', async (req, res) => {
    const key = idempotencyKey(req);
    const { amount_paise } = parseBody(req, z.object({ amount_paise: paiseString }).strict());
    const { idempotency_key, ...p } = await db.one('SELECT * FROM fn_request_payout($1, $2, $3)',
      [req.user.user_id, amount_paise, key]);
    res.status(201).json(p);
  });

  return r;
}
