#!/usr/bin/env bash
# scripts/test-all.sh — run every automated check, in dependency order, and
# print one summary line per suite. Uses only the dedicated test databases
# (payrail_test, payrail_apitest, payrail_conc, payrail_e2e); the demo database
# "payrail" is never touched.
#
#   usage: scripts/test-all.sh [--no-e2e]
#
# Docker machines (no local psql): the script detects a running compose db and
# sets PAYRAIL_REBUILD_VIA_DOCKER=1 for the Node suites itself.
# Prerequisites: .env filled in; (cd backend && npm ci); (cd frontend && npm ci);
# for e2e once: (cd frontend && npx playwright install chromium).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
E2E=1; [[ "${1:-}" == "--no-e2e" ]] && E2E=0

docker_db=0
if command -v docker >/dev/null 2>&1 && [[ -n "$(docker compose ps --status running -q db 2>/dev/null)" ]]; then
  docker_db=1
  export PAYRAIL_REBUILD_VIA_DOCKER=1
fi

# each suite's full output is kept in test-logs/<suite>.log (git-ignored)
LOGDIR="$ROOT/test-logs"
mkdir -p "$LOGDIR"
declare -a SUMMARY
fail=0
run() {   # run <label> <command…>
  local label="$1"; shift
  echo; echo "=== $label: $*"
  local log="$LOGDIR/$(echo "$label" | tr ' ' '-').log"
  if "$@" 2>&1 | tee "$log"; then
    SUMMARY+=("PASS  $label  $(grep -Eo 'TOTAL: .*|# pass [0-9]+|[0-9]+ passed( \([^)]*\))?|built in [0-9.]+m?s' "$log" | tail -1)")
  else
    local hint="see test-logs/$(basename "$log")"
    if grep -q "Executable doesn't exist" "$log"; then
      hint="Chromium for Playwright is not installed: (cd frontend && npx playwright install chromium)"
    elif grep -qE "ECONNREFUSED" "$log"; then
      hint="database not reachable: docker compose up -d db (see test-logs/$(basename "$log"))"
    elif grep -q 'password authentication failed for user "postgres"' "$log"; then
      hint="admin password in .env differs from the Docker volume: cd backend && npm run doctor (prints the fix)"
    elif grep -qE "28P01|password authentication failed" "$log"; then
      hint="payrail_app password mismatch: cd backend && npm run doctor (see test-logs/$(basename "$log"))"
    fi
    SUMMARY+=("FAIL  $label  ($hint)"); fail=1
  fi
}

if [[ $docker_db -eq 1 ]]; then
  run "SQL tests" docker compose exec -T db bash /payrail/db/tests/run_sql_tests.sh
else
  run "SQL tests" db/tests/run_sql_tests.sh
fi
run "API tests"          bash -c 'cd backend && npm run -s test:api'
run "concurrency tests"  bash -c 'cd backend && npm run -s test:concurrency'
run "frontend unit"      bash -c 'cd frontend && npm test --silent'
run "frontend build"     bash -c 'cd frontend && npm run -s build'
if [[ $E2E -eq 1 ]]; then
  run "browser e2e"      bash -c 'cd frontend && npm run -s test:e2e'
fi

echo; echo "=== summary (full logs: test-logs/)"
printf '%s\n' "${SUMMARY[@]}"
exit $fail
