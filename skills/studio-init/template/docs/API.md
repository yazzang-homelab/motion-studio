# API cheat-sheet

Signatures and defaults of what a film uses, read from `lib/*.js` (the comments at the top of each file are the source of
truth). `docs/ARCHITECTURE.md` in the motion-studio plugin repository is the full reference (sections 5 and 6 cover this
page in detail). Sizes are logical pixels of the format (1080 x 1920 for 9x16); multiply by `L.u`. Times are seconds.

## Film (`lib/timeline.js`)

| Call | Meaning |
|---|---|
| `defineFilm((ctx) => ({ scenes, overlays?, cues?, background?, capture?, setup? }))` | The default export of `film/film.js`. `cues` is an array or `(grid, ctx) => Cue[]`; `background` a color or `(g, t, c) => void`; `setup` an async one-time preparation |
| `scene(from, to, name, draw)` or `scene({ from, to, name, draw, layer })` | Draws while `from <= t < to`; `layer` (default 0) orders scenes; overlaps are allowed |
| `chapter({ name, from, to, shots: [{ at, name, draw }], cues })` | One chapter file; shot i runs to shot i+1; no shots = a visible placeholder card |
| `ctx` (factory argument) | `{ dur, fps, bpm, loop, grid, L, W, H, u, brand, fmt, title, rngFor, cfg }` |
| `draw(g, lt, c)` | `g` = 2D context in logical px; `lt` = seconds since the scene started |

`c` inside a draw:

| Field | Meaning |
|---|---|
| `t`, `lt` | The time being painted and `t - scene.from`. With motion blur these are the SUBFRAME time, so motion blurs by itself |
| `frameT`, `frameLt` | The output frame's own time and its scene-local time; the same for every subframe |
| `frame` | Output frame index `floor(frameT x fps)`, the same for every subframe |
| `sub`, `subs` | Subframe index and count (0 and 1 without blur) |
| `dur`, `p` | Scene length and `lt / dur` clamped to 0..1 |
| `W`, `H`, `u`, `fmt`, `L`, `fps` | Format size, unit, name, layout (below), frame rate |
| `grid`, `brand`, `film` | Beat grid, `studio.json` brand (`brand.colors.bg/fg/accent/muted`, `brand.fonts.display/ui`), the factory `ctx` (`c.film.dur` = film length) |
| `scene`, `chapter` | Scene name; `{ name, from, to }` or `null` |

Cue: `{ t, type, gain = 1, pan = 0, pitch = 1 }`, type one of `click tick pop thump whoosh swoosh riser hit chime type glitch snap`.
Grid: `beat(n)`, `bar(n)`, `nearest(t)`, `beatsIn(a, b)`, `barsIn(a, b)`, `isOnBeat(t)`, `hits`, `hitsIn(a, b)`.

### Which clock

With motion blur a draw runs once per subframe of the same output frame: `t`/`lt` differ between those runs on purpose and the
renderer averages them; `frameT`/`frameLt`/`frame` are identical in all of them (`lib/timeline.js` `renderFrame`, `lib/runtime.js` blur loop).

| Use | Clock | Why |
|---|---|---|
| Springs, easing, positions, scale, fades, anything that should smear | `lt` / `t` | Subframes disagree, the average is the motion blur |
| Stepped or quantized looks: `scanReveal`, `steppedText`, `stepProgress`, `stepTime(..., rate)`, blink/flicker tables | `c.frameLt` (`c.frameT` outside a scene) | All subframes pick the same step, the edge stays a hard cut |
| Frame-indexed or seeded per-frame things: `grain(..., c.frame)`, `rngFor(name, c.frame)`, sprite sheets | `c.frame` | One value per output frame |

Failure when a stepped look runs on `lt`: the subframes of one output frame land on neighbouring steps and the average is a
half-blended edge (an in-between clip rect, a half-lit glyph, grain at 0.7x strength). Without motion blur `lt === c.frameLt`, so the
mistake only shows in the final render.

## Type (`lib/draw.js`, `lib/layout.js`)

