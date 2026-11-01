#!/usr/bin/env bash
# db/reset_dev.sh — DESTRUCTIVE: drop a development database and rebuild it.
#
#   usage: db/reset_dev.sh --yes [database]     (default: $PGDATABASE, else "payrail")
#
# Safety guards:
#   * does nothing without --yes;
#   * only accepts names "payrail" or "payrail_<suffix>" (e.g. payrail_test)
#     and never a name containing "prod";
#   * normal startup (docker compose up, db/build.sh) never calls this.
# After the rebuild it loads db/seed/seed.sql if that file exists (Task 2).
set -euo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" != "--yes" ]]; then
  echo "reset_dev.sh: this DROPS the database and all its data." >&2
  echo "              re-run as: db/reset_dev.sh --yes [database]" >&2
  exit 2
fi
DB="${2:-${PGDATABASE:-payrail}}"

if [[ ! "$DB" =~ ^payrail(_[a-z0-9_]+)?$ || "$DB" == *prod* ]]; then
  echo "reset_dev.sh: refusing to drop '$DB' (only payrail / payrail_<suffix>, never *prod*)" >&2
  exit 2
fi

echo "reset_dev.sh: dropping database $DB"
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)"

"$DB_DIR/build.sh" "$DB"

if [[ -f "$DB_DIR/seed/seed.sql" && "${PAYRAIL_SKIP_SEED:-0}" != "1" ]]; then
  echo "reset_dev.sh: seeding $DB"
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$DB_DIR/seed/seed.sql"
fi
echo "reset_dev.sh: done"
