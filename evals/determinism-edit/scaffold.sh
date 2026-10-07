#!/usr/bin/env bash
# Seeds the run workspace (cwd, empty) with a fresh film project made by the plugin's own init script, the same
# thing /motion-studio:studio-init produces. Runs only with `claude plugin eval --scaffold`, as you, outside the
# agent sandbox. No npm install: the case only edits film/film.js.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
init="$root/skills/studio-init/scripts/init.mjs"
[ -f "$init" ] || { echo "determinism-edit scaffold: $init not found" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "determinism-edit scaffold: node is not on PATH" >&2; exit 1; }
# Git Bash on Windows: hand node a native path explicitly instead of relying on MSYS argument conversion.
if command -v cygpath >/dev/null 2>&1; then init="$(cygpath -m "$init")"; fi
node "$init" . >&2
for f in studio.json film/film.js lib/rng.js; do
  [ -f "$f" ] || { echo "determinism-edit scaffold: init did not create $f" >&2; exit 1; }
done
