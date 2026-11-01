#!/usr/bin/env bash
# Mounted into /docker-entrypoint-initdb.d/ by docker-compose.yml. The postgres
# image runs it ONCE, when the data volume is first initialised, against a
# temporary server on the local socket. It builds the schema into
# $POSTGRES_DB (which the image has just created, empty). Never destructive.
set -euo pipefail
export PGUSER="${POSTGRES_USER:-postgres}"
unset PGHOST PGPORT
bash /payrail/db/build.sh "${POSTGRES_DB:-payrail}"
if [[ -f /payrail/db/seed/seed.sql ]]; then
  psql -X -q -v ON_ERROR_STOP=1 -d "${POSTGRES_DB:-payrail}" -f /payrail/db/seed/seed.sql
fi
