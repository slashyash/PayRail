// node --test: the browser-side settlement CSV format check (preview only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkSettlementCsv, HEADER, MAX_ROWS } from './settlementCsv.js';

const sample = (f) => readFileSync(new URL(`../../../samples/settlements/${f}`, import.meta.url), 'utf8');

test('empty text → nothing to check', () => {
  assert.deepEqual(checkSettlementCsv('   '), { headerError: null, tooMany: false, rows: [] });
});

test('wrong header is reported and no rows are checked', () => {
  const r = checkSettlementCsv('ref,type,gross,fee,date\npay_S1,payment,100,0,2026-10-31');
  assert.match(r.headerError, /gateway_ref,record_type/);
  assert.equal(r.rows.length, 0);
});

test('valid rows; blank lines skipped; empty fee becomes 0; line numbers match the file', () => {
  const r = checkSettlementCsv(`﻿${HEADER}\r\npay_S000000365,payment,1678600,33572,2026-10-31\r\n\r\nrfnd_R000000044,refund,2099400,,2026-10-31\r\n`);
  assert.equal(r.headerError, null);
  assert.deepEqual(r.rows.map((x) => [x.line, x.errors.length]), [[2, 0], [4, 0]]);
  assert.equal(r.rows[1].cells.fee_paise, '0');
});

test('01_normal.csv: all four rows look valid', () => {
  const r = checkSettlementCsv(sample('01_normal.csv'));
  assert.equal(r.rows.length, 4);
  assert.ok(r.rows.every((x) => x.errors.length === 0));
});

test('03_exceptions.csv: exactly the four rows the API calls invalid are flagged', () => {
  // the database (not this check) refuses fee = gross and the 2099 date
  const r = checkSettlementCsv(sample('03_exceptions.csv'));
  const bad = r.rows.filter((x) => x.errors.length).map((x) => x.ref);
  assert.deepEqual(bad, ['pay_S000000373', 'pay_S000000374', 'pay_S000000375', 'pay_S000000377']);
});

test('quotes and decimal amounts are format errors', () => {
  const r = checkSettlementCsv(`${HEADER}\n"pay_S1",payment,100,0,2026-10-31\npay_S2,payment,10.5,0,2026-10-31`);
  assert.match(r.rows[0].errors[0], /quoted/);
  assert.match(r.rows[1].errors[0], /gross_paise/);
});

test('more than MAX_ROWS rows is flagged', () => {
  const body = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `pay_S${i},payment,100,0,2026-10-31`).join('\n');
  assert.equal(checkSettlementCsv(`${HEADER}\n${body}`).tooMany, true);
});
