# Shot list: <film title>

Status: draft

<!--
Template. Written by the motion-director or style-analyst subagent (or the main session) from docs/style_guide.md,
assets/manifest.json and audio/beats.json, BEFORE any film code.
The Status line above gates the build:
  Status: draft                              not approved yet: no film code
  Status: approved (<date>)                  the user said OK
  Status: autonomous (<the user's words>)    the user asked you not to wait
A rejection means rewriting this file, not the code. Replace every <...> and delete these comments when done.
Grid notation: bar.beat counted from 1 like a musician (1.1 is the first downbeat = grid.bar(0);
2.3 = grid.beat(6) in 4/4). Times in seconds must match the grid.
-->

- Film: <title> · <duration> s · <bpm> BPM, <beats per bar>/4 · grid: <synthesized | measured from audio/<track>>
- Formats: <9x16 (primary), 1x1, 16x9> · loop: <yes | no>
- Hook (first 2 s): <the single most striking image; frame 0 already shows it forming>
- CTA / last frame: <exact copy> · metric shown: <exact number and its source, or none>

## Rules for this film

- Scene changes on downbeats; SFX on beats; accents on measured hits.
- Something new every 2 to 4 s; one focal action per shot.
- <film-specific rules from the brief or the style guide>

## Shots

| # | Time (s) | Bar.beat | Shot | What the viewer notices | Action -> end state | Camera | On-screen text (exact) | Spring feel | SFX (type @ s) | Out |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0.00-2.00 | 1.1 | <hook> | <the event> | <what moves, where it ends> | <static, push in, pan> | <exact copy or none> | <snappy UI, heavy type> | <thump @ 0.00> | <cut on action> |
| 2 | 2.00-4.00 | 2.1 | <...> | <...> | <...> | <...> | <...> | <...> | <whoosh @ 2.00, click @ 3.00> | <...> |

## Per-format notes

| Shot | 9x16 | 1x1 | 16x9 |
|---|---|---|---|
| <#> | <stacked: title top, UI below> | <tighter margins> | <side by side: title left, UI right> |

## Open questions

- <anything the user must decide; subagents list questions here instead of guessing>