| Call | Meaning |
|---|---|
| `font(size, family?, weight?, style = 'normal')` | CSS font string. `family` defaults to `brand.fonts.ui`; `weight` to 700 when the family has that weight, else the nearest weight it has registered (a 400-only face is never faked bold). An explicit weight or style with no backing face warns once |
| `text(g, str, x, y, { size = 64, family, weight, style, color = '#fff', align = 'left', baseline = 'alphabetic', tracking = 0, alpha = 1 })` | One run; returns its width. `tracking` is in em (0.02 = 2% of the size) |
| `kinetic(g, str, x, y, lt, { size = 64, family, weight, color, spring = 'snappy', stagger = 0.035, rise = 0.6, by = 'char', mask = false, delay = 0, alpha, align, baseline, style, tracking })` | Per-character (`by: 'word'` per word) spring-in; `family` defaults to `brand.fonts.display`; `mask: true` clips to the line box; a negative `delay` opens mid-action; returns `{ width, left, right }` |
| `steppedText(g, str, x, y, p, { size = 64, family, weight, style, color, steps = units, by = 'char', snap = true, alpha, align, baseline, tracking })` | Stepped reveal: units appear whole, left to right, in `steps` hard steps; no fade, no rise. `p` 0..1 from `c.frameLt`; `p <= 0` or NaN draws nothing; same layout and `brand.fonts.display` default as `kinetic()`; `snap` rounds x and y to integers; records the whole string for the font check; returns `{ width, left, right }` |
| `textWidth(g, str, cssFont, tracking = 0)` | Width of a run |
| `wrapText(g, text, maxW, cssFont, { tracking = 0, maxLines, ellipsis = false, breakWords = 'space' })` | `string[]` of lines: breaks at spaces, cuts an over-long word between characters, never inside a Hangul syllable, keeps closing marks off the line start. Place the lines yourself: `y + i * lineHeight * size` with `lineHeight >= 1.2` |
| `fitFontSize(g, text \| lines[], maxW, (size) => cssFont, lo = 8, hi = 1000, { tracking, step })` | Largest size that fits. `step: 16` quantizes DOWN to a multiple of 16 (bitmap fonts such as NeoDunggeunmo), never below 16 |
| `getFontDefaults()`, `setFontDefaults({ text, kinetic })` | The families used when `family` is left out (set from `brand.fonts` at boot) |

Korean and other CJK text needs a font that has the glyphs (`npm run fonts -- coverage`). Draw pixel fonts at multiples of
their grid (16, 32, 48 ...) at integer positions.

### The two font lists

| List | File | Written by | Read by |
|---|---|---|---|
| `fonts.json` | `assets/fonts/fonts.json` (array of `{ family, src, weight, style, ... }`) | `npm run fonts -- add` / `add-file` / `remove` (`tools/fonts.mjs`) | `loadFonts` in `lib/fonts.js`, always |
| `"fonts": []` | top level of `studio.json` (same entry shape) | by hand | `loadFonts(cfg.fonts)` in `lib/runtime.js`, validated by `validateConfig` (`tools/studio.mjs`: an array, each item with string `family` and `src`) |

`loadFonts` concatenates the manifest entries first and the `studio.json` entries after them, then drops exact duplicates (same
family, weight, style, `src`, `unicodeRange`). Everything left becomes one `FontFace` and is loaded before the first frame; there is
no precedence between the lists. Two entries for the same family and weight with different `src` both register (the browser then
picks one, which is not deterministic across builds). Use `fonts.json` only and leave `studio.json` `"fonts"` as `[]`: the CLI only
writes and removes `fonts.json` entries (`fonts coverage` checks both lists), so an entry hand-added to `studio.json` is never
updated or removed by `npm run fonts`.

### Text-use registry (`lib/draw.js`, `window.__studio`)

The critique's glyph check. Off by default; `window.__TEXT_TRACK__ = true` before the page loads (or `?texttrack=1`) turns it on
and never changes a pixel.

| Call | Meaning |
|---|---|
| `window.__studio.textUse()` | Promise of `[{ family, weight, style, chars }]`: what `text()`, `kinetic()` and `textWidth()` (so `wrapText()` and `fitFontSize()`) drew with which font, `chars` = the sorted distinct non-whitespace characters. Only what the frames painted so far drew: `seek()` through the film first. `[]` while tracking is off |
| `window.__studio.coverage(family, weight = '400', style = 'normal', chars)` | Promise of `{ missing, checked }`: the characters of `chars` that face cannot draw (`missing` = a sorted string, `''` = all covered). Call it after `await window.__studio.ready` |
| `window.__studio.textTrack` | `true` while the registry records |
| `recordText(str, cssFont)`, `setTextTracking(on)`, `isTextTracking()`, `resetTextUse()`, `getTextUse()` | From `lib/draw.js`. Call `recordText` for text you draw with `g.fillText` yourself (a no-op while tracking is off); `text()` and `kinetic()` do not throw for an unregistered family, the critique reports it |

`npm run critique` uses these and raises a P0 `font-fallback` for every font row with a missing glyph, or with a family that is
not registered; register a font that covers the text (`npm run fonts -- add-file`) and run it again.

## Shapes, effects, color (`lib/draw.js`)

