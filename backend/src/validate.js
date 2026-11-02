// Input validation with Zod (Task 3, DEC-003).
//
// Lossless conventions: BIGINT ids and paise amounts are DECIMAL STRINGS
// ("125050"), at most 18 digits so they always fit a BIGINT. Small integers
// (quantity, line_no, page) are ordinary JSON numbers.
import { z } from 'zod';
import { ApiError } from './errors.js';

export const idString = z.string().regex(/^[1-9][0-9]{0,17}$/, 'must be a positive integer id as a decimal string');
export const paiseString = z.string().regex(/^[1-9][0-9]{0,17}$/, 'must be a positive amount in paise as a decimal string');
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
    'must be a real calendar date');
export const uuidString = z.uuid({ message: 'must be a UUID' });

export const pageQuery = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
};

function fail(error, where) {
  const details = error.issues.map((i) => ({ path: [where, ...i.path].join('.'), message: i.message }));
  return new ApiError(422, 'invalid_input', `invalid ${where}`, details);
}

/** parse req[where] with schema; throws a 422 ApiError listing every issue */
export function parse(schema, value, where = 'body') {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw fail(r.error, where);
  return r.data;
}

export const parseParams = (req, shape) => parse(z.object(shape), req.params, 'params');
export const parseQuery = (req, shape) => parse(z.object(shape).strict(), req.query, 'query');
export const parseBody = (req, schema) => parse(schema, req.body, 'body');

/** Idempotency-Key header (client-generated UUID, DEC-011); required for money-creating POSTs */
export function idempotencyKey(req) {
  const key = req.get('Idempotency-Key');
  const r = uuidString.safeParse(key);
  if (!r.success) {
    throw new ApiError(422, 'invalid_input', 'Idempotency-Key header (a UUID) is required',
      [{ path: 'header.Idempotency-Key', message: 'must be a UUID' }]);
  }
  return r.data.toLowerCase();
}

export const offset = (q) => (q.page - 1) * q.page_size;

/** { items, page, page_size, total } from rows that carry count(*) OVER () AS total_count */
export function pageOf(rows, q) {
  const total = rows.length ? rows[0].total_count : '0';
  return { items: rows.map(({ total_count, ...r }) => r), page: q.page, page_size: q.page_size, total };
}
