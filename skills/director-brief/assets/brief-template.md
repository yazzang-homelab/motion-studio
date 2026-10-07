# Director's brief: <working title>

<!--
How to use
1. Copy this file to docs/brief.md in the film project.
2. Fill part A: replace every <...>, write "n/a" where a field does not apply, delete hints you no longer need.
3. Keep part B as it is unless you know why you change a line. Part B is the production contract.
4. Start a fresh session in the project and say: "Read docs/brief.md and run it." (or paste the file).
Keys never go in this file. Name the variable ("FAL_KEY in .env"); the tools read .env themselves.
-->

You direct, animate, score and render this film, all in code. Work across as many sessions as it takes: plan first,
build through the gates in B1, review your own frames, and hold the final render until every gate has passed.

## A. BRIEF (fill in)

### A1. Mode
Mode: <PLAN FIRST | GO>

- PLAN FIRST: produce the gate 1 documents (B1), show them to me, and stop. Nothing is animated before my OK.
- GO: I am away. Make the decisions yourself and write each one, with its reason, to docs/decisions.md. Run every
  gate without waiting. Stop only for a missing key, a missing right to an asset, or the budget limit in A5.

### A2. The film in one line
- Logline: <who or what, what happens, the turn>
- At the end the viewer should feel or understand: <one sentence>
- The idea every decision is checked against: <the joke, the promise, or the image the film exists for>

### A3. Delivery
- Duration: <seconds> · formats: <9x16, 1x1, 16x9> (primary: <9x16>) · fps: <60> · language: <...>
- Where it will be posted: <X, Reels, YouTube, site> · loop: <yes/no>
- Deadline and who accepts it: <...>

### A4. References and inputs
| Input | Path or URL | Take | Never take | Rights (owner, license) |
|---|---|---|---|---|
| reference video | refs/<file> | pacing, type, transitions | content, logos, characters | <...> |
| image library | refs/<folder>/ | palette, texture, drawing style | subjects | <...> |
| music | <audio/track.wav or "synthesize"> | the track unchanged; measure beats first | nothing is edited | <license> |
| product assets | assets/ | real UI, logo, colors, fonts | nothing invented | <...> |
| prior work or repo | <...> | <...> | <...> | <...> |

Missing assets, rights or facts that need a human decision: <...>

### A5. Tools, keys and budget
- Route: <A (default: this engine) | B: Remotion or HyperFrames (name it) | C: generate-then-trace>
- Skills to use: <e.g. /motion-studio:springs, /motion-studio:sound-design, /claude-animation for hand-drawn shots>
- APIs available, by variable name only: <ELEVENLABS_API_KEY (voice) | FAL_KEY (image/video models) | none>
- Where the API docs live: <path or URL>
- Budget: model usage <e.g. "up to half of my plan's usage">; paid APIs <$ amount>; wall clock <hours>.
  Spend where it shows on screen and be economical everywhere else. Log every paid call (what, cost) in
  docs/decisions.md.

### A6. Look
<3 to 5 lines: palette (hex), type (display + UI face), texture, camera language.>
Banned for this film: <...> (the house bans in CLAUDE.md always apply).

### A7. Character or hero bible (write n/a for pure motion graphics)
| Element | Construction and proportions | Palette (hex) | Expressions or states | Identity lock (never changes) |
|---|---|---|---|---|
| <hero> | <shapes, head-to-body ratio, line weight> | <...> | <...> | <silhouette, key colors, one signature detail> |

### A8. Beat sheet
| Time | Act | What the viewer sees | Payoff |
|---|---|---|---|
| 0:00-0:02 | hook | <the single most striking image; frame 0 already shows it forming> | <...> |
| 0:02-<...> | act 1 | <...> | a new visual payoff every 3 to 5 seconds |
| <...> | turn | <...> | <...> |
| <end> | close | <last image; if the film loops, it sets up the first frame> | <...> |

### A9. Text on screen
- Text as picture (huge, on the beat): <moments>
- Subtitle-style text: <position, size, max words per line>
- Composition leaves room for text: <e.g. hero on the right while text builds on the left>
- Exact strings that must appear verbatim (names, claims, CTA, URL): <...>

### A10. Must have / avoid
- Must have: <...>
- Avoid: <...>

## B. PRODUCTION SPEC (keep as is)

### B0. How to work
- House rules: CLAUDE.md. Engine: route A (`window.seek(t)`, `tools/render.mjs`) unless A5 names another route.
- Put every decision in files (docs/brief.md, docs/decisions.md, docs/STORYBOARD.md, docs/review_log.md). A new
  session must be able to continue from the files alone.
- Never skip a gate. If a gate fails, go back one gate, fix, and pass it again.
- Keys stay in .env. Never print, echo or log a key; never write one into a file other than .env.
- When you are stuck on something outside your control (a key, a right, a broken tool), write the blocker to
  docs/decisions.md, pick the best fallback, and continue.

