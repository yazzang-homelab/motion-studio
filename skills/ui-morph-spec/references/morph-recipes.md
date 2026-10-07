# Morph recipes

Code patterns for a one-shape UI morph, using the project's `lib/motion.js`, `lib/draw.js` and
`lib/timeline.js`. The complete, working film is `assets/morph-loop.film.js` in this skill: copy it
to `film/film.js`, set `studio.json` `"duration": 16, "loop": true`, and replace the states.

During development that film passed every automated check in `node tools/critique.mjs`: frames
identical across three passes (in order, shuffled, fresh page), `seek(0)` equal to `seek(duration)`
with a seam continuity ratio of 0.98, 22 of 22 cues within 25 ms of a beat, 7 of 7 shot changes on
downbeats, no dead spans, no pops, empty corners, and a composed frame 0.

## 1. States on downbeats

```js
const T = STATES.map((_, i) => grid.bar(i)); // state i starts on downbeat i
const LOOP = grid.bar(STATES.length);        // must equal studio.json duration
```

Take every time from the grid. A measured `audio/beats.json` then moves every state with the
music; a typed `2.0` would not. `node scripts/statelist.mjs` (this skill) prints the same times for
the approval table.

## 2. The container is a set of tracks

Every numeric property gets one spring per change. In a loop, write the keys like this:

```js
// keys[0] = the value just before the seam (the last state); then one change per downbeat,
// starting with the change at t = 0 back into the first state. First value == last value.
const loopKeys = (value) => [[0, value(n - 1)], ...STATES.map((_, i) => [T[i], value(i)])];
const val = (t, value, spring = 'default') => loopTrack(t, loopKeys(value), dur, spring);

const w = val(t, (i) => STATES[i].w) * k;
const h = val(t, (i) => STATES[i].h) * k;
const r = Math.min(val(t, (i) => STATES[i].r) * k, w / 2, h / 2);
```

Rules that follow from how `loopTrack` works:

| Rule | Why |
|---|---|
| key times stay in `[0, duration]` and are not wrapped | `loopTrack` throws for a time outside that range |
| the change that crosses the seam is written once: a key at the first downbeat (`t = 0` for a bar-aligned track), or a key exactly at `t = duration` | a key at `duration` is felt from `t = 0` of the next cycle, the same as the first-downbeat key, so use one of them |
| `keys[0]` holds the pre-seam value | its time is ignored; it is the rest value the first change starts from |
| the first and last values are equal | `loopTrack` throws otherwise, because the loop could not close |

Outside loops use `track(t, keys, spring)` with `keys = [[0, v0], [T1, v1], ...]`.

## 3. Colors

Track each channel, then rebuild the color:

```js
const rgbOf = (i) => parseColor(TOKENS[STATES[i].fill]);
const fillAt = (t) => {
  const [r, g, b] = [0, 1, 2].map((ch) => clamp(val(t, (i) => rgbOf(i)[ch]), 0, 255));
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
};
```

Clamp: a spring with overshoot can push a channel past 0 or 255. For a border that exists only on
some states, track its alpha the same way (`val(t, (i) => hasBorder(i) ? 1 : 0)`) instead of
switching it on and off.

## 4. Content swaps

```js
STATES.forEach((s, i) => {
  const a = swapAlpha(t, T[i], i + 1 < n ? T[i + 1] : LOOP);
  withAlpha(g, a, () => content[s.name](g, { lt: t - T[i], x, y, w, h }));
});
```

`swapAlpha` fades content in 0.08 to 0.2 s after its state starts and out 0.1 s before the next
state, so two labels never overlap and the seam frame shows only the container. Draw content inside
the same transform as the container, so a press squash or camera zoom moves both together.

## 5. The cursor drives every change

```js
const clickPoint = (i) => [cx + STATES[i].w * k * 0.28, cy + STATES[i].h * k * 0.22]; // on state i
const moveAt = (i) => grid.beat(i * grid.beatsPerBar + 1);                             // beat 2 of bar i
const moveKeys = (axis) => [[0, clickPoint(n - 1)[axis]], ...STATES.map((_, i) => [moveAt(i), clickPoint(i)[axis]])];
const px = loopTrack(t, moveKeys(0), dur, 'snappy');
const py = loopTrack(t, moveKeys(1), dur, 'snappy');

const near = (t, at) => { const d = Math.abs(loopT(t - at, dur)); return Math.min(d, dur - d); };
const pressed = Math.max(0, ...T.map((c) => 1 - near(t, c) / 0.12));
cursor(g, px, py, { scale: 1.3 * u, pressed });
```

