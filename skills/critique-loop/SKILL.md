---
name: critique-loop
description: "Make Claude watch its own frames: critique.mjs evidence, harsh 7-axis scores, timestamped P0/P1/P2 problems in docs/review_log.md, fix the 3 worst, re-check, pass the gate. Use for 'critique it', 'review the frames', 'is it good'."
argument-hint: "[format] [what changed]"
effort: high
allowed-tools: Bash(node tools/critique.mjs*) Bash(node tools/stills.mjs*) Bash(node tools/gate.mjs*) Bash(npm run critique*) Bash(npm run stills*) Bash(npm run gate*)
---

# Critique loop (course step 11)

Opus reads images, so it can look at what it rendered. That habit separates the films that land from the ones posted
with "it's a bit mid". Iteration is the method, not a failure: one widely shared 45-second short took 163 model calls
over about 6.75 hours. This skill runs at effort `high` because judging frames honestly needs deliberate attention.

```
critique.mjs evidence -> LOOK at every PNG -> score 7 axes -> P0/P1/P2 with timestamps -> append a round to
docs/review_log.md -> fix the 3 worst -> re-check the affected seconds -> next round
until: >= 3 rounds AND last round every axis >= 8 (na only where gate.naAllowed lists it) AND no P0  ->  npm run gate  ->  npm run render:final
```

Work in the film project root (the folder with `studio.json`). Arguments (format and what changed, both
optional; the format defaults to `studio.json` `primaryFormat`), shown once:

<request>
$ARGUMENTS
</request>

Files of this skill live in `${CLAUDE_SKILL_DIR}`; the
relative links below point there.

Review only, no re-render: when the user asks you to review evidence that already exists (a contact sheet, stills, a
video) and not to touch code, skip steps 1, 5 and 6. Look at the files that exist, score, and append the round (step 4).

## 0. Before round 1

- `docs/shotlist.md` is approved, `npm run lint` is clean, the film plays in `npm run preview`.
- The sound axis needs audio to judge: run `npm run score` (or `npm run beats -- <track>` for a supplied track) and
  `npm run sfx` first, so cues, the beat grid and the sync metric exist.
- The sound axis is scored from a mixed render, and the critic cannot render or mix. Before every round in which cues,
  music or picture timing changed (always in round 1 and in the last round) build it: `node tools/render.mjs --format
  <fmt> --draft --sub 1 --scale 0.5`, `npm run sfx`, `node tools/mix.mjs --format <fmt>`. Then produce both evidence
  passes of step 1 before you score or brief the critic.

## 1. Produce the evidence

Two passes that never overwrite each other. Measured on this class of PC: the live pass takes about 115 s for the 12 s
demo and about 145 s for a 20 s film (three determinism passes plus the 15 to 25 s browser start dominate), the `--video` pass
about 85 s for the 20 s film, one `motion-critic` run 5 to 12 minutes. Start every pass in the background and poll its log,
never wait in the foreground for more than about 2 minutes:

```
node tools/critique.mjs --format 9x16                              # live film -> out/review/9x16/
node tools/critique.mjs --format 9x16 --video out/9x16/final.mp4   # mixed render -> out/review/9x16/video/
```

The live pass holds determinism, exact pixels, `loop.png` and the cue sync; its audio row says `n/a`. The video pass
holds loudness, true peak, audio length and what the encode really contains; it skips determinism and writes no
`loop.png`. Score sound from the video pass, everything else from both. Without a mix, sound has no evidence: score it 4
or lower with a P1 that names the missing evidence (such a round cannot be the last).

| File in `out/review/<fmt>/` (the same names in `video/`) | What it shows | Look for |
|---|---|---|
| `metrics.md` / `metrics.json` | determinism mismatches, glyph coverage of the drawn text (fonts, live pass), dead spans, pops, frame 0, loop seam, corners, borders, cue sync, audio and silent spans (`--video` pass), and the list of every page of every sheet | read first; every flag becomes a problem or a written dismissal |
| `contact.png` | one still per beat, labelled `time · beat · shot`. Every sheet (contact, shots, phone, strip; `npm run stills` and `critique.mjs` alike) is split into pages of whole rows: no page is taller than `--page-height` (1800 px by default) or wider than 1990 px, page 1 is `contact.png`, then `contact-2.png`, `contact-3.png` ...; `metrics.md` lists every page, open all of them. `--from S --to S` reviews one chapter | dead beats, repeated shots, overlaps at state changes |
| `phone.png` | one still per second at 360 px wide | readability on a phone |
| `shots.png` | one still per shot midpoint | composition, banned looks, hierarchy |
| `strip.png` | 12 consecutive frames around the fastest action (`--strip-at S` to choose) | slides, pops, restarts, text overlaps |
| `loop.png` | loop films only (`studio.json` `loop: true`, canvas film, live mode): panes described below | seam jumps, a loop that does not close |

