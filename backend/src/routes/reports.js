// Named SQL reports R1–R6 (Task 6, DEC-040). Every report is ONE call of a
// read-only SQL function in db/schema/32_reports.sql; this file only validates
// filters, scopes the call and shapes the JSON (BIGINT ids/paise stay strings).
//
//   finance (all vendors)                         vendor (own vendor only)
//   GET /api/finance/reports/trial-balance        —
//   GET /api/finance/reports/vendor-statement     GET /api/vendor/statement (R2, see vendor.js)
//   GET /api/finance/reports/monthly-performance  —
//   GET /api/finance/reports/refund-risk          GET /api/vendor/reports/refund-risk
//   GET /api/finance/reports/settlement-aging     —
//   GET /api/finance/reports/vendor-payables      GET /api/vendor/reports/payables
//
// Vendor scoping: the vendor id comes ONLY from req.user.vendor_id (the vendor
// the logged-in user owns), never from the query string.
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, notFound } from '../errors.js';
import { dateString, idString, offset, pageQuery, parseQuery } from '../validate.js';

const nonNegPaise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'must be an amount in paise as a decimal string');

export const REPORTS = {
  'trial-balance':       { id: 'R1', title: 'Trial balance' },
  'vendor-statement':    { id: 'R2', title: 'Vendor statement' },
  'monthly-performance': { id: 'R3', title: 'Monthly performance' },
  'refund-risk':         { id: 'R4', title: 'Vendor refund risk' },
  'settlement-aging':    { id: 'R5', title: 'Settlement reconciliation and aging' },
  'vendor-payables':     { id: 'R6', title: 'Vendor payables and payouts' },
};

function checkRange(from, to) {
  if (from && to && from > to) throw new ApiError(422, 'invalid_input', 'from must not be after to');
}

// ------------------------------------------------------------ shared query helpers
export async function trialBalance(db, asOf) {
  const { rows } = await db.query('SELECT * FROM fn_report_trial_balance($1) ORDER BY is_total, account_id', [asOf ?? null]);
  const total = rows.find((r) => r.is_total);
  return { accounts: rows.filter((r) => !r.is_total), total };
}

/** R2 page: opening/closing rows + one page of lines; total = number of lines in the range */
export async function vendorStatement(db, vendorId, { from, to, page, page_size }) {
  checkRange(from, to);
  const args = [vendorId, from ?? null, to ?? null];
  const [lines, ends] = await Promise.all([
    db.query(`SELECT seq, entry_id, line_no, created_at, posted_on, entry_type, payment_id, refund_id, payout_id,
                     reverses_entry_id, reference, description, credit_paise, debit_paise, running_balance_paise
                FROM fn_report_vendor_statement($1, $2, $3) WHERE row_kind = 'line'
               ORDER BY seq LIMIT $4 OFFSET $5`, [...args, page_size, offset({ page, page_size })]),
    db.query(`SELECT row_kind, seq, credit_paise, debit_paise, running_balance_paise
                FROM fn_report_vendor_statement($1, $2, $3) WHERE row_kind <> 'line'`, args),
  ]);
  const opening = ends.rows.find((r) => r.row_kind === 'opening');
  const closing = ends.rows.find((r) => r.row_kind === 'closing');
  return {
    items: lines.rows, page, page_size,
    total: (BigInt(closing.seq) - 1n).toString(),            // closing.seq = lines in range + 1
    opening_balance_paise: opening.running_balance_paise,
    closing_balance_paise: closing.running_balance_paise,
    period_credit_paise: closing.credit_paise,
    period_debit_paise: closing.debit_paise,
  };
}

export async function refundRisk(db, { from, to, min_sales_paise }, vendorId = null) {
  checkRange(from, to);
  const { rows } = await db.query(
    `SELECT * FROM fn_report_vendor_refund_risk($1, $2, $3)
      WHERE $4::bigint IS NULL OR vendor_id = $4
      ORDER BY refund_rate_bps DESC NULLS LAST, vendor_id`,
    [from ?? null, to ?? null, min_sales_paise ?? '100000', vendorId]);
  return rows;
}

