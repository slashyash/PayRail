// Thin fetch wrapper for the PayRail API (backend/README.md).
// * Adds "Authorization: Bearer <token>" when logged in.
// * Every non-2xx answer becomes an ApiError carrying the backend's
//   { error: { code, message, sqlstate?, details? } } so pages can show it.
// * A network failure (backend down, connection lost) becomes status 0 /
//   code "network" — the request MAY or MAY NOT have reached the server,
//   which is exactly why money-creating POSTs carry an Idempotency-Key and a
//   retry must reuse it (see lib/idempotency.js).
// * JSON is parsed as-is: ids and paise stay decimal STRINGS (DEC-003).

let token = null;
let onUnauthenticated = () => {};

export function setToken(t) { token = t; }
export function setUnauthenticatedHandler(fn) { onUnauthenticated = fn; }

export class ApiError extends Error {
  constructor(status, code, message, { sqlstate, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.sqlstate = sqlstate;
    this.details = details;
  }
}

export async function request(method, path, { body, rawBody, contentType, query, idempotencyKey, signal } = {}) {
  let url = `/api${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (rawBody !== undefined) headers['Content-Type'] = contentType ?? 'text/plain';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let res;
  try {
    res = await fetch(url, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Could not reach the PayRail server. Check that the backend is running, then retry.');
  }

  let text;
  try { text = await res.text(); } catch { throw new ApiError(0, 'network', 'The response was interrupted. Check the current record before retrying.'); }
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const err = data?.error;
    // the Vite proxy answers 502/503/504 without a PayRail error body when the backend is down
    if (!err && [502, 503, 504].includes(res.status)) {
      throw new ApiError(res.status, 'network', 'Could not reach the PayRail server. Check that the backend is running, then retry.');
    }
    if (res.status === 401 && path !== '/auth/login') onUnauthenticated();
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`,
      { sqlstate: err?.sqlstate, details: err?.details });
  }
  if (res.status !== 204 && data === null) throw new ApiError(0, 'network', 'The server response could not be read. Check the current record before retrying.');
  return data;
}

export const api = {
  get: (path, query, opts) => request('GET', path, { query, ...opts }),
  post: (path, body, opts) => request('POST', path, { body, ...opts }),
  patch: (path, body, opts) => request('PATCH', path, { body, ...opts }),
  del: (path, opts) => request('DELETE', path, opts),
  /** POST a text body as-is (e.g. a settlement CSV with contentType 'text/csv') */
  postText: (path, text, contentType, opts) => request('POST', path, { rawBody: text, contentType, ...opts }),
};
