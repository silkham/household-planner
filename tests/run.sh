#!/usr/bin/env bash
# Run the pure-logic unit tests (cashflow engine + Emma recurring detection).
# These are browser ES modules, so we strip `import …` lines and leading
# `export ` and concatenate each module with its import-free test file into one
# bundle, then run under whatever JS runtime exists: node if installed, else
# osascript (JavaScriptCore) on macOS.
set -euo pipefail
cd "$(dirname "$0")/.."

run_bundle () {  # $1 = module, $2 = test file, $3 = label
  local bundle
  bundle="$(mktemp -t hp-tests-XXXXXX).js"
  # drop import lines (deps are unused by the pure tests) and leading `export `
  sed -E '/^import /d; s/^export //' "$1" > "$bundle"
  cat "$2" >> "$bundle"
  echo "── $3 ──"
  if command -v node >/dev/null 2>&1; then
    node "$bundle"
  elif command -v osascript >/dev/null 2>&1; then
    osascript -l JavaScript "$bundle"
  else
    echo "no JS runtime found (need node or osascript)" >&2
    rm -f "$bundle"; exit 127
  fi
  rm -f "$bundle"
}

if command -v node >/dev/null 2>&1; then echo "runtime: node"
elif command -v osascript >/dev/null 2>&1; then echo "runtime: osascript (JavaScriptCore)"; fi

run_bundle js/engine.js    tests/engine.tests.js    "cashflow engine"
run_bundle js/recurring.js tests/recurring.tests.js "recurring detection"
run_bundle js/reconcile.js tests/reconcile.tests.js "current-month reconciliation"
