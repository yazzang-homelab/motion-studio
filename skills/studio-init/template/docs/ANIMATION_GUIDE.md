# Animation guide: <film title>

<!--
Template. The director (main session or the motion-director subagent) fills this in BEFORE any chapter-animator
starts, so every chapter is coded the same way. Chapter animators read it first and follow it exactly.
Replace every <...>, delete these comments when done, and link to docs/style_guide.md and docs/STORYBOARD.md instead
of repeating them. Aim for a guide someone can read in one pass.
-->

## 0. The film

- Logline: <one line>
- Duration <seconds> · fps <60> · formats <9x16, 1x1, 16x9> · <BPM> BPM, grid <measured from audio/track.wav | synthesized>
- Look: `docs/style_guide.md`. Shot plan: `docs/STORYBOARD.md`. House rules: `CLAUDE.md`.
- The user's direction, verbatim (quote it; paraphrase drifts): "<...>"

## 1. How a chapter works

One chapter is one file, `film/scenes/chNN_<name>.js`. Its default export takes the film context and returns
`chapter({...})`. `film/film.js` imports every chapter and puts the results in `scenes`; you never edit `film.js`.

```js
import { chapter } from '../../lib/timeline.js';
import { sp, track, swapAlpha } from '../../lib/motion.js';
import { text, kinetic, fillRoundRect, withAlpha } from '../../lib/draw.js';
import { rngFor, range } from '../../lib/rng.js';

// Chapter span in bars (downbeat indices) from docs/STORYBOARD.md. 0 = the film start, null = the film end.
export const BARS = [<a>, <b>];

// Private helpers live inside this file.
function card(g, x, y, w, h, c) { fillRoundRect(g, x, y, w, h, 24 * c.L.u, c.brand.colors.fg); }

export default function chNN(ctx) {
  const { grid } = ctx;
  const FROM = BARS[0] === 0 ? 0 : grid.bar(BARS[0]);
  const TO = BARS[1] == null ? ctx.dur : grid.bar(BARS[1]);
  return chapter({
    name: 'chNN_<name>', from: FROM, to: TO,
    shots: [
      { at: FROM, name: '<shot>', draw(g, lt, c) { /* paint this shot; lt = seconds since the shot started */ } },
      { at: grid.bar(BARS[0] + 1), name: '<shot>', draw(g, lt, c) { /* ... */ } },
    ],
    cues: [{ t: FROM, type: 'thump' }, { t: grid.beat(<n>), type: 'click' }],
  });
}
```

- Chapter spans are bars, and every time inside comes from the grid (`grid.bar(n)`, `grid.beat(n)`), never typed
  seconds. With a measured track the grid moves (the first downbeat can sit at 0.75 s or 2.0 s instead of 0), and a
  shot whose `at` falls outside `FROM..TO` makes `chapter()` throw, so the whole film stops loading. Seconds in the
  storyboard are for reading only.
- `at` is film time in seconds. A shot runs until the next shot's `at` (the last one until `TO`).
- `draw(g, lt, c)`: `g` is the canvas context in logical pixels of the current format; `c` holds `t` (film time), `lt`, `p`
  (0 to 1 through the shot), `dur`, `W`, `H`, `u`, `L`, `grid`, `brand`, `fps`, `frame`, `film`, and for motion blur `frameT`,
  `frameLt`, `sub`, `subs`. With blur on, `t` and `lt` are the SUBFRAME time being painted (motion blurs by itself);
  `frameT`, `frameLt` and `frame` (the output frame index) are the same for every subframe. `docs/API.md` lists the rest.
- The timeline paints the background first, then every shot, then the film's `overlays` (a `Scene[]` in the factory
  of `film/film.js`) on top of all of them: <list them: captions, seam transitions>. Overlays are not shots. Leave room
  for them; never draw them yourself.
- A chapter with no shots paints a placeholder card; that is how your stub looks until you land shots.

Frames render in parallel, out of order, in several browser pages. Every shot is a pure function of time:
- every value comes from `lt` or `c.t`; no `Math.random`, `Date`, `performance.now`, timers, `requestAnimationFrame`,
  CSS transitions;
- randomness from `rngFor('<chapter>/<element>', i)` created inside the draw, one stream per element;
- nothing written to module-level variables inside a draw (precompute constants at the top of the file);
- `npm run lint` must stay clean (the plugin hook lints each edit).

## 2. Ownership

- You own exactly one file: your `film/scenes/chNN_<name>.js`. Check stills go to `out/check/`.
- Shared and read-only for chapter animators: `lib/**`, `film/film.js`, `film/scenes/shared_*.js`, `index.html`,
  `studio.json`, `tools/**`, `docs/**`, `assets/**`.
- A helper you need is missing: write it privately inside your file.
- A shared file has a bug: do not edit it. Report file, line, what goes wrong and a time that shows it (section 8).
- Elements that appear in several chapters live in `film/scenes/shared_*.js` (owned by the director):
  <e.g. `import { hero } from './shared_hero.js'`>.

## 3. Canvas and layout

- Draw in logical pixels (`c.W` x `c.H`: 1080x1920, 1080x1080 or 1920x1080). Sizes are multiples of `c.L.u`
  (1 at a 1080 px short side), never literal pixels.
- Place with the safe rect: `c.L.S` (x, y, w, h), `c.L.pos(ax, ay)` (0 to 1 inside it), `c.L.split('auto', ratio, gap)`
  (stacked in portrait and square, side by side in 16:9), `c.L.cols(n, gap)`.
