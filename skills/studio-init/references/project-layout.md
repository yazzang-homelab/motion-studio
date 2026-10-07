# Film project layout

What `init.mjs` copies into a new project, what each file is for, and who edits it. "Main" means
the main Claude Code session; agent names are the plugin's subagents. A plugin hook limits each
subagent to its column where hooks are allowed to run.

```
<project>/
  CLAUDE.md                 house rules, read by Claude Code on every run in this folder
  studio.json               the one config file: timing, formats, brand, audio targets, gate
  package.json              npm scripts; devDependency playwright, optional ffmpeg-static
  index.html                canvas#stage + module script; no network
  film/
    film.js                 the film: defineFilm(factory); ships a 12 s demo to replace
    scenes/                 chapter modules chNN_<name>.js for long films
  lib/                      engine library (motion, rng, timeline, layout, draw, fonts, runtime)
  tools/                    studio (+ studio-web), render, stills, serve, audio, score (+ instruments),
                            sfx, beats, mix, voice, critique (+ critique-metrics, critique-pin, critique-baseline), lint, gate, doctor,
                            fonts, refs, deliver
  prompts/                  critique-pass.txt, refactor-springs.txt
  docs/                     API.md (lib signatures and defaults), style_guide.md, shotlist.md, review_log.md,
                            ANIMATION_GUIDE.md, STORYBOARD.md (skeletons with instructions)
  assets/fonts/             two bundled OFL families + license files + fonts.json (add more with tools/fonts.mjs)
  assets/img/               stills and images you add
  audio/                    music.wav, beats.json, cues.json, sfx.wav, voice.wav (generated)
  refs/                     reference videos, frames, analysis.json
  out/                      renders and review images (generated, git-ignored)
  .env.example              key names only (ELEVENLABS_API_KEY, FAL_KEY)
  .gitignore                node_modules/ out/ .env audio/.cache/ *.log .venv/
```

| Path | Purpose | Written by |
|---|---|---|
| `studio.json` | duration, fps, subframes, bpm, formats, primary format, brand, audio targets, gate | main (user decisions) |
| `film/film.js` | scenes, shots, cues; a pure function of time | main |
| `film/scenes/chNN_*.js` | one chapter each | `motion-studio:chapter-animator` (one owner per file) |
| `lib/*.js` | engine library; edit only to fix an engine bug | main or `motion-studio:render-engineer` |
| `tools/*.mjs` | CLI tools behind the npm scripts | `motion-studio:render-engineer` for fixes |
| `docs/style_guide.md` | look extracted from a reference | `motion-studio:style-analyst` |
| `docs/shotlist.md` | shots on the beat grid, approval status line | `motion-studio:motion-director` or `style-analyst` |
| `docs/API.md` | cheat-sheet of every `lib/` signature and default (the plugin's `docs/ARCHITECTURE.md` is the full reference) | shipped with the template |
| `docs/review_log.md` | critique rounds: scores and P0/P1/P2 problems | `motion-studio:motion-critic` only |
| `docs/ANIMATION_GUIDE.md`, `docs/STORYBOARD.md` | long-form crew docs | `motion-studio:motion-director` |
| `assets/brand/**`, `assets/manifest.json` | captured screenshots, logo, colors, fonts, copy | `motion-studio:asset-scout` |
| `assets/fonts/*`, `assets/fonts/fonts.json` | font files, license texts and the FontFace list the runtime loads | `npm run fonts`, or the product-reel capture script (fonts a page uses; license UNVERIFIED) |
| `audio/*` | music (+ `music.meta.json` sidecar), measured or analytic beat grid, cues, stems | `motion-studio:sound-designer` or the tools |
| `refs/*` | reference material and its analysis | `motion-studio:style-analyst` via `tools/refs.mjs` |
| `out/<fmt>/*` | `silent.mp4`, `final.mp4`, `poster.png`, `render.json`; `.staging/` holds a finished render that could not be published (a player held an output open) | render and mix tools |
| `out/review/<fmt>/*` | contact, shots, phone, strip (page 1 is `<name>.png`, then `<name>-2.png` ... when a sheet is paged), loop, metrics of the live film | stills and critique tools |
| `out/review/<fmt>/video/*` | the same files for the mixed render (`critique --video`), with loudness and true peak | critique tool |
| `out/deliver/*` | delivery package and manifest | `npm run deliver` |

## Render contract in one paragraph

`index.html` loads `film/film.js` and `lib/runtime.js`. The runtime fetches `studio.json` and
`audio/beats.json` (optional), loads the bundled fonts through the FontFace API, and exposes
`window.seek(t)` plus `window.__studio` (`ready`, `meta`, `grid`, `cues()`, `shots()`, `frame()`,
`hash()`, `pixels()`, `textUse()`, `coverage()`). Tools serve the project over `http://127.0.0.1` because ES modules and
`fetch` do not work from `file://`. Each frame is a pure function of `t`, so frames can render in
any order, in parallel, and identically on every run.

## Formats

| Key | Size | Typical use |
|---|---|---|
| `9x16` | 1080x1920 | Reels, TikTok, Shorts |
| `1x1` | 1080x1080 | X and feed |
| `16x9` | 1920x1080 | YouTube, websites |
| `4x5` | 1080x1350 | feed portrait |

Scenes position everything through the layout object `L` (safe rect, anchors, split, columns), so
every format is reframed from one timeline instead of cropped.
