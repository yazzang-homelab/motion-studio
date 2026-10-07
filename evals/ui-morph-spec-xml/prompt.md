---
description: A UI-morph loop spec request should route to ui-morph-spec and produce the six-section XML spec (inputs, direction, structure, build, gotchas, start) with one-shape, cursor-driven, beat-locked, seamless-loop rules
tags: [smoke]
runs: 3
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: An XML spec with <inputs>, <direction>, <structure>, <build>, <gotchas> and <start> sections that keeps one container, a cursor driving each change, states on beats, a last frame equal to the first, and an approval step before code
---

I want one of those UI-morph loops for Tallyo, our invoicing app: the style where a single shape keeps morphing from state to state, a cursor drives every change, and it loops perfectly. Write me the spec prompt I'd hand to Claude to build it, using the XML-tag structure those viral morph prompts use. Just the spec for now, no code.
