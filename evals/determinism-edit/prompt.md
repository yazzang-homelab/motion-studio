---
description: Add a sparkle effect to the scaffolded demo film without breaking determinism (seeded per-element RNG, no clocks or timers)
tags: [scaffold]
runs: 3
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Write, Edit, Skill]
expected_outcome: film/film.js gains a sparkle effect whose positions and twinkle come from rngFor/hash32-style seeded values and time, with no Math.random, Date, performance.now, timers or per-frame mutable state
---

Add a sparkle effect to the end of the film: small glints that twinkle around the logo lockup during the last two seconds. Keep it subtle, and put it in film/film.js.
