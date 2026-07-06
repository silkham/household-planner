#!/usr/bin/env bash
# Run the cashflow-engine unit tests.
# The engine is a browser ES module, so we strip `export ` and concatenate it
# with the import-free test file into one bundle, then run under whatever JS
# runtime exists: node if installed, else osascript (JavaScriptCore) on macOS.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE="$(mktemp -t hp-engine-tests-XXXXXX).js"
trap 'rm -f "$BUNDLE"' EXIT

# strip only leading `export ` (keeps arrow fns / const exports as globals)
sed -E 's/^export //' js/engine.js  > "$BUNDLE"
cat tests/engine.tests.js          >> "$BUNDLE"

if command -v node >/dev/null 2>&1; then
  echo "runtime: node"
  node "$BUNDLE"
elif command -v osascript >/dev/null 2>&1; then
  echo "runtime: osascript (JavaScriptCore)"
  osascript -l JavaScript "$BUNDLE"
else
  echo "no JS runtime found (need node or osascript)" >&2
  exit 127
fi