export async function vendorPayables(db, vendorId = null) {
  const { rows } = await db.query('SELECT * FROM fn_report_vendor_payables($1) ORDER BY vendor_id', [vendorId]);
  return rows;
}

// ------------------------------------------------------------ finance
export function financeReportRoutes({ db, asOfOrDefault }) {
  const r = Router();

  r.get('/', (req, res) => res.json({ items: Object.entries(REPORTS).map(([name, x]) => ({ name, ...x })) }));

  r.get('/trial-balance', async (req, res) => {
    const q = parseQuery(req, { as_of: dateString.optional() });
    res.json({ ...REPORTS['trial-balance'], as_of: q.as_of ?? null, ...(await trialBalance(db, q.as_of)) });
  });

  r.get('/vendor-statement', async (req, res) => {
    const q = parseQuery(req, { vendor_id: idString, from: dateString.optional(), to: dateString.optional(), ...pageQuery });
    const v = await db.one('SELECT vendor_id, legal_name FROM vendors WHERE vendor_id = $1', [q.vendor_id]);
    if (!v) throw notFound('vendor');
    res.json({ ...REPORTS['vendor-statement'], vendor: v, from: q.from ?? null, to: q.to ?? null,
               ...(await vendorStatement(db, q.vendor_id, q)) });
  });

  r.get('/monthly-performance', async (req, res) => {
    const q = parseQuery(req, { from: dateString.optional(), to: dateString.optional() });
    checkRange(q.from, q.to);
    if (q.from && q.to) {                                     // bound the generated month series
      const m = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
      if (m(q.to) - m(q.from) + 1 > 120) throw new ApiError(422, 'invalid_input', 'at most 120 months per request');
    }
    const { rows } = await db.query('SELECT * FROM fn_report_monthly_performance($1, $2) ORDER BY month',
      [q.from ?? null, q.to ?? null]);
    res.json({ ...REPORTS['monthly-performance'], from: q.from ?? null, to: q.to ?? null, items: rows });
  });

  r.get('/refund-risk', async (req, res) => {
    const q = parseQuery(req, { from: dateString.optional(), to: dateString.optional(), min_sales_paise: nonNegPaise.optional() });
    res.json({ ...REPORTS['refund-risk'], from: q.from ?? null, to: q.to ?? null,
               min_sales_paise: q.min_sales_paise ?? '100000', items: await refundRisk(db, q) });
  });

  r.get('/settlement-aging', async (req, res) => {
    const q = parseQuery(req, { as_of: dateString.optional() });
    const asOf = await asOfOrDefault(q.as_of);
    const { rows } = await db.query('SELECT * FROM fn_report_settlement_aging($1)', [asOf]);
    res.json({ ...REPORTS['settlement-aging'], as_of: asOf,
               items: rows.filter((x) => !x.is_total), total: rows.find((x) => x.is_total) ?? null });
  });

  r.get('/vendor-payables', async (req, res) => {
    const q = parseQuery(req, { vendor_id: idString.optional() });
    res.json({ ...REPORTS['vendor-payables'], items: await vendorPayables(db, q.vendor_id ?? null) });
  });

  return r;
}

// ------------------------------------------------------------ vendor (own rows only)
export function vendorReportRoutes({ db }) {
  const r = Router();
  const hide = ({ rate_rank, ...row }) => row;                // no ranking against other vendors

  r.get('/refund-risk', async (req, res) => {
    const q = parseQuery(req, { from: dateString.optional(), to: dateString.optional() });
    const [row] = await refundRisk(db, q, req.user.vendor_id);
    res.json({ ...REPORTS['refund-risk'], from: q.from ?? null, to: q.to ?? null, item: row ? hide(row) : null });
  });

  r.get('/payables', async (req, res) => {
    parseQuery(req, {});
    const [row] = await vendorPayables(db, req.user.vendor_id);
    res.json({ ...REPORTS['vendor-payables'], item: row ?? null });
  });

  return r;
}
