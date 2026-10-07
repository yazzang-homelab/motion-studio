---
description: A natural launch-video request should route to motion-reel, which collects the production inputs and lays out the code-rendered pipeline with a review gate before any final render
tags: [smoke, trigger]
runs: 3
max_turns: 8
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: The reply asks for the missing production inputs (real product assets, brand, reference, music, formats) and walks through a code-rendered pipeline with a shot-list or contact-sheet checkpoint before the final render
---

Can you make a 20-second vertical launch video for my note-taking app Driftnote (driftnote.app)? I want it to feel like those motion-design showreels people have been posting: real motion and music, not a slideshow. Before you build anything, tell me what you need from me and walk me through how you'll make it.
