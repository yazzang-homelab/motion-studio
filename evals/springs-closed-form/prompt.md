---
description: A closed-form spring request should route to springs and return an exact under/critical/over-damped spring plus superposition for multi-target values, with no timers or simulation
tags: [smoke]
runs: 3
max_turns: 8
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: JavaScript spring(t, k, d) using Math.exp with cos/sin, a real overdamped branch, t <= 0 guard, and a track()-style sum of one spring per retarget
---

Our film renders every frame through seek(t), so I can't run a physics simulation. Write me a closed-form damped spring in JavaScript (a pure function of time with stiffness and damping) that is exact for under-, critically- and over-damped settings; our "heavy" preset is k=90, d=20. Then show how to animate a value that changes target several times, like a container width going 200 → 320 → 180 at t = 0.5 s, 1.2 s and 2.0 s, without restarting the spring or simulating earlier frames.
