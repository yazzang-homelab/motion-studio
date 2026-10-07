# Setup troubleshooting

Start with `npm run doctor` (add `--json` for a machine-readable table). It never prints key
values, only whether `.env` keys are present. Fix rows top to bottom: later checks depend on
earlier ones.

## Node

| Symptom | Fix |
|---|---|
| doctor: node < 20 | install Node 20 LTS or newer (nodejs.org, `winget install OpenJS.NodeJS.LTS`, `brew install node`, or nvm) |
| `npx skills` or `hyperframes` fails with an `engines`/`styleText` error | those need Node 22+ (route B only); route A works on Node 20 |
| `spawn EINVAL` when a tool runs npm on Windows | a `.cmd` shim was spawned without a shell; use the npm scripts or report it to `motion-studio:render-engineer` |

## Playwright and the browser

| Symptom | Fix |
|---|---|
| `playwright` not importable | `npm install` in the project (not in the plugin folder) |
| no browser found, or on Windows `could not launch a browser: no safe browser found.` | run `npx playwright install chromium-headless-shell` (`npm run setup:browser`; about 115 MB). On macOS and Linux an installed Google Chrome or Microsoft Edge works too. On Windows `auto` never starts an installed Chrome or Edge (see "Windows account gets locked out" below) |
| a specific browser is required | set `studio.json` `browser` to `chrome`, `msedge`, `chromium` or an absolute executable path; `MOTION_BROWSER` (`auto`, `chrome`, `msedge`, `chromium`) overrides `studio.json`, and `MOTION_CHROME_PATH` (a path) overrides both. On Windows `chrome`, `msedge` and a `chrome.exe` or `msedge.exe` path are a guarded opt-in: a warning line per launch, and the 4th launch in 10 minutes is refused (3 pass). `MOTION_BROWSER=auto` goes back to the safe default |
| `refusing to start chrome: N launches of an installed Chrome/Edge in the last 10 minutes ...` (Windows) | the launch guard, which only applies to an installed browser you chose. Wait the time the message names, or switch: `npx playwright install chromium-headless-shell`, remove `browser` from `studio.json`, unset `MOTION_BROWSER` and `MOTION_CHROME_PATH`. `MOTION_SYSTEM_BROWSER_MAX` (1 to 9, default 4, counting the launch being started) sets the limit, `MOTION_ALLOW_LOCKOUT_RISK=1` starts anyway (still logged and warned), `MOTION_LAUNCH_LOG` moves the log (default `%LOCALAPPDATA%\motion-studio\system-browser-launches.json`) |
| doctor shows `WARN browser ... chrome` (Windows) | an installed Chrome or Edge was chosen. Every launch with a fresh profile counts as a failed logon. Fix: the same three steps as for the guard message. The info row `windows-logon-guard` shows how many launches the guard has logged in the last 10 minutes |
| `note: the browser did not close within N s; killed it` (a tool takes long to exit on Windows) | the installed Chrome's profile cleanup can take many seconds (measured; not re-measured with the headless shell); every tool bounds each browser and context close and kills the browser by pid. The output is already written, so ignore the note. `MOTION_CLOSE_TIMEOUT_MS` (default 8000) changes the wait |
| `film failed to load (<url>): ...` | the message names the first cause: `__studio.ready rejected: <cause>` (with `(__studio.error: ...)` when the page holds another line), `__studio.ready did not resolve within N s`, `the page threw while booting: <error>` (an import or syntax error before `boot()` finished) or `window.__studio was never created within 15 s`, followed by up to 6 `pageerror:` / `console:` lines. A 404 for `audio/beats.json`, `assets/fonts/fonts.json` or `favicon.ico` is normal and ignored |
| Linux CI: sandbox errors | the render tools' launcher (`tools/studio-web.mjs`, for your own trusted film pages) adds `--no-sandbox` on Linux and Playwright leaves Chrome's sandbox off on every OS there; install the OS libraries with `npx playwright install-deps chromium-headless-shell`. The product-reel `capture.mjs` (third-party pages) is different: it keeps the sandbox ON on every OS and needs `--no-sandbox` or `MOTION_NO_SANDBOX=1` only as root or in a container |
| frames differ between machines | expected across GPU/OS/browser versions; compare hashes on one machine. The canvas uses the CPU rasterizer (`willReadFrequently`, accelerated 2D canvas disabled) so one machine is repeatable. Switching between an installed Chrome and the bundled headless shell is a different browser build too: re-render before comparing |

