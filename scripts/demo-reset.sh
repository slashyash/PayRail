#!/usr/bin/env bash
# scripts/demo-reset.sh — put the DEMO database back into its known seeded state.
#
#   usage: scripts/demo-reset.sh --yes            (DESTRUCTIVE for database "payrail" only)
#          scripts/demo-reset.sh --yes --local    (force the local-psql path)
#
# What it does
#   1. drops and rebuilds database "payrail" via db/reset_dev.sh (its own guards
#      still apply), loads the deterministic seed (fixed clock, md5-keyed choices,
#      DEC-015/DEC-030), and re-sets the payrail_app password from .env, which
#      also repairs a password that drifted from the Docker volume;
#   2. prints the seed's row counts and trial balance;
#   3. runs the read-only startup check (backend: npm run doctor) if the backend
#      dependencies are installed.
# The running backend does not need a restart: the pool reconnects on the next
# request (the drop terminates its old connections). Log in again in the browser.
#
# Path selection: if `docker compose` has the db service running, the reset runs
# inside that container (no local psql needed); otherwise it uses local psql with
# PGHOST/PGPORT/PGUSER/PGPASSWORD (defaults derived from .env like the tests).
# It never touches the Docker volume itself and never runs on startup.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

YES=0; LOCAL=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --local) LOCAL=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
if [[ $YES -ne 1 ]]; then
  echo "demo-reset.sh: this DROPS database 'payrail' and reloads the demo data." >&2
  echo "               every change made since the last reset is lost." >&2
  echo "               re-run as: scripts/demo-reset.sh --yes" >&2
  exit 2
fi
if [[ ! -f .env ]]; then
  echo "demo-reset.sh: .env not found — cp .env.example .env and fill it in first" >&2
  exit 1
fi

# read .env without executing it (values may contain shell characters)
envval() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
APP_DB_PASSWORD="${APP_DB_PASSWORD:-$(envval APP_DB_PASSWORD)}"
if [[ -z "$APP_DB_PASSWORD" ]]; then
  echo "demo-reset.sh: set APP_DB_PASSWORD in .env first" >&2
  exit 1
fi
if [[ "$APP_DB_PASSWORD" == CHANGE* ]]; then
  echo "demo-reset.sh: note: APP_DB_PASSWORD is still the example placeholder (works locally, weak)"
fi
export APP_DB_PASSWORD

start=$(date +%s)
use_docker=0
if [[ $LOCAL -eq 0 ]] && command -v docker >/dev/null 2>&1 \
   && [[ -n "$(docker compose ps --status running -q db 2>/dev/null)" ]]; then
  use_docker=1
fi

if [[ $use_docker -eq 1 ]]; then
  echo "demo-reset.sh: Docker path (compose service db)"
  # -e NAME without a value passes the variable from this shell, so the
  # password never appears in the process list
  docker compose exec -T -e APP_DB_PASSWORD db bash /payrail/db/reset_dev.sh --yes payrail
else
  echo "demo-reset.sh: local path (psql)"
  command -v psql >/dev/null 2>&1 || { echo "demo-reset.sh: no running compose db and no local psql — start Docker: docker compose up -d db" >&2; exit 1; }
  export PGHOST="${PGHOST:-localhost}"
  export PGPORT="${PGPORT:-$(envval PGPORT)}"
  export PGUSER="${PGUSER:-$(envval POSTGRES_USER)}"
  export PGPASSWORD="${PGPASSWORD:-$(envval POSTGRES_PASSWORD)}"
  db/reset_dev.sh --yes payrail
fi

echo "demo-reset.sh: database 'payrail' reset in $(( $(date +%s) - start )) s"

if [[ -d backend/node_modules ]]; then
  echo
  (cd backend && node src/doctor.js) || {
    echo "demo-reset.sh: the startup check reported a problem (see above)" >&2; exit 1; }
else
  echo "demo-reset.sh: (cd backend && npm ci) to enable the startup check"
fi
echo
echo "Demo accounts (password PayRail@2026): customer1@payrail.demo, vendor1@payrail.demo, finance@payrail.demo"
echo "Reconciliation as-of date: 2026-10-31 (PAYRAIL_DEMO_AS_OF). Log in again in the browser."
