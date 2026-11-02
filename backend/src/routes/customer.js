// Customer routes — W1 checkout/payment and W3 refund requests.
// Mounted behind requireAuth + requireRole('customer'). Every query is scoped
// to req.user.user_id; another customer's order is simply "not found" (404).
// Workflow calls pass req.user.user_id as the actor and the database
// re-checks ownership (PRA01 → 403).
import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../errors.js';
import { publicPayment } from '../gateway.js';
import {
  idempotencyKey, idString, offset, pageOf, pageQuery, paiseString, parseBody, parseParams, parseQuery,
} from '../validate.js';

const ORDER_STATUS = ['pending_payment', 'paid', 'partially_refunded', 'refunded'];

const placeOrderSchema = z.object({
  items: z.array(z.object({
    product_id: idString,
    quantity: z.number().int().min(1).max(100),
  }).strict()).min(1).max(50),
}).strict();
// No price, commission or total is accepted: the database snapshots them from the catalogue.

const paymentSchema = z.object({ method: z.enum(['upi', 'card', 'netbanking']) }).strict();

const refundSchema = z.object({
  line_no: z.number().int().min(1).max(1000),
  amount_paise: paiseString,
  reason: z.string().trim().min(1).max(500),
}).strict();

const stripKey = ({ idempotency_key, ...rest }) => rest;

export function customerRoutes({ db }) {
  const r = Router();

  async function orderDetail(orderId, customerId) {
    const order = await db.one(
      `SELECT order_id, created_at, line_count, total_paise, status, captured_payment_id, captured_at,
              refunded_paise, refund_pending_paise
         FROM v_order_summary WHERE order_id = $1 AND customer_id = $2`, [orderId, customerId]);
    if (!order) return null;
    const [lines, payments, refunds] = await Promise.all([
      db.query(
        `SELECT a.line_no, a.product_id, p.name AS product_name, a.vendor_id, v.legal_name AS vendor_name,
                a.quantity, a.unit_price_paise, a.line_total_paise,
                a.refunded_paise, a.refund_pending_paise, a.refundable_paise
           FROM v_order_line_allocation a
           JOIN products p USING (product_id) JOIN vendors v ON v.vendor_id = a.vendor_id
          WHERE a.order_id = $1 ORDER BY a.line_no`, [orderId]),
      db.query(
        `SELECT payment_id, amount_paise, method, status, gateway_ref, created_at, captured_at
           FROM payments WHERE order_id = $1 ORDER BY payment_id`, [orderId]),
      db.query(
        `SELECT refund_id, line_no, amount_paise, reason, status, requested_at, processed_at, gateway_ref
           FROM refunds WHERE order_id = $1 ORDER BY refund_id`, [orderId]),
    ]);
    return { ...order, lines: lines.rows, payments: payments.rows, refunds: refunds.rows };
  }

  // W1 step 1: place an order (no money moves; prices are snapshotted by the database)
  r.post('/orders', async (req, res) => {
    const { items } = parseBody(req, placeOrderSchema);
    const { order_id } = await db.one('SELECT fn_place_order($1, $2::jsonb) AS order_id',
      [req.user.user_id, JSON.stringify(items)]);
    res.status(201).json(await orderDetail(order_id, req.user.user_id));
  });

  r.get('/orders', async (req, res) => {
    const q = parseQuery(req, { ...pageQuery, status: z.enum(ORDER_STATUS).optional() });
    const { rows } = await db.query(
      `SELECT order_id, created_at, line_count, total_paise, status, refunded_paise, refund_pending_paise,
              count(*) OVER () AS total_count
         FROM v_order_summary
        WHERE customer_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC, order_id DESC
        LIMIT $3 OFFSET $4`, [req.user.user_id, q.status ?? null, q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  r.get('/orders/:id', async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const detail = await orderDetail(id, req.user.user_id);
    if (!detail) throw notFound('order');
    res.json(detail);
  });

  // W1 step 2: start a payment attempt (amount = derived order total, idempotent per key)
  r.post('/orders/:id/payments', async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const key = idempotencyKey(req);
    const { method } = parseBody(req, paymentSchema);
    const p = await db.one('SELECT * FROM fn_initiate_payment($1, $2, $3, $4)', [req.user.user_id, id, method, key]);
    res.status(201).json(publicPayment(p));
  });

  // W3 step 1: request a (partial) refund of one order line (reserves the amount)
  r.post('/orders/:id/refunds', async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const key = idempotencyKey(req);
    const b = parseBody(req, refundSchema);
    const row = await db.one('SELECT * FROM fn_request_refund($1, $2, $3, $4, $5, $6)',
      [req.user.user_id, id, b.line_no, b.amount_paise, b.reason, key]);
    res.status(201).json(stripKey(row));
  });

  r.get('/refunds', async (req, res) => {
    const q = parseQuery(req, { ...pageQuery, status: z.enum(['requested', 'processed', 'rejected']).optional() });
    const { rows } = await db.query(
      `SELECT r.refund_id, r.order_id, r.line_no, p.name AS product_name, r.amount_paise, r.reason, r.status,
              r.requested_at, r.processed_at, r.gateway_ref, count(*) OVER () AS total_count
         FROM refunds r JOIN orders o USING (order_id)
         JOIN order_items oi USING (order_id, line_no) JOIN products p USING (product_id)
        WHERE o.customer_id = $1 AND ($2::text IS NULL OR r.status = $2)
        ORDER BY r.requested_at DESC, r.refund_id DESC
        LIMIT $3 OFFSET $4`, [req.user.user_id, q.status ?? null, q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  return r;
}
