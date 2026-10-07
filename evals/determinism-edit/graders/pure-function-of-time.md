---
type: llm
focus: { source: file, path: film/film.js }
weight: 2
---

This file is a film written as a pure function of time: a renderer calls the scenes' draw functions for arbitrary times t, in any order, and every call must paint the identical frame for the same t. A sparkle or glint effect around the final logo lockup was just added.

PASS if all of these hold:
1. A sparkle, glint or twinkle effect exists and is drawn only near the end of the film (about the last two seconds).
2. Each sparkle's position, size, phase and twinkle timing comes from seeded values keyed per element (for example rngFor('sparkle', i), hash32(i) or noise1(i, ...)) combined with the time argument, so nothing depends on how many or which frames were drawn before.
3. The file uses no Math.random, Date, performance.now, setTimeout, setInterval or requestAnimationFrame in code, and keeps no state that changes from one draw call to the next (no particle arrays updated per frame, no frame counters, no single module-level random stream that draw calls consume in order).

FAIL if the effect is missing, or if any sparkle value depends on wall-clock time, unseeded randomness, draw order or state carried between frames.
