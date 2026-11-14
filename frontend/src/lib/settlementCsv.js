// Browser-side FORMAT check for the settlement CSV (preview only).
// Mirrors backend/src/settlementCsv.js so the finance user sees malformed rows
// before importing. It is a convenience: the backend re-parses the file and the
// database decides everything else (matching, duplicates, future dates, fee < gross).
// Malformed rows are still sent — the API reports them as `invalid` per row.

export const COLUMNS = ['gateway_ref', 'record_type', 'gross_paise', 'fee_paise', 'settled_on'];
export const HEADER = COLUMNS.join(',');
export const MAX_ROWS = 1000;
export const MAX_BYTES = 256 * 1024;

const REF_RE = /^[A-Za-z0-9_]{1,64}$/;
const GROSS_RE = /^[1-9][0-9]{0,17}$/;
const FEE_RE = /^(0|[1-9][0-9]{0,17})$/;

function isCalendarDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/**
 * → { headerError: string|null, tooMany: boolean,
 *     rows: [{ line, ref, cells: {gateway_ref,…}|null, errors: string[] }] }
 * `line` is the 1-based line number in the file (same numbering as the API).
 */
export function checkSettlementCsv(text) {
  const out = { headerError: null, tooMany: false, rows: [] };
  if (typeof text !== 'string' || !text.trim()) return out;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = lines[0].split(',').map((s) => s.trim()).join(',');
  if (header !== HEADER) {
    out.headerError = `The first line must be exactly: ${HEADER}`;
    return out;
  }
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const line = i + 1;
    const cells = raw.split(',').map((s) => s.trim());
    const ref = REF_RE.test(cells[0]) ? cells[0] : undefined;
    const errors = [];
    if (raw.includes('"')) errors.push('quoted fields are not supported');
    else if (cells.length !== COLUMNS.length) errors.push(`expected ${COLUMNS.length} fields, found ${cells.length}`);
    else {
      const [gatewayRef, recordType, gross, fee, settledOn] = cells;
      if (!REF_RE.test(gatewayRef)) errors.push('gateway_ref: letters, digits and _ only');
      if (recordType !== 'payment' && recordType !== 'refund') errors.push('record_type: must be payment or refund');
      if (!GROSS_RE.test(gross)) errors.push('gross_paise: positive integer paise');
      if (fee !== '' && !FEE_RE.test(fee)) errors.push('fee_paise: non-negative integer paise');
      if (!isCalendarDate(settledOn)) errors.push('settled_on: real date YYYY-MM-DD');
    }
    const ok = errors.length === 0;
    out.rows.push({
      line,
      ref,
      cells: ok ? Object.fromEntries(COLUMNS.map((c, k) => [c, k === 3 && cells[k] === '' ? '0' : cells[k]])) : null,
      raw: cells,
      errors,
    });
  }
  out.tooMany = out.rows.length > MAX_ROWS;
  return out;
}
