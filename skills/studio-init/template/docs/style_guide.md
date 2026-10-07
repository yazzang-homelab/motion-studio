# Style guide: <film title>

<!--
Template. The style-analyst subagent (or the main session) writes this from evidence BEFORE the shot list:
  node tools/refs.mjs extract refs/<video> --every 0.5     -> refs/frames/*.png, refs/contact.png (+ contact-2.png ...)
  node tools/refs.mjs analyze refs/<video or folder> --json -> refs/analysis.json (cuts, shot lengths, palette,
                                                               brightness, contrast, motion energy, text hint)
Look at the frames yourself as well; numbers do not describe a look on their own.
Take the reference's grammar (pacing, type, transitions, texture), never its content, logos, characters or copy.
Without a reference, write the house style from studio.json brand values and the brief.
Replace every <...> and delete these comments when done.
-->

- Reference: <refs/<file> | refs/<folder>/ | image library path | none (house style)>
- Take: <pacing, type treatment, transitions, texture, camera language>
- Never take: <the reference's subject, characters, logos, copy, music>

## Palette

| Token | Hex | Share or role | Notes |
|---|---|---|---|
| bg | <#141413> | <background, ~60%> | <flat, no gradients on UI chrome> |
| fg | <#F0EEE6> | <type and UI surfaces> | |
| accent | <#D97757> | <one accent, used for the one thing to look at> | |
| muted | <#6C6B73> | <secondary text, guides> | |

Write the final values into `studio.json` `brand.colors`; the film reads them from there.

## Type

| Role | Family | Weights | Size (x L.u) | Tracking | Case | Enters / exits |
|---|---|---|---|---|---|---|
| display | <Instrument Serif> | <400> | <120-190> | <-0.02> | <sentence> | <per-char spring rise, masked> |
| ui | <Inter> | <400, 600> | <28-44> | <0> | <sentence> | <with its container> |

One display face and one UI face, bundled in `assets/fonts/` (`npm run fonts -- add "Family:400,700"`), named in
`studio.json` `brand.fonts`.

## Pacing

- Shot length: mean <s>, median <s>, range <s-s> (from refs/analysis.json).
- Cuts per bar at <bpm> BPM: <n>; cuts land on <downbeats | every beat in the drop>.
- Holds: <where the film breathes, and for how long>.

## Transitions

| Type | Used when | Length | Notes |
|---|---|---|---|
| <cut on action> | <between shots inside a scene> | <0> | <the motion carries across> |
| <mask wipe> | <between scenes> | <0.3 s> | <direction follows the motion> |

## Camera

- <static, slow push, whip pan, parallax layers; how often it moves; what never moves>

## Motion feel

| Element class | Preset | Notes |
|---|---|---|
| buttons, toggles, cursor | snappy | tiny overshoot |
| cards, containers, camera | default | no overshoot |
| hero type, logo lockup | heavy | no overshoot |
| <mascot, stickers> | playful | visible overshoot |

## Texture

- Grain: <amount 0.03-0.06, cell 2>; vignette: <strength 0-0.35>; paper or noise: <...>.
- <what stays perfectly clean (UI screenshots, product type)>

## Text on screen

- Max words per line: <n>. Hold each line long enough to read it once calmly at phone size.
- Big words on downbeats vs subtitle-style lines: <when each is used>.
- Text enters with motion (rise, mask, per-character spring), not by fading in alone.

## Banned in this film

- House bans: centered title on a gradient, everything fading in, corner labels, frame borders, glow on UI chrome,
  generic particle bursts.
- <film-specific bans from the brief or the reference>

## Formats

| Format | Reframing |
|---|---|
| 9x16 | <stacked: headline top third, UI below, captions above the bottom safe band> |
| 1x1 | <tighter: headline smaller, UI centered> |
| 16x9 | <side by side: headline left half, UI right half> |
