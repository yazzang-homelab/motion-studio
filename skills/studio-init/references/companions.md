# Optional companions

motion-studio covers route A (code-drawn canvas films) end to end. These projects cover looks or
routes it does not. Suggest one only when the request needs it, and let the user install it.
Commands were checked against each project's published instructions on 2026-09-29.

## claude-animation (hand-drawn looks)

| | |
|---|---|
| What | Hand-drawn 2D animation in Node canvas: brush, pencil, watercolor, grain, poseable rigs, synthesized sound |
| When | the brief asks for a storybook, painted or hand-drawn character look |
| License | MIT (buildwithhanif/claude-animation-skill) |
| Install | `claude plugin marketplace add buildwithhanif/claude-animation-skill` then `claude plugin install claude-animation@claude-animation-skill` |

- It renders in Node without a browser, with its own film format; it does not use this project's
  `seek(t)` page.
- To combine: render its shot to a PNG sequence, copy it to `assets/img/<shot>/`, preload the
  images in the film's `setup()`, and draw frame `floor(lt * fps)` inside the scene.
- Seen during development on Windows: its dynamic imports failed with
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Check its repository for a fix before recommending it to a
  Windows user.

## HyperFrames (route B, HTML + GSAP)

| | |
|---|---|
| What | HTML/CSS/GSAP compositions rendered deterministically to MP4 |
| When | the user names HyperFrames, or thinks in web pages and wants its studio and cloud render |
| License | Apache-2.0 (heygen-com/hyperframes) |
| Needs | Node 22 or newer, ffmpeg |
| Install (plugin) | `claude plugin marketplace add heygen-com/hyperframes` then `claude plugin install hyperframes@hyperframes`; its router is `/hyperframes:hyperframes` |
| Install (skills only) | `npx skills add heygen-com/hyperframes` (the `skills` CLI needs Node 22.20+) |

The `seek-engine` skill has the handoff steps: preview in the background, render only after the
user's OK, and never run its skills updater inside a plugin install.

## Remotion (route B, React)

| | |
|---|---|
| What | React compositions with a timeline studio; strong for series, templates, data-driven videos |
| When | the user names Remotion |
| License | Remotion License: free for individuals, for-profit organizations with up to 3 employees, and non-profits; larger for-profit organizations need a Company License (remotion.pro/license) |
| Install (plugin) | `claude plugin marketplace add remotion-dev/claude-code-plugin` then `claude plugin install remotion@remotion`, then restart Claude Code |
| Install (skills only) | `npx skills add remotion-dev/skills` |

Show the license line to the user before scaffolding a Remotion project. Pass the composition id
explicitly when rendering (the blank template's id is `MyComp`), and use a props file instead of
inline JSON on Windows. Details in the `seek-engine` skill.

## Why not by default

Route A has zero framework dependencies, works on Node 20, keeps every frame editable in one
place, and is what Opus 5.5 tends to write when unprompted. A framework earns its place when the
user already works in it or needs its studio, templates or cloud rendering.
