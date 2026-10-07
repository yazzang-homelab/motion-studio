---
description: Critique a rendered contact sheet with planted defects and append a gate-parsable round to docs/review_log.md
tags: [scaffold]
runs: 3
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Write, Edit, Skill]
expected_outcome: A new "## Round 2" block in docs/review_log.md with a SCORES line on all 7 axes, timestamped P0/P1/P2 problems that name the planted defects, and round 1 left untouched
---

I rendered a new pass of the Driftnote teaser and saved the contact sheet (one still per beat) to out/review/9x16/contact.png. Look at it properly and critique it like a harsh motion director, not a proud author: score it and log it as the next round in docs/review_log.md, in the same format as round 1. Don't touch any code and don't re-render, I only want the review logged.