- Reframe per format with `c.L.pick({ '9x16': ..., '1x1': ..., '16x9': ..., default: ... })`; never crop.
- Reserved bands: <e.g. captions own the bottom 18% of the safe rect in every format; keep key action above it>.
- Frame 0 of the film must show content; the first frame of your chapter must already be mid-action or composed.

## 4. Shared API

| Need | Call |
|---|---|
| entrance, one move | `sp(lt - delay, 'snappy' \| 'default' \| 'heavy' \| 'playful')` |
| value with several targets | `track(c.t, [[t0, v0], [t1, v1], ...], preset)` |
| loop-safe value | `loopTrack(c.t, keys, c.film.dur, preset)` (key times in `0..c.film.dur`, last value == first; a key at `c.film.dur` is the seam change) |
| text inside a morphing box | `withAlpha(g, swapAlpha(c.t, tIn, tOut), () => ...)` |
| tab indicator | `indicator(c.t, stops, { width })` |
| kinetic type | `kinetic(g, str, x, y, lt, { size, family, weight, color, spring, stagger, by, mask, delay, alpha, align, baseline, tracking })`; a spring released at the shot start is 0 at `lt = 0`, so open the first shot with `lt + 0.3` or `delay: -0.3` |
| multi-line type | `wrapText(g, str, maxW, font(size, family), { tracking, maxLines, ellipsis })` -> lines (never cuts a Hangul syllable); `fitFontSize(g, str, maxW, makeFont, lo, hi, { tracking, step })` for the size (`step: 16` for bitmap fonts) |
| text, shapes | `text()`, `fillRoundRect()`, `strokeRoundRect()`, `ring()`, `lineProgress()`, `maskReveal()`, `clipRect()`, `cursor()` |
| color | `c.brand.colors.bg / fg / accent / muted`, `mixColor(a, b, p)`, `rgba(color, alpha)` |
| fonts | `c.brand.fonts.display`, `c.brand.fonts.ui` (registered in `assets/fonts/fonts.json`; the bundled two have no Hangul or other CJK glyphs: <the CJK family the director registered, if any>). `family` left out = `ui` for `text()` / `font()`, `display` for `kinetic()`; `weight` left out = the nearest weight the family has, so pass only a weight it has. The critique raises a P0 `font-fallback` for any character a font cannot draw and for a `family` that is not registered (`text()` never throws), so pass only registered families |
| texture | `grain(g, c.W, c.H, c.frame, { amount })` (`c.frame` = the output frame, identical in stills, preview and the blurred final), `vignette(g, c.W, c.H, { strength })` |
| drawings on twos | `stepTime(c.frameLt, 12)` (a hard cut between steps even with motion blur); drawings only, never camera or fades |
| seeded values | `rngFor(name, i)`, `range(r, a, b)`, `pick(r, arr)`, `noise1(x, seed)`, `noise2(x, y, seed)` |
| beat grid | `c.grid.beat(n)`, `c.grid.bar(n)`, `c.grid.nearest(t)`, `c.grid.beatsIn(a, b)`; measured accents `c.grid.hits`, `c.grid.hitsIn(a, b)` |
| shared elements | <list: module, function, arguments, states> |

## 5. Shared elements

| Element | Module | Call | States | Identity lock (never changes) |
|---|---|---|---|---|
| <hero> | `film/scenes/shared_hero.js` | `hero(g, x, y, size, { pose, face }, c)` | <idle, run, surprised> | <silhouette, colors, one signature detail> |

## 6. Style rules

- Palette and type: only the tokens above. One accent: <hex>.
- Motion presets by element class:

| Element class | Preset |
|---|---|
| buttons, toggles, cursor, leading edges | `snappy` |
| cards, containers, camera | `default` |
| hero type, logo, big objects | `heavy` |
| <mascot, stickers> | `playful` |

- Text: <big words on downbeats vs subtitles; max words per line; hold at least long enough to read once calmly>.
- Something new every 2 to 4 seconds; one focal action per shot; each read lands before the next beat changes it.
- Inside a chapter, transitions are <cut on action | match cut | ...>; transitions between chapters belong to `film.js`.
- Banned: centered title on a gradient, everything fading in, corner labels, frame borders, glow on UI chrome,
  generic particle bursts, <film-specific bans>.
- Paint-time budget: <N> fps for a draft render of your range. The director measures the rig first
  (`node tools/render.mjs --from A --to B --sub 1 --draft --out out/check/rig`) and sets N to about half of that.

## 7. Checking your work

Run these for your range and look at every image with the Read tool:

```
node tools/lint.mjs film/scenes/chNN_<name>.js
node tools/stills.mjs --at <from>,<t1>,<t2>,<to minus 0.02> --out out/check/chNN_<name>_a.png
node tools/stills.mjs --at <every 0.1 s around each hit> --out out/check/chNN_<name>_hits.png
node tools/stills.mjs --format 16x9 --at <t1>,<t2> --out out/check/chNN_<name>_16x9.png
node tools/render.mjs --from <from> --to <to> --sub 1 --draft --out out/check/chNN
```

Check: the first and last frame of every shot; motion across consecutive times around each hit; the hand-off into and
out of your chapter; nothing inside the reserved bands; every word readable at phone size; each format reframed.
Several animators can render at once; always use your own file names under `out/check/`.

## 8. Report back

Return this block to the director (subagents cannot ask the user; put questions here):

```
CHAPTER: chNN_<name> (<from>-<to> s)
BUILT: <shots, one line each>
CHECKS: lint <clean | problems>; stills <paths>; draft render <fps>
KNOWN ISSUES: <what still looks wrong, with times>
SHARED-FILE BUGS: <file:line - what - time that shows it>
QUESTIONS: <for the director or the user>
```
