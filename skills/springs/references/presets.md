# Spring presets and conversions

All values are for a unit step (0 to 1, released at rest) with mass 1, computed from the closed forms in
`lib/motion.js` (`springPV`) and cross-checked against an RK4 integration at dt = 1e-5 s (largest difference
1.6e-6 of travel, which is the integrator's own error). Settle times are the last moment the value is outside the
band around 1, so they match `settleTime(spring, eps)` with eps 0.01 and 0.02.

## Named presets (`SPRINGS` in lib/motion.js)

| Preset | k | d | w0 = sqrt(k) (rad/s) | Damping ratio z = d / (2 sqrt(k)) | Overshoot | Peak at | Settle 1% | Settle 2% | Feel duration | Feel bounce | Value at 0.1 / 0.2 / 0.4 s | Use for |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `snappy` | 320 | 30 | 17.89 | 0.839 | 0.79% | 0.322 s | 0.242 s | 0.228 s | 0.351 s | 0.161 | 0.591 / 0.947 / 1.004 | buttons, toggles, leading edges, cursor |
| `default` | 170 | 26 | 13.04 | 0.997 | 0 (below 1e-17) | - | 0.506 s | 0.445 s | 0.482 s | 0.003 | 0.375 / 0.735 / 0.967 | cards, containers, camera |
| `heavy` | 90 | 20 | 9.49 | 1.054 (overdamped) | 0 | - | 0.780 s | 0.678 s | 0.662 s | -0.051 | 0.240 / 0.548 / 0.871 | big type, 3D objects, logo lockups |
| `playful` | 220 | 14 | 14.83 | 0.472 | 18.61% | 0.240 s | 0.593 s | 0.557 s | 0.424 s | 0.528 | 0.614 / 1.147 / 0.998 | mascots, stickers (visible overshoot) |

The four k/d pairs are the ones plotted in the course's step 08 figure (Playful peaks at 1.186 at 0.240 s).

## Other pairs you will meet

| Pair | Where | z | Overshoot | Peak at | Settle 1% | Feel duration / bounce |
|---|---|---|---|---|---|---|
| 140 / 22 | `indicator()` trailing edge (default `trail`) | 0.930 | 0.04% | 0.721 s | 0.471 s | 0.531 s / 0.070 |
| 220 / 22 | course step 07 title | 0.742 | 3.10% | 0.316 s | 0.445 s | 0.424 s / 0.258 |
| 260 / 20 | course step 07 tile grid | 0.620 | 8.34% | 0.248 s | 0.393 s | 0.390 s / 0.380 |
| 170 / 60 | strongly overdamped example | 2.301 | 0 | - | 1.563 s | 0.482 s / -0.565 |

`heavy` (z 1.054) and 170/60 are truly overdamped in `springPV`. The course's original `spring()` treated every
z >= 1 as critical; that shortcut moves too fast (up to 34% of travel off at z = 2.3), so "heavy" did not feel heavy.
Expect `heavy` to settle in about 0.78 s here, slower than a critical approximation would suggest.

## Feel parameters (`springFromFeel` / `feelFromSpring`)

Apple's SwiftUI convention: `duration` is roughly the settling time, `bounce` 0 is critical, positive values overshoot
(up to 1 = undamped), negative values are overdamped (down to -1).

| Direction | Formula |
|---|---|
| feel to spring, bounce >= 0 | k = (2 pi / D)^2, d = 4 pi (1 - b) / D |
| feel to spring, bounce < 0 | k = (2 pi / D)^2, d = 4 pi / (D (1 + b)) |
| spring to feel | D = 2 pi / sqrt(k); z = d / (2 sqrt(k)); b = 1 - z when z <= 1, else b = 1 / z - 1 |

So for bounce >= 0 the damping ratio is exactly `1 - bounce`, and for bounce < 0 it is `1 / (1 + bounce)`.

| `springFromFeel(...)` | k | d | z | Overshoot | Settle 1% | Closest preset |
|---|---|---|---|---|---|---|
| `{ duration: 0.30, bounce: 0 }` | 438.6 | 41.89 | 1.000 | 0 | 0.317 s | faster than `snappy`, no overshoot |
| `{ duration: 0.35, bounce: 0.15 }` | 322.3 | 30.52 | 0.850 | 0.63% | 0.249 s | `snappy` |
| `{ duration: 0.40, bounce: 0.10 }` | 246.7 | 28.27 | 0.900 | 0.15% | 0.326 s | between `snappy` and `default` |
| `{ duration: 0.50, bounce: 0 }` | 157.9 | 25.13 | 1.000 | 0 | 0.528 s | `default` |
| `{ duration: 0.50, bounce: 0.30 }` | 157.9 | 17.59 | 0.700 | 4.60% | 0.523 s | soft UI pop |
| `{ duration: 0.60, bounce: -0.20 }` | 109.7 | 26.18 | 1.250 | 0 | 0.934 s | slower than `heavy` |
| `{ duration: 0.80, bounce: 0 }` | 61.7 | 15.71 | 1.000 | 0 | 0.845 s | slow camera drift |

Converting an old easing: take its duration as `D` and start at `bounce: 0`; add 0.1 to 0.2 bounce for UI that should
feel alive. Keep type at bounce 0 or below.

## Formulas (underdamped, z < 1)

- damped frequency `wd = w0 sqrt(1 - z^2)`
- overshoot fraction `exp(-pi z / sqrt(1 - z^2))` (what `overshoot(spring)` returns; 0 when z >= 1)
- time of the first peak `pi / wd`
- the envelope decays as `exp(-z w0 t)`, so `-ln(eps) / (z w0)` is an upper bound on the settle time to a band eps
  (0.307 s for `snappy` at 1%, against the exact 0.242 s)

## Loop seams (`loopTrack`)

`loopTrack(t, keys, dur, spring, cycles)` sums every change over the previous cycles, so the result is exactly periodic
when the last value equals the first: position and velocity match at the seam whatever the key times. Keys are times
within one cycle, `0..dur`, never wrapped (a time outside throws). A key at `dur` is the seam change and starts at
`t = 0` of the next cycle, so frame 0 shows the pre-seam value and eases to the first value; it is the same as
`[[0, pre], [0, post], ...]`. The default number of summed cycles is `ceil((settle + tMax) / dur) + 1`, where `settle`
is the 1e-4 settle time below and `tMax` the latest key time.

Where the last change may sit relative to the seam (unit step, percent of travel still to go at time since release;
negative = overshoot past the target):

| Preset | 0.25 s | 0.5 s | 0.75 s | 1.0 s | Settle 1% | Settle 1e-4 |
|---|---|---|---|---|---|---|
| `snappy` | 0.55% | -0.08% | 0.00% | 0.00% | 0.242 s | 0.560 s |
| `default` | 16.23% | 1.07% | 0.06% | 0.00% | 0.506 s | 0.891 s |
| `heavy` | 33.64% | 6.67% | 1.23% | 0.22% | 0.780 s | 1.454 s |
| `playful` | -18.42% | 3.33% | -0.59% | 0.10% | 0.593 s | 1.294 s |

Read the table as: a change released `x` seconds before `dur` is still that far from its target at frame 0, and the
loop stays continuous either way. For an opening frame that is still, release the last change at least the 1% settle
time before `dur` (`default`: 0.51 s). Check: keys `[[0, 0], [2, 100], [4, 40], [6, 0]]`, `dur` 6, preset `default`
give 0.001 / 99.997 / 40.002 at `t = 1 / 3 / 5`.

## Reproduce these numbers

```js
// save as springs-check.mjs in the film project root, then: node springs-check.mjs
import { SPRINGS, overshoot, settleTime, feelFromSpring } from './lib/motion.js';
for (const [name, s] of Object.entries(SPRINGS))
  console.log(name, s, (overshoot(s) * 100).toFixed(2) + '%', settleTime(s).toFixed(3) + ' s', feelFromSpring(s));
```

`track()` superposition of these springs matched an RK4 spring retargeted at every key to within 5.5e-3 px (the
integrator's step error), because the spring equation is linear. That equivalence holds when every change in one
track uses the same k and d (the default). A per-change override (a key's third element) still gives continuous
position and velocity, but the result is no longer one retargeted spring.
