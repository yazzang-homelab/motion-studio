---
type: regex
target: { source: file, path: docs/review_log.md }
flags: m
pattern: '^## Round 2\b[\s\S]*?^PROBLEMS:[\s\S]*?^[ \t]*\d+\.[ \t]*\[P[012]\][ \t]*\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]'
---