## Windows account gets locked out while rendering or testing

Symptoms:

- Windows locks the account (10 minutes on the measured laptop) or refuses the password while only renders, critiques, `doctor` or
  tests ran.
- The Security log holds many events 4625 (failed logon) written by `chrome.exe` or `msedge.exe` (logon type 2, package Negotiate,
  SubStatus `0xc000006a` = wrong password) and events 4740 (account locked out).

Mechanism. Every launch of an installed Chrome or Edge with a fresh user-data-dir makes the browser test the Windows account for a
blank password, and Playwright creates a new temporary profile for every launch. The test fails, is written to the Security log as a
failed logon and counts toward the lockout threshold (10 failed logons in 10 minutes lock the account for 10 minutes on the measured
laptop).

Measured on that laptop:

| Observation | Result |
|---|---|
| Events 4625 in 24 h | 464 from `chrome.exe`, 2 from `msedge.exe` |
| Events 4740 (lockouts) | 45 since the previous afternoon |
| Playwright's `chrome-headless-shell`, 3 launches | 0 failed logons |
| Installed Google Chrome, fresh profile, 1 launch | +1 failed logon |
| Installed Chrome, one persistent profile directory, 2 launches | +1 on the first launch, 0 on the second |

Confirm it in PowerShell (an elevated session, or an account in Event Log Readers):

```powershell
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625; StartTime=(Get-Date).AddHours(-1)} | Group-Object {([xml]$_.ToXml()).Event.EventData.Data | Where-Object Name -eq 'ProcessName' | ForEach-Object '#text'}
```

A `chrome.exe` (or `msedge.exe`) group whose count matches your recent launches is the cause. The SubStatus as well:

```powershell
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625; StartTime=(Get-Date).AddHours(-1)} | ForEach-Object { $d = @{}; ([xml]$_.ToXml()).Event.EventData.Data | ForEach-Object { $d[$_.Name] = $_.'#text' }; [pscustomobject]@{ Process = Split-Path $d.ProcessName -Leaf; SubStatus = $d.SubStatus } } | Group-Object Process, SubStatus
```

`chrome.exe, 0xc000006a` is the blank-password test. Count launches of your own runs the same way before and after a command; the
expected count for the plugin's default browser is 0.

Fix.

1. Use the bundled headless shell: `npx playwright install chromium-headless-shell` (`npm run setup:browser`). It is the
   default on Windows (`browser: "auto"`) and does not run the blank-password test (measured: 3 launches, 0 failed logons).
2. Remove `browser: "chrome"` or `"msedge"` from `studio.json`, and unset `MOTION_BROWSER` and `MOTION_CHROME_PATH` when they point
   at an installed browser (`MOTION_BROWSER=auto` also works for one session).
3. `npm run doctor`: the `browser` row reads `OK ... chromium-headless-shell`, and the info row `windows-logon-guard` shows 0
   launches in the last 10 minutes once nothing else starts an installed browser.
4. Your own scripts: start the browser with `launchBrowser` from `tools/studio.mjs`, never with `channel: 'chrome'` or
   `'msedge'`, and never with a path to `chrome.exe` or `msedge.exe`.

Do not fix it by turning the lockout policy off. `net accounts /lockoutthreshold:0` removes the protection against password
guessing for every account on the machine: NOT recommended.

A persistent profile also avoids the repeats: an installed Chrome with one persistent profile directory failed on its first launch
only (measured above). The plugin does not do this: every tool starts a fresh profile, so an installed browser stays guarded
(a warning per launch; the 4th launch in 10 minutes is refused, 3 pass).

Side effect of the headless shell. It is unsigned, so on a machine with real-time antivirus each browser process takes 4 to 5 s to
start (AhnLab V3 on the measured laptop): launch about 3.5 s, first page about 11 s, 15 to 25 s per tool run, against 2.4 s for the
signed installed Chrome. An antivirus exclusion for `%LOCALAPPDATA%\ms-playwright` removes the delay. Whether to ask for one is the
user's or IT's decision; the plugin does not change antivirus settings. Flags such as `--disable-gpu`, `--in-process-gpu` or
`--no-sandbox` did not help meaningfully (measured).

