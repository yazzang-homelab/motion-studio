---
name: director-brief
description: "Plan long-form or overnight films: director's brief (PLAN FIRST or GO, budget, definition of done), ANIMATION_GUIDE + STORYBOARD, chapter subagents, gates, chunked render. Use for 'overnight film', 'music video', '2-minute film'."
argument-hint: "[logline or topic] [duration]"
effort: max
---

# Director's brief (course step 10)

Long films are productions. The briefs behind the overnight films in the course do not describe a video; they hire a
crew: a logline to check every decision against, references, tools and budget, a character bible, a beat sheet,
text-on-screen rules, gates, a critique loop and deliverables. This skill turns the user's idea into that brief and
runs the production through its gates. For clips up to about 45 seconds without chapters use
`/motion-studio:motion-reel` instead (the same threshold that skill uses to hand a longer film over to this one).

Arguments, shown once:

<request>
$ARGUMENTS
</request>

Files of this skill live in `${CLAUDE_SKILL_DIR}` (the brief template is
`${CLAUDE_SKILL_DIR}/assets/brief-template.md`, [assets/brief-template.md](assets/brief-template.md)).

## Cost of this skill

It runs at effort `max`: the deepest reasoning and the highest token use of any motion-studio skill. Planning
mistakes compound over hours of autonomous work, so the plan is where that spend pays off. Set expectations with the
user before starting. Reported data points from the course: an overnight music video ran about 12 hours and used about
80% of a Max plan's usage plus $75 of image/video API credit; a 45-second hand-painted short took 163 model calls,
62.7M tokens (96% cache reads), about $34 at API list prices and about 6.75 hours. Keep the rest cheaper: chapter
animators run at their own effort (high), and fixes and re-renders are medium-effort work. Tell the user to lower
the session effort with `/model` once the plan is approved if budget matters.

## 1. Collect the inputs

Only the main session can ask the user questions (subagents cannot). If the user dictated a long brief, parse it
instead of re-asking. Otherwise ask once, in one message, for what is missing:

| Input | Why |
|---|---|
| logline, and what the viewer should feel at the end | every decision is checked against it |
| duration, formats, where it will be posted | chapter count, render time, safe areas |
| references (video, frames, image library, prior repo) | grammar to take, content to avoid |
| music: a track (and its license) or "synthesize" | the beat grid everything locks to |
| route (A default; B only if they name Remotion/HyperFrames; C generate-then-trace) and API keys by variable name | tools and spend |
| budget: model usage, paid APIs, wall clock | when to stop generating |
| mode: PLAN FIRST or GO | whether to stop after the plan |

## 2. Write docs/brief.md

1. If there is no `studio.json`, run `/motion-studio:studio-init` first (set `--duration`, `--bpm`, `--formats`).
2. Copy `${CLAUDE_SKILL_DIR}/assets/brief-template.md` to `docs/brief.md`. Fill part A with the user's answers; keep
   part B as it is.
3. Update `studio.json` to match (title, duration, fps, bpm, formats, brand, `loop`).
4. PLAN FIRST: show the filled brief and stop until the user approves. GO: record every decision you made for the
   user in `docs/decisions.md` and continue.

## 3. Gate 1: plan documents

| File | Content | Who writes it |
|---|---|---|
| `docs/style_guide.md` | palette, type, pacing, transitions, texture, banned looks | `style-analyst` subagent from references (`/motion-studio:reference-style`), or you |
| `docs/STORYBOARD.md` | the idea, cast, what ties it together, chapters with timed shots and transitions | `motion-director` subagent, or you |
| `docs/shotlist.md` | every shot on the beat grid (bars), camera, text, SFX | `motion-director` |
| chapter plan (in STORYBOARD) | chapter boundaries on downbeats, owner per chapter | you |

Measure or synthesize the music before timing anything (`/motion-studio:sound-design`): chapter and shot times are
`grid.bar(n)` values, not guesses. Keep chapters 8 to 30 seconds so one subagent can finish and check one in a session.
The `motion-director` writes only `docs/**` (the role-guard hook enforces it).

