# Changelog

All notable changes to motion-studio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).
The plugin version lives in `.claude-plugin/plugin.json`; users receive an update only when it changes.

## [Unreleased]

### Changed

- License: MIT is replaced by a dual license. The [PolyForm Noncommercial License 1.0.0](LICENSE) covers personal,
  research, education and other noncommercial use for free; commercial use needs a paid license ([COMMERCIAL.md](COMMERCIAL.md)).
  Contributions are accepted under the contribution license in `CONTRIBUTING.md`.
- Init: after the first new project on a machine, `init.mjs` prints a one-time GitHub star suggestion (`starHint` in
  `--json`). Marker in `~/.motion-studio/`; off under `node --test`, in CI and with `MOTION_STUDIO_STAR_HINT=off`.

Fixes from the first production of a real film (the emulog.app launch film). Each item names its row in the film's plugin feedback.

### Added

- `skills/product-reel/scripts/states.mjs` (row 1): the UI-states capture is a script of its own, no longer a ~400-line heredoc in
  `agents/asset-scout.md` (577 to 156 lines). Writes `00-first`, `01-escape`, `scroll-NN`, `10-click-*`, `crop-20-*` and optional
  mobile and full-page shots plus `states.json`, and prints one JSON line. Flags: `--root`, `--name` or `--out`, `--viewport
  desktop|mobile|tablet|both`, `--click`, `--crop`, `--full-page`, `--scroll-frames`, `--wait`, `--settle`, `--timeout`, `--locale`,
  `--no-dismiss-banners`, `--no-escape`, `--allow-private`, `--no-sandbox`, `--project-launcher`. Exit 0 ok, 1 failed, 2 usage error.
  The old `<outDir> <url>` order still works. A skills-only install needs only Node and a resolvable `playwright`
  (`${CLAUDE_SKILL_DIR}/scripts/states.mjs --root <folder>`).
- `canvas-frames.mjs`, `canvas-pack.mjs`, `png-sheet.mjs` (row 2): samples a `<canvas>` into sprite sheets with the buffer copied,
  never resampled (`imageSmoothingEnabled = false`, frame size a whole-number reduction of the buffer or exit 2). Writes
  `<clip>.png` and `frames.json` (version 1: real time and FNV hash per frame, `distinct`, `blank`, `maxLagMs`, optional `--probe`
  text). `canvas-frames.mjs pack [--range clip=first:count] [--trim-lead] [--cols]` writes `pack/<clip>.png` and `pack.json`
  with pure-Node PNG code (no ffmpeg).
- `capture.mjs` manifest `brand.wordmark` (row 3): when a site has no logo image or SVG, the text wordmark is recorded (text, HTML,
  per-span colors and fonts, computed font and `fontLoaded`, link, box, reference crop `assets/brand/logo/wordmark-crop.png`).
  The "ask the user for an SVG or PNG logo" warning remains only when neither exists.
- `capture.mjs` manifest `fonts.registry` (row 5): for every family in use, whether it is registered in `assets/fonts/fonts.json`
  (`registered`, `registered+added`, `added`, `not-registered`, `system`) and whether its license is verified, unverified, mixed or found,
  with `font registry:` lines on stderr. A new face of an already verified family reuses its license (`licenseState()` in
  `capture-fonts.mjs`), so no second UNVERIFIED entry appears next to a verified one.
- Template `lib/draw.js` (row 8): `stepProgress(p, steps = 6)`, `scanReveal(g, rect, p, { steps, dir }, fn)` and
  `steppedText(g, str, x, y, p, opts)`, hard-step reveals with no alpha ramp and integer-snapped edges.
- `studio.json` `critique.stepped` (default `false`) and `critique.popIgnore` (`[[t0, t1], ...]` seconds, default `[]`) (row 7): jump
  candidates of a hard-stepped film go to `metrics.json` `pops.info`, ignored spans to `pops.ignored`, and `metrics.md` lists what was held back.
  A one-frame flicker stays a P1.
- `tools/critique-pin.mjs` (rows 11, 12): `filmHash` (sha256 over `film/**`, `lib/**`, `studio.json`, LF-normalised) in `metrics.json`
  and `film-hash.json` of every evidence folder, `critique.mjs --check-hash [--format f] [--video]` (no browser; exit 0 match, 1 mismatch),
  and `--skip-determinism-repeat`, which reuses a passing determinism result (`determinism-cache.json`) while the key (film hash, format,
  range, tool code) is unchanged. Measured on the 12 s demo: 114.7 s without, 94.7 s with.
