# Motion studio house rules

This folder is a film made in code. These rules apply to every film made here. `studio.json` holds the title,
duration, fps, BPM, formats, brand, audio targets and the critique gate: read it before changing anything.
API: `docs/API.md` has every `lib/` signature and default; the full reference is `docs/ARCHITECTURE.md` in the
motion-studio plugin repository (film API in section 5, libraries in section 6).

## Render contract
- A film is a pure function of time. `film/film.js` returns scenes and cues; `lib/runtime.js` exposes `window.seek(t)`
  and `window.__studio`. Any frame must render correctly on its own, in any order, in any page.
- In `film/` and `lib/`: no `Math.random`, `Date`, `performance.now`, `setTimeout`/`setInterval`,
  `requestAnimationFrame`, CSS transitions or animations, and no state carried between frames. Seeded randomness only:
  `rngFor(name, i)` per element, never one shared stream.
- Fonts and images come from `assets/` (fonts are bundled and asserted by `loadFonts`). No network at render time.
- Draw through the layout `L` (`L.u`, `L.S`, `L.pos()`, `L.pick()`, `L.split()`), never literal pixel positions.
- Render only with `tools/render.mjs`: http server, CPU canvas, in-page motion blur, H.264 yuv420p BT.709, CRF 16.
- `npm run lint` stays clean. The plugin hook lints every edit to `film/`, `lib/` and `index.html`.
- With motion blur `c.t`/`lt` are the subframe time being painted; `c.frame` (output frame index), `c.frameT` and
  `c.frameLt` are identical for every subframe. Use `c.frame` for `grain()` and `stepTime(c.frameLt, 12)` for "on twos".
  Stepped reveals (`scanReveal`, `steppedText`) also take `c.frameLt`; springs and blur-friendly motion take `lt`. Table: `docs/API.md` "Which clock".

## Look
- Banned defaults: centered title on a gradient, everything fading in, corner labels, frame borders, glow on UI
  chrome, generic particle bursts.
- One display face and one UI face (`brand.fonts`). One accent color unless the brief says otherwise. `tracking` in
  `text()` and `kinetic()` is in em (0.02 = 2% of the font size), not pixels.
- Frame 0 already shows content; open mid-action. A spring released at the scene start is 0 at `lt = 0`, so type or
  opacity driven by it is missing on frame 0 (the critique flags a P0). Release it before the scene:
  `kinetic(g, str, x, y, lt + 0.3, ...)`, `sp(lt + 0.3)`, or `{ delay: -0.3 }`. Position and scale springs start visible.
- Something new happens on screen every 2 to 4 seconds. No dead beat.
- Real product UI only (from `assets/`). Never redraw a product's UI from imagination.
- Reframe type and UI per format with `L.pick()` / `L.split()`. Never crop one format out of another.

## Motion
- Springs from `lib/motion.js` for everything that moves: `sp(t, preset)`, `track()`, `springFromFeel()`. No linear
  slides. `easeOutCubic` only for pure opacity fades. Tiny overshoot on UI (`snappy`), none on type (`default`,
  `heavy`). `playful` only for mascots and stickers.
- A value with more than one target uses `track(t, keys)`: one spring per change. Never restart a spring.
- Loops use `loopTrack()`: key times in `0..duration` (never wrapped; outside throws), last value equals the first.
  A key exactly at `duration` is the seam change (frame 0 shows the pre-seam value and eases to the first). Frame 0
  equals frame `duration`, position and velocity included (the critique compares `hash(0)` with
  `hash(duration, { wrap: false })`).
- Text inside a morphing container uses `swapAlpha()`: in after the morph starts, out before the next one.
- `stepTime()` ("on twos") only for drawings, never for camera moves or global fades. No `will-change` on anything
  the camera scales (blurry text).
- Chrome's CPU canvas snaps glyphs under about 256 device px to whole pixels vertically, so a slow sub-pixel vertical
  drift of text moves in visible 1 px steps (the critique pop scan can flag it). Move type with a spring or a fast
  move, or hold it still. Judge it at scale 1, not on a `--scale 0.5` draft.
- Film-wide captions and seam transitions go in the factory's `overlays: Scene[]` (painted after every scene, never
  counted as shots); `scene({ ..., layer })` orders ordinary scenes by `(layer, from)`. Do not wrap every `draw`.

## Sound
- Music and SFX are synthesized in code (`npm run score`, `npm run sfx`) unless a track is supplied. A supplied track
  is measured (`npm run beats -- audio/<track>`) and used unchanged. `score --if-missing` (part of `npm run build`)
  keeps a supplied track and regenerates a score it made when duration, bpm or style changed.
