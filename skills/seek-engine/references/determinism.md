# Determinism: rules, fixes and evidence

A frame must depend only on `t`, `studio.json` and files in the project. Frames render in parallel, out of order and
in separate pages, so anything that remembers the previous frame or reads a clock produces a different film on every
run. Numbers below were measured on the reference machine (Windows 11, Chrome 154, ffmpeg 6.1.1) while this plugin
was built; see `CREDITS.md` for sources.

## Rules for film and lib code

| # | Rule | Why |
|---|---|---|
| 1 | Compute every value from `t` (or `lt = t - from`). Derive time from the frame index (`i / fps`); never accumulate `t += dt`. | Any frame can be asked for first. |
| 2 | No clocks: `Date`, `new Date(`, `performance.now`, `setTimeout`, `setInterval`, `requestAnimationFrame`. | Wall time differs per run. Only `lib/runtime.js` preview lines carry `// studio-allow preview`. |
| 3 | No unseeded randomness: `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues`. Use `rngFor(name, i)` per element; `noise1`/`noise2` for smooth wobble. | Seeded streams replay exactly. |
| 4 | One RNG per element, created where it is used: `const r = rngFor('tile', i); const delay = range(r, 0, 0.1)`. Never one module-level stream shared by many elements. | A shared stream shifts every later draw when one element consumes a different number of values. |
| 5 | No state carried between frames: no module-level `let` counters, `Map` caches or arrays written inside draw functions. Precompute immutable data in the factory or in `setup()`. Memoize only pure functions keyed by all of their inputs. | Pass B of the check (shuffled order) catches this. |
| 6 | No CSS `transition`, `animation`, `@keyframes`, `element.animate()`, `will-change` in render paths. Page-capture films set styles from `t` inside `seek`. | The browser animates on its own clock. |
| 7 | No network: fonts from `assets/fonts/`, images from `assets/`, no `https://` in `fetch`, `import`, `url(` or `<link href>`. | Offline renders must match online ones. |
| 8 | Fonts go through `loadFonts` (FontFace + `document.fonts.load` + `check`). Never draw with a family that is not bundled. | `document.fonts.ready` does not load canvas-only fonts. |
| 9 | Finite repetition only: no `repeat: -1` or `Infinity` iterations; loops use `loopT` and `loopTrack`. | Infinite timelines have no defined frame at `t`. |
| 10 | Loop films: `hash(seek(0)) === hash(seek(duration))`, and the motion across the seam is continuous. | Frame N (t = duration) is never rendered; it must equal frame 0. |
| 11 | Images and data load once in `setup()` (awaited), from local paths, before the first paint. | A late decode paints an empty frame. |

## Lint rules (`tools/lint.mjs`, also run by the plugin hook after each edit)

| Rule | Severity | Catches |
|---|---|---|
| `no-math-random` | error | `Math.random` |
| `no-date` | error | `Date.now`, `new Date(`, `performance.now` |
| `no-timers` | error | `setTimeout`, `setInterval` |
| `no-raf` | error | `requestAnimationFrame` |
| `no-remote-fetch` | error | `http(s)` URLs loaded at render time: in `fetch`, `import`, `url(`, `<link href>` (stylesheet, icon, preload; not `rel=canonical` or `alternate`), including Google Fonts, and URLs held in a constant, array or object that is later used as `.src`, `fetch(...)`, `loadImage(...)`, `new Image/Audio/Worker/WebSocket` or `setAttribute('src', ...)`. A URL that is only drawn as text is fine |
| `no-infinite-repeat` | error | `repeat: -1`, `Infinity` iterations |
| `no-css-transition` | warn | `transition:`, `animation:`, `@keyframes` in a style sink or rule block (not in on-screen copy), `.animate(` with a keyframes array or options object (`mascot.animate(t)` is fine) |
| `no-will-change` | warn | `will-change` |
| `no-random-uuid` | warn | `crypto.randomUUID`, `getRandomValues` |
| `shared-rng` | warn | a stream from `mulberry32`/`rngFor` declared outside a draw and read inside it later: module-level or factory streams read in scene draws, `draw:` properties or stored closures. A stream created in the draw and read in an immediate callback (`Array.from`, `map`, `forEach`, `sort` ...) or a private helper is the recommended pattern and stays clean |

Escape hatches, used sparingly and with a reason in the same comment: `// studio-lint-disable-line <rule>` for one line,
`// studio-lint-disable-next-line <rule>` for the line below, `/* studio-lint-disable <rule> */` for a file. Comments
and string literals are ignored except by `no-remote-fetch`. `// studio-allow preview` marks preview-only lines in
`lib/runtime.js`; never use it in film code.

## Fixes table

