# PayRail backend (Task 3)

Express 5 API over the PostgreSQL stored workflows. Node 22, `pg`, Zod 4, `jsonwebtoken`, `bcryptjs`. No ORM:
every financial action is **one call to a `SECURITY DEFINER` workflow function** (`db/schema/21–24`), and the
database is the authority on business rules; the API authenticates, validates input shape, passes the actor id
**from the token**, and maps the database's verdict (SQLSTATE) to HTTP.

## Run
```bash
cp .env.example .env            # repo root; set every CHANGE value (APP_DB_PASSWORD = password in DATABASE_URL)
docker compose up -d db         # database (seeded on first start)
cd backend && npm ci
npm start                       # http://127.0.0.1:4000  (npm run dev restarts on changes)
```
Demo logins (password `PayRail@2026`): `customer1…60@payrail.demo`, `vendor1…12@payrail.demo`, `finance@payrail.demo`.

## Tests
```bash
# test/_env.js loads the root .env: PGUSER/PGPASSWORD default to POSTGRES_USER/POSTGRES_PASSWORD; rebuilds payrail_apitest per file
npm run test:api
PAYRAIL_REBUILD_VIA_DOCKER=1 npm run test:api     # no local psql: rebuild inside the compose container
npm run test:concurrency                          # Task 2 multi-connection database tests
PAYRAIL_REBUILD_VIA_DOCKER=1 npm run test:concurrency
```

## Conventions (DEC-003, DEC-034)
- BIGINT ids and paise amounts are **decimal strings** both ways (`"125050"` = ₹1,250.50). Small integers (quantity, line_no, page) are numbers.
- `Authorization: Bearer <jwt>` from `POST /api/auth/login`. No sign-up route: roles exist only in the database.
- Money-creating POSTs need `Idempotency-Key: <uuid>`. Same key + same body → the original result (201 again); same key + different body → `409 idempotency_conflict`. Generate a new key per new logical action; reuse it when retrying.
- Errors: `{ "error": { "code", "message", "sqlstate"?, "details"? } }`. Lists: `{ items, page, page_size, total }` (`?page=&page_size=`, max 100).
- Reads are scoped to the caller (someone else's order → 404). Workflow refusals come from the database (`PRA01` → 403).

| SQLSTATE | HTTP | code |
|---|---|---|
| PRA01 | 403 | forbidden |
| PRN01 | 404 | not_found |
| PRV03 / PRV04 | 422 | vendor_not_verified / product_inactive |
| PRV07, 23514, 22P02 | 422 | invalid_input |
| PRR02 | 422 | refund_below_minimum |
| PRI01 | 409 | idempotency_conflict |
| PRS01 / PRS02 | 409 | invalid_transition / already_paid |
| PRO01 / PRO02 | 409 | order_frozen / order_not_paid |
| PRP01 | 409 | amount_mismatch |
| PRR01 | 409 | refund_exceeds_refundable |
| PRF01 | 409 | insufficient_funds |
| PRV06 / 23505 / 23503 | 409 | immutable / duplicate / referenced |
| anything else (incl. PRL0x, PRX01, 42501) | 500 | internal (logged, not echoed) |

## Endpoints
| Method & path | Role | Calls |
|---|---|---|
| `POST /api/auth/login`, `GET /api/auth/me` | — / any | `users` (bcrypt) |
| `GET /api/products?q&vendor_id&min_price_paise&max_price_paise&sort`, `GET /api/products/:id`, `GET /api/vendors` | any | active products of verified vendors |
| `POST /api/orders` `{items:[{product_id,quantity}]}` | customer | `fn_place_order` |
| `GET /api/orders?status`, `GET /api/orders/:id` | customer | `v_order_summary`, `v_order_line_allocation` |
| `POST /api/orders/:id/payments` `{method}` + key | customer | `fn_initiate_payment` |
| `GET /api/mock-gateway/checkout/:id`, `POST /api/mock-gateway/checkout/:id` `{action:'pay', instrument}` \| `{action:'cancel'}` | customer (owner) | hosted checkout: the gateway decides the outcome from a TEST instrument and sends one signed callback (DEC-038) |
| `POST /api/mock-gateway/payments/:id/simulate` `{outcome, amount_paise?, deliveries?}` | finance_admin | fault injection: signs and delivers callbacks (DEC-038) |
| `POST /api/gateway/callback` (HMAC headers) | gateway | `fn_capture_payment` / `fn_fail_payment` |
| `POST /api/orders/:id/refunds` `{line_no, amount_paise, reason}` + key, `GET /api/refunds` | customer | `fn_request_refund` |
| `GET /api/vendor/me`, `/statement?from&to`, `/sales`, `/payouts` | vendor_admin | `fn_vendor_balance`, `v_vendor_statement` |
| `GET/POST /api/vendor/products`, `PATCH/DELETE /api/vendor/products/:id` | vendor_admin | `products` (only table the app writes) |
| `POST /api/vendor/payouts` `{amount_paise}` + key | vendor_admin | `fn_request_payout` |
| `GET /api/finance/refunds?status&vendor_id`, `POST …/:id/approve`, `POST …/:id/reject` | finance_admin | `fn_approve_refund`, `fn_reject_refund` |
| `GET /api/finance/payouts`, `POST /api/finance/payouts/:id/complete` `{outcome, bank_utr?}` | finance_admin | `fn_complete_payout` |
| `POST /api/finance/settlements/import` (text/csv or `{rows}`), `GET /api/finance/settlements` | finance_admin | `fn_record_settlement` (one transaction, SAVEPOINT per row) |
| `POST /api/finance/reconcile` `{as_of?}`, `GET /api/finance/reconciliation?as_of&category&gateway_ref` | finance_admin | `fn_reconcile`, `fn_reconciliation_report` |
| `GET /api/finance/trial-balance`, `/vendors`, `/journal-entries?…`, `/orders/:id`, `/payments?status&order_id` | finance_admin | `v_account_balances`, ledger, payments |

## Mock gateway (DEC-033, DEC-038)
**Customer path (hosted checkout).** The shop redirects the customer to the gateway's page; the customer pays with a
published test instrument and the **gateway** decides: UPI `success@payrail` / `failure@payrail`, card
`4111 1111 1111 1111` (approved) / `4000 0000 0000 0002` (declined) with any `MM/YY` and 3-digit CVV, net banking
`PAYRAIL_TEST_BANK` / `PAYRAIL_FAIL_BANK`; `cancel` = failure. Any other instrument → 422 (no real payment details are
accepted, stored or logged). The amount is the attempt's amount — the customer cannot send one or choose the outcome.

**Finance path (fault injection).** The simulator builds the event the gateway would send (`pay_S<id>` / `pay_F<id>`, stable per payment and outcome),
signs it with `GATEWAY_WEBHOOK_SECRET` (`X-PayRail-Timestamp`, `X-PayRail-Signature: v1=HMAC-SHA256(ts.body)`, ±5 min)
and delivers it through the **same** handler as `POST /api/gateway/callback`. Controls: `outcome` success/failure,
`amount_paise` (wrong amount → 409 `amount_mismatch`, nothing changes), `deliveries` 1–3 (duplicates are harmless).

## Layout
`src/config.js` env · `src/db.js` pool (as `payrail_app`, int8/date kept as strings, `withTransaction` on one client) ·
`src/errors.js` SQLSTATE mapping · `src/validate.js` Zod helpers · `src/auth.js` login/JWT/guards ·
`src/gateway.js` HMAC + simulator · `src/settlementCsv.js` bounded CSV parser · `src/routes/*` · `test/api/*` · `test/concurrency/*`.
