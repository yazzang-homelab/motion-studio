# Critique rubric

Seven axes, scored 1 to 10 by looking at rendered frames. The axis keys are the ones `studio.json` `gate.axes` lists
and `tools/gate.mjs` checks: `hook readability motion variety composition brand sound`. The course's step 11 prompt
defines these seven; its step 02 house rules list six (no composition) and its step 10 brief lists another seven
(depth and polish instead of variety and brand). This plugin uses the step 11 set everywhere.

## Scoring rules

1. Score the worst moment on the axis, not the average. One dead beat caps variety; one unreadable line caps
   readability.
2. 8 means "ready to ship". An axis with any P0 or P1 problem in the same round scores 7 or lower.
3. Scores need evidence from this round: a fresh `npm run critique` after the last fix. Carry nothing over.
4. `na` only when the axis cannot apply: `brand=na` for a showreel with no brand. The gate accepts `na` only on axes
   listed in `studio.json` `gate.naAllowed` (default `["brand"]`); any other `na` in the last round fails with `na not
   allowed for <axis>`. So never use `na` to skip a hard axis, and `sound=na` is never right for a film that ships
   with audio (only the user may list `sound` in `gate.naAllowed`, for a film that ships silent).
5. Hard caps (apply before anything else):

| Evidence | Cap |
|---|---|
| determinism mismatch in `metrics.md` | P0; motion <= 5 until fixed |
| `frame0` flagged (uniform background at t = 0) | hook <= 4 |
| dead span >= `critique.deadSpanSec` (2.0 s) | variety <= 6 |
| single-frame pop (`pops` kind `flicker`, P1) | motion <= 6 |
| corner content or a border flagged and confirmed by eye | composition <= 5 |
| centered title on a gradient | composition <= 4, hook <= 5 |
| text unreadable in `phone.png` | readability <= 5 |
| fallback font visible, or a `font-fallback` finding in the live `metrics.md` (P0: a character has no glyph in its font, or the family is not registered) | brand <= 5 (or readability <= 6 without a brand); P0 until a font that covers the text is registered |
| invented product UI | brand <= 4, P0 |
| loop film with a seam jump or a loop that does not close (`loop.png`, metrics `loop`) | motion <= 5, P0 |
| cue sync share below 0.8 with no listed reason | sound <= 6 |
| integrated loudness outside -14 LUFS +-0.5 or true peak above -1 dBTP (with `--video`, in `out/review/<fmt>/video/metrics.md`) | sound <= 6 |
| silent span of 1 s or more in the mix (`audio-gap`, P1, in `out/review/<fmt>/video/metrics.md`; `deliver` fails the same span as `silence`) | sound <= 7 (the P1 rule) until the stem is fixed |

## Anchors

| Axis | 4 | 6 | 8 | 10 |
|---|---|---|---|---|
| hook (first 2 s) | frame 0 empty, or a logo/title fading in on a flat or gradient field | moves at once but generic: centered text, stock reveal | frame 0 shows a strong partial composition; a clear event lands within the first second | an image nobody has seen, tied to the idea, hit on the first downbeat |
| readability (phone, 360 px wide) | key words unreadable, overlapping, or on busy ground; holds shorter than reading time | readable but cramped, weak contrast, one flicker in a swap | every word readable at 360 px, one focal point per shot, each line held long enough to read once calmly | hierarchy instant in every format; type sized per format |
| motion | linear slides, stock easing, teleports, jitter, pops | springs present but uniform; a velocity kink at a restart; an occasional pop | every move has mass: preset per element, overlap and stagger, continuous multi-target values, clean blur | choreographed: leading and trailing edges, anticipation, follow-through, invisible loop seam |
| variety | dead span >= 2 s, or one shot type repeated | changes happen but one technique or transition repeats | a new idea every 2-4 s, no dead span, transitions chosen per cut | every shot escalates or surprises; rhythm varies on purpose |
| composition | centered on gradient, corner labels, frame borders, cramped edges, outside the safe area | balanced but static, weak hierarchy, one format looks cropped | clear focal point, intentional negative space, grid alignment, every format reframed | every frame works as a poster; layered depth; the eye path flows across cuts |
| brand | wrong colors or fonts, invented UI, distorted logo | right palette with extra accents, system fonts, UI loosely redrawn | exact palette with one accent, bundled brand fonts, real UI, correct logo, clear CTA | feels like the brand's own launch film |
| sound | silent, static generic pad, cues off beat, clipping, far off target loudness | music present, SFX generic or unbalanced, some drift | cuts on downbeats, SFX on beats or hits within 25 ms, -14 LUFS +-0.5, <= -1 dBTP | sound tells the story, every hit on its visual event, arrangement builds to the drop |

## Severity

