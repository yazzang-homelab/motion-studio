# Command reference

Run from the project root. `npm run <script>` passes extra flags after `--`
(`npm run stills -- --at 1,2.5`); calling `node tools/<tool>.mjs <flags>` directly is equivalent.
Every tool prints usage with `--help`, rejects unknown flags with exit 2, exits 1 on failure, logs
to stderr, and prints one JSON line on stdout with `--json`: the result on success, `{"ok":false,"error":"..."}` on any
usage, configuration or runtime error (the human message stays on stderr, the exit code is unchanged), `gate.mjs` and
`lint.mjs` included. A `studio.json` that does not validate (for example `audio.lufs` outside -70 to -5) is a configuration
error: exit 1 in every tool, `mix` too; only a bad command-line flag is exit 2. Two tools also report failed checks as their own
JSON: `gate.mjs` prints its verdict (`pass: false`, `reasons`), and `deliver.mjs` prints `{ ok: false, error, failed: [...] }`, also
when the run cannot start. Flags override `studio.json`.

Long commands (`render:final`, `build`, `mix`, `deliver`, a critique of a long film) run in the background with a log that you
poll; see the pipeline runbook of `/motion-studio:motion-reel`, section "Long commands", for expected times.

## npm scripts

| Script | Runs | Output |
|---|---|---|
| `preview` | `tools/serve.mjs --open` | local server; prints a link per format and opens the primary |
| `render` | `tools/render.mjs` | `out/<primary>/silent.mp4`, `poster.png`, `render.json`, published as one unit (a `--from/--to` range that leaves frames out writes `clip_<from>-<to>.mp4/.json/.sha256` instead; a range covering the whole film is a full render) |
| `render:all` | `render.mjs --format all` | every format in `studio.json` |
| `render:final` | `render.mjs --format all --final` | final quality; blocked by the plugin hook until the critique gate passes |
| `animatic` | `render.mjs --scale 0.5 --fps 30 --sub 1 --draft --out out/animatic` | fast half-size pass for pacing |
| `stills` | `tools/stills.mjs --beats` | `out/review/<fmt>/contact.png`, one still per beat; a sheet taller than 1800 px or wider than 1990 px is paged: page 1 is `contact.png`, then `contact-2.png`, `contact-3.png` ... |
| `critique` | `tools/critique.mjs` | `out/review/<fmt>/` contact, shots, phone, strip (each paged like `stills`), `loop.png` (loop films), `metrics.json/.md` (determinism, glyph coverage of the drawn text, pops, silent spans ...); with `--video` the same files in `out/review/<fmt>/video/` |
| `gate` | `tools/gate.mjs [--json]` | pass/fail from `docs/review_log.md` against `studio.json` `gate` (minRounds, minScore, axes, naAllowed, requireFormats); exit 0 or 1 |
| `lint` | `tools/lint.mjs` | determinism and house-rule problems; exit 1 on errors |
| `score` | `tools/score.mjs` | `audio/music.wav` + analytic `audio/beats.json` |
| `beats` | `tools/beats.mjs <track>` | measured `audio/beats.json` |
| `sfx` | `tools/sfx.mjs` | `audio/cues.json` + `audio/sfx.wav` from the film's cues |
| `voice` | `tools/voice.mjs` | `audio/voice.wav` via ElevenLabs (`--dry-run` first) |
| `mix` | `tools/mix.mjs --format all` | `out/score.wav`, `out/<fmt>/final.mp4`, `out/final.mp4` |
| `deliver` | `tools/deliver.mjs` | checks (including silent spans) + `out/deliver/` (video, poster, every contact page), `docs/production.json` |
| `doctor` | `tools/doctor.mjs` | environment table with fixes (Windows: the bundled headless shell is `ok`, an installed Chrome or Edge is `warn`; info row `windows-logon-guard`) |
| `setup:browser` | `playwright install chromium-headless-shell` | downloads Playwright's headless shell (about 115 MB) into Playwright's browser cache (`%LOCALAPPDATA%\ms-playwright` on Windows); required on Windows, optional elsewhere when Chrome or Edge is installed |
| `refs` | `tools/refs.mjs extract\|analyze` | `refs/frames/`, `refs/contact.png` (paged: `contact-2.png` ...), `refs/analysis.json` |
| `fonts` | `tools/fonts.mjs add\|add-file\|coverage\|list\|remove` | `assets/fonts/*` + `fonts.json` + license files |
| `build` | score (if missing), sfx, final render, mix, deliver | everything; gated like `render:final` |

