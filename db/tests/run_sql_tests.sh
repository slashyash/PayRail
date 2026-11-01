#!/usr/bin/env bash
# db/tests/run_sql_tests.sh — run the SQL test files against a throwaway
# database `payrail_test` (rebuilt from scratch before EVERY file).
#
#   usage: db/tests/run_sql_tests.sh [NN_name.sql ...]    (default: all files)
#
# Uses the same libpq variables as db/build.sh (administrator connection).
# Some tests log in as payrail_app; when PGPASSWORD is set, a temporary
# pgpass file supplies both the admin and the app password (APP_DB_PASSWORD).
#
# Each file prints lines "PASS <name>" / "FAIL <name> ...". The run fails if
# any FAIL is printed or psql exits non-zero (an unexpected error in setup).
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(dirname "$TEST_DIR")"
TEST_DB=payrail_test
export APP_DB_PASSWORD="${APP_DB_PASSWORD:-payrail_app_dev_only}"

if [[ -n "${PGPASSWORD:-}" ]]; then
  PASSFILE="$(mktemp)"
  trap 'rm -f "$PASSFILE"' EXIT
  printf '*:*:*:%s:%s\n*:*:*:payrail_app:%s\n' "${PGUSER:-postgres}" "$PGPASSWORD" "$APP_DB_PASSWORD" > "$PASSFILE"
  chmod 600 "$PASSFILE"
  export PGPASSFILE="$PASSFILE"
  unset PGPASSWORD
fi

if [[ $# -gt 0 ]]; then
  files=(); for a in "$@"; do files+=("$TEST_DIR/$(basename "$a")"); done
else
  files=("$TEST_DIR"/[0-9][0-9]_*.sql)
fi

total_pass=0; total_fail=0; broken=0
for f in "${files[@]}"; do
  name="$(basename "$f")"
  if ! PAYRAIL_SKIP_SEED=1 "$DB_DIR/reset_dev.sh" --yes "$TEST_DB" > /tmp/payrail_build.$$ 2>&1; then
    echo "BUILD FAILED before $name"; cat /tmp/payrail_build.$$; exit 1
  fi
  out="$(cd "$TEST_DIR" && psql -X -q -d "$TEST_DB" -v ON_ERROR_STOP=1 -f "$f" 2>&1)"; rc=$?
  p=$(grep -c '^PASS' <<<"$out"); fl=$(grep -c '^FAIL' <<<"$out")
  total_pass=$((total_pass + p)); total_fail=$((total_fail + fl))
  if [[ $rc -ne 0 || $fl -gt 0 ]]; then
    [[ $rc -ne 0 ]] && broken=$((broken + 1))
    echo "== $name: $p passed, $fl failed, psql exit $rc"
    grep '^FAIL' <<<"$out" | sed 's/^/   /'
    [[ $rc -ne 0 ]] && tail -n 5 <<<"$out" | sed 's/^/   | /'
  else
    echo "== $name: $p passed"
  fi
  [[ -n "${VERBOSE:-}" ]] && grep -E '^(PASS|FAIL)' <<<"$out" | sed 's/^/   /'
done
rm -f /tmp/payrail_build.$$

echo "TOTAL: $total_pass passed, $total_fail failed, $broken file(s) aborted"
[[ $total_fail -eq 0 && $broken -eq 0 ]]
