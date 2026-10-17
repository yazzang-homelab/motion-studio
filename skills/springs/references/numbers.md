# Motion in numbers

Adjectives do not survive a render. "Premium", "dynamic", "cinematic", "natural" leave the model to guess, and its
guess is the default look the house rules ban (dark gradient, neon, particles, a spinning product, everything fading in
at once). A brief that names numbers gets the film it describes, and a critic can check numbers frame by frame.

The figures below come from the "Opus 5.5 Motion Lab" write-up (three films: a 6 s Three.js product ad, an 8 s voxel
mascot, a 6 s SDF liquid-chrome title) and from common motion-design practice. They are starting points: the critique
loop decides. Every row names the `lib/` call that produces it.

## 1. Replace the adjective

| The brief says | Write instead | In code |
|---|---|---|
| premium, refined | entrance `outQuint` 600–900 ms, spring ζ 0.7–0.85, one accent colour | `tween(t, t0, 0.75, a, b, 'outQuint')`, `{ zeta: 0.8, freq: 2 }` |
| dynamic, energetic | 11-frame anticipation, 25-frame airtime, landing spring ζ 0.55 | `windup(t, at, { lead: 11 / 60 })`, `{ zeta: 0.55, freq: 2.2 }` |
| playful | overshoot 15–25% (ζ 0.4–0.6), squash 1.25 × 0.8 on contact | `SPRINGS.playful` (ζ 0.47), `squash(1.25)` |
| cinematic | FOV 28–35°, three-point light, a slow dolly (2–4% of frame per second), `inOutQuart` camera | `threeLayer(THREE, { fov: 30 })`, `tween(..., 'inOutQuart')` |
| natural, organic | ease out on entry, ease in on exit, parts lag 2–6 frames behind the body | `track(t - 4 / 60, keys)` per limb |
| smooth loop | every motion periodic in the loop length, frames 0..N−1 rendered, frame N = frame 0 | `loopTrack`, `loopWave`, `loopNoise` |
| on the music | 120 BPM at 60 fps = 30 frames per beat; hits on beats, cuts on downbeats | `grid.beat(n)`, `grid.bar(n)`, `framesPerBeat(fps, bpm)` |
| luxurious material | ceramic white `#F4F1EC` roughness 0.38 clearcoat 0.35; chrome metalness 1 roughness 0.05 | `skills/gl-scenes` |

## 2. Timing curves (`EASES`, `tween`)

Springs are for things with mass. A named curve is for moves whose landing frame is part of the choreography.

| Name | cubic-bezier | Use |
|---|---|---|
| `outExpo` | 0.16, 1, 0.3, 1 | text and logo entrances |
| `outQuint` | 0.22, 1, 0.36, 1 | premium entrances (the default of `tween`) |
| `outCubic` | 0.33, 1, 0.68, 1 | small UI moves |
| `inOutQuart` | 0.76, 0, 0.24, 1 | camera moves, repositioning across the frame |
| `inOutCubic` | 0.65, 0, 0.35, 1 | gentler repositioning |
| `inExpo` | 0.7, 0, 0.84, 0 | fast exits |
| `inQuint` | 0.64, 0, 0.78, 0 | exits that still read |
| `outBack` | 0.34, 1.56, 0.64, 1 | a pop with ~10% overshoot (badges, stickers; never body text) |

Rules: entrances ease out, exits ease in, moves across the frame ease in-out. An exit runs 40–50% shorter than its
entrance (a 750 ms entrance leaves in ~400 ms). `linear` is for things that should feel mechanical (a ticker, a
progress bar) and for colour cross-fades.

## 3. Springs by damping ratio (`{ zeta, freq }`)

ζ = d / (2√(km)); `springFromRatio({ zeta, freq })` gives k = (2πf)², d = 2ζ(2πf). Overshoot = e^(−ζπ/√(1−ζ²)).

| ζ | Overshoot | Character | Use |
|---|---|---|---|
| ≥ 1.0 | 0 | settles without a bounce | type, camera, logo lockups (`default` ζ 0.997, `heavy` ζ 1.05) |
| 0.7–0.85 | 0.6–5% | restrained elasticity | cards, product parts, premium UI (`snappy` ζ 0.84) |
| 0.4–0.6 | 9–25% | lively, playful | mascots, lids, stickers (`playful` ζ 0.47) |
| < 0.3 | > 37% | cartoon wobble | jokes only |

Frequency sets the speed: 2 Hz (a 0.5 s period) is neutral; 3–4 Hz snappy; 1–1.5 Hz heavy and slow. The guide's
product film: lid opens 100° on ζ 0.6, earbuds rise 4.0 units on ζ 0.7, a secondary 35° turn on ζ 0.5. Its mascot's
arms follow through on a 2.2 Hz spring after the body stops.

