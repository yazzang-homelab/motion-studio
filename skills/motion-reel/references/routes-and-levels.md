# Levels, routes, and what the sources actually say

The course sorts the viral Opus 5.5 videos by how much the creator wrote (levels L1 to L4) and by
how the frames were made (routes A to D). Use both to set expectations before stage 0.

---

## Level ladder

Figures come from the course's fig 01 ("figures reported by creators"). They are anecdotes from
public posts, not benchmarks.

| Level | What the user writes | Input size | Run time | Creators cited | Skill |
|---|---|---|---|---|---|
| L1 one-liner | one sentence, no product | ~150 characters | 15 to 50 min | @stephanlivera, @himanshutwtxs, @robj3d3 | `showreel` |
| L2 brand reel | one-liner + URL + asset and music lines | ~350 characters | 30 to 45 min | @tdinh_me, @achxvi | `product-reel` |
| L3 state spec | XML spec: inputs, direction, state list, build rules, gotchas | 1.5k to 3k characters | ~1 to 2 h with fixes | @twoclipping, @verbove | `ui-morph-spec` |
| L4 director brief | a crew brief: logline, references, keys and budget, beat sheet, gates | 9.5k to 19k characters | 6 to 12 h autonomous | @donaldjewkes, @pradeepXkapoor, @pleometric | `director-brief` |

How to pick the level from a request:

| The user gave | Level |
|---|---|
| a topic or nothing, "show what you can do" | L1 |
| a product URL and a duration | L2 |
| a list of UI states, or asked for a loop of one morphing shape | L3 |
| a script, a song to follow, characters, chapters, or more than ~45 s | L4 |
| a reference frame, video or folder | same level, plus the reference stage |

What changes with the level:

| | L1 | L2 | L3 | L4 |
|---|---|---|---|---|
| Shot list approval | autonomous by nature of the test | yes | state list approval | plan first, then may continue unattended |
| Brand axis in critique | `na` | scored | scored | scored |
| Assets | none | captured from URL | captured or supplied | references, keys, generated assets (route C) |
| Durations seen in the cited posts | 10 to 30 s | 15 to 40 s | 14 to 20 s loop | 45 s to 5 min |
| Subagents | optional | asset-scout, director, critic | director, critic | all, plus chapter-animator per chapter |

Our own render cost is small next to these run times. Measured on the template's 12 s demo film (60 fps, 4 subframes,
4 workers, final encode, installed Chrome on a 12-thread Windows laptop): 123 ms per frame in 9x16, 75 ms in 1x1 and 118 ms in
16x9, about 4 minutes for the three formats, roughly 20 s of wall time per second of film. Critique rounds (about
115 s of tool time per live pass for the 12 s demo, plus the mixed render each round needs) and fixes dominate the time. Quote this
figure, with its conditions, when you give the user a time estimate before stage 0.

---

## Routes

From the course's fig 02 and fig 03, reworded.

| Route | Best for | Strength | Weakness | In motion-studio |
|---|---|---|---|---|
| A code-drawn | showreels, UI motion, loops, pixel art, product films | zero dependencies, fully editable, what Opus picks when unprompted | characters and photoreal need a lot of spec | the whole pipeline; default |
| B framework (Remotion, HyperFrames) | explainers, product videos, series and templates | studio preview, reusable components, skill-guided code | Remotion needs a company license for for-profit orgs with more than 3 employees; HyperFrames and the `skills` CLI need Node 22+ | handoff via `seek-engine` |
| C mixed pipeline | music videos, character stories | physics and faces from video models, code draws the visible layer on top | API spend, sync work, less determinism | planned with `director-brief`; keys + budget first |
| D footage edit | talking heads, recuts, launch edits of real clips | the user's real face and voice stay in | needs raw footage and clean audio | out of scope for v0.1 |

### Route A (default)

Use it unless the user names a framework. Tommy D. Rossi's inspection of a one-shot result found a
single `index.html` with a seek function, Playwright capturing frame by frame, and ffmpeg encoding.
motion-studio is that route with the rough edges fixed: http serving instead of `file://`, a font
gate, in-page subframe accumulation, loudness normalization and a critique gate.

### Route B (only when named)

- Switch only when the user names Remotion or HyperFrames. Opus tends to write its own engine
  unless told, so say the framework explicitly in the handoff.
- Remotion: show the license gate before scaffolding. Individuals, for-profit organizations with
  up to 3 employees and non-profits use it free; larger for-profit organizations need a Company
  License (see remotion.pro/license).
- HyperFrames (Apache-2.0) requires Node 22+. Its plugin router is `/hyperframes:hyperframes`.
- Commands, plugin installs and the render gates are in the `seek-engine` skill. A motion-studio
  film can also be driven by HyperFrames through the `hf-seek` event the runtime listens for
  (experimental).

### Route C (needs keys and a budget)

- The course's example: a director brief had an image model draw character sheets and a video
  model render base shots; Opus then redrew the whole video in JavaScript on top, so viewers only
  see the code-drawn layer. @donaldjewkes reported about 80% of a Max plan's usage plus $75 of fal
  credits for a 142 s music video.
- Before starting: keys in `.env` by name (`FAL_KEY`, `ELEVENLABS_API_KEY`), a spend cap from the
  user, and a note that generated assets are not deterministic. The determinism lint covers the
  JavaScript layer only.
- Plan it with `director-brief`; the trace layer is ordinary route A film code.

### Route D (out of scope)

Editing recorded footage is a different job. Tell the user this plugin does not cover it in
v0.1. HyperFrames ships a talking-head recut workflow, and a regular video editor is the other
option. Do not claim or attempt it here.

---

## Effort

The course recommends medium for small fixes and re-renders, xhigh for new films, and max when the
first 3 seconds have to carry a launch. Set it with `/effort <level>` or in `/model`. `motion-reel`
sets `xhigh` in its frontmatter while it runs.

| Task | Effort |
|---|---|
| fix a flagged problem, re-render, change copy | medium |
| a new film, a new format pass | xhigh |
| flagship hook, the first 3 seconds of a launch | max |

---

## Claims versus sources

Checked against the original posts (fetched 2026-09-29). Use the right-hand column when you
explain the method to a user.

| The course says | The source says |
|---|---|
| Every viral one-shot ran on xhigh or max | Plausible for the posts it cites (Stephan Livera: Max; Rob Hallam: xhigh), but the athemeroy dataset of 168 reviewed cases mentions an effort level in only 3 |
| Opus 5.5 defaults to medium effort and always thinks | Not in the official launch thread; only a third-party summary says so. Treat as unverified |
| One prompt | Some were one sentence. Others were a 9,608-character dictated brief and a 12-hour run; @mablesjoseph's watercolor short took 163 model calls and about 6 3/4 hours |
| Only Claude Code can render the video | @himanshutwtxs reports a rendered result from a plain claude.ai chat with no connectors; how it rendered is not documented. With a shell, the render-look-fix loop is what this plugin automates |
| Opus skipped Remotion and HyperFrames even when available | Tommy D. Rossi wrote that the model "seems to prefer" doing everything from scratch; he did not say the tools were installed |
| Tony Dinh added three lines | Four: introduce the product URL, use the real screenshots, logo and assets, have music that the motion follows, and make it read as a professional production rather than a demo or prototype |
| Rob Hallam's second reel came out faster because the pipeline existed | Rob made two reels in the same chat and said xhigh took about an hour for both; the speed-up is the course's inference |
| The @twoclipping XML template is in the thread | It is in the main post body |
| achxvi's 38-second film is vertical | That post's video is 1920x1080; the vertical one is his service-offer video |
