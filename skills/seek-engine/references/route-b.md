# Route B: hand off to HyperFrames or Remotion

Use route B only when the user names a framework. Left alone, Opus writes its own engine (route A) even when a
framework is installed, so the handoff has to name the framework and its skill explicitly. Do not vendor either
framework into this plugin or into the film project; install it the way its authors document.

Checked against upstream docs and repos on 2026-09-29. Re-check versions before relying on them.

## 1. Choose

| | Route A (this engine) | B: HyperFrames | B: Remotion |
|---|---|---|---|
| Model | canvas + `window.seek(t)` + Playwright + ffmpeg | HTML + CSS + GSAP (and other seekable runtimes) | React components |
| Best for | showreels, UI motion, loops, pixel art | pages you think of as web layouts, captions, explainers | series, templates, data-driven videos |
| Node | 20 or newer | 22 or newer | check Remotion's docs; the `skills` CLI needs 22.20.0+ |
| License | PolyForm Noncommercial 1.0.0 (this plugin) | Apache-2.0 | Remotion License (source-available, see the gate below) |
| Preview | `npm run preview` | `npx hyperframes preview --background` | `npx remotion studio --no-open` |

## 2. Pre-flight (both frameworks)

1. `node -v`. Below 22: stop and tell the user. Windows with nvm-windows: `nvm install 22` then `nvm use 22`.
   macOS/Linux with nvm: `nvm install 22 && nvm use 22`. Route A keeps working on Node 20.
2. ffmpeg on PATH (`ffmpeg -version`). If only the film project's `ffmpeg-static` exists, the framework will not see
   it; install ffmpeg system-wide (`winget install Gyan.FFmpeg`, `brew install ffmpeg`, `sudo apt install ffmpeg`).
3. `npm run doctor` in a studio project also reports Node and ffmpeg for route B.
4. Make a separate folder for the framework project. Do not scaffold into the route A project.

## 3. HyperFrames (HTML)

Install once (Claude Code plugin, recommended upstream):

```
claude plugin marketplace add heygen-com/hyperframes
claude plugin install hyperframes@hyperframes
```

Then `/reload-plugins` or a new session. Standalone skills instead of the plugin: `npx skills add heygen-com/hyperframes`
(pass `--skill <name>` or `--all`; the picker is interactive otherwise).

Work:

1. Scaffold: `npx hyperframes init my-video --non-interactive` (options include `--resolution portrait|landscape|square`
   and `--example blank|kinetic-type|product-promo|...`).
2. Invoke the router by name in the prompt: "Using /hyperframes:hyperframes, turn docs/shotlist.md into a 20-second
   9:16 film ...". Carry over the house rules: one accent, banned defaults, something new every 2 to 4 seconds.
3. Checks: `npx hyperframes lint`, then `npx hyperframes check` (lint, runtime, layout, motion and contrast), and
   `npx hyperframes snapshot --at 1,2.5,4` for stills to critique.
4. Preview without blocking the session: `npx hyperframes preview --background`, confirm it answers, give the URL to the
   user. Never chain `preview && render`: preview is a long-running server and the render never starts.
5. Render after the user's OK: `npx hyperframes render --quality delivery --fps 60 --output out/final.mp4`.

Rules from upstream worth keeping:
- Inside a plugin install, do not run `npx hyperframes skills update`, `skills check` or `npx skills add`; the plugin
  ships a version-pinned launcher. Treat the plugin directory as read-only.
- HyperFrames' own determinism rules match ours: no render-time clocks, no unseeded `Math.random`, no render-time
  network, no `repeat: -1`.
- `init` checks skills against GitHub; set `HYPERFRAMES_SKIP_SKILLS=1` to skip that. Telemetry opt-out variables:
  `HYPERFRAMES_NO_TELEMETRY`, `DO_NOT_TRACK`.

Experimental bridge (not verified end to end): `lib/runtime.js` listens for `hf-seek` events
(`e.detail.time`) and calls `window.seek`, so a route A canvas can be embedded as a HyperFrames composition
(root `data-composition-id`, `data-width`, `data-height`, `data-duration`). Test on a 2 s clip before promising it.

## 4. Remotion (React)

### LICENSE GATE (show this before any install or scaffold)

Quote the terms to the user and ask which one applies. Source: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md

> "Individuals and small companies are allowed to use Remotion to create videos for free (even commercial), while a
> company license is required for for-profit organizations of a certain size."

Free License eligibility, verbatim: "an individual", "a for-profit organization with up to 3 employees", "a non-profit
or not-for-profit organization", "evaluating whether Remotion is a good fit, and are not yet using it in a commercial
way".

> "You are required to obtain a Company License to use Remotion if you are not within the group of entities eligible
> for a Free License." Pricing: https://www.remotion.pro/license

Also disallowed under the free license: "to copy or modify Remotion code for the purpose of selling, renting,
licensing, relicensing, or sublicensing your own derivate of Remotion." The LICENSE notes that Remotion 5.0 changes the
terms slightly; read the current file.

Decision: a for-profit organization with more than 3 employees needs a Company License. If the user cannot confirm
they are eligible or licensed, stop and offer route A. This plugin gives no legal advice; the LICENSE text decides.

### Install and work

```
claude plugin marketplace add remotion-dev/claude-code-plugin
claude plugin install remotion@remotion
```

Restart Claude Code afterwards. Standalone alternative: `npx skills add remotion-dev/skills` (needs Node 22.20.0+).

1. Scaffold (non-interactive): `npx create-video@latest --yes --blank --no-tailwind my-video`, then `cd my-video` and
   `npm i`.
2. Invoke the router skill by name: "/remotion-best-practices make a 20 s 9:16 launch film ..." (with the plugin the
   namespaced form may be `/remotion:remotion-best-practices`; the command menu shows the exact name).
3. Preview: `npx remotion studio --no-open` (long-running; hand the URL to the user).
4. Render after the user's OK, passing the composition id: `npx remotion render MyComp out/final.mp4`.
   The blank template's composition id is `MyComp`; the course's `npx remotion render Main ...` only works if you named
   a composition `Main`. Without an id the CLI asks interactively, which hangs an agent.
5. Props: on Windows pass a file (`--props=props.json`); inline JSON does not survive Windows shells.

## 5. What carries over from a studio project

- `studio.json` values: duration, fps, formats, brand colors and fonts, loudness targets.
- `docs/style_guide.md`, `docs/shotlist.md`, `docs/STORYBOARD.md`: framework-neutral; reuse them as the prompt.
- Music and beat grid: `node tools/score.mjs` or `node tools/beats.mjs <track>` in the studio project produce
  `audio/music.wav` and `audio/beats.json`; import both into the framework project.
- The critique loop: review stills from `snapshot` / `remotion still`, score the same 7 axes, log rounds in
  `docs/review_log.md`. The render gate hook only guards route A commands, so hold yourself to the same bar.
- Loudness: check the framework's output with `node tools/critique.mjs --video <path>` from the studio project
  (reports integrated LUFS and true peak against -14 LUFS / -1 dBTP).
