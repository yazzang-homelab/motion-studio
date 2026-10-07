# Prompt templates

The prompt templates ship inside the skills that use them, so a skills-only install (`npx skills add`) carries them
too. This page is the index. Every template is original motion-studio text; where a template follows a pattern from a
public post, the file credits and links the post instead of copying it (see [CREDITS.md](../CREDITS.md)). The one
licensed adaptation is in the director brief: its acceptance gates follow a CC BY 4.0 production brief, with the credit,
the license link and a changes note inside `brief-template.md`.

## What is quoted verbatim

No template, skill or agent copies a post's prompt text, with one exception: the one-line showreel prompt by
@stephanlivera is quoted whole (it is the subject of the `showreel` skill), credited in `skills/showreel/SKILL.md` and
`skills/showreel/assets/variants.md`, and reused as the test prompt of the `trigger-showreel` eval. Besides it, the shipped
files carry a handful of short attributed phrases, each under 15 words, used to correct a claim or to name an example.
This is the complete list:

| Phrase | Source | Where | Used to |
|---|---|---|---|
| "what an incredible motion designer you are", "your showreel for a résumé" | @stephanlivera, the showreel prompt | `skills/showreel/SKILL.md`, the eval graders | Take the one-liner apart (duration, subject, genre, effort) |
| "Try again, ultracode." | @tdinh_me, prompt post | `skills/product-reel/SKILL.md` | Explain the `ultracode` keyword and say it is not a quality switch |
| "slick and punchy", "not good enough to be shared" | @mablesjoseph, post | `skills/product-reel/SKILL.md` | A counterexample: direction matters more than assets |
| "seems to prefer" | @__morse, post | `skills/motion-reel/references/routes-and-levels.md` | Correct the course's claim that the model skipped installed frameworks |
| "slow every zoom to 0.7x", "hard cut here", "push in on the button" | @rexan_wong, workflow post | `skills/reference-style/assets/reference-prompt.md` | Examples of director notes (the file lists them as coming from that post) |
| "brief contagion" | athemeroy/awesome-opus-5-5-videos README (CC BY 4.0) | `skills/showreel/SKILL.md`, `skills/showreel/assets/variants.md` | Name the look-alike-reel problem the randomizer addresses |
| "figures reported by creators" | Movez, the course figure 01 caption | `README.md`, `skills/motion-reel/references/routes-and-levels.md` | Label the level table as anecdotes |
| The course title "How to build motion design studio with Opus 5.5 (Full-course)" | Movez | `CREDITS.md`, `CHANGELOG.md` | Name the source |

Two licensed passages are quoted under their terms: the Remotion Free License eligibility terms (short passages with a link, in
`skills/seek-engine/references/route-b.md`) and the acceptance gates of the director brief (adapted, not copied). Everything
else that touches a post's ideas is paraphrased. If you add a quotation, keep it under about 15 words, attribute it, link the
post in `CREDITS.md`, and add a row to this table.

Placeholders are written as `[...]`, `<...>` or `{...}`; each file says which. Keys never go into a prompt: name the
variable (for example `ELEVENLABS_API_KEY in .env`) and let the tools read `.env`.

## Templates by course step