| Level | Meaning | Gate effect |
|---|---|---|
| P0 | broken or banned: determinism mismatch, blank or fallback-font frames (the tool's P0 `font-fallback`), frame 0 empty, overlapping or unreadable text at a key moment, banned default look, invented UI, wrong name or logo, loop seam jump, key content outside the safe area, clipping | any P0 in the last round fails the gate |
| P1 | clearly hurts the film: dead beat, sliding instead of easing, a pop or stutter, weak hook, cramped type, a cue more than one frame off its event, a cropped-looking format | caps the axis at 7, so the gate fails until fixed |
| P2 | polish: spacing, a timing nudge, color balance, grain, a long hold | no gate effect |

## Hunt list: where each problem shows up

| Problem | First place to look | Typical fix |
|---|---|---|
| text overlapping during swaps | `contact.png` around state changes, `strip.png` | `swapAlpha(t, tIn, tOut)`; content in after the morph starts, out before the next |
| sliding instead of easing, spring restarts | `strip.png` spacing between frames | `sp()` / `track()` (`prompts/refactor-springs.txt`) |
| corner labels, frame borders | metrics `corners` / `borders`, then look | delete them; move the information into the composition |
| centered title on a gradient | `shots.png` | off-center layout with `L.pos()`, flat brand background, texture with `grain()` |
| blurry scaled text | `phone.png`, full-size stills | draw at the target font size instead of scaling the context |
| dead beat | metrics `deadSpans`, `contact.png` | add an event on that beat (`grid.beatsIn(a, b)`), a camera push or a stagger |
| loop seam stutter | `loop.png` (`\|last - first\|` should look like one normal step, `\|end - first\|` should be black), metrics `loop` | `loopTrack()` with keys in `0..dur`, last value == first, the seam change written once (at `0` or at `dur`); other springs wrapped with `loopT` alone are the usual culprit |
| single-frame pop, hard jump | metrics `pops` (`flicker` = one odd frame, P1; `jump` = a spike against its neighbours, P2), `strip.png` via `--strip-at` | a discontinuity: scene windows that do not meet, a restarted spring, a key time typo, text or digits that flip. A stepped (pixel-art) film sets `critique.stepped: true` (jumps become info, flicker stays P1) and `critique.popIgnore: [[t0, t1], ...]`; `metrics.md` lists what was suppressed |
| frame 0 empty | metrics `frame0` | release the hook before 0: `sp(lt + 0.3)`, `kinetic(g, str, x, y, lt + 0.3, ...)` or `{ delay: -0.3 }`, so frame 0 is mid-motion. A spring released at `lt = 0` draws no type and no opacity on the first frame; position and scale springs start visible. A gradient or vignette with nothing on it still reads as empty |
| everything fading in | `contact.png` first frames of each shot | enter with motion (position, scale, mask reveal), not opacity alone |
| fallback font | metrics `fonts` (P0 `font-fallback`: names the family, weight and the missing characters), then a full-size still vs `docs/style_guide.md` | bundle it (`npm run fonts -- add` or `add-file`), use `brand.fonts` names; Korean or other CJK text needs a font that has the glyphs (`npm run fonts -- coverage --text "..." --family "Name"`); re-run the live critique to clear the finding |
| silence in the mix | `out/review/<fmt>/video/metrics.md` audio row (WARN) and the P1 `audio-gap` line, `npm run deliver` check `silence` | a stem ends early or a bed plays under nothing: regenerate it (`npm run score`, `sfx`, `voice`) and `npm run mix` |
| outside the safe area | `npm run preview`, press G | position with `L.S` / `L.pos()` |
| cropped-looking format | stills per format (`npm run stills -- --format 1x1`) | reframe with `L.pick()` / `L.split()` |
| cue off the grid | metrics `sync` | derive cue times from `grid.beat(n)` / `grid.bar(n)` |

## Output block (parsed by tools/gate.mjs)

```
## Round 2 — 9x16 — tightened the loader swap, new chart entrance
SCORES: hook=8 readability=7 motion=8 variety=8 composition=8 brand=na sound=7
PROBLEMS:
1. [P1] [00:04.20] text overlaps during the swap into the chart state
2. [P1] [00:07.80] cue for the counter lands 60 ms after the number settles
3. [P2] [00:10.40] tagline tracking too tight at 360 px
FIXES: swapAlpha windows on the loader label; chart line now uses track() on its end point
```

Times are `[mm:ss.cc]` (minutes, seconds, centiseconds, as the tile labels print them). Gate: at least `gate.minRounds`
(3) rounds, and the last round has every axis at `gate.minScore` (8), `na` only on an axis in `gate.naAllowed`, and no
P0. By default only the last round is judged; with `gate.requireFormats: true` every format in `studio.json` `formats` also
needs a logged round (format in the heading) and the LATEST round of that format must pass on its own. The example above fails: readability=7 and sound=7, each held down by a P1 problem.
