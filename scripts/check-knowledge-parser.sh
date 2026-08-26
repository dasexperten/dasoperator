#!/usr/bin/env bash
# =============================================================================
# Knowledge-graph parser check.
#
# The parser reads the organizacia corpus. Every entry the graph shows, every
# link it draws and every family filter it offers comes out of this one module,
# so a silent regression here is a graph that looks complete and is not — the
# exact failure the corpus rules exist to prevent.
#
# Transpiles the module on its own (the Worker bundle is built by wrangler at
# deploy time; this needs it as plain JS) and runs the tests against it.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/api"

if [ ! -d node_modules/typescript ]; then
  npm install --no-audit --no-fund --silent
fi

BUILD="$ROOT/api/.kg-build"
rm -rf "$BUILD"

npx tsc src/lib/kg-parse.ts \
  --target es2022 --module es2022 --moduleResolution bundler \
  --skipLibCheck --strict \
  --outDir "$BUILD"

node --test src/lib/kg-parse.test.mjs
status=$?

rm -rf "$BUILD"
exit $status
