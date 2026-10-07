---
description: A team switching to Remotion should get the license gate first (company license for for-profit orgs above 3 employees) plus the route-B handoff, from seek-engine
tags: [smoke]
runs: 3
max_turns: 8
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep, Skill]
expected_outcome: The reply says a 12-person for-profit company needs a paid Remotion Company License (free tier covers individuals and companies up to 3 employees) before switching, then explains the handoff
---

We're a 12-person startup and our engineers know React, so for our launch videos we'd rather use Remotion than a hand-rolled canvas renderer. Is there anything we need to sort out before switching, and how would the handoff work?