- `tools/critique-baseline.mjs` (row 14): every run writes `baseline.json`; the next run prints `same as previous run: N of M
  candidates`, lists the new ones first and marks unchanged findings `[same as the previous run]`.
- `studio.json` `gate.requireFormats` (default `false`, row 13): when `true`, every format in `formats` needs a logged round that passes
  on its own. Default behaviour (last round only, heading format ignored) is unchanged and now documented.

### Fixed (review of the above)

- `gate.requireFormats`: the LATEST round of each format must pass; an earlier passing round no longer covers a later regression.
- `capture.mjs` fonts: a verified license is reused only for a file from the same origin as the entry's recorded `source` (new optional
  `fonts.json` key) or, for an entry without one, when the new file's own license check does not name another license; a different
  license text never overwrites a license file already on disk.
- `capture.mjs` `brand.wordmark.link` and `.html`: query and fragment of the link are dropped and secret-looking values masked, so
  `/?token=...` never reaches the manifest, stdout or stderr.
- `canvas-frames.mjs` / `canvas-pack.mjs`: clip names from `frames.json` are validated, paths stay inside the project and `pack/`,
  and Windows device names (`con`, `nul`, `com1` ...) are refused.
- `critique-pin.mjs`: symbolic links and junctions below `film/` and `lib/` are followed (cycle-safe); the determinism cache key now
  includes the content of every file under `assets/`.
- `test/browser-policy.test.mjs` checks that no third policy copy exists; the shared test helper moved to `scripts/test-support/`
  (nothing loadable but `*.test.mjs` below `test/`). Docs: crop files are `<viewport>-crop-20-<slug>.png`; the "request above" promise
  was dropped where it was not kept.

### Changed

- `capture-banner.mjs` points at `states.mjs` instead of "the asset-scout states script". `buildPalette`, `sniffImage` and
  `parseDataUrl` moved to `capture-palette.mjs` and `capture-image.mjs` (re-exported from `capture.mjs`); `capture-session.mjs` and
  `capture-cli.mjs` are shared by the page-driving scripts.
- Browser policy: the byte-identical block is now in two files (`tools/studio-web.mjs` and `capture.mjs`); `states.mjs` and
  `canvas-frames.mjs` reach it through `capture.mjs` `launch()`.
- Timing figures are measured: a live critique takes about 115 s for the 12 s demo and about 145 s for a 20 s film, `--video` about
  85 s, one `motion-critic` run 5 to 12 minutes (the old 20 to 30 s and 25 s figures are gone).
- Docs: the template `docs/API.md` gains the "Which clock" table (row 9: `frameLt` for hard steps, `frame` for grain) and "The two font
  lists" (row 10: `assets/fonts/fonts.json` and `studio.json` `fonts` merge with no precedence; use `fonts.json` only). Critic runs append
  to one `docs/review_log.md` and must run one after another (row 12).
- Skills show the request arguments (`$ARGUMENTS`) once, in a delimited `<request>` block, instead of repeating them in prose and
  inside inline code spans (row 4).

## [0.1.0] - 2026-09-29

First release: the 12-step course "How to build motion design studio with Opus 5.5 (Full-course)" by Movez
(@0xMovez), packaged as a Claude Code plugin and single-plugin marketplace.

### Added

- Marketplace and plugin manifests in one repository (`.claude-plugin/marketplace.json` with `"source": "./"`), so the
  plugin installs with `claude plugin install motion-studio@motion-studio` and the skills also install with
  `npx skills add`.
- 12 skills, one per course step plus the end-to-end pipeline: `motion-reel`, `studio-init`, `showreel`,
  `product-reel`, `reference-style`, `ui-morph-spec`, `seek-engine`, `springs`, `sound-design`, `director-brief`,
  `critique-loop`, `ship-formats`.
- 7 subagents: `motion-director`, `motion-critic`, `render-engineer`, `sound-designer`, `asset-scout`,
  `style-analyst`, `chapter-animator`.
- 4 hooks: determinism lint after film and library edits, a critique gate before final renders (it follows package
  scripts and nested shells), write lanes for subagents (chapter-animators cannot write the shared
  `film/scenes/shared_*` files), and project status at session start. `MOTION_STUDIO_HOOKS=off` disables them. Each
  adds well under a second on top of Node startup and fails open.
