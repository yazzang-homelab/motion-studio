# Review log

One block per critique round, newest last. `npm run gate` reads this file: the final render stays blocked until
there are at least 3 rounds and the last round scores 8 or more on every axis (`na` passes) with no P0 problem.

Block format (keep the keywords exactly):

    ## Round <n> — <format> — <what this pass changed>
    SCORES: hook=<1-10> readability=<1-10> motion=<1-10> variety=<1-10> composition=<1-10> brand=<1-10|na> sound=<1-10|na>
    PROBLEMS:
    1. [P0|P1|P2] [mm:ss.cc] <problem, one line>
    FIXES: <what the next pass changes>

## Round 1 — 9x16 — first full pass
SCORES: hook=6 readability=5 motion=6 variety=6 composition=6 brand=7 sound=na
PROBLEMS:
1. [P1] [00:00.00] hook word sits too small; at 360 px wide it reads as a caption, not a headline
2. [P1] [00:01.50] note card slides in on a linear ease with no spring settle
3. [P2] [00:05.50] lockup lands late and the last downbeat has no visual hit
FIXES: hook type scaled to fill the safe width, card moved to the snappy spring, lockup moved onto the 5.5 s beat
