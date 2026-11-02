# Sample settlement reports (W4)

Simulated gateway settlement CSVs for the finance **Settlements** screen (`/finance/settlements`) or
`POST /api/finance/settlements/import` with `Content-Type: text/csv`.

Format (header exact, no quoting, ≤ 1000 rows, ≤ 256 KB): `gateway_ref,record_type,gross_paise,fee_paise,settled_on`
— amounts are integer paise, `settled_on` is an IST date that may not be in the future, refund rows carry fee 0.

The references belong to the **deterministic seed** (DEC-030), so the files behave as described only on a freshly
seeded database (`db/reset_dev.sh --yes payrail`, or a new Docker volume). Import them in this order; reconcile with the
demo as-of date **2026-10-31**.

| File | Rows | Result on a fresh seed (observed, T5-04) |
|---|---|---|
| `01_normal.csv` | 3 payments + 1 refund that exactly match: two in transit (30 Oct), one long overdue (`pay_S000000018`, 3 Sep), refund `rfnd_R000000044` | 4 `inserted`, 4 posted (D BANK + D GATEWAY_FEE_EXPENSE / C GATEWAY_CLEARING; refund rows D GATEWAY_CLEARING / C BANK). Importing it **again** → 4 `duplicate`, 0 posted |
| `02_reupload_duplicate_conflict.csv` | `pay_S000000365` identical again, `pay_S000000366` with a different fee, `pay_S000000368` new | 1 `duplicate`, 1 `conflict` (the original row is kept), 1 `inserted` + posted |
| `03_exceptions.csv` | amount mismatch (₹100 short), unknown reference, a payment reported as a refund, fee = gross, a 2099 date, a decimal amount, 30 Feb, an unknown record type, a short row | 3 `inserted` but **not posted** (reconciliation: `amount_mismatch`, `unknown_reference`, `amount_mismatch` "reported as refund"); 2 `rejected` by the database (`23514` fee < gross CHECK, `PRV07` future date); 4 `invalid` before reaching the database |

After all three: Reconciliation as of 2026-10-31 shows all five categories — matched, amount mismatch, unknown
reference, in transit, overdue/missing — and the trial balance still balances.

**Revisit an unknown reference:** a row for a payment whose success callback has not arrived yet is stored as
`unknown_reference`. Once the payment is captured, **Run reconciliation** (with an as-of date on or after the row's
`settled_on`) posts it exactly once ("newly posted now" = 1; a second run posts nothing). The browser test
`frontend/e2e/vendor-finance.spec.js` does this with a fresh order.
