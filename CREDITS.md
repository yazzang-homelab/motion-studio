# Credits

motion-studio is an independent implementation, licensed under the PolyForm Noncommercial License 1.0.0. It packages a course and a set of patterns that other
people published in the week after Claude Opus 5.5 shipped (22 September 2026). This file says where each idea came
from, under what license, and what we did not take.

Policy, stated plainly:

1. No code was copied from any source below, and no post's prompt text was reused apart from the quotations of policy 3.
   Everything in this repository was written for it.
2. X posts carry no license; their authors keep copyright. Where a creator's pattern shaped a skill, the skill
   describes the pattern in our own words and links the post.
3. Quotations. The one-sentence showreel prompt by @stephanlivera is quoted whole, with credit, in the `showreel` skill,
   exactly as the course quotes it. Besides it a handful of short attributed phrases (each under 15 words, for example
   "Try again, ultracode." or "seems to prefer") appear where they correct a claim or name an example. The complete list,
   with the source and the file of each, is in [prompts/README.md](prompts/README.md#what-is-quoted-verbatim). No other
   post text is copied.
4. Repositories without a license file (PDoomVideo, Battle-of-Austerlitz-Film, the remorses gist) were studied for
   ideas only. Nothing from them is redistributed.
5. Two licensed texts are used under their terms and listed in "Licensed text used" below: the acceptance gates of the
   director-brief template (adapted from a CC BY 4.0 document, with a changes note) and the Remotion license terms
   (quoted with a link to the source).
6. Posts and repositories were checked on 29 September 2026. View counts and star counts drift; none are repeated here.

## The course

| What | License | Ideas taken (where they live here) | Not taken |
|---|---|---|---|
| "How to build motion design studio with Opus 5.5 (Full-course)" by Movez ([@0xMovez](https://x.com/0xMovez/status/2104216919033192746)), X article, 27 September 2026 | Not stated (X article) | The 12-step structure (one skill per step, `motion-reel` for the whole run); the step-02 house rules, adapted and extended in the template `CLAUDE.md`; the prompt-size ladder L1 to L4 and the route table A to D (README, `motion-reel` references); the step-07 `seek(t)` approach (`lib/runtime.js`, `tools/render.mjs`); the step-08 spring presets read from its figure, snappy 320/30, default 170/26, heavy 90/20, playful 220/14 (`lib/motion.js`); the three-lane sound timeline (`sound-design`); the 7-axis critique and its hunt list, adapted in `prompts/critique-pass.txt`; the default palette of its sample page, #141413 / #F0EEE6 / #D97757 (`studio.json` `brand.colors`) | Article prose beyond short quotes, the cover, the figures and the mascot. The course's code samples were rewritten, not copied; our versions also fix `file://` loading, canvas font loading, the overdamped spring branch, ffmpeg error handling and loudness normalization |

## Creators whose public posts informed a pattern

| Creator | Post | Pattern it informed | Where it lives here |
|---|---|---|---|
| Claude (@claudeai) | [launch](https://x.com/claudeai/status/2102435511222890900) | The Opus 5.5 launch that started the trend | Context only |
| Thariq (@trq212) | [post](https://x.com/trq212/status/2102870353781641416) | A "one-shot" post can hide a 10k-character prompt with skills, examples and keys | Level ladder (README), `director-brief` |
| Tommy D. Rossi (@__morse) | [post](https://x.com/__morse/status/2103485566570369333) | Route A as the model's default: one `index.html`, a seek function, Playwright frame by frame, ffmpeg; beat times measured in Python | Render contract (`lib/runtime.js`, `tools/render.mjs`), `seek-engine` |
| Stephan Livera (@stephanlivera) | [post](https://x.com/stephanlivera/status/2103315922098470926) | The one-line showreel prompt (the one sentence quoted verbatim, with credit) | `showreel` |
| Rob Hallam (@robj3d3) | [post](https://x.com/robj3d3/status/2103875898349088830) | The one-liner on xhigh with one-shot audio; delivery checks for fps, frame count, exact duration, -14 LUFS stereo and file size under X's 512 MB limit | `showreel`, `tools/deliver.mjs`, `studio.json` `deliver.maxBytes` |
| Himanshu (@himanshutwtxs) | [post](https://x.com/himanshutwtxs/status/2103495232637882858) | The same sentence at Max and Medium effort; synced audio arriving unprompted | `showreel` effort notes |
| Tony Dinh (@tdinh_me) | [post](https://x.com/tdinh_me/status/2103703135902740699), [prompt](https://x.com/tdinh_me/status/2103705073494987058), [v2 prompt](https://x.com/tdinh_me/status/2103796614771179929) | Brand reel: the product URL, real screenshots, logo and assets, music the motion matches, a real production rather than a demo; v2 breaks screenshots into animatable components; the ~$1,000 agency price anchor | `product-reel`, `ship-formats` service template |
| Chain (@achxvi) | [post](https://x.com/achxvi/status/2103918792845963545), [prompt](https://x.com/achxvi/status/2103938227786654016), [45-minute film](https://x.com/achxvi/status/2104014659615392078), [service offer](https://x.com/achxvi/status/2104137954427830588), [later price posts](https://x.com/achxvi/status/2104564174881996863) | A talking mascot voiced through ElevenLabs; a placeholder instead of a real key; the service offer (music, mascot, features, an offer, any language, up to 3 edits); the observation that market prices for such videos vary widely ($39, then $69 per video) | `product-reel`, `tools/voice.mjs`, `.env.example`, `ship-formats` service template |
| Rexan Wong (@rexan_wong) | [post](https://x.com/rexan_wong/status/2103707054108299437) | The reference workflow: name a style instead of describing it; references from whatships.com; one still per scene before anything moves; notes given like a director, used as examples of director notes | `reference-style`, `critique-loop` |
| Pleometric (@pleometric) | [TikTok-feed piece](https://x.com/pleometric/status/2102572941699354900), [PC-98 re-run](https://x.com/pleometric/status/2103082510607610023) | A single reference frame; your own image library as the reference; let the model choose the technique | `reference-style`, `director-brief` |
| zero (@twoclipping) | [UI morph spec](https://x.com/twoclipping/status/2103273003555402193), [later template](https://x.com/twoclipping/status/2103835273813496100), [course article](https://x.com/twoclipping/status/2104446706741825818) | The six-section XML spec structure (inputs, direction, structure, build, gotchas, start); one shape that never cuts; a cursor driving every change; one frame per beat before the full render; the last frame equal to the first; later, a scan for single-frame pops (3x their neighbours) and a preference for real sound effects | `ui-morph-spec`, `tools/critique.mjs` pop scan (`critique-metrics.mjs`), `lib/motion.js` `loopTrack`, `tools/sfx.mjs` samples path |
| Martijn Verbove (@verbove) | [post](https://x.com/verbove/status/2103483957266268381) | The MakerMap spec, in the same spec structure as @twoclipping's: real UI and real data, every aspect ratio rendered in parallel | `ui-morph-spec`, `ship-formats`, `render --format all` |
| SuSu (@NFT_Chen) | [editor film](https://x.com/NFT_Chen/status/2102681172367323300), [tips](https://x.com/NFT_Chen/status/2102650980936581304) | A fake UI as a film set; naming the banned looks explicitly | `ui-morph-spec`, template `CLAUDE.md` banned list |
| onur ozcan (@oozn) | [post](https://x.com/oozn/status/2103482545111232946) | A soundtrack synthesized in Node with cuts locked to 120 BPM | `tools/score.mjs`, `sound-design` |
| Vox (@Voxyz_ai) | ["small print"](https://x.com/Voxyz_ai/status/2102531681450119426), [crew prompt](https://x.com/Voxyz_ai/status/2104194355556671987) | Music synthesized in code and a second-by-second polish pass; a review-only reviewer with P0/P1/P2 severities | `critique-loop`, `motion-critic`, the review-log format |
| donald (@donaldjewkes) | [film](https://x.com/donaldjewkes/status/2102801274173587569), [brief](https://x.com/donaldjewkes/status/2102801469976248500) | The dictated director brief: resources, budget, anti-references, text on screen, verification loops; generate-then-trace | `director-brief`, route C notes |
| @other__reality | [P(doom) video](https://x.com/other__reality/status/2102514581684052169) | Parallel subagents writing the scenes of one film | `chapter-animator`, `director-brief` |
| DreW (@devteamdrew) | [post](https://x.com/devteamdrew/status/2102436464323661880) | A previous video as the reference; several soundtrack iterations | `critique-loop` |
| Mable Joseph (@mablesjoseph) | [post](https://x.com/mablesjoseph/status/2103465246014746943) | Openly not one-shot: 163 model calls and about 6¾ hours; character and animation guides written first | `critique-loop`, `director-brief` |
| Pradeep Kapoor (@pradeepXkapoor) | ["Pip" brief](https://x.com/pradeepXkapoor/status/2103176289482154373), [fill-in template](https://x.com/pradeepXkapoor/status/2103177003885273599) | The brief-template pattern, idea only, reworded (no text copied): a crew-style opening and multi-session framing; the fill-in versus keep-as-is split; PLAN FIRST and GO modes; a definition of done (-14 LUFS ±0.5, ≤ -1 dBTP, review scores 8+, a re-render gives the same frames) | `director-brief` (`assets/brief-template.md`), `tools/mix.mjs` targets, `tools/gate.mjs` |
| klöss (@kloss_xyz) | [post](https://x.com/kloss_xyz/status/2103560107921723834) | A long reel with an original piano score and no generic synth (variant pattern, paraphrased) | `showreel` variants, `score.mjs --style piano` |
| 1LittleCoder (@1littlecoder) | [post](https://x.com/1littlecoder/status/2103587706999914649) | Keep frames and text out of the corners (the anti-slop guardrail, paraphrased) | `showreel` variants, `critique.mjs` corner and border heuristics |
| Sonny (@sonnylazuardi) | [post](https://x.com/sonnylazuardi/status/2103660301132685418) | A story instead of a list of techniques: the showreel sentence applied to a narrative (variant pattern, paraphrased) | `showreel` variants |

## Repositories and resources

| Resource | What it is | License | Ideas taken (where they live here) | Not taken |
|---|---|---|---|---|
| [buildwithhanif/claude-animation-skill](https://github.com/buildwithhanif/claude-animation-skill) | Claude Code plugin for hand-drawn 2D animation in Node canvas | MIT | The `verify` idea: the determinism check of `critique.mjs` hashes frames in order, shuffled and on a fresh page (reimplemented, credited in the code comment). One harness CLI with sheet, strip and verify verbs; staged output that never replaces a good file with a failed encode; a `render.json` sidecar; a numbered traps table; `{sfx, vol}` cue keys; the credit-table format of this file (`tools/render.mjs`, `tools/critique.mjs`, `lib/timeline.js` `normalizeCues`, `seek-engine` references) | All code, the rigs, the pen and brush library and the hand-drawn look, which `studio-init` recommends as an optional companion |
| [JohnHeibel/ClaudeAnimationBase](https://github.com/JohnHeibel/ClaudeAnimationBase) | p5.brush character-animation starter with a headless renderer | MIT | A ready gate and `?render` page contract; frames returned from the canvas rather than screenshots; parallel, resumable workers with atomic writes; exact-length audio instead of `-shortest` (its PR #4); stepped time for drawings only (issue #6); multi-format output (issue #7); commit 4751cc7, the finding that one shared RNG stream shifts every later value, fixed by per-element seeds (80k to 140k changed pixels per frame went to 0), cited in `lib/rng.js` and `seek-engine/references/determinism.md`; commit 58cf4ba, the finding that a non-finite point throws a misleading canvas error, cited in `lib/draw.js` (`lib/runtime.js`, `tools/render.mjs`, `lib/rng.js`, `lib/draw.js`, `tools/mix.mjs`, `lib/motion.js` `stepTime`, `lib/layout.js`) | All code, the Clawd character and model sheets, p5.brush, network font links |
| [JohnHeibel/PDoomVideo](https://github.com/JohnHeibel/PDoomVideo) | A 156 s music video made with parallel subagents | No license (all rights reserved) | Pattern ideas only: an `ANIMATION_GUIDE.md` written before spawning chapter subagents, a `STORYBOARD.md`, one file per chapter, "edit only your own file, report shared-file bugs", placeholder chapters that keep the film renderable, a transition column in the storyboard (`chapter-animator`, `director-brief`, `lib/timeline.js` `chapter()` and `placeholder()`, `hooks/role-guard.mjs`, template `docs/ANIMATION_GUIDE.md` and `docs/STORYBOARD.md`) | Any code, text, characters or audio (its song is third-party) |
| [remorses gist "ui-morph-colorful"](https://gist.github.com/remorses/3d467b50a0519ef7859823046dc9c427) | The code behind @__morse's colorful UI morph run | No license | Ideas only: a render flag set by an init script (`window.__RENDER__`), cues exported by the page for the audio stage, cyclic spring tracks for exact loop seams, subframes centered on the output frame, parallel pages (`lib/runtime.js`, `tools/sfx.mjs`, `lib/motion.js` `loopTrack`, `tools/render.mjs`) | All code, the music track |
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) | HTML + GSAP video framework and Claude Code plugin | Apache-2.0 | Its published determinism rules (render-time clocks, unseeded random, render-time network, infinite repeats), adapted as the lint rules of `tools/lint.mjs` (independent implementation, credited in the code comment); the `hf-seek` event bridge; route B handoff notes: plugin install, `preview --background`, Node 22+ (`lib/runtime.js`, `seek-engine` references) | All code and skills; no file from the repository is redistributed |
| Remotion: [Agent Skills docs](https://www.remotion.dev/docs/ai/skills), [remotion-dev/skills](https://github.com/remotion-dev/skills), [remotion-dev/claude-code-plugin](https://github.com/remotion-dev/claude-code-plugin), [LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) | React video framework, its agent skills and its Claude Code plugin | Skills and plugin manifests are labelled MIT (the skills repository has no LICENSE file). The framework is under the Remotion License: a Company License is required for for-profit organizations with more than 3 employees | The route B handoff and its license gate; pass the composition id; pass props as a file on Windows (`seek-engine` references). The Free License eligibility terms are quoted from LICENSE.md in `seek-engine/references/route-b.md` so the user sees the real wording before any install | Any Remotion package, template or skill text. Remotion is never bundled |
| [vercel-labs/skills](https://github.com/vercel-labs/skills) | The `npx skills add` installer | MIT | A layout that serves both installers: skills in `skills/<name>/` plus a marketplace entry with `"source": "./"`; the film template lives inside the `studio-init` skill so a skills-only install still gets it | Code |
| [guanmo-ai/awesome-ai-motion](https://github.com/guanmo-ai/awesome-ai-motion) | Curated gallery of AI motion videos with creator prompts | MIT for its own code and docs; third-party prompts, videos and covers excluded | A survey of recurring prompt patterns (pinning the route, plan before build, naming keys instead of pasting them), paraphrased in `showreel`, `product-reel` and `director-brief`; linked for further browsing | Any prompt text, cover or video |
| [athemeroy/awesome-opus-5-5-videos](https://github.com/athemeroy/awesome-opus-5-5-videos) | Dataset of reviewed Opus 5.5 video cases | CC BY 4.0 for its original writing and data ([license](https://creativecommons.org/licenses/by/4.0/)); third-party media and prompts excluded | (1) `docs/production-brief.md`: the acceptance gates (keyframes, then the hardest 2 to 4 second sample, then the whole film) and the rights and spend fields, adapted in `skills/director-brief/assets/brief-template.md`; changes: reworded, merged into the B1 gate table, mapped to motion-studio tools (`npm run gate`, `render --hash`, `deliver.mjs`). (2) The "brief contagion" framing for look-alike one-liner reels, which appeared in its README in commits e5a0072 to 55cce56 (26 to 27 September 2026) and was softened in 10bc706; it motivates the `showreel` randomizer. (3) Its count of effort mentions (3 of 168 reviewed cases), which backs the accuracy notes in `motion-reel` | Data files, other docs text, media, prompts |
| [WinterArc21/Battle-of-Austerlitz-Film](https://github.com/WinterArc21/Battle-of-Austerlitz-Film) | A five-minute historical film made in code | No license | Study only: chunked, resumable parallel rendering (write `.part`, then rename; concat without re-encoding), sound cues derived from the picture, the `imageio-ffmpeg` fallback, a render flag plus ready gate (`tools/render.mjs --chunk`, `tools/studio.mjs` `resolveFfmpeg`, `tools/sfx.mjs`) | Any code, footage, narration or audio |
| [Google Fonts](https://fonts.google.com/): Instrument Serif, Inter | Typefaces bundled in the film template | SIL Open Font License 1.1 | Default display face (Instrument Serif) and UI face (Inter), see below | Nothing else |

## Licensed text used

| Text | Source and license | Where | How it is used |
|---|---|---|---|
| The showreel one-liner | [@stephanlivera](https://x.com/stephanlivera/status/2103315922098470926), no license stated (X post) | `skills/showreel` variants | One sentence quoted verbatim with credit, as the course quotes it |
| Acceptance gates and rights/spend fields of a copyable production brief | athemeroy/awesome-opus-5-5-videos `docs/production-brief.md`, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | `skills/director-brief/assets/brief-template.md` (credit in its closing comment), `skills/director-brief/SKILL.md` | Adapted with attribution, the license link and a changes note: reworded, merged into the B1 gate table, mapped to motion-studio tools |
| Remotion Free License eligibility terms | [remotion-dev/remotion LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md), Remotion License | `skills/seek-engine/references/route-b.md` | Short passages quoted with the source link so the license gate shows the real wording; the file itself is not redistributed |

## Bundled assets

| Asset | Copyright | License | Files |
|---|---|---|---|
| Instrument Serif (regular and italic, latin + latin-ext subsets) | Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif) | SIL OFL 1.1 | `skills/studio-init/template/assets/fonts/instrument-serif-*.woff2`, `OFL-InstrumentSerif.txt` |
| Inter (variable 100 to 900, latin + latin-ext subsets) | Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) | SIL OFL 1.1 | `skills/studio-init/template/assets/fonts/inter-*.woff2`, `OFL-Inter.txt` |

Both bundled families are Latin-only. No Korean, Japanese or Chinese font ships with the plugin: `fonts.mjs add-file` and
`add --subsets korean` register fonts you choose, from their own sources and licenses, and copy the license text you give
them next to the font. Keep the OFL files next to the fonts when you redistribute a film project, and check any added
font before commercial use (an OFL font may declare a Reserved Font Name; `add-file` prints a note when it sees one).

Test fixtures under `test/fixtures/fonts/` are not font software: `notosanskr.css` is a trimmed copy of the Google Fonts
CSS response for Noto Sans KR (URLs and unicode ranges only) and `OFL-rfn.txt` is an abbreviated OFL text that declares a
Reserved Font Name, labelled as a fixture. The font-tool tests build their TrueType files from code.

## Runtime dependencies (installed into film projects, never bundled)

| Package or service | License or terms | Used for |
|---|---|---|
| [Playwright](https://github.com/microsoft/playwright) | Apache-2.0 | Driving Playwright's headless Chromium shell |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | GPL-3.0-or-later; downloads a GPL build of [FFmpeg](https://ffmpeg.org/) | Encoding, loudness measurement, muxing (optional; `FFMPEG_PATH` works instead) |
| [librosa](https://github.com/librosa/librosa) | ISC | Optional beat tracking in `tools/beats.py` |
| [ElevenLabs API](https://elevenlabs.io/) | Your account's terms | Optional voice lines in `tools/voice.mjs`, with your own key |

## Algorithms and standards (reimplemented from their published descriptions)

| Item | Used in |
|---|---|
| Closed-form damped harmonic oscillator step response (under-, critically and over-damped) | `lib/motion.js` |
| Apple's duration and bounce spring parameterization (SwiftUI, WWDC 2023) | `lib/motion.js` `springFromFeel` / `feelFromSpring` |
| mulberry32 PRNG (Tommy Ettinger) and FNV-1a hashing (Fowler, Noll, Vo) | `lib/rng.js` |
| SHA-256 (FIPS 180-4), for pages without `crypto.subtle` | `lib/runtime.js` |
| Spectral-flux onset strength and beat tracking by dynamic programming (Ellis, 2007) | `tools/beats.mjs` JS engine |
| EBU R 128 / ITU-R BS.1770 loudness, via FFmpeg `loudnorm` and `ebur128` | `tools/mix.mjs`, `tools/deliver.mjs`, `tools/critique.mjs` |
| ITU-R BT.709 color tagging | `tools/render.mjs` |
| OKLab color space (Björn Ottosson, 2020) for palette clustering | `tools/refs.mjs` |

## Accuracy notes

Where the course's claims differ from the original posts (for example the effort levels, Tony Dinh's "three extra
lines", or where @twoclipping's template was posted), `skills/motion-reel/references/routes-and-levels.md` records
what the sources say.