## ffmpeg

| Symptom | Fix |
|---|---|
| doctor: ffmpeg missing | `npm install ffmpeg-static` (downloads a binary from GitHub), or install ffmpeg (`winget install Gyan.FFmpeg`, `brew install ffmpeg`, `apt install ffmpeg`) |
| ffmpeg-static download blocked (proxy, offline) | install ffmpeg by other means and set `FFMPEG_PATH` to the executable |
| missing filters (loudnorm, ebur128, alimiter, sidechaincompress, amix, tmix, scale) | use a full build (ffmpeg-static or the distribution build), not a minimal one |
| license question | ffmpeg-static ships a GPL build; the plugin only calls it as a separate program |

## Python (optional)

| Symptom | Fix |
|---|---|
| doctor: librosa absent | fine: `beats.mjs` falls back to its JS engine (it searches 70 to 180 BPM without `--bpm-hint`). For librosa: Python 3.12+, `python -m venv .venv`, then `.venv/Scripts/pip install librosa soundfile` (Windows) or `.venv/bin/pip install librosa soundfile` |
| several Pythons installed | `MOTION_PYTHON` is a pin, not a hint: when it is set, that interpreter alone is used (60 s to answer `import sys`), and if it does not answer `beats.mjs --engine auto` says `MOTION_PYTHON=<path> is not usable: <why>` and uses its JS engine, while `--engine librosa` stops with a fix line; `doctor` shows the same reason. Unset, `.venv`, `python3`, `python`, `py -3` are tried in that order (20 s each, so a Microsoft Store stub cannot stall the search) |
| first librosa run is slow | numba compiles on first use; results are cached by audio hash in `audio/.cache/` |

## Renders, mixes and delivery

| Symptom | Fix |
|---|---|
| `cannot replace <file>: EBUSY ... The finished render is kept in out/<fmt>/.staging` (Windows) | a video player or image viewer holds `silent.mp4`, `poster.png` or `render.json` open. The finished render is safe in `.staging/` and the old outputs are untouched: close the program and copy the files from `.staging/`, or render again. `MOTION_PUBLISH_WAIT_MS` (default 30000) sets how long a held file is waited for; a warning at the start of the render names the files that are open |
| `refusing to mix: ... stem problem(s) do not fit the N s film` | a music, voice or sfx stem is shorter than the film by more than 0.25 s, empty or silent (a silent sfx stem only warns; usually a `music.wav` from an earlier duration): regenerate it (`npm run score`, `npm run sfx`, `npm run voice`), or `--allow-short-stems` for a stem that is meant to be short |
| `out/final.mp4 is open in another program` (mix warning) | close the player and mix again; the finished file is `out/<fmt>/final.mp4` |
| deliver: `stale render: studio.json says 12 s @ 60 fps ... final.mp4 has ...` | `duration`, `fps` or the format changed after the render: run `npm run render:final` and `npm run mix` again |
| deliver: `final render` fails, `dimensions` fails | the cut is a draft or a scaled render: only `npm run render:final` output passes |
| deliver: `silence 2.2 s at 00:02.1` fails, or critique `--video` lists a P1 `audio-gap` | the soundtrack is silent for 1 s or more (below -50 dB) after the first 0.3 s and before the last second: a stem ends early or a bed plays under nothing, while the loudness still reads -14 LUFS. Regenerate the stem (`npm run score`, `npm run sfx`, `npm run voice`) and `npm run mix` again. An intended silence belongs in `studio.json` `critique.allowSilence: [[from, to], ...]`, but this build's config validation rejects that key (`critique.allowSilence must be a number`; CHANGELOG, known limitations), so fix the stem instead |
| a tool run with `--json` printed nothing on stdout before | every tool, `gate.mjs` and `lint.mjs` included, now prints one `{"ok":false,"error":"..."}` line on any usage, configuration or runtime error (`deliver.mjs` adds `failed: [...]`; `gate.mjs` prints its verdict, `pass: false`, for a failing gate); read stderr for the human message |
| `invalid <path>/studio.json:` then `- audio.lufs must be between -70 and -5 (got -3)`, exit 1 | a configuration error, not a usage error: every tool that loads `studio.json` stops before it reads its flags (`mix --lufs -14` cannot rescue it). Fix the key. Only a bad command-line flag exits 2 |

