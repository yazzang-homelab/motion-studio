---
description: A request for a "premium, dynamic" product loop should come back as a numeric motion spec (frames, curves, damping ratios, FOV, banned list, QA checks), not adjectives
tags: [smoke]
runs: 3
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: A spec with GOAL/TIME/MOTION/SHOTS/CAMERA/SOUND/BANNED/QA sections where every adjective is a number (frame ranges at 60 fps, named easing curves, spring damping ratios, FOV), plus checks the film can assert
---

Before you build anything: write the spec you would build from for a premium, dynamic 6-second looping ad for white wireless earbuds (square, for Instagram). The lid should pop open with some bounce, the buds float up, the camera feels cinematic, and the end has to loop back seamlessly to the start. Synced sound. I want to approve the spec first.
