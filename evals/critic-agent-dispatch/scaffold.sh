#!/usr/bin/env bash
# Seeds the run workspace (cwd, empty) with a small film project: one review round already logged and fresh stills to
# review. The fixtures are critique-writes-log's (one contact sheet, one generator, one pixel check in the self-test).
# The empty film/ dir makes the folder a studio project for the plugin hooks, so the critic's write goes through
# role-guard's motion-critic lane. Runs only with `claude plugin eval --scaffold`, as you, outside the agent sandbox.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fx="$here/../critique-writes-log/fixtures"
for f in studio.json review_log.md contact.png; do
  [ -f "$fx/$f" ] || { echo "critic-agent-dispatch scaffold: missing fixture $fx/$f" >&2; exit 1; }
done
mkdir -p docs film out/review/9x16
cp "$fx/studio.json" studio.json
cp "$fx/review_log.md" docs/review_log.md
cp "$fx/contact.png" out/review/9x16/contact.png
