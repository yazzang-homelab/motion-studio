---
description: A near-miss request (a CSS loading spinner for a web button) must not fire any motion-studio skill and should still get a plain CSS answer
tags: [smoke, negative]
runs: 3
max_turns: 5
timeout_seconds: 120
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: No motion-studio skill is invoked; the reply gives JSX plus CSS with @keyframes for a spinning ring
---

Add a loading spinner to my React submit button: while `isLoading` is true, show a small spinning ring next to the label. Just give me the JSX and the CSS (keyframes are fine), nothing else.