- Film-project scaffold (`skills/studio-init/template/`), copied by `skills/studio-init/scripts/init.mjs` (existing
  folders get missing files only; `package.json` and `.gitignore` are merged):
  - `seek(t)` canvas runtime with the `window.__studio` render contract (`frame`, `hash` and `pixels`, with a
    `wrap: false` option for loop checks), a preview UI outside the canvas with audio, and a HyperFrames `hf-seek`
    bridge (experimental).
  - Libraries: closed-form springs with presets, `track()` superposition with per-key springs, `loopTrack()` for
    seamless loops (a key at the loop end is the seam change), `springFromFeel()`; seeded per-element randomness; beat
    grid with measured accent peaks (`grid.hits`), scenes with draw layers, film-wide overlays, chapters and cues;
    format layouts with safe areas; canvas drawing helpers (color mixing, masked kinetic type, pivot transforms).
  - Fonts: eager loading of every face and unicode-range slice with a hard check, and glyph coverage detection for
    Korean and other CJK text (`tools/fonts.mjs add-file`, `coverage`, sliced Google families with `--subsets korean`).
    The bundled fonts are Latin-only.
  - Tools: parallel renderer with in-page subframe motion blur, partial ranges (`clip_<from>-<to>.mp4`), chunked
    resumable renders, BT.709 H.264 encode, frame hashes with a digest, and bounded browser shutdown
    (`MOTION_CLOSE_TIMEOUT_MS`); stills and contact sheets; static preview server; original synthesized music in four
    styles; synthesized SFX from the film's cues with an optional licensed-samples path; beat tracking (librosa or a
    built-in JS engine) that snaps beats and hits to onsets; two-pass loudness mix to -14 LUFS and -1 dBTP at exact
    length with a limiter fallback and an AAC true-peak re-master; optional ElevenLabs voice; automated critique
    evidence (`critique.mjs` with `critique-metrics.mjs` and a documented `metrics.json`); determinism lint; critique
    gate (`na` passes only on `gate.naAllowed`, default `brand`); doctor with per-check timeouts; reference analysis;
    delivery checks and packaging (`out/deliver/manifest.json`, `docs/production.json`).
  - A 12-second demo film in all formats, bundled Instrument Serif and Inter (OFL-1.1), house-rules `CLAUDE.md`,
    doc templates and prompt templates.
- Eval suite for `claude plugin eval` (12 cases: trigger, content, scaffolded, subagent dispatch, negative and render),
  a zero-cost eval lint and a zero-cost grader self-test (`npm run eval:selftest`).
- CI: lint, both `claude plugin validate --strict` targets and unit tests on Ubuntu, Windows and macOS; a smoke
  render on Ubuntu; eval lint and eval self-test on all three systems. A separate paid evals workflow runs manually or
  weekly.
- Documentation: README (English and Korean, with a Korean / CJK videos section), `docs/ARCHITECTURE.md`,
  `CREDITS.md`, `CONTRIBUTING.md`, `prompts/README.md`.

### Fixed during review

An adversarial review ran before the release. Each finding was reproduced, fixed at its root and given a regression test. The
behavior of 0.1.0 includes these corrections:

- Renderer: outputs (`silent.mp4`, `render.json`, `poster.png`, `frames.sha256`) are published as one unit with rollback, a
  held-open file is waited for (`MOTION_PUBLISH_WAIT_MS`) and a failed publish keeps the finished render in `.staging/`.
  Partial versus full is decided in whole frames. Scenes see the output frame (`c.frame`, `c.frameT`, `c.frameLt`, `c.sub`,
  `c.subs`), so grain and "on twos" match between stills and blurred finals. `parseColor` accepts percentage `rgb()` and throws
  on malformed input. Stills split tall contact sheets into pages and take `--from`/`--to`.
- Type: `text()`, `font()` and `kinetic()` default to the brand families and to a registered weight (no fake bold, no hidden
  `Inter`). New `wrapText()` and `fitFontSize(..., { tracking, step })` for Korean copy and bitmap fonts.
