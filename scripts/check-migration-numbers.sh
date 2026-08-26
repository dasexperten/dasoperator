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
  echo "ERROR: duplicate migration number prefixes found."
  echo
  # Name the files, not just the number. A bare "0066" sends the reader back to
  # ls to find out which two files collided and which of them is the newcomer;
  # this guard sat red for sixteen runs partly because its message asked for
  # work before it gave any help.
  for n in $dupes; do
    echo "  $n:"
    for f in db/migrations/"$n"_*.sql; do
      born=$(git log --format='%ad' --date=short --diff-filter=A -1 -- "$f" 2>/dev/null)
      echo "    $(basename "$f")  ${born:-uncommitted}"
    done
  done
  echo
  echo "Rename the NEWER file. Use a free number at the end of the sequence when the"
  echo "file was written after everything else; use the suffix form (0014a_) only when"
  echo "it genuinely belongs beside its neighbour in apply order."
  exit 1
fi

echo "OK: all migration number prefixes are unique."