## 4. Durations

| Element | Duration |
|---|---|
| button and UI feedback | 100–200 ms |
| UI moves | 200–500 ms |
| hero entrance | 600–900 ms |
| letter-to-letter stagger | from 1 frame (16.7 ms at 60 fps) |
| word-to-word stagger | 60–120 ms |
| list items | 40–80 ms apart |
| secondary motion delay | 100–200 ms after the hero |

Text hold: `holdTime(words)` = 0.3 s per word + 0.5 s; a two-word title holds at least 1.1 s, fully legible and still.

## 5. Hierarchy: one hero move per shot

The eye follows the biggest, earliest move. Give each shot one hero motion and make everything else answer it:

| Layer | Travel (vs the hero) | Starts |
|---|---|---|
| hero | 100% | on the beat |
| secondary | 50–70% | 100–200 ms after the hero |
| background drift | under 5% | always, never stopping |

Never start every element on the same frame. During a hold, keep about 2% camera drift so the frame does not die
(the critique flags still spans as dead).

## 6. Animation principles as numbers

The mascot film checked 71 numeric assertions over 480 frames; six failed on the first pass. Write principles so a
check can fail:

| Principle | Number | Call |
|---|---|---|
| Anticipation | 11-frame crouch before a jump, 18 frames before a spin jump | `windup(t, at, { lead: 11 / 60, depth: 0.12 })` |
| Squash and stretch | take-off 0.85 × 1.28, landing 1.25 × 0.7 (across × along) | `squash(1.28)` → `{ along, across }` |
| Overlapping action | arms 4 frames, legs 6 frames behind the body | `track(t - 4 / 60, keys)` |
| Follow-through | arms swing on a 2.2 Hz spring after the body stops (ζ about 0.3: a few visible swings) | `{ zeta: 0.3, freq: 2.2 }` |
| Arcs | jumps follow a parabola (height 3.5 units), never a straight line | `y = 4h·p(1 − p)` |
| Slow in / slow out | landing settles on ζ 0.55 | `track(t, keys, { zeta: 0.55, freq: 2 })` |
| Timing | 25 frames of airtime; a spin needs 18 frames of preparation | frame numbers in the shot list |

Probe these values (`c.probe('mascot.footY', y)`) and declare checks (`checks: [...]` in the film) so
`npm run probe` proves them: foot contact on the planned frame, label on with its beat, the seam continuous.

## 7. Beats and frames

Frames per beat = fps × 60 / BPM (`framesPerBeat`): 24 fps at 120 BPM = 12, 30 fps = 15, 60 fps = 30, 30 fps at
128 BPM = 14.0625. When it is not whole, never step beats by a rounded count (the error adds up, 1 frame every 16 beats
at 128 BPM); take each beat's absolute time from the grid and round that: `Math.round(grid.beat(n) * fps)`.

At 48 kHz and 60 fps one frame is exactly 800 samples. A sound that should land with a visual event on frame F
sounds best one frame late, at sample (F + 1) × 800: light reaches the eye before the brain fuses the sound (measure
the waveform's peak, not its first sample; attack, wave-shapers and compressors move it).

## 8. Camera and space

| Item | Number |
|---|---|
| product / hero FOV | 28–35° (30° reads "photographed"; 50°+ reads "game") |
| parallax speeds | foreground 1.0, midground 0.5, background 0.2 |
| camera vs subject | the camera moves slower than the subject and keeps it in a stable place |
| hold drift | about 2% of the frame over the hold |

## 9. Loops

Duration × fps = N frames; render 0..N−1, never N (frame N is frame 0). Every periodic value completes whole cycles
in N frames: `loopWave(t, dur, cycles)`; noise loops when sampled on a circle: `loopNoise(t, dur)`. Check value AND
velocity at the seam (`npm run probe` reports both for every probe; the critique's loop seam checks the pixels).

## 10. Accessibility

| Rule | Number | Enforced |
|---|---|---|
| text contrast | ≥ 4.5:1 (body), ≥ 3:1 (large display type) | critic, readability axis |
| flashes | ≤ 3 per second (WCAG 2.3.1) | critique P0 `flash` |
| reading | no motion behind text while it is being read beyond the hold drift | critic |

## 11. Banned unless the brief asks

Generic neon gradients, decorative particles, unmotivated lens flares, a product spinning on a turntable, heavy bloom,
every element moving at once, text nobody asked for, corner labels, frame borders. Say them in the brief's BANNED list:
a model told what not to do stops reaching for it.
