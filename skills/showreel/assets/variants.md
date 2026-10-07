# Showreel variants and randomizer

Everything below except the credited one-liner is written for motion-studio. The variant patterns
paraphrase public posts and link them; the creators' own wording stays with them.

## The canonical one-liner (engine test only)

> make a dynamic 15-second motion graphics video that shows what an incredible motion designer
> you are, like it's your showreel for a résumé. go all out.

Prompt by @stephanlivera (Opus 5.5 on Max effort, 2026-09-25,
https://x.com/stephanlivera/status/2103315922098470926), as surfaced by the Movez course
"How to build motion design studio with Opus 5.5". Quoted with credit; use it verbatim only to
test a fresh setup.

## Variant patterns seen in public posts (paraphrased)

| Pattern | Credit | What changed | motion-studio template |
|---|---|---|---|
| Long piano reel | @kloss_xyz, https://x.com/kloss_xyz/status/2103560107921723834 | 16:9, 90 s (the course retells it as 60 s), top-tier sound design without synths, an original piano score, 1080p export | "Make a {seconds}-second 16:9 motion graphics showreel that tests your real creative range. Score it yourself with an original piano piece, no generic synth pads, and land every cut on the music. Deliver 1080p." |
| Anti-slop guardrail | @1littlecoder, https://x.com/1littlecoder/status/2103587706999914649 | 10 s self-introduction; keep frames and text out of the corners, the usual tells of AI-made video | "Make a dynamic 10-second motion graphics video in which you introduce yourself. Keep every frame edge and corner clear of text and boxes." |
| Story instead of techniques | @sonnylazuardi, https://x.com/sonnylazuardi/status/2103660301132685418 | the reel's energy applied to a history story, storyboard left to the model; his post set no duration or format (the course adds 45 s vertical) | "Bring showreel energy to a story: the history of {topic} from {start} to today. Choose the storyboard yourself. {seconds} seconds, {format}." |
| Agency persona | the Movez course's own variant | the reel made as a niche studio would make it; one accent; every shot a different technique | "Make a {seconds}-second showreel the way {persona} would. Draw every graphic from scratch, one accent color, a different technique in every shot." |
| Product slot | @robj3d3 ("for SuperX", run inside the product's codebase folder), @achxvi ("about Pocketsflow") | the one-liner pointed at a product | use `/motion-studio:product-reel` |
| Spec remix | @__morse applied "make it more colorful" to @twoclipping's UI-morph spec | one style line on top of a state spec | use `/motion-studio:ui-morph-spec` |

Why vary at all: hundreds of people ran the same sentence the same week and the results rhymed.
The athemeroy/awesome-opus-5-5-videos README described the trend as "brief contagion" in commits
e5a0072 to 55cce56 (26 to 27 Sep 2026); commit 10bc706 (27 Sep 2026) removed the phrase and the
current text is more cautious ("Several similar showreels appeared on the same day."). The
randomizer below makes each engine test start from a different brief.

## Randomizer

`scripts/roll.mjs` in this skill reads the tables in this section. Each table needs an `id`
column; ids must be unique across all tables. Add or remove rows freely. The roll picks one row
from Persona, Genre, Constraint and Frame, and three distinct rows from Technique, seeded, so the
same seed always gives the same brief.

### Persona

| id | option |
|---|---|
| p01 | a two-person studio that only works with typography |
| p02 | a niche branding studio for startup founders |
| p03 | a Swiss-style information designer |
| p04 | a title designer for indie film festivals |
| p05 | a UI motion engineer at a fintech company |
| p06 | a data-visualization desk at a newsroom |
| p07 | a sound-first studio that cuts everything to the kick drum |
| p08 | a paper-craft artist who works only in code |
| p09 | an 8-bit game interface designer |
| p10 | the exhibition graphics team of a science museum |
| p11 | a sports broadcast graphics package designer |
| p12 | a minimalist architect who animates plans and sections |
| p13 | a retro-futurist airline brand team |
| p14 | a letterpress printer discovering motion |

### Genre

| id | option |
|---|---|
| g01 | a résumé showreel: best work first, a new technique in every shot |
| g02 | an opening title sequence that ends on a title card |
| g03 | a teaser for a fictional product: problem, reveal, three features, lockup |
| g04 | a music visualizer where every cut lands on the kick and scene changes on downbeats |
| g05 | a kinetic-type poem: one sentence, one word per shot |
| g06 | a broadcast ident package: sting, bumper, lower third, end card |
| g07 | a data story that tells one invented dataset in five charts |
| g08 | a five-step explainer of how something works |
| g09 | a countdown of five items |
| g10 | a before-and-after reveal |
| g11 | a seamless loop whose last frame equals its first |
| g12 | a miniature timeline history of a craft |

### Constraint

| id | option |
|---|---|
| c01 | monochrome plus one accent color |
| c02 | only two shapes: a circle and a rounded rectangle |
| c03 | no text at all in the first 4 seconds |
| c04 | every element snaps to a 12-column grid |
| c05 | one continuous camera move, no cuts |
| c06 | typography only, no illustrations |
| c07 | paper texture and grain, no gradients anywhere |
| c08 | a 160x90 pixel grid scaled up with hard pixel edges |
| c09 | every shot starts from the last shape of the previous shot |
| c10 | three colors plus black for the whole reel |
| c11 | line art only, one stroke weight |
| c12 | all text inside the central 60 percent of the frame |
| c13 | hard cuts only, no crossfades |
| c14 | an off-white background with dark ink, never a dark background |

### Technique

| id | option |
|---|---|
| t01 | per-character kinetic type on staggered springs |
| t02 | a mask-reveal wipe |
| t03 | a line that draws itself into a shape |
| t04 | one shape morphing from bar to pill to circle |
| t05 | a staggered grid of tiles popping in with seeded delays |
| t06 | a counter that springs to a number |
| t07 | a split screen that reframes for every format |
| t08 | a match cut on shape |
| t09 | parallax layers with depth scale |
| t10 | a cursor driving a UI interaction |
| t11 | a chart assembling itself with a tooltip |
| t12 | a tab indicator whose edges stretch on different springs |
| t13 | stepped animation on twos for a drawn element |
| t14 | a loader ring that resolves into a check mark |
| t15 | an isometric extrusion of a flat shape |
| t16 | a type scale jump from tiny to full frame |
| t17 | a halftone dot reveal |
| t18 | text running along a curved path |
| t19 | a hard-cut montage on eighth notes |
| t20 | a radial wipe transition |
| t21 | a layout that splits into columns on the beat |
| t22 | a 3D card flip done with 2D scaling |

### Frame

| id | seconds | format |
|---|---|---|
| f01 | 10 | 1x1 |
| f02 | 15 | 16x9 |
| f03 | 15 | 9x16 |
| f04 | 20 | 9x16 |
| f05 | 20 | 16x9 |
| f06 | 30 | 16x9 |
| f07 | 12 | 1x1 |
| f08 | 15 | 4x5 |

## Composed brief

The roll fills this template (edit it here; placeholders: `{seconds}`, `{format}`, `{genre}`,
`{persona}`, `{constraint}`, `{techniques}`):

```
Make a dynamic {seconds}-second {format} motion graphics showreel that proves your range as a
motion designer, framed as {genre}. Make it the way {persona} would.
Constraint: {constraint}.
Build it around these techniques, at least one per shot: {techniques}.
Everything else is your call. Go all out.
```
