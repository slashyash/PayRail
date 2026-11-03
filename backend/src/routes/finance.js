// Finance routes — W3 refund decisions, W2 payout completion, W4 settlement
// import and reconciliation, ledger views. Mounted behind requireAuth +
// requireRole('finance_admin'); the functions re-check the role (PRA01).
import express, { Router } from 'express';
import { z } from 'zod';
import { fromDbError, notFound } from '../errors.js';
import { parseSettlementCsv, settlementRowSchema, MAX_ROWS } from '../settlementCsv.js';
import { dateString, idString, offset, pageOf, pageQuery, parseBody, parseParams, parseQuery } from '../validate.js';
import { financeReportRoutes, trialBalance } from './reports.js';

const CATEGORIES = ['matched', 'amount_mismatch', 'unknown_reference', 'in_transit', 'overdue_missing'];
const stripKey = ({ idempotency_key, ...rest }) => rest;

// ledger lines as JSON with BIGINTs cast to text, so json parsing never turns them into Numbers
const LINES_JSON = `(SELECT json_agg(json_build_object(
      'line_no', l.line_no, 'account_id', l.account_id::text, 'account_code', a.code,
      'direction', l.direction, 'amount_paise', l.amount_paise::text) ORDER BY l.line_no)
    FROM ledger_lines l JOIN accounts a USING (account_id) WHERE l.entry_id = e.entry_id) AS lines`;

