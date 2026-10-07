#!/usr/bin/env bash
# Seeds the run workspace (cwd, empty) with a film project that already has one review round logged and a fresh
# contact sheet to critique. Runs only with `claude plugin eval --scaffold`, as you, outside the agent sandbox.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fx="$here/fixtures"
for f in studio.json review_log.md contact.png; do
  [ -f "$fx/$f" ] || { echo "critique-writes-log scaffold: missing fixture $fx/$f" >&2; exit 1; }
done
mkdir -p docs out/review/9x16
cp "$fx/studio.json" studio.json
cp "$fx/review_log.md" docs/review_log.md
cp "$fx/contact.png" out/review/9x16/contact.png
