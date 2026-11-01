#!/usr/bin/env bash
# db/build.sh — build the PayRail schema into an EMPTY database (non-destructive).
#
#   usage: db/build.sh [database]          (default: $PGDATABASE, else "payrail")
#
# Connects with the standard libpq variables (PGHOST, PGPORT, PGUSER,
# PGPASSWORD) as an ADMINISTRATOR (superuser, or a role that can create roles
# and databases and is a member of payrail_owner). Creates the database if it
# does not exist. Refuses to touch a database that already has the `payrail`
# schema — use db/reset_dev.sh --yes for a destructive rebuild.
#
# APP_DB_PASSWORD sets the payrail_app login password (default is a
# development-only placeholder; never use it outside your laptop).
#
# All schema files run in ONE transaction: a failure leaves nothing behind
# (except the empty database and the cluster roles, which are harmless).
set -euo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${1:-${PGDATABASE:-payrail}}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-payrail_app_dev_only}"

if [[ ! "$DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
  echo "build.sh: invalid database name '$DB'" >&2; exit 2
fi

PSQL=(psql -X -q -v ON_ERROR_STOP=1)

# 1. database (CREATE DATABASE cannot run inside a transaction)
exists=$("${PSQL[@]}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'")
if [[ "$exists" != "1" ]]; then
  echo "build.sh: creating database $DB"
  "${PSQL[@]}" -d postgres -c "CREATE DATABASE \"$DB\" ENCODING 'UTF8' TEMPLATE template0"
fi

# 2. refuse to rebuild over an existing schema
has_schema=$("${PSQL[@]}" -d "$DB" -tAc "SELECT 1 FROM pg_namespace WHERE nspname = 'payrail'")
if [[ "$has_schema" == "1" ]]; then
  echo "build.sh: database $DB already has the payrail schema; nothing done." >&2
  echo "          (destructive rebuild: db/reset_dev.sh --yes $DB)" >&2
  exit 1
fi

# 3. cluster roles (idempotent)
"${PSQL[@]}" -d "$DB" -v app_password="$APP_DB_PASSWORD" -f "$DB_DIR/schema/00_roles.sql"

# 4. schema files 01..99 in one transaction
files=()
for f in "$DB_DIR"/schema/[0-9][0-9]_*.sql; do
  [[ "$(basename "$f")" == 00_* ]] && continue
  files+=(-f "$f")
done
"${PSQL[@]}" -d "$DB" --single-transaction "${files[@]}"

echo "build.sh: schema built in database $DB ($(( ${#files[@]} / 2 )) files)"
