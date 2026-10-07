#!/usr/bin/env bash
# Seeds the run workspace (cwd, empty) with a film project from the plugin's init script, installs its npm
# dependencies and Playwright's headless shell, and pins that browser in studio.json. Runs only with
# `claude plugin eval --scaffold`, as you, outside the agent sandbox (it has network; the agent's Bash sandbox does not).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
init="$root/skills/studio-init/scripts/init.mjs"
[ -f "$init" ] || { echo "render-smoke scaffold: $init not found" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "render-smoke scaffold: node is not on PATH" >&2; exit 1; }
if command -v cygpath >/dev/null 2>&1; then init="$(cygpath -m "$init")"; fi
node "$init" . >&2

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    # Native Windows has no Bash sandbox backend, so the run itself is refused; skip the ~200 MB of downloads.
    echo "render-smoke scaffold: Windows detected; this case needs Linux or macOS (Bash sandbox). Skipping installs." >&2
    exit 0 ;;
esac

npm install --no-audit --no-fund --loglevel=error >&2

# Browsers go inside the workspace: the run's HOME is a temp dir and the sandbox cannot read the real one.
# The browser is Playwright's headless shell, the default of the plugin's browser policy: the render runs on the same
# browser everywhere and no installed Chrome or Edge is involved. Playwright has no public executablePath() for the
# shell, so the file it installed is looked up in the workspace.
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers"
if ! node node_modules/playwright/cli.js install chromium-headless-shell >&2; then
  echo "render-smoke scaffold: playwright install chromium-headless-shell failed" >&2
fi
exe="$(find "$PWD/.pw-browsers" -type f -name chrome-headless-shell 2>/dev/null | head -n 1 || true)"
if [ -z "$exe" ] || [ ! -x "$exe" ]; then
  echo "render-smoke scaffold: no headless shell in $PWD/.pw-browsers (npx playwright install chromium-headless-shell needs network; on Linux it also needs the system libraries: npx playwright install-deps chromium-headless-shell)" >&2
  exit 1
fi

# studio.json "browser" accepts an absolute executable path (contract section 3); pin it so the render finds it.
node -e "
const fs=require('fs');const p='studio.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.browser=process.argv[1];fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');
" "$exe"
echo "render-smoke scaffold: browser pinned to $exe" >&2