Every flag of `node tools/critique.mjs` (run it with `--help` for the same list):

| Flag | Effect |
|---|---|
| `-f, --format <fmt>` | format to review; default `primaryFormat`. Files go to `out/review/<fmt>/` |
| `--video [path]` | review a rendered mp4 instead of the live film. Bare `--video` takes `out/<fmt>/final.mp4`, else `silent.mp4`. Adds integrated LUFS, true peak and audio length; skips the determinism passes; writes no `loop.png` (continuity metric only). Everything goes to `out/review/<fmt>/video/`, so the live evidence stays as it was; the report names both folders |
| `--from <sec>`, `--to <sec>` | review one chapter of a long film: the stills, every sheet and every metric (dead spans, pops, determinism samples, glyph coverage, silent spans, cues) cover only that range, `metrics.json` records it in `range`. Frame 0 and the loop seam are checked only for the whole film (reported as skipped), loudness is always the whole file, the automatic strip stays inside the range. A bad range (`--from` past the end, `--to` not above `--from`, fewer than 3 frames) is a usage error, exit 2 |
| `--page-height <px>` | most height of one sheet image (default 1800; the image viewer shrinks anything past about 2000 px). Taller sheets are split into pages of whole tile rows (`contact.png`, `contact-2.png` ...); `0` = one tall sheet. A page is never wider than 1990 px either (`--cols` is lowered to fit) |
| `--strip-at <sec>` | centre the 12-frame strip on a moment, for example a problem time (default: the moment with most motion) |
| `--no-determinism` | skip the three hash passes when they passed this round and only the picture changed |
| `--skip-determinism-repeat` | reuse the passing determinism result of the previous live run (`determinism-cache.json` in the folder) when the film hash, every file under `assets/` (images, fonts, audio, cue data: name, size and content), format, `--from`/`--to` and the code of the pass are unchanged; any edit of `film/**`, `lib/**`, `studio.json` or `assets/` changes the key, so the passes run again. A failing result is never reused. The metrics row reads `n/a ... reused from the run of <time>`. A Chrome upgrade is not part of the key: run once without the flag after one |
| `--check-hash` | starts no browser: compares the live film (sha256 of `film/**` + `lib/**` + `studio.json`) with the evidence in `out/review/<fmt>/` (add `--video` for `video/`); exit 0 = same film, 1 = changed or no hash, and it names the changed files |
| `--json` | print one JSON result line (paths, `pages` of every sheet, `range`, summary, findings, `nextRound`, gate status) instead of the report |
| `-h, --help` | usage |

