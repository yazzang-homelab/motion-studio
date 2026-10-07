---
description: End-to-end smoke test of the real render path (Playwright + ffmpeg) in a scaffolded project; Linux/macOS only because it grants Bash
tags: [render]
runs: 3
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Write, Edit, Bash, Skill]
expected_outcome: tools/render.mjs writes an MP4 for the 0-2 s window of the 9:16 format under out/9x16/ (clip_0.00-2.00.mp4 plus its JSON sidecar) and the reply names the file
---

Do a quick test render so I can check the pipeline works end to end: just the first 2 seconds of the vertical 9:16 version. Tell me where the file ended up.