- Config and CLI: `validateConfig` checks safe insets with the layout rule and names only real bounds, and `audio.lufs` must be
  -70 to -5 (`audio.lufs must be between -70 and -5 (got -3)`). With `--json` a failure prints one `{"ok":false,"error":...}` line in
  every tool, `gate.mjs` and `lint.mjs` included (a bare `--` now ends their options). One exit-code rule: a bad `studio.json` is a
  configuration error and exits 1 everywhere (`mix` too, where it used to exit 2); only a bad command-line flag exits 2.
  `studio.mjs` re-exports everything `studio-web.mjs` exports, the browser-policy helpers included.
- Init: `--brand-url` is stored without `user:password@` and without secret-looking query, `;matrix` or fragment parameters (stderr
  names what was removed, `--json` has `redacted`); the failure line follows the last `--json` or `--no-json`.
- Static server: dot-files stay hidden through 8.3 short names, symlinks, junctions, backslashes and NTFS streams.
- Audio: `mix` refuses short, empty or silent stems (`--allow-short-stems`), survives an open `out/final.mp4` and a true-peak
  ceiling below -9 dBTP, and attenuates a premix that is too hot. `score --if-missing` regenerates a stale generated score
  (`audio/music.meta.json`). `beats --bpm-hint` widens the JS tempo window and a broken `MOTION_PYTHON` falls back to the JS
  engine. `voice` bills identical lines once and reports network errors readably. Mono and multichannel decoding no longer depend
  on the sample rate. SFX noise seeds depend on type, time and rank among identical cues instead of the sorted index, so a cue keeps its
  sound when other cues are added, removed or moved.
- Contact sheets and ranges: `stills`, `critique` and `refs extract` page every sheet by one rule: no image taller than
  `--page-height` (default 1800 px, was 2400 in `stills`) or wider than 1990 px (`--cols` is lowered to fit); page 1 is `contact.png`,
  page n is `contact-n.png` (`stills` used to name page 1 `contact-1.png`); a run deletes the pages it no longer writes; every page
  is listed in `metrics.md` and in `--json` (`pages`). `critique` takes `--from`/`--to` (stills, sheets and every metric cover
  only that range; frame 0 and the loop seam are skipped for a range) and `--page-height`. `deliver` copies every contact page.
- Glyph preflight and silence: the live critique records which characters the film draws with which font
  (`window.__TEXT_TRACK__`, `__studio.textUse()`, `__studio.coverage()`) and raises a P0 `font-fallback` for text a font cannot
  draw (Hangul in Inter, an unregistered family). `text()` and `kinetic()` still never throw for an unregistered family. `critique
  --video` reports a silent span of 1 s or more below -50 dB as a P1 `audio-gap`, and `deliver` fails on it (check `silence`); a
  silent intro, a fade-out that ends in silence and `critique.allowSilence` intervals are not gaps. `deliver --json` prints
  `{ok:false, error, failed:[...]}` also when the run cannot start.
- QA tools: the gate reads any `P0` token strictly (a P0 closes only through `FIXES: <n>. fixed`); `deliver` judges
  `final.mp4` against the current `studio.json` (stale renders fail), keeps other formats on `--format` and fails cleanly on an
  unreadable file; `critique --video` writes to `out/review/<fmt>/video/` instead of overwriting the live evidence; frame-0 and
  border metrics handle gradients and vignettes; lint follows URLs held in constants and no longer flags on-screen copy, canonical
  links or private RNG helpers; `fonts remove` never deletes outside `assets/fonts/`; `refs` measures containers without a
  `Duration`.
- Hooks and init: the final-render gate sees PowerShell assignments, `Invoke-Expression`, `eval`, `Start-Process` and
  `--prefix`/`-w` in any position. `init --force` resets only template scripts, never a dependency version, and lists what it
  kept or reset.
- Capture: Chrome's renderer sandbox stays on, requests to local and private addresses are refused, credentials and secret query
  values never reach a file or log, WOFF/WOFF2 decompression bombs are refused, Hangul file names and consent buttons in seven
  languages work, and the scripts start through symlinks and junctions.
