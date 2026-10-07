# Style guide notes

How to fill the project's `docs/style_guide.md` skeleton from a reference. The skeleton defines the
headings (Palette, Type, Pacing, Transitions, Camera, Motion feel, Texture, Text on screen, Banned);
these notes say where each answer comes from. Every line of the guide should be traceable to a
number in `refs/analysis.json`, a frame you looked at, or the user's words.

## Evidence map

| Guide section | From `refs/analysis.json` | From looking at frames | Decide |
|---|---|---|---|
| Reference / Take / Never take | `source`, `kind` | what the user said they like | the take list and the never-take list, in the user's terms |
| Palette | `palette[].hex` and `share` (6 colors, perceptual k-means) | which color is the ground, which one draws the eye | map to `bg`, `fg`, `accent`, `muted`; one accent; write them into `studio.json` `brand.colors` unless the brand overrides them |
| Palette (tone) | `brightness.mean` (0 black to 1 white), `contrast.mean` | flat or graded, clean or dirty | dark, mid-tone or light ground |
| Type | `text.hint` and `text.edgeShare` (heuristic text density) | serif or sans, weight, tracking, case, scale jumps, how many words on screen | map classes to bundled or vendored families; never name the reference's commercial font as a requirement |
| Pacing | `shots.mean`, `shots.median`, `shots.min`, `shots.max`, `cuts[]` | holds, where the film breathes | cuts per bar at the film's BPM (shot length in s x BPM / 60 / beats per bar) |
| Transitions | `cuts[]` times; look at the frames either side of each | cut on action, mask wipe, match cut, morph, whip | the 2 or 3 transitions this film uses |
| Camera | `motion.perSecond` peaks | push-ins, pans, parallax, locked-off | how often the camera moves and what never moves |
| Motion feel | `motion.mean` (overall energy) | snappy or floaty, overshoot or none | spring preset per element class |
| Texture | `contrast`, frames at 100 % zoom | grain, paper, halftone, blur | grain amount and where the frame stays clean |
| Text on screen | `text.hint` | entry and exit (rise, mask, per-character, typewriter) | max words per line, big words vs subtitle lines |
| Banned | none | anything in the reference the user does not want | house bans plus film-specific bans |

Frames to open: `refs/contact.png` first (and `refs/contact-2.png` ... when the sheet is paged), then the frames just before and after each time in
`cuts[]` (frame N sits at N x `--every` seconds; `refs/frames/frames.json` lists the times), and
the frames around `motion.peakSecond`.

## Per rung

| Rung | What the numbers can say | What they cannot |
|---|---|---|
| One frame | palette, tone, text density | pacing, transitions, camera: take those from the brief and say so in the guide |
| A video | all rows above | intent: confirm with the user which parts they actually like |
| A library | a stable palette and texture across many images | motion: define it from the brief and the house rules |

## Writing rules

- Concrete values only: hex codes, seconds, weights, tracking in em, spring preset names.
- Name the style in a phrase the user recognises ("Swiss grid with one warm accent", "PC-98
  dithered pixel art") and describe it with the values; naming beats describing, the values keep
  it honest.
- Convert reference pacing to this film's beat grid: at 120 BPM a bar is 2 s, so a 1.0 s median
  shot means two cuts per bar.
- Keep the house rules unless the user explicitly overrides them: one display face, one UI face,
  one accent, something new every 2 to 4 s, no banned looks.
- When the reference itself uses a banned look (for example corner labels), record it under
  "Banned in this film" and describe the replacement.

## Check before showing the user

- Palette has exactly one accent and every hex is valid.
- Pacing numbers match `refs/analysis.json` (quote them).
- Nothing in "Take" names the reference's subject, logo, characters or copy.
- Fonts named are available (bundled, vendored with `npm run fonts -- add`, or supplied by the user).
- The shot list that follows uses these values: shot lengths, transitions and spring presets.