## Fonts

| Symptom | Fix |
|---|---|
| render fails with `font missing: <spec>` | the family in `studio.json` brand fonts is not in `assets/fonts/fonts.json`; `npm run fonts -- add "Family:400,700"` or point brand fonts at a bundled family |
| text renders in a fallback face in preview | same cause; canvas text only uses fonts that were loaded through the FontFace API |
| a commercial or own font file | `npm run fonts -- add-file <path\|https-url> --family "Name" --license-file <path\|url>`: the format comes from the file's magic bytes, the license text is copied next to it, and no license gives a warning. It refuses HTML pages, Git LFS pointers, `.ttc` collections and truncated files |
| critique reports a P0 `font-fallback` | a character the film draws has no glyph in its font, or the family is not registered (every character then comes from a system font). The finding names the family, the weight and up to 40 characters. Register a font that covers them (`add-file`), check with `npm run fonts -- coverage --text "..." --family "Name"`, set `brand.fonts` or the `family` option, and run `npm run critique` again. `preflight: unavailable` in the fonts row is a note (an older `lib/runtime.js` without `textUse()`), not a finding |
| Korean, Japanese or Chinese text draws boxes or a different font | the bundled Instrument Serif and Inter have no such glyphs. Register a font that has them (one full Hangul woff2 via `add-file`, or `npm run fonts -- add "Noto Sans KR:400" --subsets korean,latin`, which needs `--yes` above 12 files), then `npm run fonts -- coverage --text "..." --family "Name"` (exit 1 lists the missing characters) |
| `add --subsets korean` refuses with a file count | a CJK family is about 100 slices; check the count and size it prints, rerun with `--yes`, or use one full font via `add-file` |
| pixel or bitmap font looks blurry | draw it at multiples of its pixel grid in device pixels (NeoDunggeunmo: 16, 32, 48, 64 ...) at integer positions, judge it at scale 1, and size it with `fitFontSize(g, text, maxW, makeFont, 16, 200, { step: 16 })` |
| Korean text wraps mid-word or a line ends inside a syllable | wrap with `wrapText(g, text, maxW, font(size, family))`: it breaks at spaces, cuts an over-long word only between characters and never inside a Hangul syllable |
| a 400-only font looks smeared (fake bold) | leave `weight` out (the nearest registered weight is used) or pass one the family has; an explicit weight with no backing face logs a one-time `no weight N face registered` warning |

## Project files

| Symptom | Fix |
|---|---|
| `studio.json` invalid | doctor names the key; restore it from the template defaults |
| init skipped files | merge mode keeps existing files. Rerun init with `--force` to refresh the template files: it keeps `studio.json`, `film/**`, `docs/**` and `assets/fonts/fonts.json`, merges `package.json` (sets `type: module`, adds missing scripts and dependencies, resets a template script whose command differs and lists it as `was ..., now ...`; dependency versions are never changed) and `.gitignore` (appends missing lines), and overwrites `CLAUDE.md`, `lib/**`, `tools/**`, `prompts/**` and `index.html`. Commit or copy local edits to those first. Without `--force` init prints `kept your package.json values, which differ from the template` for every script or dependency version of yours that differs: those `npm run` names run YOUR command |
| a template doc changed after a plugin update | `--force` keeps `docs/**`, so compare `template/docs/` in the plugin with the project's `docs/` and merge by hand |
| tools misbehave after a plugin update | the project holds its own copy of `lib/` and `tools/`: run `node <plugin>/skills/studio-init/scripts/init.mjs . --force` to refresh them |
| preview shows a blank page from `file://` | always use `npm run preview`; ES modules and `fetch` need http |
| port in use | `node tools/serve.mjs --port <N>` |

## Plugin hooks

Some organizations allow only managed hooks. The plugin's lint and gate hooks then load but do not
run. Nothing breaks, but you must run `npm run lint` after edits and `npm run gate` before
`npm run render:final` yourself. `MOTION_STUDIO_HOOKS=off` disables them deliberately.
