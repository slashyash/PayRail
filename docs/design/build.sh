#!/usr/bin/env bash
# Rebuild the design document: ER diagram + relational schema diagram (Graphviz) + HTML → PDF
# (Chromium via Playwright). schema.dot is generated from the live catalog; regenerate it after a
# schema change with:  python3 schema_diagram.py payrail > schema.dot   (admin libpq env set)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
dot -Tsvg er.dot -o er.svg
neato -n -Tsvg schema.dot -o schema.svg
node build.mjs
command -v pdfinfo >/dev/null && pdfinfo PayRail_Database_Design.pdf | grep Pages || true
