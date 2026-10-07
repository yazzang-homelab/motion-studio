---
name: <brand>-reel
description: "Make <Brand> motion videos rendered from code: launch reels, feature spots and social cuts in 9:16, 1:1 and 16:9 with <Brand>'s real UI, palette and fonts. Use for '<brand> video', 'launch reel for <feature>', 'social cut'."
argument-hint: "[feature or topic] [duration] [format]"
effort: xhigh
---

# <Brand> reel

<!--
Template from the motion-studio plugin (ship-formats skill). Copy it to .claude/skills/<brand>-reel/SKILL.md in the
brand's repository (or ~/.claude/skills/<brand>-reel/SKILL.md for personal use), replace every <...> from a finished,
approved film project, and delete these comments. Keep the description under about 230 characters and this file under
about 200 lines; put long material (story variants, copy bank) in files next to it and link them.
The skill works with the motion-studio plugin installed (it calls its skills and subagents) and, without it, with the
tools inside any motion-studio film project (npm run ...).
-->

Makes a <Brand> video from code with the motion-studio pipeline. Everything in "Brand constants" is fixed: never ask
for it. Ask only for what changes per video.

## Brand constants

| Token | Value |
|---|---|
| name, URL | <Brand>, <https://...> |
| colors | bg <#......> · fg <#......> · accent <#......> (the only accent) · muted <#......> |
| display face | <Family, weights> (bundle with `npm run fonts -- add "<Family>:<weights>"`; license: <OFL / commercial>) |
| UI face | <Family, weights> |
| logo | `${CLAUDE_SKILL_DIR}/assets/<logo.svg>`: copy into the film project's `assets/brand/` |
| voice and tone | <three adjectives>; never say <words the brand never uses> |
| default CTA | "<exact copy>" |
| music | <`node tools/score.mjs --style minimal --bpm 120`, or licensed track `<path>` with its license <...>> |
| formats | 9x16 (primary), 1x1, 16x9 |
| motion signature | <e.g. logo lockup on the heavy spring with a 0.8 s hold; UI on snappy; one mask wipe per film> |
| last approved film | <path to its docs/shotlist.md and out/final.mp4> |

## Inputs per video (ask once, in one message)

- Feature or topic, and the one number that proves it works (with its source).
- Duration (default <20> s), formats (default all three), deadline.
- Anything new to show: screenshots or a staging URL (never invent UI).

## Pipeline

1. Project: if the current folder has no `studio.json`, create one with `/motion-studio:studio-init <dir>` and set
   `studio.json` `title`, `duration`, `formats` and `brand` from the constants above.
2. Assets: capture the real UI for this feature into `assets/` (the `asset-scout` subagent, or Playwright
   screenshots; on Windows use Playwright's headless shell, never an installed Chrome or Edge, whose fresh-profile launches
   count as failed Windows logons) and list what you found before animating. Break screenshots into parts so each can move.
3. Music and grid: synthesize or measure (`/motion-studio:sound-design`). Every time comes from the beat grid.
4. Shot list in `docs/shotlist.md`, on the grid, using the brand story: hook (the problem in at most 5 words of huge
   type) -> product appears and assembles -> <n> feature moments, each with a cursor doing a real action -> the proof
   number -> logo lockup with the CTA. Show it and wait for OK.
5. Build `film/film.js` with springs from `lib/motion.js` and the layout `L` for every format.
6. Critique loop (`/motion-studio:critique-loop`): at least 3 rounds, every axis 8 or more, no P0, one round per
   format before the final.
7. `npm run build`, then report: files in `out/deliver/`, loudness per format, last scores, what you would improve.

## Hard rules

- Real <Brand> UI only. Never redraw screens from imagination; crop and animate the real thing.
- Brand palette only, one accent. Bundled brand fonts only.
- Banned: centered title on a gradient, everything fading in, corner labels, frame borders, glow on UI chrome,
  generic particle bursts, <brand-specific bans learned from past critiques>.
- No `Math.random`, timers, `Date` or CSS transitions in film code. Keys only in `.env`, referred to by name.
- Master at -14 LUFS +-0.5, true peak <= -1 dBTP.

## Lessons from past films

<!-- The problems the critic kept flagging in docs/review_log.md, turned into rules. Examples:
- The logo needs 0.8 s of hold after it settles, or the lockup reads as a flash.
- Dashboard screenshots are too dense at 360 px wide: crop to one card per shot. -->
- <lesson>