- Scene changes on downbeats (`grid.bar(n)`), SFX on beats (`grid.beat(n)`), accents on measured hits:
  `grid.hits` / `grid.hitsIn(a, b)` (from `audio/beats.json`; never fetch that file yourself).
- Cues live in the film (`cues` in the factory or a chapter); `sfx.mjs` reads them from the page. Take every time
  from the grid; never type a time the grid can give you. A cue's `t` is where the sound lands: the transient for
  hits, the peak for `whoosh` and `swoosh`. A `riser` starts on its cue and arrives on the next `hit`, `thump` or
  `snap` 0.4 to 4 s later (else it lasts 1.6 s), so cue it a bar before the impact.
- Master: -14 LUFS integrated +-0.5, true peak <= -1 dBTP, audio exactly as long as the video (`npm run mix`;
  never `-shortest`). `mix` measures every stem first and refuses one that is short, empty or silent (a silent sfx stem only warns).
  A span of 1 s or more below -50 dB is a P1 `audio-gap` in `critique --video` and a failing `silence` check in `deliver`: fix the stem.

## Fonts, Korean and other CJK text
- The bundled Instrument Serif and Inter have no Hangul, kana or Han glyphs: such text falls back to a system font
  (different on every machine) or draws tofu. Register a font that has them before writing the text.
- Own file: `npm run fonts -- add-file <path|https-url> --family "Name" [--weight 400] [--license-file <path|url>]
  [--license "SIL OFL 1.1"]` (format read from magic bytes; the license text is copied next to it, and without one
  you get a warning: check the license before publishing). Prefer one full Hangul woff2. Google's CJK families come in
  about 100 slices: `npm run fonts -- add "Noto Sans KR:400" --subsets korean,latin` (needs `--yes` above 12 files).
- Before drawing: `npm run fonts -- coverage --text "안녕하세요" --family "Name"` (or `--text-file film/film.js`). Exit 1
  lists characters with no glyph (tofu or a silent system fallback). Then set `brand.fonts` to the family.
- Two font lists exist: `assets/fonts/fonts.json` (written by `npm run fonts`) and `studio.json` `"fonts": []` (hand-written extra
  FontFace items, merged after the manifest by `loadFonts`, exact duplicates dropped). Use `fonts.json` only; keep `studio.json` `"fonts"` `[]`.
- A call without `family` draws `brand.fonts.ui` (`text`, `font`) or `brand.fonts.display` (`kinetic`); without `weight`
  it takes the nearest weight the family has (a 400-only face is never faked bold). Pass only a weight the family has.
- Multi-line copy: `wrapText(g, text, maxW, font(size, family))` breaks at spaces and never inside a Hangul syllable;
  place the lines at `y + i * lineHeight * size`, lineHeight >= 1.2. Latin and digits are half-width, Hangul is
  full-width: measure with `textWidth()`.
- `npm run critique` (live) checks every character the film really draws: `text()`, `kinetic()` and `textWidth()` record them,
  and a character with no glyph in its font, or a `family` that is not registered, is a P0 `font-fallback` (`text()` never throws
  for a family, so the critique is where it shows). It blocks the gate until a font that covers the text is registered. Text drawn
  with `g.fillText` directly is seen only if you call `recordText(str, cssFont)` from `lib/draw.js`.
- Bitmap or pixel fonts (NeoDunggeunmo) are crisp only at multiples of their pixel grid (16, 32, 48, 64, 80, 96) at
  integer `x`/`y`: `fitFontSize(g, text, maxW, makeFont, 16, 200, { step: 16 })` returns such a size; `Math.round`
  positions. No non-integer camera zoom on such text: hold an integer size or cross-fade.

## Loop before you show me anything
1. Build the evidence, then LOOK. When cues, music or picture timing changed: `node tools/render.mjs --format <fmt>
   --draft --sub 1 --scale 0.5`, `npm run sfx`, `node tools/mix.mjs --format <fmt>`. Then `npm run critique` (live
   film, `out/review/<fmt>/`) and `node tools/critique.mjs --format <fmt> --video out/<fmt>/final.mp4` (the mix,
   `out/review/<fmt>/video/`; sound is scored from it). Open every PNG and every page of a paged sheet (`contact.png`, then
   `contact-2.png` ...). Be a harsh motion director, not a proud author.
2. Score 1 to 10 on seven axes: hook, readability, motion, variety, composition, brand, sound. `na` counts only on
   axes in `gate.naAllowed` (default `["brand"]`); `sound=na` in the last round fails the gate.
