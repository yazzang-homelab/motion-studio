---
description: An overnight long-form request should route to director-brief and produce a brief with the full skeleton (logline, references, tools and keys with budget, character bible, beat sheet, on-screen text, gated workflow, critique loop, deliverables)
tags: [smoke]
runs: 3
max_turns: 10
timeout_seconds: 480
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: A director's brief with the nine skeleton sections, keys referenced by variable name in .env with a budget, gates from plan to render, a scored critique loop with a stop rule, and concrete deliverables
---

I want to leave Claude running overnight to make a 90-second animated music video for my band's new single. The track is a WAV I'll drop into the project, about 118 BPM, and there's a recurring character, a small paper fox. Write the director's brief I should give it so I wake up to something good instead of a mess.