## 4. Gate 2: rig and guide

1. Write `docs/ANIMATION_GUIDE.md` from the template in the project's `docs/` before any chapter animator starts, so
   every chapter codes in the same style: how a chapter works, ownership, layout and reserved bands, the shared API,
   shared elements, style rules with a paint-time budget, and the exact check commands.
2. Build shared elements (hero character, UI kit, palette helpers) yourself in `film/scenes/shared_<name>.js`. Chapter
   animators import them and never edit them. Render stills of every element in every state.
3. Stub every chapter so the film renders end to end while chapters are in progress:

```js
// film/scenes/ch03_build.js (stub written by the main session; the chapter animator replaces the shots)
import { chapter } from '../../lib/timeline.js';
export const BARS = [12, 20];                          // span in bars from docs/STORYBOARD.md (null = to the end)
export default function ch03(ctx) {
  const FROM = BARS[0] === 0 ? 0 : ctx.grid.bar(BARS[0]);
  const TO = BARS[1] == null ? ctx.dur : ctx.grid.bar(BARS[1]);
  return chapter({ name: 'ch03_build', from: FROM, to: TO, shots: [], cues: [] });   // no shots = placeholder card
}
```

4. Wire `film/film.js` once. `buildFilm` accepts `chapter()` results inside `scenes`, flattens their scenes and merges
   their cues. Film-wide layers (captions, seam transitions) go in the factory's `overlays: Scene[]`: they paint after
   every scene, in array order, on the same `from <= t < to` rule (end-inclusive at the film's last frame), and they
   never count as shots, so stills labels, critique shot boundaries and the preview strip list chapter shots only.
   Chapter code stays untouched; do not wrap or patch chapter `draw` functions. Nested arrays, `null` and `chapter()`
   results are accepted in `overlays` too, so a chapter can ship its own overlay scenes. To stack ordinary scenes, give
   a scene a `layer` number (default 0): scenes paint by `(layer, from)`.

```js
import { defineFilm, scene } from '../lib/timeline.js';
import ch01 from './scenes/ch01_hook.js';
import ch02 from './scenes/ch02_problem.js';
import ch03 from './scenes/ch03_build.js';

const CHAPTERS = [ch01, ch02, ch03];

export default defineFilm((ctx) => ({
  scenes: CHAPTERS.map((make) => make(ctx)),
  overlays: [
    scene(0, ctx.dur, 'captions', (g, lt, c) => { /* film-wide captions: draw from film time c.t */ }),
    // one short scene per chapter seam that needs a transition, timed from the grid
    scene(ctx.grid.bar(12) - 0.2, ctx.grid.bar(12) + 0.2, 'seam-ch02-ch03', (g, lt, c) => { /* wipe or flash */ }),
  ],
  cues: (grid) => [{ t: grid.bar(0), type: 'hit' }],   // film-level cues; chapter cues merge automatically
}));
```

## 5. Fan out the chapters

Spawn one `chapter-animator` subagent (`motion-studio:chapter-animator`) per chapter, several in parallel. Brief each
one with: its file (`film/scenes/chNN_<name>.js`), its span (the `BARS` export in its stub, plus the same span in
seconds for the check commands), its STORYBOARD section, and "follow
docs/ANIMATION_GUIDE.md". The role-guard hook allows a chapter animator to write only `film/scenes/**` (except
`film/scenes/shared_*`, which stay read-only for chapter animators, who report shared-file bugs instead) and
`out/check/**`. Each returns a report: what it built, check stills, known issues, and bugs it found in shared files.
You fix shared files, re-run the whole-film checks, and re-brief a chapter when its report shows a problem.

Chapter spans are bars, computed with `ctx.grid` inside the chapter's factory, so consecutive chapters always meet and
follow a measured track. Shot times are absolute film seconds taken from the grid
(`shots: [{ at: grid.bar(13), name: 'assemble', draw }, ...]`); each shot runs to the next one's `at`, and its
`draw(g, lt, c)` receives `lt` from the shot start. A shot outside its chapter span makes `chapter()` throw and the film
stops loading (for example a literal `TO = 4` rejects a shot at `grid.bar(1)` = 4.003 s once a measured track puts
the first downbeat at 2.0 s).

