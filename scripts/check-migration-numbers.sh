#!/usr/bin/env bash
# =============================================================================
# Guard: migration number prefixes in db/migrations must be unique.
#
# Why: two files sharing a numeric prefix (e.g. 0014_a.sql and 0014_b.sql)
# make apply order depend on the runner's sort and can desync dev/prod.
# Historic collisions were resolved by suffixing (0014a_...) — the prefix
# up to the first underscore is the identity this script checks.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

dupes=$(ls db/migrations/*.sql | xargs -n1 basename | sed 's/_.*//' | sort | uniq -d)

if [ -n "$dupes" ]; then
  echo "ERROR: duplicate migration number prefixes found:"
  echo "$dupes"
  echo "Rename the newer file to a free number (or suffix form like 0014a_)."
  exit 1
fi

echo "OK: all migration number prefixes are unique."
