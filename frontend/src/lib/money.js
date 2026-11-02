// Money helpers (DEC-003): the API sends paise as decimal STRINGS.
// We never convert paise to a JavaScript Number (a double loses exactness
// above 2^53 and invites float arithmetic); all arithmetic uses BigInt.

const PAISE_RE = /^-?[0-9]{1,19}$/;

/** paise string|bigint → BigInt (throws on anything that is not an integer string) */
export function toPaise(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && PAISE_RE.test(v)) return BigInt(v);
  throw new TypeError(`not a paise value: ${String(v)}`);
}

/** Indian digit grouping: 12345678 → "1,23,45,678" */
function groupIndian(digits) {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const parts = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

/** "12345050" → "₹1,23,450.50" (exact; negative values keep their sign) */
export function formatINR(paise) {
  const p = toPaise(paise);
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const rupees = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '−' : ''}₹${groupIndian(rupees)}.${frac}`;
}

/**
 * User-typed rupees → paise string, exactly, by string manipulation (no floats).
 * Accepts "1250", "1,250.5", "0.75". Returns null for anything else
 * (negative, more than 2 decimals, empty, letters). Zero returns "0".
 */
export function parseRupees(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim().replace(/,/g, '');
  const m = /^([0-9]{1,16})(?:\.([0-9]{1,2}))?$/.exec(s);
  if (!m) return null;
  const paise = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return paise.toString();
}

/** paise → plain rupee text for an input box: "125050" → "1250.50" */
export function paiseToInput(paise) {
  const p = toPaise(paise);
  return `${p / 100n}.${(p % 100n).toString().padStart(2, '0')}`;
}

export const addPaise = (a, b) => (toPaise(a) + toPaise(b)).toString();
export const mulPaise = (a, qty) => (toPaise(a) * BigInt(qty)).toString();
export const cmpPaise = (a, b) => { const x = toPaise(a); const y = toPaise(b); return x < y ? -1 : x > y ? 1 : 0; };
