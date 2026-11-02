// Uniform error format (Task 3):
//   { "error": { "code": "<stable name>", "message": "...", "sqlstate"?: "PRxxx", "details"?: [...] } }
//
// Database errors are translated by SQLSTATE (db/README.md lists the PayRail
// codes). The database is the authority on business rules; the API only maps
// its verdict to an HTTP status. Unexpected errors become a generic 500 and
// their text is logged, not sent.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what) => new ApiError(404, 'not_found', `${what} not found`);

// SQLSTATE → [HTTP status, stable error code]
const SQLSTATE_MAP = {
  PRA01: [403, 'forbidden'],
  PRN01: [404, 'not_found'],
  PRV01: [422, 'rule_violation'],
  PRV02: [422, 'rule_violation'],
  PRV03: [422, 'vendor_not_verified'],
  PRV04: [422, 'product_inactive'],
  PRV05: [422, 'rule_violation'],
  PRV06: [409, 'immutable'],
  PRV07: [422, 'invalid_input'],
  PRI01: [409, 'idempotency_conflict'],
  PRS01: [409, 'invalid_transition'],
  PRS02: [409, 'already_paid'],
  PRO01: [409, 'order_frozen'],
  PRO02: [409, 'order_not_paid'],
  PRP01: [409, 'amount_mismatch'],
  PRR01: [409, 'refund_exceeds_refundable'],
  PRR02: [422, 'refund_below_minimum'],
  PRF01: [409, 'insufficient_funds'],
  23505: [409, 'duplicate'],
  23503: [409, 'referenced'],
  23514: [422, 'invalid_input'],
  '22P02': [422, 'invalid_input'],
  22003: [422, 'invalid_input'],
  22007: [422, 'invalid_input'],
  22008: [422, 'invalid_input'],
};
// Never expected through the API: a ledger invariant (PRL0x), wrong isolation
// level (PRX01) or a missing privilege (42501) is a server bug → 500.

export function fromDbError(e) {
  const hit = e && typeof e.code === 'string' && SQLSTATE_MAP[e.code];
  if (!hit) return null;
  let message = e.message;
  if (e.code === '23503') message = 'the record is referenced by financial history and cannot be removed';
  if (e.code === '23505') message = 'a record with these values already exists';
  const err = new ApiError(hit[0], hit[1], message);
  err.sqlstate = e.code;
  return err;
}

export function errorMiddleware(logErrors) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let api = err instanceof ApiError ? err : fromDbError(err);
    if (!api) {
      if (err?.type === 'entity.parse.failed') api = new ApiError(400, 'bad_json', 'request body is not valid JSON');
      else if (err?.type === 'entity.too.large') api = new ApiError(413, 'too_large', 'request body is too large');
      else {
        if (logErrors) console.error(`[${req.method} ${req.originalUrl}]`, err?.code ?? '', err?.message ?? err);
        api = new ApiError(500, 'internal', 'internal server error');
      }
    }
    const body = { error: { code: api.code, message: api.message } };
    if (api.sqlstate) body.error.sqlstate = api.sqlstate;
    if (api.details) body.error.details = api.details;
    res.status(api.status).json(body);
  };
}