- Windows lockout: on Windows an installed Chrome or Edge that starts with a fresh profile (every tool run and every test run,
  because Playwright makes a temporary profile per launch) tests the account for a blank password, and each test is written
  to the Security log as a failed logon (event 4625, SubStatus `0xc000006a`). One laptop logged 464 such events from
  `chrome.exe` in 24 h and 45 lockouts (event 4740) against a policy of 10 failed logons in 10 minutes. `browser: "auto"` now
  starts only Playwright's bundled headless shell on Windows (3 launches, 0 failed logons; installed Chrome, 1 fresh launch,
  +1) and never falls through to Chrome or Edge; macOS and Linux keep Chrome, Edge, bundled. An installed Chrome or Edge on
  Windows is an explicit opt-in (`studio.json` `browser`, `MOTION_BROWSER`, `MOTION_CHROME_PATH`) with a warning per launch and
  a launch guard that refuses the 4th launch in 10 minutes (`MOTION_SYSTEM_BROWSER_MAX`, `MOTION_ALLOW_LOCKOUT_RISK`,
  `MOTION_LAUNCH_LOG`). `launchBrowser` and `capture.mjs` share one policy block, checked byte for byte by a test (the
  states capture, which used to carry a third copy inside `agents/asset-scout.md`, is now `states.mjs`; see Unreleased). The
  states capture treats an installed Chrome as a guarded opt-in and its `states.json` `via` is `chromium-headless-shell` for the bundled shell. `doctor` warns for an
  installed browser and shows a `windows-logon-guard` row, `npm run setup:browser` installs the shell, and the setup docs,
  troubleshooting and `docs/ARCHITECTURE.md` (section 9.10) describe it. CI installs the headless shell on all three operating
  systems before the unit tests (`--with-deps` on Linux), the unit-test job has a 90-minute limit (was 40), the evals workflow installs the
  shell's system libraries, and the render eval's scaffold downloads the shell and no longer falls back to a system Chrome. Cost,
  measured: the shell is unsigned, so real-time antivirus scans each browser process; launch about 3.5 s, first page about 11 s, 15 to
  25 s per tool run against 2.4 s for the installed Chrome.
- Docs and skills: the critic is briefed after a mixed render exists and reads both evidence folders; long commands are documented
  with measured times and a background pattern; one render-time measurement and one 45 s hand-off between `motion-reel` and
  `director-brief`; `product-reel` and `showreel` time the shot list on the beat grid; skills-only fallbacks for
  `${CLAUDE_PLUGIN_ROOT}` commands; a PowerShell 5.1 quickstart; a corrected `claude plugin details` description; the complete list
  of verbatim quotations (`prompts/README.md`); a template `docs/API.md`.

### Known limitations

- Frame hashes and the render contract are guaranteed on one machine and one browser build; pixels can differ across
  operating systems, GPUs and browser versions, and MP4 bytes are not deterministic.
- Routes C (generate-then-trace) and D (footage edit) are planned in the skills but bundle no generator or editor.
- `capture.mjs` filters the page's requests but cannot see everything Chrome sends: speculation rules (`<script
  type="speculationrules">`), UDP and bare TCP preconnects, and DNS rebinding are not filtered (the manifest notes speculation
  rules). Capture only pages you trust.
- The glyph preflight sees only text that the reviewed frames drew: films longer than 7,200 frames (the pixel pass strides) and text
  on frames that no pass paints are not tracked, and a chapter `placeholder()` card draws with `g.fillText` and is not recorded.
- Neither GitHub workflow has run on a real runner. The 90-minute CI limit assumes hosted runners are not slower than the measured
  laptop (about 45 minutes for the whole suite) [assumption]. On Ubuntu and macOS `auto` still tries the runner's Chrome before the
  headless shell, so the shell is only the fallback there. The Linux branch of the render eval's scaffold and the shell inside the eval
  sandbox are unverified.
- `voice.mjs` (ElevenLabs) uses your account and is not exercised in CI. The eval render case has not yet run inside
  the Linux sandbox.
- On Windows the default browser is Playwright's headless shell, which is unsigned: a real-time antivirus made each tool run 15
  to 25 s slower on the measured laptop (an exclusion for `%LOCALAPPDATA%\ms-playwright` removes it; that is the user's or IT's
  decision). Its per-frame render speed and its pixel difference from the installed Chrome are not measured; the render-time
  table comes from an installed Chrome. The full bundled Chromium (`chromium-<n>/chrome-win64/chrome.exe`) is classified as an
  installed browser by file name and guarded; whether it runs the blank-password test is not measured.
- The bounded-close behavior is measured on Windows; on Linux and macOS it follows the same code path with a
  process-group kill that has not been exercised there.

[Unreleased]: https://github.com/yazzang-homelab/motion-studio/compare/motion-studio--v0.1.0...HEAD
[0.1.0]: https://github.com/yazzang-homelab/motion-studio/releases/tag/motion-studio--v0.1.0