The click on downbeat i happens on the element as it looks before the morph (state i - 1); the
cursor settles onto the new element one beat later. The circular distance in `near` makes the
press at t = 0 look the same as the press at t = duration.

## 6. Camera push per state

```js
const zoomOf = (i) => clamp(Math.min((L.S.w * 0.8) / (STATES[i].w * k), (L.S.h * 0.5) / (STATES[i].h * k)), 0.85, 2.2);
const cam = val(t, zoomOf);
withTransform(g, { x: cx, y: cy, ox: cx, oy: cy, s: cam * (1 - 0.035 * pressed) }, () => { /* container + content */ });
const toScreen = ([x, y]) => [cx + (x - cx) * cam, cy + (y - cy) * cam]; // cursor stays unscaled
```

Small states (a check, a loader) get pushed in so they read at phone size; wide states pull back.
Divide stroke widths by `cam` when a line must stay the same thickness on screen.

## 7. Stretching indicators

```js
const beatAt = (b) => grid.beat(i * grid.beatsPerBar + b) - T[i]; // beat b of state i, in local time
const hl = indicator(lt, [[0, rowY(0)], [beatAt(1), rowY(1)], [beatAt(2), rowY(2)]], { width: rowH });
fillRoundRect(g, x0, hl.left, rowW, hl.right - hl.left, radius, highlight);
```

The leading edge rides `snappy` and the trailing edge a softer spring, so the highlight stretches
while it moves and settles to its width. Works horizontally (tabs) and vertically (lists).

## 8. Typing, counting, drawing

| Moment | Pattern |
|---|---|
| typed field | `COPY.slice(0, Math.floor(clamp((lt - 0.25) / 1.2) * COPY.length))`; a caret that pulses with `0.5 + 0.5 * cos(2 pi f lt)` rather than a hard blink |
| counter | `Math.round(target * sp(lt - 0.35, 'snappy'))`, then print the exact final string once settled |
| chart line | `lineProgress(g, points, sp(lt - 0.15, { k: 60, d: 16 }), { width, color })` |
| tooltip on hover | `withAlpha(g, sp(lt - 1.0, 'snappy'), ...)`, one beat after the line lands |
| loader | `ring(g, cx, cy, r, clamp((lt - 0.1) / 1.6), { start: -Math.PI / 2 + lt * 5 })` |
| check mark | `lineProgress` over three points with `sp(lt - 0.12, 'snappy')` |

## 9. Drags (direct manipulation)

While the cursor holds, the value follows the cursor; on release it springs from wherever it was:

```js
function dragged(t, { t0, t1, rest, target, fromCursor }) {
  if (t < t0) return rest;
  if (t < t1) return fromCursor(t);                        // held: pure function of the cursor track
  const v1 = fromCursor(t1);                               // released here
  return v1 + (target - v1) * sp(t - t1, 'default');       // position-continuous spring back
}
```

`fromCursor` maps the cursor's tracked x or y to the control's value, so it stays a pure function
of time. Keep drags inside one state and away from the seam.

## 10. Sound on the grid

```js
const beatInBar = (i, b) => grid.beat(i * grid.beatsPerBar + b); // beat b (0-based) of state i's bar
const cues = [
  ...T.map((t) => ({ t, type: 'click', gain: 0.9 })),   // every press
  ...T.map((t) => ({ t, type: 'swoosh', gain: 0.35 })), // under every morph
  { t: beatInBar(4, 0), type: 'chime', gain: 0.6 },     // success check
];
```

Types: click, tick, pop, thump, whoosh, swoosh, riser, hit, chime, type, glitch, snap. The critique
reports the share of cues within 25 ms of a beat; aim for all of them.

## 11. Checks specific to morph loops

| Check | Where | Pass |
|---|---|---|
| seam | `out/review/<fmt>/loop.png`, metrics "loop seam" | `hash(0)` equals `hash(duration, { wrap: false })` (the `\|end - first\|` pane is black) and continuity ratio <= 1.5 |
| swaps | `contact.png` and `strip.png` around each downbeat | never two labels at once |
| cursor | `contact.png` | on the element it is about to click at every downbeat |
| state length | `node scripts/statelist.mjs` warnings | loop length equals `studio.json` duration; first state at 0 |
| formats | `node tools/stills.mjs --at <state mids> --format 16x9` and `1x1` | the widest state fits the safe rect |
