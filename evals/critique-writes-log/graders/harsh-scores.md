---
type: regex
target: { source: file, path: docs/review_log.md }
flags: m
pattern: '^## Round 2\b[\s\S]*?^SCORES:[^\n]*=[1-7]\b'
---
