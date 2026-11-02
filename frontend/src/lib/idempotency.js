// Idempotency keys in the browser (DEC-011, DEC-034, DEC-037).
//
// Rule: ONE key per logical action.
//   * Retrying the same action (same payload after a timeout / network error /
//     double click) reuses the key  → the server returns the original row.
//   * Changing the payload, or starting a new action after a success or a
//     final failure, gets a fresh key.
// The key is tied to a "signature" of the payload: same signature → same key.
// Keys can be persisted in sessionStorage so that a page refresh in the middle
// of an action is still a retry of that action, not a new one.
import { useCallback, useRef } from 'react';

export function newKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // fallback for non-secure contexts (e.g. opened via a LAN IP): RFC 4122 v4 from getRandomValues
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function readStore(storageKey) {
  if (!storageKey) return null;
  try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { return null; }
}
function writeStore(storageKey, value) {
  if (!storageKey) return;
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  } catch { /* storage unavailable: the key just lives in memory */ }
}

/**
 * useIdempotencyKey(storageKey?)
 *   keyFor(signature) → the key for this payload (stable while the signature is unchanged)
 *   reset()           → the next keyFor() returns a new key (call after success / final failure)
 *   current()         → { signature, key } or null
 */
export function useIdempotencyKey(storageKey) {
  const ref = useRef(readStore(storageKey));
  const keyFor = useCallback((signature) => {
    if (!ref.current || ref.current.signature !== signature) {
      ref.current = { signature, key: newKey() };
      writeStore(storageKey, ref.current);
    }
    return ref.current.key;
  }, [storageKey]);
  const reset = useCallback(() => { ref.current = null; writeStore(storageKey, null); }, [storageKey]);
  const current = useCallback(() => ref.current, []);
  return { keyFor, reset, current };
}