export function financeRoutes({ db, config }) {
  const r = Router();

  const asOfOrDefault = async (asOf) =>
    asOf ?? config.demoAsOf ?? (await db.one(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;

  // ------------------------------------------------------------ W3 refunds
  r.get('/refunds', async (req, res) => {
    const q = parseQuery(req, {
      ...pageQuery, status: z.enum(['requested', 'processed', 'rejected']).optional(), vendor_id: idString.optional(),
    });
    const { rows } = await db.query(
      `SELECT r.refund_id, r.order_id, r.line_no, r.amount_paise, r.reason, r.status, r.requested_at,
              r.processed_at, r.gateway_ref, o.customer_id, u.full_name AS customer_name,
              a.vendor_id, v.legal_name AS vendor_name, pr.name AS product_name,
              a.line_total_paise, a.refunded_paise AS line_refunded_paise, a.refundable_paise AS line_refundable_paise,
              count(*) OVER () AS total_count
         FROM refunds r
         JOIN orders o USING (order_id) JOIN users u ON u.user_id = o.customer_id
         JOIN v_order_line_allocation a ON a.order_id = r.order_id AND a.line_no = r.line_no
         JOIN vendors v ON v.vendor_id = a.vendor_id JOIN products pr ON pr.product_id = a.product_id
        WHERE ($1::text IS NULL OR r.status = $1) AND ($2::bigint IS NULL OR a.vendor_id = $2)
        ORDER BY r.requested_at, r.refund_id LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.vendor_id ?? null, q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  r.post('/refunds/:id/approve', async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    res.json(stripKey(await db.one('SELECT * FROM fn_approve_refund($1, $2)', [req.user.user_id, id])));
  });

  r.post('/refunds/:id/reject', async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    res.json(stripKey(await db.one('SELECT * FROM fn_reject_refund($1, $2)', [req.user.user_id, id])));
  });

  // ------------------------------------------------------------ W2 payouts
  r.get('/payouts', async (req, res) => {
    const q = parseQuery(req, {
      ...pageQuery, status: z.enum(['requested', 'paid', 'failed']).optional(), vendor_id: idString.optional(),
    });
    const { rows } = await db.query(
      `SELECT p.payout_id, p.vendor_id, v.legal_name AS vendor_name, p.amount_paise, p.status, p.bank_utr,
              p.requested_at, p.completed_at, count(*) OVER () AS total_count
         FROM payouts p JOIN vendors v USING (vendor_id)
        WHERE ($1::text IS NULL OR p.status = $1) AND ($2::bigint IS NULL OR p.vendor_id = $2)
        ORDER BY p.requested_at, p.payout_id LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.vendor_id ?? null, q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  const completeSchema = z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('paid'), bank_utr: z.string().regex(/^[A-Z0-9]{12,22}$/, '12–22 upper-case letters/digits') }).strict(),
    z.object({ outcome: z.literal('failed') }).strict(),
  ]);
  r.post('/payouts/:id/complete', async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const b = parseBody(req, completeSchema);
    res.json(stripKey(await db.one('SELECT * FROM fn_complete_payout($1, $2, $3, $4)',
      [req.user.user_id, id, b.outcome, b.outcome === 'paid' ? b.bank_utr : null])));
  });

  // ------------------------------------------------------------ W4 settlement import
  // Body: text/csv (see src/settlementCsv.js) or JSON { rows: [...] }.
  // One transaction on ONE client; each row runs inside its own SAVEPOINT, so a
  // row the database rejects (e.g. fee ≥ gross, future date) is rolled back on
  // its own and reported, while the other rows are kept. Only exact matches are
  // posted (inside fn_record_settlement); everything else is stored as received.
  r.post('/settlements/import', express.text({ type: 'text/csv', limit: '256kb' }), async (req, res) => {
    let rows;
    let invalid = [];
    if (req.is('text/csv')) {
      ({ rows, invalid } = parseSettlementCsv(req.body));
    } else {
      const b = parseBody(req, z.object({ rows: z.array(z.unknown()).min(1).max(MAX_ROWS) }).strict());
      rows = [];
      b.rows.forEach((row, i) => {
        const p = settlementRowSchema.safeParse(row);
        if (p.success) rows.push({ line: i + 1, data: p.data });
        else invalid.push({ line: i + 1, errors: p.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) });
      });
    }
    const results = await db.withTransaction(async (client) => {
      const out = [];
      for (const { line, data } of rows) {
        await client.query('SAVEPOINT row_sp');
        try {
          const { rows: [x] } = await client.query(
            'SELECT * FROM fn_record_settlement($1, $2, $3, $4, $5, $6)',
            [req.user.user_id, data.gateway_ref, data.record_type, data.gross_paise, data.fee_paise, data.settled_on]);
          await client.query('RELEASE SAVEPOINT row_sp');
          out.push({ line, gateway_ref: data.gateway_ref, result: x.result, settlement_id: x.settlement_id,
                     posted_entry_id: x.entry_id });
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT row_sp');
          const api = fromDbError(e);
          if (!api || api.status === 403) throw e;             // not a row problem: abort the whole import
          out.push({ line, gateway_ref: data.gateway_ref, result: 'rejected', error: { code: api.code, message: api.message, sqlstate: api.sqlstate } });
        }
      }
      return out;
    });
    for (const x of invalid) results.push({ line: x.line, gateway_ref: x.gateway_ref, result: 'invalid', errors: x.errors });
    results.sort((a, b) => a.line - b.line);
    const summary = {};
    for (const x of results) summary[x.result] = (summary[x.result] || 0) + 1;
    // rows this import stored AND posted (a duplicate/conflict row only echoes the original's entry)
    summary.posted = results.filter((x) => x.result === 'inserted' && x.posted_entry_id).length;
    res.json({ summary, results });
  });

  r.get('/settlements', async (req, res) => {
    const q = parseQuery(req, { ...pageQuery, settled_on: dateString.optional() });
    const { rows } = await db.query(
      `SELECT s.settlement_id, s.gateway_ref, s.record_type, s.gross_paise, s.fee_paise, s.settled_on, s.imported_at,
              je.entry_id AS posted_entry_id, count(*) OVER () AS total_count
         FROM gateway_settlements s LEFT JOIN journal_entries je ON je.settlement_id = s.settlement_id
        WHERE ($1::date IS NULL OR s.settled_on = $1)
        ORDER BY s.settled_on DESC, s.settlement_id DESC LIMIT $2 OFFSET $3`,
      [q.settled_on ?? null, q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  // ------------------------------------------------------------ W4 reconciliation
  r.post('/reconcile', async (req, res) => {
    const b = parseBody(req, z.object({ as_of: dateString.optional() }).strict());
    const asOf = await asOfOrDefault(b.as_of);
    const { rows } = await db.query('SELECT * FROM fn_reconcile($1, $2)', [req.user.user_id, asOf]);
    res.json({ as_of: asOf, categories: rows });
  });

  r.get('/reconciliation', async (req, res) => {
    const q = parseQuery(req, {
      ...pageQuery, as_of: dateString.optional(), category: z.enum(CATEGORIES).optional(),
      gateway_ref: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).optional(),
    });
    const asOf = await asOfOrDefault(q.as_of);
    const { rows } = await db.query(
      `SELECT *, count(*) OVER () AS total_count FROM fn_reconciliation_report($1)
        WHERE ($2::text IS NULL OR category = $2) AND ($3::text IS NULL OR gateway_ref = $3)
        ORDER BY category, event_on NULLS LAST, settled_on NULLS LAST, gateway_ref
        LIMIT $4 OFFSET $5`, [asOf, q.category ?? null, q.gateway_ref ?? null, q.page_size, offset(q)]);
    res.json({ as_of: asOf, ...pageOf(rows, q) });
  });

  // ------------------------------------------------------------ ledger views
  // R1 (fn_report_trial_balance) — kept at this path for the T5 Ledger page
  r.get('/trial-balance', async (req, res) => {
    const q = parseQuery(req, { as_of: dateString.optional() });
    const { accounts, total } = await trialBalance(db, q.as_of);
    res.json({ accounts, total_debit_paise: total.debit_paise, total_credit_paise: total.credit_paise,
               balanced: total.balanced, as_of: q.as_of ?? null });
  });

  // ------------------------------------------------------------ named reports R1–R6 (Task 6)
  r.use('/reports', financeReportRoutes({ db, asOfOrDefault }));

  r.get('/vendors', async (req, res) => {
    const { rows } = await db.query(
      `SELECT v.vendor_id, v.legal_name, v.kyc_status, v.commission_bps, b.balance_paise,
              (SELECT count(*) FROM payouts p WHERE p.vendor_id = v.vendor_id AND p.status = 'requested') AS pending_payouts
         FROM vendors v JOIN v_account_balances b ON b.vendor_id = v.vendor_id AND b.owner_type = 'vendor'
        ORDER BY v.vendor_id`);
    res.json({ items: rows });
  });

  // payment attempts (newest first) — used by the finance gateway simulator screen
  r.get('/payments', async (req, res) => {
    const q = parseQuery(req, {
      ...pageQuery,
      status: z.enum(['initiated', 'captured', 'failed']).optional(),
      order_id: idString.optional(),
    });
    const { rows } = await db.query(
      `SELECT p.payment_id, p.order_id, o.customer_id, p.amount_paise, p.method, p.status, p.gateway_ref,
              p.created_at, p.captured_at, count(*) OVER () AS total_count
         FROM payments p JOIN orders o USING (order_id)
        WHERE ($1::text IS NULL OR p.status = $1) AND ($2::bigint IS NULL OR p.order_id = $2)
        ORDER BY p.payment_id DESC LIMIT $3 OFFSET $4`,
      [q.status ?? null, q.order_id ?? null, q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  r.get('/journal-entries', async (req, res) => {
    const q = parseQuery(req, {
      ...pageQuery,
      entry_type: z.enum(['capture', 'refund', 'payout', 'settlement', 'reversal']).optional(),
      payment_id: idString.optional(), refund_id: idString.optional(), payout_id: idString.optional(),
      order_id: idString.optional(),
    });
    const { rows } = await db.query(
      `SELECT e.entry_id, e.entry_type, e.description, e.created_at, e.payment_id, e.refund_id, e.payout_id,
              e.settlement_id, e.reverses_entry_id, ${LINES_JSON}, count(*) OVER () AS total_count
         FROM journal_entries e
        WHERE ($1::text IS NULL OR e.entry_type = $1)
          AND ($2::bigint IS NULL OR e.payment_id = $2)
          AND ($3::bigint IS NULL OR e.refund_id = $3)
          AND ($4::bigint IS NULL OR e.payout_id = $4
               OR e.reverses_entry_id IN (SELECT entry_id FROM journal_entries WHERE payout_id = $4))
          AND ($5::bigint IS NULL
               OR e.payment_id IN (SELECT payment_id FROM payments WHERE order_id = $5)
               OR e.refund_id  IN (SELECT refund_id  FROM refunds  WHERE order_id = $5))
        ORDER BY e.entry_id DESC LIMIT $6 OFFSET $7`,
      [q.entry_type ?? null, q.payment_id ?? null, q.refund_id ?? null, q.payout_id ?? null, q.order_id ?? null,
        q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  r.get('/orders/:id', async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const order = await db.one('SELECT * FROM v_order_summary WHERE order_id = $1', [id]);
    if (!order) throw notFound('order');
    const [lines, payments, refunds] = await Promise.all([
      db.query('SELECT * FROM v_order_line_allocation WHERE order_id = $1 ORDER BY line_no', [id]),
      db.query('SELECT payment_id, amount_paise, method, status, gateway_ref, created_at, captured_at FROM payments WHERE order_id = $1 ORDER BY payment_id', [id]),
      db.query('SELECT refund_id, line_no, amount_paise, reason, status, requested_at, processed_at, gateway_ref FROM refunds WHERE order_id = $1 ORDER BY refund_id', [id]),
    ]);
    res.json({ ...order, lines: lines.rows, payments: payments.rows, refunds: refunds.rows });
  });

  return r;
}
