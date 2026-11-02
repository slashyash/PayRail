// Bounded settlement-report parser (W4). Accepts the simulated gateway's CSV:
//
//   gateway_ref,record_type,gross_paise,fee_paise,settled_on
//   pay_S000000123,payment,125050,2501,2026-10-30
//   rfnd_R000000007,refund,50000,0,2026-10-30
//
// Deliberately simple and strict: no quoting (no field needs it), header
// required and exact, at most MAX_ROWS data rows, blank lines ignored. Each
// row is validated on its own; a bad row is reported with its line number and
// does not stop the others (row-level validation).
import { z } from 'zod';
import { ApiError } from './errors.js';
import { dateString } from './validate.js';

export const MAX_ROWS = 1000;
export const COLUMNS = ['gateway_ref', 'record_type', 'gross_paise', 'fee_paise', 'settled_on'];

export const settlementRowSchema = z.object({
  gateway_ref: z.string().regex(/^[A-Za-z0-9_]{1,64}$/, 'letters, digits and _ only (1..64)'),
  record_type: z.enum(['payment', 'refund']),
  gross_paise: z.string().regex(/^[1-9][0-9]{0,17}$/, 'positive integer paise'),
  fee_paise: z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'non-negative integer paise').default('0'),
  settled_on: dateString,
}).strict();

/** → { rows: [{ line, data }], invalid: [{ line, errors }] } */
export function parseSettlementCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ApiError(422, 'invalid_input', 'empty CSV');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = lines[0].split(',').map((s) => s.trim());
  if (header.join(',') !== COLUMNS.join(',')) {
    throw new ApiError(422, 'invalid_input', `CSV header must be exactly: ${COLUMNS.join(',')}`);
  }
  const rows = [];
  const invalid = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    if (rows.length + invalid.length >= MAX_ROWS) {
      throw new ApiError(413, 'too_large', `at most ${MAX_ROWS} data rows per import`);
    }
    const lineNo = i + 1;
    if (raw.includes('"')) { invalid.push({ line: lineNo, errors: ['quoted fields are not supported'] }); continue; }
    const cells = raw.split(',').map((s) => s.trim());
    // echo the reference of a bad row (only if it is a plain reference) so the report can name it
    const ref = /^[A-Za-z0-9_]{1,64}$/.test(cells[0]) ? cells[0] : undefined;
    if (cells.length !== COLUMNS.length) {
      invalid.push({ line: lineNo, gateway_ref: ref, errors: [`expected ${COLUMNS.length} fields, found ${cells.length}`] });
      continue;
    }
    const obj = Object.fromEntries(COLUMNS.map((c, k) => [c, cells[k]]));
    if (obj.fee_paise === '') delete obj.fee_paise;
    const r = settlementRowSchema.safeParse(obj);
    if (r.success) rows.push({ line: lineNo, data: r.data });
    else invalid.push({ line: lineNo, gateway_ref: ref, errors: r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) });
  }
  return { rows, invalid };
}
