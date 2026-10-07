# Review log

One block per critique round, oldest first, newest at the bottom. `npm run gate` (tools/gate.mjs) reads this file.
The final render stays blocked until there are at least `gate.minRounds` rounds (studio.json, default 3), the last
round scores every axis in `gate.axes` at `gate.minScore` (default 8) or higher (`na` passes only on axes listed in
`gate.naAllowed`, default `["brand"]`), and the last round lists no P0 problem. That is all the gate checks by default: it reads the LAST round only and ignores the format in the
heading. With `gate.requireFormats: true` (studio.json, default false) every format in `formats` also needs a
logged round with that format in its heading, and the LATEST round of each format must pass on its own scores (an earlier pass does not cover a later regression); turn it on when the brief ships several formats.
Critic runs append to this file one after another (one run takes 5 to 12 minutes): never run two at once.

How to write a round:

1. Produce fresh evidence: `npm run critique` (live film, in `out/review/<format>/`; it also prints a ready-to-fill block)
   and, once a mix exists (`render --draft`, `npm run sfx`, `npm run mix`), `node tools/critique.mjs --format <format>
   --video out/<format>/final.mp4` (the mixed render, in `out/review/<format>/video/`, where the sound evidence is).
   Look at every PNG in both folders, and every page of a paged sheet (`contact.png`, then `contact-2.png`, `contact-3.png`
   ...; `metrics.md` lists them), before scoring. Evidence is pinned to the film version (`film-hash.json`):
   `node tools/critique.mjs --check-hash` must say MATCH before you render a zoom still from the live film. A machine-found `font-fallback` (P0: a character has no glyph in its font)
   or `audio-gap` (P1: a silent span of 1 s or more) line in `metrics.md` is a problem to log or a dismissal to explain.
2. Append the block below at the end of this file, with the next round number. Keep the keywords and the em dashes in
   the heading exactly.
3. Scores are integers 1 to 10 for all seven axes. Write `na` only when an axis cannot apply and `gate.naAllowed`
   lists it (for example `brand=na` on a showreel with no brand). `sound=na` in the last round fails the gate.
4. Problems go worst first, every P0 first: `[P0]` broken or banned, must be fixed before any final render; `[P1]`
   clearly hurts the film; `[P2]` polish. Every problem has a timestamp `[mm:ss.cc]` (minutes, seconds, centiseconds,
   for example `[00:04.20]`; a range `[00:04.20-00:06.00]` also parses).
5. `FIXES:` says what changed since the previous round (files, functions, times), or `none (first round)`.
6. Never edit or delete an earlier round. A new score needs new evidence.
7. The gate reads the token `P0` strictly: any `P0` on a problem line of the last round is open, however it is written
   (`[P0]`, `**P0**`, `(P0)`), and a `P0` in a notes line or loose text outside `PROBLEMS:` and `FIXES:` fails the gate too.
   A P0 closes only through a line in the same round's `FIXES:` that starts with its number and `fixed`, `resolved` or
   `wontfix`, for example `1. fixed: frame 0 now shows the headline`. `not fixed` and `will fix` close nothing.

Block format (this fenced copy and the commented example are ignored by the gate):

```
## Round <n> — <format> — <what this pass changed>
SCORES: hook=<1-10> readability=<1-10> motion=<1-10> variety=<1-10> composition=<1-10> brand=<1-10|na> sound=<1-10>
PROBLEMS:
1. [P0|P1|P2] [mm:ss.cc] <what is wrong and where; which evidence file shows it>
2. [P0|P1|P2] [mm:ss.cc] <...>
FIXES: <what changed since the previous round>
```

<!--
Example round (inside an HTML comment, so tools/gate.mjs does not count it):

## Round 1 — 9x16 — first full pass
SCORES: hook=6 readability=7 motion=6 variety=5 composition=7 brand=na sound=6
PROBLEMS:
1. [P0] [00:00.00] frame 0 is an empty background; the hook only starts forming at 00:00.40 (metrics frame0)
2. [P1] [00:04.20] label text overlaps the loader ring during the swap into the chart state (strip.png)
3. [P1] [00:06.00] dead span until 00:08.00: nothing moves after the chart settles (metrics deadSpans, contact.png)
4. [P2] [00:10.10] tagline sits 12 px outside the 9x16 safe area (phone.png)
FIXES: none (first round)
-->

<!-- Append rounds below this line. -->
