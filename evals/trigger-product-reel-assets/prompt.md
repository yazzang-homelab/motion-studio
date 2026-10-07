---
description: A request to pull a product's real screenshots, logo and colors from its URL should route to product-reel, which plans a real capture into the project instead of redrawing or guessing the brand
tags: [smoke, trigger]
runs: 3
max_turns: 8
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: The reply plans a capture from the live site (page screenshots, the logo file, brand colors and fonts from the page) into the project, keeps the captured UI as-is instead of redrawing it, and asks for what it cannot capture instead of guessing
---

Grab the real screenshots, logo and brand colors from https://example.com for my launch video. What exactly will you pull, and where will it end up?
