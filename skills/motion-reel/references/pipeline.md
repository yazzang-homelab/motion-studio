# motion-reel pipeline runbook

Stage-by-stage commands, expected files, checks and fixes. Run every command from the project root
(the directory holding `studio.json`). `npm run <script> -- <flags>` and `node tools/<tool>.mjs <flags>`
are equivalent; the direct `node` form avoids npm argument quirks, so prefer it when passing flags.

Plugin scripts live outside the project. Their full paths are printed in the SKILL.md of the skill
that owns them (this file is read raw, so it names them by skill: "the studio-init script", "the
product-reel capture script").

---

## Long commands: run them in the background

In Claude Code the Bash tool waits 2 minutes by default and 10 minutes at most; a command that outlives its timeout keeps
running as a background task that ends when the agent that started it gives its final answer. Several stages take longer
than that, so start them in the background and poll their log. Never wait in the foreground for more than about 2 minutes.

| Command | Expected time | How to run it |
|---|---|---|
| `npm run doctor` | 20 to 35 s | foreground |
| `npm run score` | 4 to 11 s | foreground |
| `npm run sfx` | 10 to 15 s | foreground |
| `node tools/render.mjs --format <fmt> --draft --sub 1 --scale 0.5` | about 20 s per format for the 12 s demo at 60 fps (720 frames) | foreground; background over 30 s of film |
| `node tools/critique.mjs --format <fmt>` (live) | measured on this class of PC: about 115 s for the 12 s demo, about 145 s for a 20 s film (the three determinism passes and the 15 to 25 s browser start are most of it); `--skip-determinism-repeat` on an unchanged film: 95 s instead of 115 s for the demo (the passes run beside the pixel pass, so the saving is the CPU they take, about 20 s, not their own 33 s) | background, always |
| `node tools/critique.mjs --format <fmt> --video out/<fmt>/final.mp4` | about 85 s for a 20 s film (no determinism passes, but a full decode and the loudness measurement) | background, always |
| one `motion-critic` run (reads the evidence, zooms, appends a round) | 5 to 12 minutes, 31 to 39 tool calls (measured over 4 rounds of a 20 s film) | background; one at a time, see stage 6 |
| `npm run mix` | 40 to 80 s (the stems are measured, then mixed and muxed per format) | background |
| `npm run deliver` | about 40 s | background |
| `npm run render:final` (or `render:all`) | about 4 min for the 12 s demo in three formats at 60 fps, 4 subframes, 4 workers (about 20 s per second of film; 15 s takes 5 min) | background, always |
| `npm run build` | the final render plus about 2 min (score check, sfx, mix, deliver): about 6 min for the 12 s demo | background, always |

Pattern (the marker line tells you when it is over, whatever the result). Bash:

```
cd "<root>" && (npm run render:final > out/render.log 2>&1; echo "exit $?" >> out/render.log)
```

Windows PowerShell (5.1 has no `&&`, and `*>` decorates native stderr; let `cmd` do the redirect):

```
cmd /c "npm run render:final > out\render.log 2>&1"; "exit $LASTEXITCODE" | Add-Content out\render.log
```

Start that with the Bash tool's `run_in_background` option, then poll with short calls: `tail -n 3 out/render.log`.
The renderer prints `frame N/M ... ETA` once per film second. Read the result only after the `exit` line appears;
`exit 0` means success. A subagent must not return its report while such a command is still running: the command
stops when the agent finishes and leaves half-written output. For films over about 30 s or three formats, add
`--chunk 10` to the final render so an interruption resumes instead of restarting.

---

## Resume: where is this project?

Check the files before starting anything. Resume at the first stage whose output is missing.

| Evidence on disk | Stage done | Resume at |
|---|---|---|
| no `studio.json` | none | 0 |
| `studio.json`, no `node_modules/playwright` | scaffold only | 0 (install + doctor) |
| URL film and no `assets/manifest.json` | 0 | 1 |
| reference given and no `docs/style_guide.md` content | 1 | 2 |
| no `audio/beats.json` | 2 | 3 |
| `docs/shotlist.md` without a `Status: approved` or `Status: autonomous` line | 3 | 4 |
| `film/film.js` still the shipped demo (title "MAKE IT MOVE.") | 4 | 5 |
| `npm run gate` fails | 5 | 6 |
| no `out/<fmt>/final.mp4` for every format | 6 | 7 |
| `npm run deliver` fails or `out/deliver/manifest.json` missing | 7 | 8 |

The plugin's SessionStart hook prints a similar summary where hooks are allowed.

---

## Stage 0: project and doctor

Goal: a working project with a browser and ffmpeg.

1. Scaffold if needed (the studio-init script, full path in SKILL.md):

   | Flag | Use |
   |---|---|
   | `<dir>` | target directory; `.` for the current empty directory |
   | `--title T` | film title (also the delivery file slug) |
   | `--duration S` | seconds |
   | `--fps N` | default 60 |
   | `--bpm N` | default 120; overwritten later by a measured track |
   | `--formats a,b` | subset of `9x16,1x1,16x9,4x5` |
   | `--loop` | seamless loop film (UI morphs) |
   | `--brand-url URL` | stores the product URL in `studio.json` `brand.url`; `user:password@` and secret-looking parameters (query, `;matrix`, fragment: token, key, secret, password, auth, sig, session, code ...) are removed first, stderr names them and `--json` lists them in `redacted`. Pass a public URL; a secret that is a bare path segment cannot be recognized |
   | `--install` | runs `npm install` in the new project |
   | `--force` | refresh template files (overwrites `CLAUDE.md`, `lib/**`, `tools/**`, `prompts/**`, `index.html`); keeps `studio.json`, `film/**`, `docs/**` and `assets/fonts/fonts.json`; merges `.gitignore`; in `package.json` it resets a template script whose command differs and never changes a dependency version (init lists what it reset and what it kept) |

   In an existing non-empty directory init only adds missing files and lists what it skipped.
2. `npm install` if `--install` was not used. `ffmpeg-static` is optional: when its download is
   blocked (proxy, offline), install still succeeds and doctor tells you to set `FFMPEG_PATH`.
3. `npm run doctor`. Expected: every row OK except optional rows.

   | FAIL row | Fix |
   |---|---|
   | node < 20 | install Node 20 LTS or newer |
   | playwright not importable | `npm install` in the project |
   | no browser (Windows: `no safe browser found`) | `npx playwright install chromium-headless-shell` (`npm run setup:browser`). Windows never uses an installed Chrome or Edge on its own: each fresh-profile launch counts as a failed Windows logon and can lock the account (guarded opt-in only). macOS and Linux: an installed Chrome or Edge also works, or set `MOTION_CHROME_PATH` to a Chromium-family executable |
   | WARN browser `chrome` or `msedge` (Windows) | an installed browser was chosen (`studio.json` `browser`, `MOTION_BROWSER`, `MOTION_CHROME_PATH`). Remove the choice and install the headless shell as above; the lockout entry is in `${CLAUDE_SKILL_DIR}/../studio-init/references/troubleshooting.md` |
   | ffmpeg missing or lacks filters | `npm install ffmpeg-static`, or set `FFMPEG_PATH` to an ffmpeg with loudnorm, ebur128, alimiter, sidechaincompress, amix, tmix |
   | fonts missing | `npm run fonts -- add "Family:400,700"` (Google Fonts) or `npm run fonts -- add-file <path or https-url> --family "Name"` (your own file), or restore `assets/fonts/` |
   | studio.json invalid | fix the reported key; defaults live in `tools/studio.mjs` |

4. Edit `studio.json`: `title`, `duration`, `formats`, `primaryFormat`, `loop`, `brand`. Keep
   `fps: 60`, `subframes: 4` unless the user asks otherwise.

---

## Stage 1: brand assets (films about a product or site)

Goal: real screenshots, logo, colors, fonts and copy on disk before any animation.

Brief for `motion-studio:asset-scout`:

```
Project root: <abs path>. Product: <name>, URL: <url>.
Run the product-reel capture script (command given below) and then check its output:
  <capture command with --root <abs path>>
Add element crops with --selector for: <hero, pricing card, key feature panels>. Crops outside
the page are skipped with a note.
Then capture UI states with states.mjs (click, scroll, crop) and, for a canvas-drawn product, sample
the canvas over time with canvas-frames.mjs (see asset-capture.md):
  node "${CLAUDE_PLUGIN_ROOT}/skills/product-reel/scripts/states.mjs" <url> --root <abs path> [--click <sel>]... [--crop <sel>]...
  node "${CLAUDE_PLUGIN_ROOT}/skills/product-reel/scripts/canvas-frames.mjs" <url> --root <abs path> --canvas <sel> --clip <name>[=<click sel>]...
(Skills-only install: use ${CLAUDE_SKILL_DIR}/../product-reel/scripts/<script> instead of the plugin root.)
Do not draw or invent any UI. Report: files written, logo candidates, suggested palette,
font families, anything missing or blocked (login wall, cookie banner, bot check).
```

Then, in the main session:

1. Read `assets/manifest.json`. List to the user: screens, logo candidates, palette with roles,
   fonts, notes. Ask about anything missing (logo SVG, exact brand hex, licensed font files).
2. Write `studio.json` `brand`: `name`, `url`, `colors.bg/fg/accent/muted`, `fonts.display/ui`.
3. Fonts: the capture already saved the web fonts the page loads into `assets/fonts/` and registered them in
   `assets/fonts/fonts.json` (manifest `fonts.files[]`, each with a license `status`, `UNVERIFIED` unless a
   license URL or file was found). Registered is not permission: confirm the license with the user before a
   font goes into `brand.fonts`. A Google Fonts family can also be vendored with
   `npm run fonts -- add "Family:400,700"`. A commercial font needs the user's own license and files
   (`npm run fonts -- add-file <path> --family "Name" --license-file <path>`). Otherwise remove the entry
   (`npm run fonts -- remove "Family"`), keep the bundled faces and say so.
4. Break screenshots into parts (cards, buttons, charts, nav) so each can move on its own. The
   product-reel skill has the component rules and story-beat template.

---

## Stage 2: reference

Goal: `docs/style_guide.md` written from evidence, grammar only.

1. The reference must be a local file or folder under `refs/`. Ask the user for the file when
   given a link to someone else's video; study it, never embed it.
2. `node tools/refs.mjs extract refs/<video> --every 0.5` writes `refs/frames/*.png` and
   `refs/contact.png`.
3. `node tools/refs.mjs analyze refs/<video or dir> --json` writes `refs/analysis.json`: cut times,
   shot lengths, palette with shares, brightness and contrast, motion energy per second, text hint.
4. Brief `motion-studio:style-analyst`:

   ```
   Project root: <abs path>. Reference: refs/<file>. Subject: <subject>. Duration: <S> s.
   Look at refs/contact.png and frames, read refs/analysis.json, and write docs/style_guide.md:
   palette (hex), type (family, weight, tracking), shot lengths, transitions, camera moves,
   texture, how text enters and exits. Take the grammar, never the content, logos or characters.
   ```

The reference-style skill holds the full method and the template notes.

---

## Stage 3: music and beat grid

Goal: `audio/beats.json` that the film reads, and a music stem of the right length.

| Situation | Command | Result |
|---|---|---|
| User supplied a track | copy it to `audio/`, then `node tools/beats.mjs audio/<track>` | measured `audio/beats.json` (librosa if available, else JS engine) |
| Track with a known tempo | add `--bpm-hint <N>` (30 to 300) | better tempo pick on ambiguous tracks; without a hint the JS engine searches 70 to 180 BPM (a 60 BPM track reads as 120), with a hint it widens the search around the hint |
| No track | `node tools/score.mjs --style pulse --bpm 120 --dur <S>` | `audio/music.wav` + analytic `audio/beats.json` |
| UI film | `--style minimal` | ticks, clicks, soft kick |
| Story or history film | `--style cinematic` or `--style piano` | |
| Want a later drop | `--drop <bar>` | drop lands on that downbeat |
| Seamless loop film (`studio.json` `loop: true`) | `--loop` (default from `studio.json` `loop`) | no intro or ending, tails wrap to the start; use a whole number of bars |

Optional `studio.json` `audio` keys read by `score.mjs`: `style` (template default `pulse`), `key`, `mode`, `seed`.
A flag overrides the key. `voiceId` is read by `voice.mjs`.

Every `score.mjs` run also writes `audio/music.meta.json` (the settings and the sha256 of the WAV). `--if-missing`,
which `npm run build` uses, keeps a supplied or replaced track and a score whose settings still match, and regenerates
a score it made itself when `duration`, `bpm`, style, key, mode, seed, loop or drop bar changed. A stale generated
track therefore never reaches the mix.

Checks:

- Set `studio.json` `audio.music` to the track path when a track is supplied, and `bpm` to the
  measured `bpm` from `audio/beats.json`.
- `duration` in `studio.json` is the film length. The mixer pads or trims music to exactly
  frames / fps; a longer track is cut, never time-stretched.
- An empty `beats` array (silence, speech-only audio) means the runtime falls back to the bpm grid.
  Tell the user, or pick another track.
- License: a supplied or downloaded track must allow the intended use. Ask when unsure.

---

## Stage 4: shot list on the beat grid

Goal: an approved `docs/shotlist.md` that the build follows line by line.

Brief for `motion-studio:motion-director`:

```
Project root: <abs path>. Inputs: <subject, duration, formats, CTA, metric, mode>.
Read docs/style_guide.md (if present), assets/manifest.json (if present), audio/beats.json.
Write docs/shotlist.md on the beat grid: for every shot give start-end in seconds and bar.beat,
what the viewer notices, action -> end state, camera, on-screen text (exact copy), spring feel,
SFX cues (type @ time), and per-format notes for 9x16 / 1x1 / 16x9.
Rules: scene changes on downbeats; hook in the first 2 s; frame 0 already shows content;
something new every 2-4 s; one accent; no banned looks. Return questions instead of guessing.
```

Then:

1. Check the list against the beat grid (downbeat times in `audio/beats.json`), the duration, and
   the banned looks. Fix it with the director before showing it.
2. PLAN FIRST: show the shot list (a compact table is enough) and wait for the user's OK.
3. On OK add `Status: approved (<date>)` near the top of `docs/shotlist.md`. Autonomous mode:
   `Status: autonomous (<the user's words>)`.
4. On rejection rewrite the shot list and show it again. Do not start code to "show instead".

---

## Stage 5: build the film

Goal: `film/film.js` that implements the shot list and passes lint.

- Replace the shipped demo. Keep the `defineFilm((ctx) => ({ scenes, cues }))` factory shape.
- One `scene(from, to, name, draw)` per shot; names match the shot list, so critique labels
  and `__studio.shots()` read the same.
- Layout: every coordinate from `c.L` (`L.S` safe rect, `L.pos`, `L.split`, `L.cols`, `L.pick`,
  `L.u` unit). No literal pixel positions, so every format reframes instead of cropping.
- Motion: `sp(t, 'snappy')` for UI, `'heavy'` for big type and lockups, `track()` for any value
  with several targets, `loopTrack()` in loop films (key times in `[0, duration]`, last value equal to the
  first), `stepTime(c.frameLt, 12)` ("on twos", a hard cut between steps) only for drawn elements.
- Frame 0 must already show content. A spring released at the scene start is 0 at `lt = 0`, so a hook built on
  `kinetic(..., lt, ...)` or on a spring-driven opacity draws nothing there. Release it before the scene:
  `kinetic(g, str, x, y, lt + 0.3, ...)`, `sp(lt + 0.3, 'snappy')`, or a `delay` of -0.3 (the first film scene only:
  later scenes may start empty because the previous scene is still on screen). Position and scale springs
  (`lerp(from, to, sp(lt - 0.15))`) start visible, so they are fine.
- Film-wide frame indices: `c.frame` is the output frame index, the same for all motion-blur subframes, so
  `grain(g, c.W, c.H, c.frame)` looks the same in stills, preview and the final; `c.t` is the subframe time and
  blurs by itself.
- Film-wide layers: captions and seam transitions go in the factory's `overlays: Scene[]`, which paint
  after every scene and never count as shots. Use a scene's `layer` (number) to stack ordinary scenes.
- Type: `kinetic()` for hooks, `fitFontSize()` so headlines fit each format, `wrapText()` for multi-line copy (it
  breaks at spaces, never inside a Hangul syllable), fonts from `studio.json` brand only. A call without `family`
  draws `brand.fonts.ui` (`text()`, `font()`) or `brand.fonts.display` (`kinetic()`), and without `weight` the nearest
  weight the family has registered, so a 400-only face is never faked bold. Korean, Japanese or Chinese text needs a
  font with those glyphs: the bundled faces have none (`npm run fonts -- coverage --text "..." --family "Name"`
  checks, and the live critique repeats the check on what the film really draws: a missing glyph is a P0 `font-fallback`).
  `text()` and `kinetic()` never throw for an unregistered family, so the critique is where it shows; text drawn with
  `g.fillText` directly is invisible to that check unless the film calls `recordText(str, cssFont)` from `lib/draw.js`.
  Signatures and defaults of every `lib/` function: `docs/API.md` in the project; the full reference is
  `docs/ARCHITECTURE.md` in the plugin repository (sections 5 and 6).
- Randomness: `ctx.rngFor(name, i)` per element, created inside the draw call, never one shared
  stream.
- Cues: `{ t, type, gain, pan }` for every visible hit: `thump` on scene downbeats, `whoosh`
  into transitions, `click` on cursor presses, `pop` on small entrances, `hit` on the lockup.
  Types: click, tick, pop, thump, whoosh, swoosh, riser, hit, chime, type, glitch, snap.
  `t` is where the sound lands: the transient of a click, pop or hit, the peak of a whoosh or swoosh.
  A riser starts on its cue and swells into the next hit, thump or snap 0.4 to 4 s later (else it
  lasts 1.6 s), so put it a bar or a beat before the impact, not on it.
- Measured accents: `ctx.grid.hits` / `grid.hitsIn(a, b)` (from `audio/beats.json` `hits[]`, `[]` for a
  synthesized score without them). Never fetch `audio/beats.json` yourself.
- Long films: split into `film/scenes/chNN_<name>.js` chapters, fill missing ones with
  `placeholder()`, and use `motion-studio:chapter-animator` per chapter (director-brief skill).
- After edits: `npm run lint` (the post-edit hook also lints where hooks run). Fix every error;
  treat warnings as P2.

---

## Stage 6: critique loop

Goal: `npm run gate` passes with evidence the user can inspect.

The critic scores sound from a real mixed render, so the main session builds the whole evidence set BEFORE it briefs
the critic. The critic never renders or mixes (its hard rules forbid it). Round checklist, in this order:

1. `npm run lint`
2. `npm run stills` (one still per beat: `out/review/<fmt>/contact.png`; a sheet taller than 1800 px or wider than 1990 px is
   paged: page 1 is `contact.png`, then `contact-2.png`, `contact-3.png` ...; `--from S --to S` reviews one chapter at a
   time). Step 4 writes the same `contact.png` and pages, so the later of the two wins
3. Sound chain for the format under review, whenever the cues, the music or the picture timing changed since the last
   mix (always in round 1 and in the last round). Long steps go to the background:
   `node tools/render.mjs --format <fmt> --draft --sub 1 --scale 0.5`, `npm run sfx`, `node tools/mix.mjs --format <fmt>`.
   A supplied or synthesized track must exist (`audio/music.wav`, stage 3).
4. Evidence, in two passes that never overwrite each other (each takes minutes: start both in the background and poll the log; the table of long commands above has the measured times):
   - live film: `node tools/critique.mjs --format <fmt>` writes `out/review/<fmt>/` (contact, shots, phone, strip, loop,
     `metrics.md`: determinism, fonts (glyph coverage of the text the film draws), dead spans, pops, frame 0, corners,
     borders, sync; audio is `n/a` in this mode). Every sheet is paged (`contact.png`, `contact-2.png` ...; at most 1800 px
     tall, 1990 px wide; `--page-height` changes it) and `metrics.md` lists every page. For one chapter of a long film add
     `--from S --to S`: sheets and metrics then cover only that range
   - mixed render: `node tools/critique.mjs --format <fmt> --video out/<fmt>/final.mp4` writes
     `out/review/<fmt>/video/` (same file names; `metrics.md` there holds LUFS, true peak, audio length and silent spans:
     a silence of 1 s or more is a P1 `audio-gap`)
   - every evidence folder is pinned to the film version it shows: `film-hash.json` and `metrics.json` `filmHash` = sha256 of
     `film/**` + `lib/**` + `studio.json`. `node tools/critique.mjs --check-hash [--format <fmt>] [--video]` (no browser, exit 0 =
     match) says whether the live film still is that film. Do not edit the film between producing the evidence and the critic's reply
   - the second and every later run in the same folder compares its pop, jump and dead-span candidates with the previous run
     (`baseline.json`): `same as previous run: N of M candidates`, new ones listed first (`metrics.md` section "Film version and
     delta"). A stepped (pixel-art) film sets `studio.json` `critique.stepped: true` (hard jumps become info, a one-frame flicker
     stays a P1) and `critique.popIgnore: [[t0, t1], ...]` (seconds; silences the pop scan inside intended spans); `metrics.md`
     lists what was suppressed. `--skip-determinism-repeat` reuses the passing determinism result of the previous live run when the
     film hash, format, range and tool code are the same (the passes always run again after any edit of `film/`, `lib/` or `studio.json`)
   - a P0 `font-fallback` finding means a character has no glyph in its font (or the family is not registered): fix the
     film (register a font, `npm run fonts -- add-file ...`, check with `coverage`) before the round; it stays an open P0 and
     blocks the gate until it is gone
5. Brief `motion-studio:motion-critic`:

   ```
   Project root: <abs path>. Round <N>, format <fmt>. Changes since last round: <list>.
   Evidence: both, already produced this round. Live film in out/review/<fmt>/, mixed render
   out/<fmt>/final.mp4 in out/review/<fmt>/video/. Do not run render, sfx or mix. Do not edit the film while you work.
   Before you render any zoom still run node tools/critique.mjs --check-hash --format <fmt>; on a mismatch stop and report it.
   Open contact.png and every contact-N.png page (metrics.md lists the pages of every sheet), shots.png, phone.png,
   strip.png (and loop.png) in the live folder, then the same files in video/, and read both metrics.md files. Every
   finding becomes a logged problem or a one-line dismissal with a reason. A font-fallback (P0) is logged as a P0 and
   blocks the gate until the font is fixed (dismiss it only for text that never reaches the screen); an audio-gap (P1)
   caps sound at 7. Be a harsh motion director, not a proud author. Score hook, readability, motion, variety, composition, brand, sound 1-10. Sound comes from the video
   folder's audio row. `na` only for an axis that studio.json gate.naAllowed lists (default: brand, for a film
   with no brand). Sound is never na for a film with audio.
   List problems as [P0|P1|P2] [mm:ss.cc] text (minutes:seconds.centiseconds, e.g. [00:04.20]).
   Append exactly one round block to docs/review_log.md in the format critique.mjs printed.
   ```

   One critic run takes 5 to 12 minutes and appends its round to the same `docs/review_log.md`: never run two critics at the
   same time (not for two formats either); start the next one after the previous one has returned. Use the waiting time to
   render the next evidence set, not to edit the film that is under review.

   If there is no mix yet, write `Evidence: live only, no mix yet` in the brief. The critic then scores sound 4 or
   lower with a P1 that names the missing evidence, and that round cannot be the last.
6. Fix the 3 worst problems, P0 first. Check only what changed:
   `node tools/render.mjs --format <fmt> --from <a> --to <b> --draft --out out/check` (writes
   `out/check/<fmt>/clip_<a>-<b>.mp4` plus `.json` and never touches `silent.mp4`) or
   `node tools/stills.mjs --at <t1,t2,...> --format <fmt> --out out/check/<fmt>/fix.png`.
7. Other formats: at least one round per extra format before the final render, each with its own evidence set
   (steps 3 to 5 with that format). Reframing faults (clipped headline, UI outside the safe rect) are P1. This is a working
   rule, and by default the gate does not enforce it (see step 8): set `gate.requireFormats: true` in `studio.json` when the
   brief ships several formats and the extra-format rounds must be proven.
8. `npm run gate`. What it checks by default: it judges the LAST round only (the format in that round's heading is not looked
   at, so one `9x16` round can pass a film that lists three formats). With `gate.requireFormats: true` it also requires, for
   every format in `studio.json` `formats`, a logged round whose heading names that format (`## Round 4 — 1x1 — ...`)
   and the LATEST such round must pass on its own scores (every gate axis scored, all >= `gate.minScore`, `na` only on `gate.naAllowed`, no open P0). Turn it on
   for a multi-format delivery; leave it off for a one-format film or a draft. Pass = at least 3 rounds, the last round has every
   gate axis, every numeric score >= 8, no `na` outside `gate.naAllowed` (default `["brand"]`), and no open P0 (a P0 closes only through a
   `FIXES:` line `<n>. fixed|resolved|wontfix`, see docs/review_log.md). Otherwise start
   the next round. A last round with `sound=na` fails with `na not allowed for sound (gate.naAllowed:
   brand)`: score the mixed render instead. Only the user may list `sound` in `gate.naAllowed`
   (a film that ships silent). In a brand film do not score brand `na` either: the gate cannot tell.

Severity guide:

| Severity | Meaning | Examples |
|---|---|---|
| P0 | must fix before any final render | nondeterministic frames, broken text, wrong brand, frame 0 blank, loop seam jump, audio clipping |
| P1 | fix this round if among the 3 worst | text overlap during a swap, dead beat, off-grid hit, unreadable at 360 px, banned look |
| P2 | polish | slightly long hold, minor spacing, weak easing on one element |

Hunt list for every round: text overlapping during swaps, anything sliding instead of springing,
corner labels and frame borders, centered-on-gradient shots, blurry scaled text, a dead beat with
nothing happening, a stutter at the loop seam, cues that miss their visual hit.

---

## Stage 7: final render, SFX, mix

Goal: `out/<fmt>/final.mp4` for every format with a loudness-normalized soundtrack.

| Command | Output | Check |
|---|---|---|
| `npm run render:final` | `out/<fmt>/silent.mp4`, `poster.png`, `render.json` | frames = round(duration x fps) |
| `npm run sfx` | `audio/cues.json`, `audio/sfx.wav` | every cue type valid; length = film |
| `npm run voice -- --dry-run` then `npm run voice` (optional) | `audio/voice.wav` | character count shown before spending credits |
| `npm run mix` | `out/score.wav`, `out/<fmt>/final.mp4`, `out/final.mp4`, `out/poster.png` | I = -14 LUFS +-0.5, TP <= -1 dBTP after AAC. Every stem is measured first: a music, voice or sfx stem shorter than the film by more than 0.25 s, empty, or silent stops the mix (regenerate it, or pass `--allow-short-stems` for a voice-over that is meant to be short); a silent sfx stem only warns |

`npm run build` runs score (if missing), sfx, the final render, mix and deliver in one go. The
plugin hook gates it like `render:final`.

Render time (one measurement, used everywhere in this plugin): the template's 12 s demo film, 60 fps, 4 subframes, the
default 4 workers, final x264 encode, installed Chrome on a 12-thread Windows laptop (Core i7-1255U; the Windows default is
now the headless shell, whose per-frame speed was not re-measured and which adds 15 to 25 s start-up per tool run under
real-time antivirus). It ran at 123 ms per frame in 9x16, 75 ms in 1x1 and 118 ms in 16x9: 720 frames per format, 91, 55 and 87 s, about 4 minutes for the three
formats (3 min 55 s to 3 min 58 s on an idle machine, up to 5 min while other programs load it). The cost is frames
x formats: about 20 s of wall time per second of film for three formats. Lower it with `--sub 1`, `--scale`,
`--fps 30`, `--draft` or `npm run animatic`, and raise `--workers` on a bigger machine. The `--final` render runs in the
background (see the section on long commands above).

If a render fails: read the error (it names the page error or the ffmpeg cause), then brief
`motion-studio:render-engineer` with the command and the log, or use `/motion-studio:seek-engine`.

---

## Stage 8: deliver and report

1. `npm run deliver` checks each format against the CURRENT `studio.json` (frames = duration x fps, the format's
   size, fps; a cut rendered before an edit of `duration` or `fps` fails as `stale render`), plus loudness, silent spans (a
   span of 1 s or more below -50 dB fails as `silence`, for example `silence 2.2 s at 00:02.1`: regenerate the stem and
   `npm run mix`), size vs `deliver.maxBytes`, poster, loop seam and gate status, copies files to `out/deliver/` (video,
   poster and every page of the contact sheet) and writes `out/deliver/manifest.json` and `docs/production.json`. Exit 1
   names the failing check; with `--json` a failing run prints `{ ok: false, error, failed: [...] }`. `--format 1x1`
   re-delivers only that format and keeps the others' delivered files.
2. Fill the delivery note template (`assets/delivery-note.md` in this skill). Include honest time
   and effort: how many rounds, what the user had to decide, what is still weak.
3. Offer next moves: fix list at `/effort medium`, another format, a brand skill of the user's own
   (`/motion-studio:ship-formats`).

---

## Autonomous mode

When the user asked for no interruptions:

- Take the defaults from the SKILL.md input table and write them into `docs/shotlist.md`.
- Skip the approval wait. Never skip lint, the critique gate or delivery checks.
- Anything that needs the user (missing logo, a key, a license question) goes into the final
  report as an open item instead of a guess.
