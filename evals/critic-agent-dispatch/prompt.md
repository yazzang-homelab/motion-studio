---
description: Asking for the motion critic should dispatch the plugin's motion-critic agent, which reviews the latest stills and appends a gate-parsable round to docs/review_log.md
tags: [scaffold]
runs: 3
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Write, Edit, Skill, Agent]
expected_outcome: The main session hands the review to the motion-studio:motion-critic agent, and docs/review_log.md gains a "## Round 2" block with a SCORES line on all 7 axes while round 1 stays untouched
---

The latest stills of the Driftnote teaser are rendered; the contact sheet is out/review/9x16/contact.png. Have the motion critic review them and log its verdict as the next round in docs/review_log.md. It is a review-only pass: nothing to re-render, and don't touch any code. Wait until the critic has finished, then give me its scores and the three worst problems.
