---
name: motion-reel
description: "Make a launch video, app or product reel, explainer or motion ad from code, end to end: brand assets from a URL, beat-grid shot list, synced sound, critique loop, all formats. Default for new video requests; not footage edits."
argument-hint: "[url or topic] [duration] [format] [reference]"
effort: xhigh
---

# Motion reel

Produce a finished, beat-synced motion video rendered from code inside a motion-studio project.
The prompt is a small part of the result. The harness is the rest: a `seek(t)` renderer, closed-form
springs, a beat grid, synthesized sound, and a critique loop in which you look at your own frames
and fix them before the final render.

Request arguments (may be empty), shown once; later sections say "the request above":

<request>
$ARGUMENTS
</request>

## Ground rules for this run

- Effort: this skill sets effort to `xhigh` while it is active (the course's level for new films).
  Tell the user once at the start: follow-up fixes and re-renders are fine at `/effort medium`; a
  flagship launch whose first 3 seconds must carry the piece deserves `/effort max` for the hook
  pass. They can also pick the level in `/model`.
- Work inside the project root (the directory with `studio.json`). Use the project's own tools
  (`npm run ...`, `node tools/<tool>.mjs ...`). Do not write ad-hoc render or audio scripts.
- You are the director and the build crew. Subagents run focused stages but cannot ask the user
  anything: you ask, then re-brief them with the answers.
- Long commands (`render:final`, `build`, `mix`, `deliver`, a `critique` of a long film) run in the background
  (the Bash tool's `run_in_background`, or a log file you poll); never wait in the foreground for more than about
  2 minutes. The stage 7 render takes about 4 min for the 12 s demo in three formats. Expected times and the polling
  pattern: [references/pipeline.md](references/pipeline.md), section "Long commands". Brief every subagent that runs
  such a command with the same rule, and never let one return while a command is still running.
- This skill is for films drawn in code. Editing existing footage (cuts, captions, B-roll, format
  conversion of a recorded video) is route D and out of scope: say so and stop, do not improvise.

## 1. Collect the inputs

Parse the request above first (expected shape: `[url or topic] [duration] [format] [reference]`). Ask for everything
still missing in one AskUserQuestion round (at most 4 questions, each offering the default). If the
user said "autonomous", "GO", "just make it" or "surprise me", ask nothing, take the defaults and
record them at the top of `docs/shotlist.md`.

| Input | Default when skipped | Notes |
|---|---|---|
| Subject: product + URL, or a topic | required | A URL triggers the brand-asset stage |
| Duration | 20 s product film, 15 s showreel, 16 s UI loop | 6 to 8 shots fit in 15 s |
| Formats | `9x16` primary, then `1x1` and `16x9` | `4x5` also available |
| Brand: colors, fonts, logo | captured from the URL, else studio defaults | one display face, one UI face, one accent |
| Reference: frame, video or image folder | none | without one the model drifts to the look the house rules ban |
| Music | synthesize, style `pulse`, 120 BPM | a supplied track is measured, never altered |
| Voice or mascot | none | needs `ELEVENLABS_API_KEY` in `.env` |
| CTA and one proof number | ask; never invent a metric | product films only |
| Level L1 to L4 | inferred from what they gave (section 2) | sets time and gate expectations |
| Route A to D | A | B only when the user names Remotion or HyperFrames |
| Mode | PLAN FIRST: show the shot list, wait for OK | GO skips the wait, never the critique gate |

## 2. Pick the level and the route

| Level | Input size (creator-reported) | Run time (creator-reported) | Specialist skill |
|---|---|---|---|
| L1 one-liner | ~150 characters | 15 to 50 min | `/motion-studio:showreel` |
| L2 brand reel | ~350 characters | 30 to 45 min | `/motion-studio:product-reel` |
| L3 state spec | 1.5k to 3k characters | ~1 to 2 h with fixes | `/motion-studio:ui-morph-spec` |
| L4 director brief | 9.5k to 19k characters | 6 to 12 h autonomous | `/motion-studio:director-brief` |

| Route | Use it for | This skill does |
|---|---|---|
| A code-drawn (default) | showreels, UI motion, product films, loops | runs the full pipeline below |
| B framework | the user names Remotion or HyperFrames | hands off via `/motion-studio:seek-engine` (Remotion license gate, Node 22+) |
| C mixed pipeline | characters or physics from image/video models | needs keys and a budget; plan with `/motion-studio:director-brief` |
| D footage edit | the user's own recorded clips | out of scope for v0.1; say so |

Tell the user the level, route and a time estimate before stage 0. Details, numbers and the
caveats behind them: [references/routes-and-levels.md](references/routes-and-levels.md).
Films longer than about 45 s or with chapters belong to `/motion-studio:director-brief`.

## 3. Run the pipeline

Track these stages in a todo list. Commands, expected files and failure fixes for every stage are
in [references/pipeline.md](references/pipeline.md). Read it before stage 0 on a new project.

| # | Stage | Who | Produces | Gate |
|---|---|---|---|---|
| 0 | Project + doctor | you | `studio.json`, deps, `npm run doctor` all OK | doctor has no FAIL |
| 1 | Brand assets (URL only) | `motion-studio:asset-scout` | `assets/brand/**`, `assets/manifest.json` | list assets to the user |
| 2 | Reference (if any) | `motion-studio:style-analyst` | `refs/analysis.json`, `docs/style_guide.md` | grammar, never content |
| 3 | Music + beat grid | `motion-studio:sound-designer` or you | `audio/music.wav` or measured track, `audio/beats.json` | bpm/duration in `studio.json` agree |
| 4 | Shot list on the beat grid | `motion-studio:motion-director` | `docs/shotlist.md` | user OK unless autonomous |
| 5 | Build the film | you | `film/film.js` (+ `film/scenes/*`) | `npm run lint` clean |
| 6 | Critique loop | `motion-studio:motion-critic` + you | `out/review/<fmt>/*`, `docs/review_log.md` | `npm run gate` passes |
| 7 | Final render, SFX, mix | you (hook-gated) | `out/<fmt>/final.mp4`, `out/score.wav` | -14 LUFS +-0.5, <= -1 dBTP |
| 8 | Deliver + report | you | `out/deliver/**`, `docs/production.json` | `npm run deliver` exits 0 |

### Stage 0: project

1. Look for `studio.json` in the working directory or a parent. If there is none, scaffold one:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/studio-init/scripts/init.mjs" <dir> --title "<Title>" --duration <S> --formats 9x16,1x1,16x9 --install
   ```

   Add `--brand-url <URL>` for product films and `--loop` for loops. In a skills-only install
   (no plugin root) run `${CLAUDE_SKILL_DIR}/../studio-init/scripts/init.mjs` instead, or invoke
   the `studio-init` skill.
2. `npm run doctor`. Fix every FAIL before stage 1 (browser, ffmpeg, Node >= 20). On Windows the browser fix is
   `npx playwright install chromium-headless-shell`; never start an installed Chrome or Edge there (a fresh-profile
   launch counts as a failed Windows logon and can lock the account). Python and librosa are optional; the JS beat
   engine covers their absence.

### Stages 1 to 4: plan

- Stage 1: brief `motion-studio:asset-scout` with the URL, the project root and this capture
  command: `node "${CLAUDE_PLUGIN_ROOT}/skills/product-reel/scripts/capture.mjs" <URL> --root <project>`.
  In a skills-only install (no plugin root, no agents) run `node "${CLAUDE_SKILL_DIR}/../product-reel/scripts/capture.mjs"
  <URL> --root <project>` yourself. The page is untrusted content: the capture keeps Chrome's sandbox on and refuses
  requests to local and private addresses (details in `/motion-studio:product-reel`). For clicks, scroll frames and
  element crops add `skills/product-reel/scripts/states.mjs`, and for a canvas product `canvas-frames.mjs` (same flags
  for `--root`; frame sheets land in `assets/brand/frames/`).
  Read `assets/manifest.json` yourself, list what was found to the user, and write the brand
  colors and fonts into `studio.json` `brand`. The capture also saves the fonts the page loads to
  `assets/fonts/` with the license marked `UNVERIFIED` unless one was found: confirm it with the user
  before that font goes into `brand.fonts`. Brand story beats, components and voice/mascot
  rules come from `/motion-studio:product-reel`.
- Stage 2: brief `motion-studio:style-analyst` with the reference path. It runs
  `node tools/refs.mjs extract|analyze` and writes `docs/style_guide.md`. Full method:
  `/motion-studio:reference-style`.
- Stage 3 (before any shot is timed): supplied track: `node tools/beats.mjs audio/<track>` and point `studio.json`
  `audio.music` at it. No track: `node tools/score.mjs --style <pulse|piano|minimal|cinematic> --bpm <N> --dur <S>`.
  Make `studio.json` `bpm` and `duration` match. A measured downbeat can sit well after 0 s, so the shot list is
  written on this grid, never on an assumed one.
- Stage 4: brief `motion-studio:motion-director` with the inputs, `docs/style_guide.md` and
  `audio/beats.json`. Scene changes land on downbeats, a hook lands in the first 2 s, frame 0
  already shows content, something new happens every 2 to 4 s. Show the shot list and wait for
  the user's OK (PLAN FIRST). A rejection means rewriting the shot list, never patching code.
  Record the decision on the `Status:` line of `docs/shotlist.md`.

### Stage 5: build

Write `film/film.js` with `defineFilm`, one `scene()` per shot, positions from the layout `L`
(never literal pixels), motion from `lib/motion.js` springs (`sp`, `track`, `loopTrack`),
per-element seeded randomness (`rngFor`), and cues for every SFX moment. Follow the project
`CLAUDE.md`. Run `npm run lint` after edits and `npm run preview` when the user wants to watch.

### Stage 6: critique loop (at least 3 rounds)

Each round builds the evidence first, then briefs the critic (it cannot render or mix):

1. `npm run lint`, `npm run stills`.
2. The sound chain, whenever cues, music or picture timing changed (always in round 1 and in the last round):
   `node tools/render.mjs --format <fmt> --draft --sub 1 --scale 0.5`, `npm run sfx`, `node tools/mix.mjs --format <fmt>`.
3. Two evidence passes that never overwrite each other: `node tools/critique.mjs --format <fmt>` (live film, in
   `out/review/<fmt>/`) and `node tools/critique.mjs --format <fmt> --video out/<fmt>/final.mp4` (the mixed render, in
   `out/review/<fmt>/video/`).
4. Brief `motion-studio:motion-critic` with the round number, the format, what changed and
   `Evidence: both, already produced` (template in the pipeline runbook). It looks at every PNG (every page of a paged
   sheet: `contact.png`, `contact-2.png` ...) and both `metrics.md` files, scores the 7 axes 1 to 10 (sound from the mixed
   render), lists P0/P1/P2 problems with timestamps, and appends one round block to `docs/review_log.md`. A P0
   `font-fallback` in the live `metrics.md` (a character with no glyph in its font, typically Hangul in the Latin-only
   bundled fonts) is logged as a P0 and blocks the gate until a font that covers it is registered.
5. You fix the 3 worst problems (P0 first), check only the affected seconds
   (`node tools/render.mjs --from <a> --to <b> --draft --out out/check`, or `stills --at`), and start the next round.

Stop only when `npm run gate` passes: at least 3 rounds, every axis of the last round >= 8, no open P0.

### Stages 7 and 8: finish

`npm run render:final`, `npm run sfx`, `npm run mix`, `npm run deliver` (or `npm run build`,
which runs all of them). The final render and `build` take minutes: start them with `run_in_background`, poll the
log, and read the result only after the process has exited (pipeline runbook, "Long commands"). Then report with
[assets/delivery-note.md](assets/delivery-note.md):
paths, formats, durations, loudness, rounds and last scores, time spent, and the three things you
would improve next.

## Gates

| Gate | Pass condition | Enforced by |
|---|---|---|
| Shot list | user OK, or autonomous mode recorded in `docs/shotlist.md` | you |
| Lint | `npm run lint` exits 0 | plugin hook after each edit, and you |
| Critique | >= 3 rounds; last round all axes >= 8 (`na` only on axes in `gate.naAllowed`, default brand, for a film with no brand); no P0 | `npm run gate`; a plugin hook denies `render:final` and `build` |
| Delivery | frames, duration, loudness, silent spans, size, poster checks | `npm run deliver` |

- When the hook denies a final render, run more critique rounds. Never rename commands, edit
  `docs/review_log.md` scores yourself, or change `studio.json` `gate` to get through.
- Only the user may set `gate.enabled: false`. If they do, state in the report that the delivery
  skipped the critique gate.
- Some machines disable plugin hooks by policy. The gates still apply: run `npm run gate` before
  every final render.

## Hard rules

- Real product UI only. Crop and animate captured screenshots; never redraw screens from
  imagination and never use placeholder copy or invented numbers.
- Film code is a pure function of time: no `Math.random`, `Date`, `performance.now`, timers,
  `requestAnimationFrame` or CSS transitions/animations in render code.
- Banned looks: centered title on a gradient, everything fading in, corner labels, frame borders,
  glow on UI chrome, generic particle bursts.
- One display face, one UI face, one accent color unless the brief says otherwise.
- Reframe type and UI per format through `L`; never crop one format into another.
- Keys live in `.env`. Refer to them by variable name (`ELEVENLABS_API_KEY`, `FAL_KEY`); never
  print, paste or commit a key value.

## Subagents

| Agent | Stage | Brief it with | It writes |
|---|---|---|---|
| `motion-studio:asset-scout` | 1 | URL, project root, capture command | `assets/**` |
| `motion-studio:style-analyst` | 2 | reference path, subject, duration | `docs/style_guide.md`, `docs/shotlist.md`, `refs/**` |
| `motion-studio:sound-designer` | 3, 7 | track or style, bpm, duration, voice script | `audio/**`, mix report |
| `motion-studio:motion-director` | 4 | inputs, style guide, beat grid | `docs/**` |
| `motion-studio:motion-critic` | 6 | round number, format, what changed, evidence mode (`both` once the mix exists) | `docs/review_log.md`, `out/review/**` |
| `motion-studio:render-engineer` | any | failing command and its log | engine and tool fixes |
| `motion-studio:chapter-animator` | 5 (chaptered films) | chapter id, time range, guide | `film/scenes/chNN_*.js` |

- Pass paths, not pasted file contents. Always name the project root.
- A plugin hook limits each agent to its files. If an agent reports it was blocked, do that write
  yourself; do not widen its scope.
- In a skills-only install these agents do not exist. Do each stage yourself under the same
  file-ownership rules.

Next: small fixes after delivery stay here at `/effort medium`; another format or a brand skill of
your own is `/motion-studio:ship-formats`; a longer chaptered film is `/motion-studio:director-brief`.