3. List problems as P0/P1/P2 with timestamps `[mm:ss.cc]`. Append the round to `docs/review_log.md` in its exact
   block format. The `motion-critic` subagent does this step when it is available. Any P0 token in the last round
   is an open P0 until a `FIXES:` line `<n>. fixed|resolved|wontfix` closes it.
4. Fix the 3 worst problems, every P0 first. Re-check only the affected seconds (`node tools/stills.mjs --at ...`).
5. Repeat until at least 3 rounds are logged, every axis is 8 or more, and no P0 is open (`npm run gate`).
6. Only then `npm run render:final` (or `npm run build`). The plugin blocks a final render that fails the gate.
Never raise a score without new evidence, never edit an old round, never turn the gate off. Only the user may set
`gate.enabled` to false.

## Files and commands
| Path or command | Purpose |
|---|---|
| `studio.json` | title, duration, fps, bpm, formats, brand, audio targets, gate |
| `film/film.js`, `film/scenes/chNN_*.js` | the film; chapters for long films (one owner per chapter file) |
| `lib/`, `tools/` | engine library (change with care), CLI tools behind the npm scripts |
| `docs/` | `API.md`; `style_guide.md`, `shotlist.md` (approve before code); `STORYBOARD.md`, `ANIMATION_GUIDE.md`; `review_log.md` (read by `npm run gate`) |
| `prompts/` | `critique-pass.txt` (harsh-director review), `refactor-springs.txt` (easing to springs) |
| `npm run preview` · `doctor` | live preview (scrub, Space, arrows, `[` `]` shots, F formats, G safe-area guides) · environment check |
| `npm run stills` · `critique` · `animatic` | contact sheet per beat (`contact.png`, then `contact-2.png`... past 1800 px; `--from/--to`) · review evidence and metrics (`--from/--to` for one chapter) · half-scale 30 fps draft |
| `npm run render` · `render:all` · `render:final` | primary format · every format (not gated) · final of every format (gated) |
| `npm run score` · `beats` · `sfx` · `voice` · `mix` | music · beat grid · SFX · voice · master and mux |
| `npm run fonts` · `refs` | add, add-file, coverage, list, remove fonts · extract and analyze a reference video |
| `npm run lint` · `gate` · `deliver` · `build` | determinism lint · critique gate · delivery checks and `out/deliver/` · score if missing, sfx, final render, mix, deliver |
Check renders of a range go to `out/check/` (`node tools/render.mjs --from 4 --to 6 --draft --out out/check` writes
`clip_4.00-6.00.mp4`); `out/<format>/` holds only the full film. If a player holds an output open, the finished render
stays in `out/<format>/.staging/` (`cannot replace ... EBUSY`): close the player and copy it, do not delete it.

## Long commands, effort, keys, routes
- `render:final`, `build`, `mix`, `deliver` and a critique of a long film take minutes (the 12 s demo in three formats
  renders in about 4 min). Run them in the background with a log (`(cmd > out/x.log 2>&1; echo "exit $?" >> out/x.log)`),
  poll `tail -n 3 out/x.log`, never wait in the foreground for more than about 2 minutes, add `--chunk 10` to a long final.
- Browser: the tools start Playwright's headless shell on Windows (`npx playwright install chromium-headless-shell`), and
  Chrome, Edge, then the bundled one elsewhere. On Windows never start an installed Chrome or Edge (no `channel: 'chrome'` or
  `'msedge'`, no `chrome.exe` path, no `studio.json` `browser: "chrome"`): each fresh-profile launch counts as a failed Windows
  logon and can lock the account. Start browsers in your own scripts with `launchBrowser` from `tools/studio.mjs`. The shell is
  slow to start under a real-time antivirus (15 to 25 s per tool run, measured): expect it, do not switch browsers to avoid it.
- Effort: medium for small fixes, re-renders and sound tweaks; xhigh for a new film or chapter; max for flagship pieces
  where the first 3 seconds carry a launch. Set it with `/model`.
- API keys live only in `.env` (`ELEVENLABS_API_KEY`, `FAL_KEY`; see `.env.example`). Refer to them by variable name;
  never print, paste, log or commit a key. `.env` is git-ignored; the tools read it themselves.
- Route A (default): this engine. Route B only when the user names Remotion or HyperFrames (`/motion-studio:seek-engine`;
  Node 22+; Remotion needs a Company License for for-profit organizations with more than 3 employees). Route C
  (generate-then-trace) only when the brief selects it, with keys in `.env` and a stated budget.