| Step | File | Used by | What it is |
|---|---|---|---|
| 03 One-liner | [skills/showreel/assets/variants.md](../skills/showreel/assets/variants.md) | `showreel` | The credited one-liner, paraphrased variant patterns (long piano reel, anti-slop guardrail, story, agency persona) and the option tables that `skills/showreel/scripts/roll.mjs` draws a seeded brief from |
| 04 Brand | [skills/product-reel/assets/brand-prompt.md](../skills/product-reel/assets/brand-prompt.md) | `product-reel`, `motion-director` | Fill-in brand reel brief: product and URL, real assets, story beats, sound, formats, review before render |
| 05 Reference | [skills/reference-style/assets/reference-prompt.md](../skills/reference-style/assets/reference-prompt.md) | `reference-style`, `style-analyst` | One block per rung of the reference ladder (a frame, a video, a library); take the grammar, never the content; wait for OK |
| 05 Reference | [skills/reference-style/assets/style-guide-notes.md](../skills/reference-style/assets/style-guide-notes.md) | `style-analyst` | Where each heading of `docs/style_guide.md` gets its evidence (`refs/analysis.json`, frames, the user's words) |
| 06 Spec | [skills/ui-morph-spec/assets/spec-template.xml](../skills/ui-morph-spec/assets/spec-template.xml) | `ui-morph-spec` | The six-section state spec (`inputs`, `direction`, `structure`, `build`, `gotchas`, `start`) for a one-shape UI morph film; the filled copy goes to `docs/spec.xml` |
| 10 Overnight | [skills/director-brief/assets/brief-template.md](../skills/director-brief/assets/brief-template.md) | `director-brief`, `motion-director` | Long-form director's brief: part A to fill (mode PLAN FIRST or GO, logline, delivery, references, tools/keys/budget, look, bible, beat sheet, text on screen) and part B as the production contract (gates, chapters and subagents, critique loop, route C, definition of done, final report) |
| 11 Critique | [skills/studio-init/template/prompts/critique-pass.txt](../skills/studio-init/template/prompts/critique-pass.txt) | `critique-loop`, `motion-critic` (copied into each film project as `prompts/critique-pass.txt`) | The harsh-director pass: evidence files to open, 7 axes with anchored scores, P0/P1/P2, the hunt list, the exact review-log block |
| 08 Springs | [skills/studio-init/template/prompts/refactor-springs.txt](../skills/studio-init/template/prompts/refactor-springs.txt) | `springs` (copied as `prompts/refactor-springs.txt`) | Replace easing with closed-form springs across the film: presets per element, `track()` for multi-target values, `loopTrack` for loops, lint and stills afterwards, a change table |
| 12 Ship | [skills/ship-formats/assets/brand-skill-template.md](../skills/ship-formats/assets/brand-skill-template.md) | `ship-formats` | A `SKILL.md` template for packaging your own `<brand>-reel` skill once a film has shipped |
| 12 Ship | [skills/ship-formats/assets/service-offer.md](../skills/ship-formats/assets/service-offer.md) | `ship-formats` | Fill-in offer for selling product motion videos as a service (credits the posts it follows; not pricing advice) |
| 12 Ship | [skills/motion-reel/assets/delivery-note.md](../skills/motion-reel/assets/delivery-note.md) | `motion-reel` | The final report: files, checks, loudness, rounds and scores, "what I'd improve next", all read from files on disk |

## Starting points that are not prompts

| File | Used by | What it is |
|---|---|---|
| [skills/ui-morph-spec/assets/morph-loop.film.js](../skills/ui-morph-spec/assets/morph-loop.film.js) | `ui-morph-spec` | A `film/film.js` starting point for a one-shape UI morph loop (states on downbeats, cursor-driven, last frame = first) |
| [skills/product-reel/assets/voice-script.example.json](../skills/product-reel/assets/voice-script.example.json) | `product-reel`, `voice.mjs` | Example `audio/voice.json` for ElevenLabs voice lines (`[{ t, text }]`) |

## Helper scripts next to the templates

| Script | Used by | What it does |
|---|---|---|
| [skills/showreel/scripts/roll.mjs](../skills/showreel/scripts/roll.mjs) | `showreel` | Draws a seeded showreel brief from the tables in `variants.md`; the same seed gives the same brief |
| [skills/ui-morph-spec/scripts/statelist.mjs](../skills/ui-morph-spec/scripts/statelist.mjs) | `ui-morph-spec` | Places each state on a downbeat and prints the state list to approve before any code |
| [skills/product-reel/scripts/capture.mjs](../skills/product-reel/scripts/capture.mjs) | `product-reel`, `asset-scout` | Captures screenshots, logo, colors and fonts from a product URL into `assets/brand/` and `assets/manifest.json` |

Each script prints its usage with `--help`.

## Using a template

1. Open a Claude Code session inside a film project (a folder with `studio.json`), or run
   `/motion-studio:studio-init` first.
2. Invoke the skill that owns the template (`/motion-studio:<skill>`); it fills the template from your answers and
   the project files. To use a template by hand, copy the block, replace every placeholder and paste it.
3. Keep the gates the templates ask for: show the shot list or state list and wait for OK, run at least 3 critique
   rounds, and render finals only after `npm run gate` passes.