## Frequently used flags

| Tool | Flags |
|---|---|
| `render.mjs` | `--format f\|all\|a,b` `--fps N` `--sub N` `--shutter S` `--from S` `--to S` `--scale s` `--workers N` `--crf N` `--preset p` `--draft` `--chunk S` `--out DIR` `--final` `--no-poster` `--hash` `--json` (`--json` reports `framesDigest` with `--hash`) |
| `stills.mjs` | `--at 0.5,2,4.2` `--every S` `--beats` `--shots` `--from S` `--to S` `--format f` `--width 270` `--cols 6` `--no-label` `--out FILE` `--page-height 1800` (0 = one tall sheet; pages: `contact.png`, `contact-2.png` ...) `--frames-dir DIR` `--sub N` `--max N` |
| `critique.mjs` | `--format f` `--video [PATH]` (bare: `final.mp4`, else `silent.mp4`; evidence in `out/review/<fmt>/video/`) `--from S` `--to S` (one chapter: sheets and metrics cover only that range) `--page-height 1800` `--strip-at S` `--no-determinism` `--skip-determinism-repeat` (reuse a passing determinism result for an unchanged film) `--check-hash` (no browser: does the evidence match `film/**` + `lib/**` + `studio.json`; exit 0 match, 1 mismatch) `--json` |
| `score.mjs` | `--bpm N` `--dur S` `--style pulse\|piano\|minimal\|cinematic` `--key A` `--mode minor\|major` `--seed N` `--drop BAR` `--loop` `--out FILE` `--beats FILE\|none` `--if-missing` (defaults from `studio.json` `audio.style/key/mode/seed`, `loop`) |
| `beats.mjs` | `<track>` `--out FILE` `--engine auto\|librosa\|js` `--bpm-hint N` (30 to 300) `--no-cache` |
| `deliver.mjs` | `--format f\|all\|a,b` (re-delivers only those formats, keeps the others) `--json` |
| `sfx.mjs` | `--cues FILE` `--format f` `--out FILE` `--dur S` `--seed N` `--samples DIR\|none` (`--no-samples`) `--dump-cues` `--list` |
| `mix.mjs` | `--format f\|all` `--music P\|none` `--sfx P\|none` `--voice P\|none` `--lufs -14` (-70 to -5) `--tp -1` (-20 to 0) `--no-duck` `--allow-short-stems` (mix a short, empty or silent stem anyway) |
| `voice.mjs` | `--script audio/voice.json` `--dry-run` `--voice-id ID` `--model eleven_multilingual_v2` |
| `refs.mjs` | `extract <video> [--every 0.5] [--out refs/frames]`, `analyze <video\|folder\|image> [--threshold 0.3] [--json]` |
| `fonts.mjs` | `add "Family:400,700" [--italic] [--subsets latin,latin-ext\|korean] [--yes]`, `add-file <path\|https-url> --family NAME [--weight W] [--style S] [--license-file P] [--license ID] [--unicode-range R]`, `coverage --text "..." [--text-file F] [--family A,B] [--format f]`, `list`, `remove <family>` |

## Typical sequences

| Goal | Commands |
|---|---|
| look at the film now | `npm run stills`, open `out/review/<fmt>/contact.png` (and every `contact-2.png`, `contact-3.png` ... page) |
| review one chapter of a long film | `node tools/critique.mjs --from 10 --to 20 --no-determinism` (or `node tools/stills.mjs --from 10 --to 20`) |
| one critique round | `npm run lint`, `npm run stills`, the sound chain below, then `npm run critique -- --format <fmt>` and `node tools/critique.mjs --format <fmt> --video out/<fmt>/final.mp4` |
| check a fix in seconds 4 to 6 | `node tools/render.mjs --from 4 --to 6 --draft --out out/check` |
| hear the draft (the sound chain) | `node tools/render.mjs --format <fmt> --draft --sub 1 --scale 0.5`, `npm run sfx`, `node tools/mix.mjs --format <fmt>` |
| finish | `npm run gate`, then `npm run build` |
| long film, resumable (run in the background) | `node tools/render.mjs --format all --final --chunk 10` |
| prove a range is deterministic | two `node tools/render.mjs --from 0 --to 2 --hash --draft --no-poster --json --out out/check/a` runs (second `--out out/check/b`, other `--workers`): equal `framesDigest` |
| Korean or other CJK text | `npm run fonts -- add-file <font> --family "Name" --license-file <license>`, then `npm run fonts -- coverage --text "..." --family "Name"` |