`fillRoundRect(g, x, y, w, h, r, color)` · `strokeRoundRect(g, x, y, w, h, r, color, width = 2)` · `circle(g, x, y, r, color)` ·
`clipRect(g, x, y, w, h, fn)` · `maskReveal(g, { x, y, w, h }, p, dir = 'up', fn)` ·
`scanReveal(g, { x, y, w, h }, p, { steps = 6, dir = 'down' }, fn)` (clip rect grown in hard steps, same `dir` names as `maskReveal`, edges rounded to integers, `p` from `c.frameLt`, returns the quantized progress) · `stepProgress(p, steps = 6)` (`p` rounded up to `steps` steps; 0 only at `p <= 0`, NaN -> 0) · `lineProgress(g, points, p, { width, color, cap, join })` (returns the tip) ·
`ring(g, x, y, r, p, { width, color, start, cap })` · `cursor(g, x, y, { scale, pressed, fill, stroke })` ·
`withAlpha(g, a, fn)` · `withTransform(g, { x, y, s, sx, sy, r, ox, oy }, fn)` (scale around a point: `{ x: cx, y: cy, ox: cx, oy: cy, s: 1.2 }`) ·
`grain(g, W, H, frameIndex, { amount = 0.05, seed = 1, cell = 2 })` (pass `c.frame`) · `vignette(g, W, H, { strength = 0.35, color })` ·
`mixColor(a, b, p)` · `rgba(color, alpha)` · `parseColor(c)` (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` with numbers or percentages; anything else throws).

## Layout (`lib/layout.js`)

`L = c.L` (or `ctx.L`): `u` (size unit), `S` (safe rect `{ x, y, w, h }`), `cx`, `cy`, `orientation`, `portrait`, `landscape`, `square`,
`pos(ax, ay)` (point inside `S`, 0..1), `pick({ '9x16': a, '1x1': b, '16x9': c, portrait, landscape, square, default })`,
`split(dir = 'auto', ratio = 0.5, gap = 0)` -> `{ dir, a, b }` (stacked in portrait and square, side by side in landscape),
`cols(n, gap)` -> `[{ x, w }]`, `rows(n, gap)` -> `[{ y, h }]`. Never use literal pixel positions.

## Motion (`lib/motion.js`) and randomness (`lib/rng.js`)

| Call | Meaning |
|---|---|
| `sp(t, preset = 'default')` | Spring 0 to 1, `t` = time since release; 0 before. Presets `snappy`, `default`, `heavy`, `playful` |
| `track(t, keys, spring)` | Value with several targets: `keys = [[time, value, spring?], ...]`, `keys[0]` is the rest value |
| `loopTrack(t, keys, dur, spring, cycles)` | Seamless loops: key times in `0..dur`, last value equals the first |
| `indicator(t, stops, { width })` -> `{ left, right }` · `swapAlpha(t, tIn, tOut)` | Stretching tab indicator; alpha for content inside a morphing box |
| `springFromFeel({ duration, bounce })` · `stagger(i, step = 0.03)` · `stepTime(t, rate = 12)` | Apple-style spring; delay of item i; "on twos" (use `c.frameLt`, drawings only) |
| `{ zeta, freq }` anywhere a spring goes · `springFromRatio({ zeta, freq })` · `ratioFromSpring(spec)` | Damping ratio and natural frequency (Hz): `track(t, keys, { zeta: 0.6, freq: 2 })` |
| `tween(t, t0, dur, from, to, ease = 'outQuint')` · `EASES` · `resolveEase(e)` · `cubicBezier(x1, y1, x2, y2)` | Timed move on a named curve (`outExpo`, `outQuint`, `outCubic`, `outBack`, `inOutQuart`, `inOutCubic`, `inExpo`, `inQuint`, `linear`) or `[x1, y1, x2, y2]` |
| `windup(t, at, { lead, depth, spring })` · `squash(s, { preserve })` -> `{ along, across }` | Anticipation (dip, then spring to 1 from `at`); squash and stretch that keeps area or volume |
| `loopWave(t, dur, cycles, phase)` · `loopNoise(t, dur, { radius, seed, offset })` (rng.js) | Periodic sine with whole cycles; noise sampled on a circle, so t = 0 and t = dur match |
| `holdTime(words)` · `framesPerBeat(fps, bpm)` | Minimum text hold (0.3 s per word + 0.5 s); frames per beat (round each beat's own time, never a stepped count) |
| `clamp`, `lerp`, `invLerp`, `remap`, `smoothstep`, `easeOutCubic` | Scalars; `easeOutCubic` only for opacity fades |
| `rngFor(...parts)`, `range(r, a, b)`, `pick(r, arr)`, `shuffle(r, arr)`, `noise1(x, seed)`, `noise2(x, y, seed)` | Seeded randomness: one stream per element, created inside the draw |

## Probes and checks (`lib/timeline.js`, `lib/checks.js`)

Numbers the spec promises are proved, not eyeballed. Inside any draw, `c.probe(name, value)` records a value for the frame
being painted: a finite number, a boolean (0/1) or `[x, y, z?, w?]` (stored as `name.x`, `name.y` ...). It is a no-op outside
`npm run probe` and the critique, never changes a pixel, and names are film-wide (prefix chapter probes; inside a replay such
as `paintAt`, guard with `!c.depth`). The film factory may return `checks: [...]` or `(grid, ctx) => [...]`:

| Kind | Shape | Passes when |
|---|---|---|
| point | `{ name?, probe, at \| frame, eq \| near, tol = 1e-3, min?, max? }` | the value at that time is within `tol` of `eq` (and inside `min`/`max`) |
| range | `{ name?, probe, from, to, min?, max? }` | every frame in `[from, to)` stays inside `min`/`max` |
| event | `{ name?, probe, crosses, at \| frame, tolFrames = 0, dir = 'any' \| 'up' \| 'down', from? }` | the first crossing of `crosses` lands on that frame ± `tolFrames` (foot contact, light on, label in) |
| smooth | `{ name?, probe, kind: 'smooth', from?, to?, maxKink = 4, allow = [] }` | no velocity kink or jump (shot boundaries and `allow` times excused) |

Times are seconds from `grid` (`grid.beat(8)`); `frame` is an output-frame index at the film fps. Loop films also get a seam
check per probe: value and velocity across frame N−1 → 0. A failing check is a P0 in the critique; `npm run probe` draws
`motion.png` and, with `--onion A:B`, `onion.png`. Runtime: `window.renderAt(t)` (= `seek`), `__studio.probes(t)`,
`__studio.probeRun({ from, to, fps })`, `__studio.checks()`; `index.html?render&t=2.5` paints that time.

## GL layers: 3D and shaders (`lib/gl.js`, `lib/three-layer.js`)

A GL layer is a scene draw: it paints an offscreen WebGL2 canvas and composites it with `drawImage` in the current
transform, so layers, cues, motion blur and every format work unchanged. Full guide: the `gl-scenes` skill.

| Call | Meaning |
|---|---|
| `glLayer({ frag, uniforms, textures, scale = 1, name })` -> `{ draw(g, lt, c), dispose() }` | One GLSL ES 3.00 fragment shader writing `fragColor`; `scene(0, 6, 'blob', layer.draw)` |
| built-in uniforms (declared only when used) | `uTime` (`c.t`), `uLt`, `uP`, `uFrame`, `uRes` (device px), `uDur` |
| `uniforms(t, c, lt)` -> `{ name: value }` | Converted by the declared GLSL type: numbers, arrays (vec/mat, uniform arrays), `'#rrggbb'` -> vec3, booleans |
| `sdfText(text, { font, weight, style, size, pad, letterSpacing })` | Signed distance texture of text (exact EDT) for extruded or melting type: `textures: { uText: sdfText('MOTION', {...}) }` |
| `GLSL.sdf` · `GLSL.raymarch` · `GLSL.lighting` · `GLSL.color` · `GLSL.noise` · `GLSL.text` | Chunks: shapes + `smin`; `march`, `calcNormal`, `softShadow`, `ao`; `fresnelSchlick`, `envStudio`; tonemap; `loopNoise`; `textSdf` |
| `threeLayer(THREE, { setup, update, fov = 30, toneMapping = 'aces', exposure, background, shadows, scale })` | Three.js inside a scene: `setup` once (synchronous), `update(t, ctx)` sets every transform from `t` |
| `studioEnv(THREE, renderer, { panels, room, blur })` | Reflection-only softbox environment (chrome reads as chrome, white stays white) |
| `glInfo()` | `{ renderer, version }` (SwiftShader under `"gl": "software"`) |

Rules: time enters only through uniforms or `update(t)`; no `THREE.Clock`, `setAnimationLoop` or accumulating state;
noise loops via `loopNoise`. `studio.json` `"gl": "software"` (default) renders WebGL on SwiftShader so frames hash the same
on every machine; `"gpu"` is faster but not reproducible. Three.js: `npm run three:add` (pins 0.160.0); `index.html`
maps `three` and `three/addons/`. Cost is per pixel and per subframe: `scale: 0.5` for drafts, `subframes: 2` for GL finals.

## Opening on content

Frame 0 must already show content (the critique flags an empty frame 0 as a P0). A spring released at the scene start is 0 at
`lt = 0`, so type and opacity driven by it are absent on the first frame. Release before the scene instead:
`kinetic(g, 'HOOK', x, y, lt + 0.3, { ... })`, `sp(lt + 0.3, 'snappy')`, or `kinetic(..., { delay: -0.3 })`. Position and scale springs
(`lerp(from, to, sp(lt - 0.15))`) start visible and need no shift. `film/film.js` shows the pattern: `HOOK_START` holds negative
start times.
