// node --test src/lib/money.test.js   (no browser needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { addPaise, cmpPaise, formatINR, mulPaise, paiseToInput, parseRupees, toPaise } from './money.js';

test('formatINR uses Indian grouping and exact paise', () => {
  assert.equal(formatINR('0'), '₹0.00');
  assert.equal(formatINR('5'), '₹0.05');
  assert.equal(formatINR('125050'), '₹1,250.50');
  assert.equal(formatINR('801428631'), '₹80,14,286.31');
  assert.equal(formatINR('-4410000'), '−₹44,100.00');
  // 2^53 + 1 paise: a Number would print ...992; BigInt keeps the 3
  assert.equal(formatINR('9007199254740993'), '₹9,00,71,99,25,47,409.93');
});

test('parseRupees is exact and strict', () => {
  assert.equal(parseRupees('1250'), '125000');
  assert.equal(parseRupees('1,250.5'), '125050');
  assert.equal(parseRupees('0.75'), '75');
  assert.equal(parseRupees('0.1'), '10');
  assert.equal(parseRupees(' 19.99 '), '1999');
  assert.equal(parseRupees('0'), '0');
  for (const bad of ['', '-1', '1.234', 'abc', '1e3', '.5', '1.', null]) assert.equal(parseRupees(bad), null, String(bad));
});

test('helpers never go through floating point', () => {
  assert.equal(addPaise('9007199254740993', '1'), '9007199254740994');
  assert.equal(mulPaise('333333', 3), '999999');
  assert.equal(cmpPaise('10', '9'), 1);
  assert.equal(paiseToInput('125050'), '1250.50');
  assert.throws(() => toPaise(12.5));
  assert.throws(() => toPaise('12.5'));
});

test('chartRupees is display-only geometry: whole rupees, refuses unsafe sizes; formatBps is exact', async () => {
  const { chartRupees, formatBps } = await import('./money.js');
  assert.equal(chartRupees('137833829'), 1378338);
  assert.equal(chartRupees('99'), 0);
  assert.equal(chartRupees('-1603942'), -16039);
  assert.throws(() => chartRupees('9223372036854775807'), RangeError);
  assert.equal(formatBps('448'), '4.48%');
  assert.equal(formatBps('10000'), '100.00%');
  assert.equal(formatBps('5'), '0.05%');
  assert.equal(formatBps(null), '—');
});