### B1. Gates, in order
| # | Gate | Output | Passes when |
|---|---|---|---|
| 1 | Plan | docs/style_guide.md, docs/STORYBOARD.md, docs/shotlist.md, chapter plan with times on downbeats | PLAN FIRST: my OK. GO: checked against A2 and A8 and recorded in docs/decisions.md |
| 2 | Rig | docs/ANIMATION_GUIDE.md; shared elements (hero, UI kit) in film/scenes/shared_*.js; one stub per chapter | stills of every shared element in every state look right |
| 3 | Stills | one keyframe per shot (`node tools/stills.mjs --shots`) | critique round logged; no P0 in composition or brand |
| 4 | Animatic | `npm run animatic` with placeholder or real audio | pacing works: every read lands before the next beat |
| 5 | Hardest sample | the hardest 2 to 4 seconds at full quality (`node tools/render.mjs --from A --to B --out out/check`) | adjacent frames clean (strip), seek-order repeatability (critique determinism), audio in sync |
| 6 | Full pass | every chapter painted, no placeholder left | critique round on the whole film |
| 7 | Polish and sound | music or measured track, cues from the film, SFX, voice | sync metric clean; sound axis >= 8 |
| 8 | Final | `npm run build` (or render:final, mix, deliver) | the definition of done (B6) holds |

### B2. Chapters and subagents
- Chapters start and end on downbeats. Each chapter is one file, `film/scenes/chNN_<name>.js`, owned by one
  chapter-animator subagent.
- docs/ANIMATION_GUIDE.md is written before any chapter subagent starts, so every chapter codes in the same style.
- A chapter-animator edits only its own file. It writes missing helpers privately inside that file. It reports bugs in
  shared files (lib/, film/film.js, film/scenes/shared_*.js) instead of editing them.
- Until a chapter lands, its stub paints a placeholder card, so the film always renders end to end.
- Global overlays (captions, transitions at chapter seams) belong to film/film.js, which lists them in the factory's
  `overlays` (a Scene[]); they paint after every scene, never count as shots, and chapters never draw them.

### B3. Critique loop (every gate from 3 on, at least 3 rounds)
- `node tools/critique.mjs` produces the evidence of the live film (`out/review/<fmt>/`); once a draft render, `npm run sfx` and
  `npm run mix` exist, `node tools/critique.mjs --format <fmt> --video out/<fmt>/final.mp4` adds the mixed render
  (`out/review/<fmt>/video/`), where the sound axis is scored. Look at every PNG, including phone.png (360 px wide).
- Score 1 to 10 on hook, readability, motion, variety, composition, brand, sound. List problems as P0/P1/P2 with
  timestamps. Append the round to docs/review_log.md in its exact block format.
- Fix the 3 worst problems, every P0 first, re-check the affected seconds, repeat.
- `npm run gate` must pass before the final render. Never edit an old round; never raise a score without new evidence.

### B4. Route C: generate-then-trace (only if A5 selects it)
- Generated material (character sheets, base shots) is an input, frozen as files under refs/base/ with a manifest
  (service, model, prompt, seed, cost, license).
- The code layer redraws on top. What the viewer sees comes from code; base shots supply timing, physics and faces.
- Never call an API at render time. Stop generating when the budget in A5 is spent.
- Verify sync of the code layer against the base shots and the audio before gate 6.

### B5. Don't
- Don't render the final before the gate passes. Don't delete or overwrite a finished chapter without a reason in
  docs/decisions.md.
- Don't use Math.random, Date, timers, requestAnimationFrame, CSS transitions or network fonts in film code.
- Don't invent product UI, facts or claims. Don't use assets, music or fonts without a known right to use them.
- Don't paste the reference's content (characters, logos, copy). Take its grammar.

### B6. Definition of done
- [ ] Loudness: integrated -14 LUFS +-0.5 and true peak <= -1 dBTP, measured on the delivered MP4 (`npm run deliver`).
- [ ] Review: at least 3 critique rounds; every axis in the last round scores 8 or more (`na` only on axes in `gate.naAllowed`,
      default brand); no open P0 (`npm run gate` passes).
- [ ] Determinism: a re-render gives identical frames. The critique determinism check passes (in order, shuffled,
      after reload), and two `node tools/render.mjs --hash --json` runs of the same range report the same `framesDigest`
      and write identical hash manifests (`frames.sha256` for the full film, `clip_<from>-<to>.sha256` for a range).
- [ ] Exact duration and frame count for every format in studio.json; every format reframed, none cropped.
- [ ] Loop films: frame 0 equals the frame at the duration (`hash(0)` equals `hash(duration, { wrap: false })` in the
      critique loop metric), and `loop.png` shows no jump at the seam.
- [ ] Deliverables: out/final.mp4, out/<fmt>/final.mp4, out/poster.png, out/review/<fmt>/contact.png,
      out/deliver/manifest.json, docs/production.json, and a README section with the exact re-render commands.

### B7. Final report
Reply with: what was delivered and where; a table of scores per round; actual spend (model usage, paid APIs, wall
clock, render time); known defects; unverified claims; what you would improve next.

<!--
Credits. The skeleton follows the director's brief in Movez's course "How to build motion design studio with Opus 5.5"
(step 10). The fill-in / keep-as-is split, the PLAN FIRST vs GO modes and the definition-of-done idea follow a public
brief template pattern by @pradeepXkapoor (reworded; no text copied). The acceptance gates (keyframes, hardest
2 to 4 second sample, whole film) and the rights and spend fields are adapted from "Copyable video production brief"
in athemeroy/awesome-opus-5-5-videos (docs/production-brief.md), CC BY 4.0,
https://creativecommons.org/licenses/by/4.0/. Changes: reworded, merged into the B1 gate table, mapped to motion-studio
tools.
-->