Without `--json` the report is printed: evidence list, metrics table, machine-found candidate problems, the rubric and
a ready-to-fill review-log block with the next round number (also saved as `metrics.md`). The tool never scores. With
`--json` the line carries `dir` (where this run wrote) and `other` (the other mode's folder, mode and time, or `null`).

`loop.png` panes, left to right (all downscaled the same way):

| Pane | Shows | Read it as |
|---|---|---|
| last frame | frame `N-1` | the state just before the seam |
| `t=dur` unwrapped | the raw end state at `t = duration` | present only when the runtime honours `hash(t, { wrap: false })`, which the tool tests first |
| `seek(0)` | frame 0 | the state after the seam |
| `\|last - first\| x4` | difference of the last frame and frame 0, amplified 4x | should look like one normal step between two consecutive frames |
| `\|end - first\| x4` | difference of the unwrapped end state and frame 0, amplified 4x | should be black: `t = duration` is frame 0. Present only with the unwrapped pane |

The loop verdict in `metrics.json` `loop` = `{ enabled, unwrapped, invariant, hashEqual, endDiff, seamDiff, prevDiff,
ratio, continuity, closes, pass }`. `continuity` = the last-to-first step is at most 1.5x the step between the last two
frames (or under `critique.staticEps`); `closes` = `hash(0)` equals `hash(duration, { wrap: false })`, or their mean
difference is under 0.1. A failure is a P0 at the film's end. Without the unwrapped pane (older runtime, DOM film) only
continuity is measured and the report says so.

Every evidence folder also holds `film-hash.json` (the film version the evidence shows; `filmHash` is repeated in `metrics.json`) and
`baseline.json` (the pop, jump and dead-span candidate times of the last run). Two consequences for the review:

- Film version: before you render any zoom still from the live film, run `node tools/critique.mjs --check-hash --format <fmt>`.
  A mismatch means the stills would show a newer film than the contact sheet: stop, report the mismatch (the command names the
  changed files) and ask for fresh evidence; never mix versions. Do not edit the film while a critic is reviewing.
- Delta: from the second run in a folder `metrics.md` prints `same as previous run: N of M candidates` and lists the NEW ones first
  (the machine-found list puts new findings first inside each severity, and marks the others `[same as the previous run]`).
  Review the new ones in full, and re-verify an old one only when the film changed near its time.

Stepped (pixel-art, "on twos") films make hard steps on purpose. Set in `studio.json`: `critique.stepped: true` lists every `jump`
as info (`metrics.json` `pops.info`, section "Suppressed by studio.json" in `metrics.md`) instead of a P2 finding; a one-frame
`flicker` stays a P1. `critique.popIgnore: [[t0, t1], ...]` (seconds, `0 <= t0 < t1`) silences both kinds inside intended spans
(`pops.ignored` lists them with their span). `metrics.md` states how many candidates each setting held back and why. This is
the film's grammar, not a threshold tweak: a real glitch still shows as a flicker or as a jump outside the stepped spans.

Metric semantics, so a flag is triaged correctly:

| Metric | Fails when | Finding |
|---|---|---|
| determinism | any sampled time hashes differently in order, shuffled or on a fresh page (samples straddle every shot boundary and cue) | P0 |
| fonts (live pass) | a character the film draws has no glyph in its font, or the family is not registered or generic (`sans-serif`): the machine draws a system font (different on every computer) or a tofu box. The pages are opened with `window.__TEXT_TRACK__ = true`, so `text()`, `kinetic()` and `textWidth()` record what they draw and `__studio.coverage()` judges it. One finding per font row names the family and weight, up to 40 missing characters, the total and the fix. A page without `textUse()` gives a note `preflight: unavailable`, never a finding; text on frames no pass painted is not seen | P0 `font-fallback` |
| dead spans | mean frame difference under `critique.staticEps` (0.35) for `critique.deadSpanSec` (2 s) or more | P1 |
| pops, `flicker` | one frame differs from both neighbours by more than `critique.popRatio` (3) times how far they differ from each other | P1 (an intended flash next to a cue is dismissed in writing) |
| pops, `jump` | a difference spike more than `popRatio` times the mean of the four neighbouring differences: something teleported, popped in or flipped | P2 from the tool; you raise it to P1 when it hurts the shot. Info only with `critique.stepped: true`; none inside a `critique.popIgnore` span |
| frame 0 | nearly empty: under 0.5 % of the pixels differ from the smooth background (a plain fill, a gradient or a vignette all count as background) | P0 |
| corners, borders | small content in a corner box (`critique.cornerPct`, 8 %) in 30 % or more of the sampled frames; thin uniform edge lines with an abrupt inner step on 3 or more sides in 25 % or more (a vignette, a gradient or a card on a coloured backdrop is not a border) | P1 from the tool, P0 once confirmed by eye (banned looks) |
| sync | under 80 % of hit cues (four or more cues) within 25 ms of a beat, or shot changes off the downbeats; risers, whooshes and swooshes lead the beat on purpose and are not counted | P2 |
| audio (`--video`) | no audio stream, loudness outside the target, true peak above the target, audio length off the video by more than a frame | P0 for no audio stream or true peak above 0 dBTP, else P1 |
| silence (`--video`) | a silent span of 1 s or more below -50 dB (one finding per gap, `silence 3.2 s at 00:08.1`), except one that starts in the first 0.3 s, starts in the last 1.0 s or lies inside a `critique.allowSilence` interval. A stem that ends early still measures -14 LUFS after the mix, so loudness cannot see it | P1 `audio-gap` (the audio row reads WARN) |

Both pop kinds also need a mean step above 1.0 on the 0-255 scale, so a near-static scene does not trip them. Hard cuts on
shot boundaries are listed as cuts, not as pops. Canvas films are scanned at half size or more
(`pixelScale`), because Chrome's CPU canvas snaps glyphs to whole pixels at small sizes and would fake jumps; DOM films
are sampled at 10 fps from screenshots. Never change `critique` thresholds to make a flag go away.

## 2. Look, properly

Open every image with the Read tool. Do not score from `metrics.md` alone and do not score from memory of the code.
Order: `metrics.md`, `contact.png`, `phone.png`, `shots.png`, `strip.png`, `loop.png` (each with every page it has:
`contact-2.png`, `contact-3.png` ...; the `metrics.md` evidence list names them, or list the folder), then the `video/metrics.md`
audio row. Compare against `docs/shotlist.md` (what was promised) and the previous round (what should now be fixed).

Two findings need a fix rather than a judgment call:

- `font-fallback` (P0): a character has no glyph in its font. Look at the tile it names, then register a font that covers the
  characters (`npm run fonts -- add-file <file> --family "Name"`), check with `npm run fonts -- coverage --text "..." --family
  "Name"`, point `brand.fonts` or the `family` option at it and re-run the live pass. Log it as a P0 until it is gone; dismiss it
  only with a written reason (text that never reaches the screen).
- `audio-gap` (P1, `--video`) and a failing `silence` check in `deliver`: the soundtrack is silent for 1 s or more. Regenerate the
  stem that ends early (`npm run score`, `sfx`, `voice`) and `npm run mix` again; the axis stays at 7 or lower until it is gone. An
  intended silence is listed in `studio.json` `critique.allowSilence: [[from, to], ...]` (seconds, `from < to`); never list a silence
  that is a defect.

## 3. Score and list problems

Delegate when the `motion-critic` subagent is available (`motion-studio:motion-critic`). A run takes 5 to 12 minutes and appends
its round to the same `docs/review_log.md`, so critic runs go one after another, never in parallel (not for two formats either);
render the next evidence set while one runs, but do not edit the film under review. Give it the format, the round
number, what changed and the evidence mode (`Evidence: both, already produced this round`, or `live only, no mix yet`). It
looks at the PNGs and both `metrics.md` files, runs `critique.mjs` itself only when told `fresh`, and writes only
`docs/review_log.md`. A fresh
context reviews more harshly than the author of the code. Without the subagent, follow the project's
`prompts/critique-pass.txt` yourself.

Read the rubric before scoring: `${CLAUDE_SKILL_DIR}/references/rubric.md` ([references/rubric.md](references/rubric.md))
has the 4/6/8/10 anchors, hard caps and the hunt list with typical fixes. The essentials:

| Axis | Question |
|---|---|
| `hook` | does the first 2 s stop the scroll, with content already on frame 0? |
| `readability` | does every word read at 360 px wide, one focal point per shot? |
| `motion` | springs with mass, no slides, pops or dead frames? |
| `variety` | something new every 2 to 4 s? |
| `composition` | focal point, negative space, safe areas, reframed per format? |
| `brand` | exact palette, one accent, bundled fonts, real UI, correct logo (`na` only without a brand, and only while `gate.naAllowed` lists `brand`, the default)? |
| `sound` | cuts on downbeats, SFX on beats or hits, -14 LUFS +-0.5, <= -1 dBTP? |

| Severity | Meaning |
|---|---|
| P0 | broken or banned; must be fixed before any final render (any P0 fails the gate) |
| P1 | clearly hurts the film; the axis stays at 7 or lower until fixed |
| P2 | polish |

Hunt explicitly for: text overlapping during swaps, anything sliding instead of easing, corner labels and frame
borders, centered-on-gradient shots, blurry scaled text, a dead beat, a stutter at the loop seam, single-frame pops,
an empty frame 0, fallback fonts, content outside the safe area, cues off the grid.

## 4. Log the round

Append exactly this block to `docs/review_log.md` (never edit earlier rounds). `critique.mjs` prints the same block
with the next round number and the machine-found problems prefilled:

```
## Round 3 — 9x16 — loader swap retimed, chart entrance on track()
SCORES: hook=8 readability=8 motion=8 variety=7 composition=8 brand=na sound=8
PROBLEMS:
1. [P1] [00:06.00] dead span until 00:08.00 while the chart holds
2. [P2] [00:10.40] tagline tracking too tight at 360 px
3. [P2] [00:03.10] loader ring 4 px off the button center
FIXES: swapAlpha windows on the loader label; chart end point on track(); cue times from grid.beat()
```

Times are `[mm:ss.cc]`, minutes, seconds and centiseconds exactly as the tile labels print them (`[00:04.20]`,
`[01:12.05]`); a range `[00:04.20-00:06.00]` also parses. Severity is `[P0]`, `[P1]` or `[P2]`. A bare `4.2s` parses
but is not the house format. A placeholder such as `[P0|P1|P2]` or `[mm:ss.cc]` left unfilled counts as no severity or
no time.

Then run `node tools/gate.mjs` (add `--json` for a machine-readable answer) to confirm the round parsed: it prints the
rounds, the last scores, `na allowed: ...` and why it fails.

The open-P0 rule is strict. Any `P0` token in a problem line of the last round counts as an open P0, however it is
decorated (`[P0]`, `**P0**`, `(P0)`, `Severity: P0`, a table cell; `[BLOCKER]`, `[CRITICAL]` and `SEV0` count too), and a P0
written outside `PROBLEMS:` (in notes or loose text under the heading) fails the gate as well. The unfilled placeholder
`[P0|P1|P2]` and a sentence that says there is none (`no P0`, `P0: 0`) do not count. A P0 closes only when the SAME round's
`FIXES:` block has a line that starts with the problem's number and the word `fixed`, `resolved` or `wontfix`:

```
FIXES:
1. fixed: frame 0 now shows the headline (kinetic released 0.3 s early)
```

`not fixed`, `will fix` and prose without the number close nothing. `node tools/gate.mjs --help` prints the rule.

## 5. Fix the 3 worst

Every P0 first, then the P1 problems that cost the most points. Fix the film, not the evidence: never tune
`critique` thresholds in `studio.json` to make a flag disappear. The hunt-list table in the rubric maps each problem to
its usual fix (`swapAlpha`, `track()`, `loopTrack()`, `L.pos()`, grid-derived cue times). Keep a note of each change for
the next round's `FIXES:` line. If a problem survives two rounds, change the approach: rewrite that shot in
`docs/shotlist.md` instead of tweaking numbers again.

## 6. Re-check only the affected seconds

| Check | Command |
|---|---|
| stills at the problem times | `node tools/stills.mjs --at 4.0,4.2,4.4 --out out/review/9x16/fix-check.png` |
| 12 consecutive frames at a moment | `node tools/critique.mjs --strip-at 4.2 --no-determinism` |
| the same film, picture re-checked | `node tools/critique.mjs --skip-determinism-repeat` (only repeats the passes when the film changed) |
| one chapter of a long film (evidence and metrics for that range only) | `node tools/critique.mjs --from 10 --to 20 --no-determinism` |
| a clip of the range for the user to watch | `node tools/render.mjs --from 3.5 --to 5 --draft --out out/check` (`out/check/<fmt>/clip_3.50-5.00.mp4`) |
| another format | `node tools/stills.mjs --format 1x1` |

When the targeted checks look right, run the full `node tools/critique.mjs` again: every round is scored from fresh,
complete evidence.

## 7. Pass the gate, then render

`npm run gate` exits 0 when there are at least `gate.minRounds` (3) rounds and the last round has every axis in
`gate.axes` at `gate.minScore` (8), with no open P0. By default it judges the LAST round only and does not look at the format in
its heading: one `9x16` round passes a film that lists three formats. `na` passes only on an axis listed in `gate.naAllowed` (default
`["brand"]`, a film with no brand). A last round with `sound=na` fails with `na not allowed for sound (gate.naAllowed:
brand)`: score the mixed render (`--video`) instead. Only the user may add `sound` to `gate.naAllowed`, for a film that
ships silent. Before the final, run at least one round on each other format
in `studio.json` `formats` (the round heading names the format). The default gate does not check that; set
`gate.requireFormats: true` in `studio.json` for a multi-format delivery and it requires, per listed format, a logged
round with that format in the heading, and the LATEST round of that format must pass on its own scores (an earlier pass does not cover a later regression: all axes >= `gate.minScore`, `na` only on `gate.naAllowed`,
no open P0), and names the formats that lack one. Leave it `false` (the default) for a one-format film. A round only proves its
format for the code it was scored on: log the rounds after the last film edit. Then `npm run render:final` (or `npm run build`).

The plugin's PreToolUse hook denies a final render while the gate fails and says why. Do not work around it: never
edit old rounds, never raise a score without new evidence, never set `gate.enabled` to false. Only the user may turn
the gate off.

## 8. After the final render

`node tools/critique.mjs --format 9x16 --video out/9x16/final.mp4` confirms loudness, true peak, duration and frame count
on the encoded file (evidence in `out/review/9x16/video/`). Report the scores of every round to the user in one table,
plus what you would improve next.

Next: `/motion-studio:ship-formats` to deliver every format and package the pipeline as your own skill.