## 6. Gates 3 to 8

| Gate | Do | Check |
|---|---|---|
| 3 stills | `node tools/stills.mjs --shots` (one still per shot) | critique round (`/motion-studio:critique-loop`) |
| 4 animatic | `npm run animatic` (half scale, 30 fps, no blur) with the real or placeholder track | pacing: every read lands before the next beat |
| 5 hardest sample | `node tools/render.mjs --from A --to B --out out/check` on the hardest 2 to 4 s | `node tools/critique.mjs --strip-at <t>`; determinism; sync |
| 6 full pass | no placeholder left (no shot label in `node tools/stills.mjs --shots` ends in `/placeholder`) | critique round on the whole film |
| 7 polish and sound | `/motion-studio:sound-design`: score or beats, cues, SFX, voice | sync metric, sound axis |
| 8 final | `npm run build` | the definition of done in brief B6 |

Long films render in resumable segments: `node tools/render.mjs --format all --final --chunk 10` writes
`out/<fmt>/.parts/seg_<a>_<b>.mp4` and skips finished segments when re-run after an interruption. Run long renders in
the background (the Bash tool's `run_in_background`, or a log file you poll) instead of blocking the session, and never
wait in the foreground for more than about 2 minutes. Budget about 20 s of wall time per second of film for three
formats at 60 fps and 4 subframes (a 2-minute film is about 40 minutes of rendering); the pipeline runbook of
`/motion-studio:motion-reel` has the pattern and the expected time of every other command. A chapter-animator or any
other subagent must not return while a command it started is still running.

## 7. Route C: generate-then-trace (optional)

Only when the brief selects route C and lists the keys (by variable name: `FAL_KEY`, `ELEVENLABS_API_KEY` in `.env`)
and a budget. Video models give physics, timing and faces that are hard to hand-code; the code layer gives a consistent
look the user owns. Viewers see the code layer.

1. Generate character sheets and base shots with the user's chosen service, following its own docs. Save every result
   under `refs/base/` with a manifest row (service, model, prompt, seed, cost, license). Stop at the budget.
2. Extract frames to study: `node tools/refs.mjs extract refs/base/shot01.mp4 --every 0.1 --out refs/base/shot01`.
3. Redraw each shot in code on top of that timing (look at the frames, rebuild the motion with springs and tracks).
   Base footage never loads at render time from the network; if a shot composites a base frame, load it from a local
   file in `setup()`.
4. Verify sync: stills of the code layer next to base frames at the same times, and the audio cues on the grid.
   Re-run the step for any shot that drifts.

Keys: never print, echo, log or paste them. Tools read `.env` themselves; name the variable in prompts and docs.

## 8. Definition of done and report

The brief's B6 is the contract: loudness -14 LUFS +-0.5 and <= -1 dBTP on the delivered MP4, at least 3 critique
rounds with every axis >= 8 and no P0 (`npm run gate`), a re-render gives identical frames (critique determinism check
plus equal `framesDigest` values from two `--hash` renders), exact duration and frames in every format, and all deliverables present
(`npm run deliver` checks most of this and writes `docs/production.json`). Finish with the B7 report: deliverables,
scores per round, actual spend, known defects, what you would improve next.

Credits: the brief skeleton follows the course's step 10; the fill-in / keep-as-is split, PLAN FIRST vs GO and a
definition of done follow a public template pattern by @pradeepXkapoor (reworded); the acceptance gates are adapted
from athemeroy/awesome-opus-5-5-videos `docs/production-brief.md` (CC BY 4.0); the guide-plus-storyboard subagent
pattern was studied in JohnHeibel/PDoomVideo (ideas only, no text reused).

Next: `/motion-studio:critique-loop` after every gate from 3 on, then `/motion-studio:ship-formats` to deliver.
