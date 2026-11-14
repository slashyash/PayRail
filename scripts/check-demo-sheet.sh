#!/usr/bin/env bash
# scripts/check-demo-sheet.sh — verify that every "file:line" on the Demo Sheet
# (docs/submission/PayRail_Demo_Sheet.pdf) still points at the object it names.
# Run it after any change to db/schema and before tagging the final commit.
# Exit 0 = all references correct.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../db/schema"

fail=0
check() {   # check <file> <line> <text expected on that line>
  local got; got="$(sed -n "${2}p" "$1")"
  if [[ "$got" == *"$3"* ]]; then printf '  ok    %-28s %4s  %s\n' "$1" "$2" "$3"
  else printf '  FAIL  %-28s %4s  expected "%s", found: %s\n' "$1" "$2" "$3" "$got"; fail=1; fi
}

echo "B. SQL queries"
check 32_reports.sql 32  "FUNCTION fn_report_trial_balance"
check 32_reports.sql 80  "FUNCTION fn_report_vendor_statement"
check 30_views.sql   85  "VIEW v_vendor_statement"
check 32_reports.sql 143 "FUNCTION fn_report_monthly_performance"
check 32_reports.sql 211 "FUNCTION fn_report_vendor_refund_risk"
check 32_reports.sql 281 "FUNCTION fn_report_settlement_aging"
check 24_wf_settlements.sql 123 "FUNCTION fn_reconciliation_report"
check 32_reports.sql 324 "FUNCTION fn_report_vendor_payables"
echo "C. DBMS features"
check 23_wf_payouts.sql 21 "FUNCTION fn_request_payout"
check 20_wf_common.sql  55 "FUNCTION fn_lock_vendor_accounts"
check 03_ledger.sql 97  "CONSTRAINT TRIGGER trg_journal_entries_balanced"
check 03_ledger.sql 102 "CONSTRAINT TRIGGER trg_ledger_lines_balanced"
check 03_ledger.sql 116 "TRIGGER trg_journal_entries_no_update_delete"
check 03_ledger.sql 125 "TRIGGER trg_ledger_lines_no_truncate"
check 03_ledger.sql 46  "TRIGGER trg_ledger_lines_sealed"
check 30_views.sql 10 "VIEW v_account_balances"
check 30_views.sql 58 "VIEW v_order_summary"
check 31_indexes.sql 13 "INDEX ledger_lines_account_entry_idx"
check 02_tables.sql 87 "UNIQUE INDEX payments_one_capture_per_order"
check 21_wf_orders_payments.sql 38 "FUNCTION fn_place_order"
check 21_wf_orders_payments.sql 139 "FUNCTION fn_capture_payment"
check 99_privileges.sql 26 "GRANT EXECUTE ON FUNCTION"

[[ $fail -eq 0 ]] && echo "all Demo Sheet references are correct" || echo "update the Demo Sheet (docs/submission/) for the FAIL lines"
exit $fail