| Symptom | Root cause | Fix | Evidence |
|---|---|---|---|
| still scenery jitters while a character moves | one RNG stream reseeded per frame, consumed unevenly | per-element seeds `rngFor(name, i)` | ClaudeAnimationBase commit 4751cc7: 80k-140k changed pixels per frame went to 0 |
| first frames render in a fallback font | `document.fonts.ready` resolves before canvas-only fonts load | `loadFonts` asserts `load(spec).length > 0 && check(spec)` | fallback text measured 650.4 px, the real face 494.8 px |
| a named system font looks different on another OS | family not declared, silent fallback (Times New Roman, Times, DejaVu) | bundle the font in `assets/fonts/` (`npm run fonts -- add`) | `check()` returned true while `load()` returned `[]` |
| `fetch` or module import fails, or a path with `#`/`%` 404s | `file://` URL | the tools serve over `http://127.0.0.1` | `ERR_FILE_NOT_FOUND` for `hash#1` and `pct%41` folders |
| same frame hashes differently across renders on one machine | GPU canvas vs CPU canvas | CPU raster: `getContext('2d', { willReadFrequently: true, alpha: true })` plus `--disable-accelerated-2d-canvas`. The stage keeps `alpha: true` on purpose: an opaque canvas lets Chrome draw LCD sub-pixel text (red and blue fringes that follow the OS ClearType or fontconfig setting), and every frame fills the opaque background first anyway | three backends, three hashes (below) |
| accent `#D97757` decodes as (224,126,82) | RGB to yuv420p with untagged BT.601 matrix | `scale=out_color_matrix=bt709:out_range=tv` plus the four `bt709` tags | tagged encode decodes as (217,118,86) |
| mp4 sha differs between two identical renders on two machines | x264 thread count changes the bitstream and decoded frames | hash captured frames (`--hash`, `__studio.hash`), never the mp4 | `-threads 1` vs `-threads 4` gave different decoded frames |
| loop seam jumps | `loopT(t)` wraps time but springs from the last keys are still moving | `loopTrack(t, keys, dur)` sums prior cycles; key times in `0..dur` (a key at `dur` is the seam change), last value equals first | naive wrap jumped 54.33 px to 0.00; periodic sum gave 54.33, 33.17, 16.82 |
| "heavy" motion feels too fast | overdamped springs approximated as critical | exact overdamped branch in `springPV` | the shortcut was off by up to 34% of travel at damping ratio 2.3 |
| motion blur keeps the wrong subframes | `tmix` followed by `framestep` | `tmix=frames=N,select='eq(mod(n\,N)\,N-1)'` (page capture only) | `framestep` kept 0,25,65,105 instead of 15,55,95,135 |
| audio 14 ms short | `-shortest` with `-c:v copy` | exact `-t frames/fps` plus `apad,atrim` | 2.986 s audio against 3.000 s video |
| grain is weaker and flickers differently in the final than in stills; "on twos" blends two steps | the frame index was derived from each motion-blur subframe time, so the four subframes of one output frame got different grain and `stepTime(c.t)` straddled a step | scenes get `c.frame` (the output frame index, shared by all subframes), `c.frameT` and `c.frameLt`; use `grain(g, W, H, c.frame)` and `stepTime(c.frameLt, 12)` | grain at 4 subframes was 0.71x the 1-subframe grain (r = 0.5 between frames); now pixel-identical |

## Three raster backends, three hashes

The same `seek(1.234)` of one test scene gave three different SHA-256 prefixes on one laptop:

| Backend | How you get it | Hash prefix |
|---|---|---|
| GPU canvas | Chrome default, even headless | `4cc32de58ebd` |
| CPU canvas | `willReadFrequently: true`, `--disable-gpu` or `--disable-accelerated-2d-canvas` | `6f47891a78db` |
| SwiftShader GL | `--use-angle=swiftshader` | `25191a3279a7` |

Each backend repeated itself exactly, so the danger is mixing them: a render where some pages fall back to another
backend, or a comparison against a render made with other flags. The engine pins the CPU path (it also matches
`getImageData` byte for byte with screenshots), and `render.json` records the browser build. Switching browsers (an installed
Chrome against Playwright's headless shell, the Windows default) is a change of build: re-render before comparing hashes [pixel
difference not measured; the numbers on this page come from Chrome 154]. Use SwiftShader only for
WebGL scenes, and keep it for every render of that film.

What we promise: bit-identical frames on the same machine, browser build and flags. What we do not promise:
bit-identical frames across operating systems; font rasterizers differ there.

## How the check samples time

`tools/critique.mjs` hashes frames at times that straddle every shot boundary and every cue (one frame before, at,
and after), because state bugs hide at hand-offs: a check that samples only mid-shot frames can pass while the frame
after a cut is wrong. Pass A renders them in order, pass B in a seeded shuffle, pass C after a page reload. Any
mismatch lists `t`; fix the film, not the check.
