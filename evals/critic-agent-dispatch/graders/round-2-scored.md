---
type: regex
target: { source: file, path: docs/review_log.md }
flags: m
weight: 2
pattern: '^## Round 2\b[\s\S]*?^SCORES:(?=[^\n]*\bhook=(?:10|[1-9]|na)\b)(?=[^\n]*\breadability=(?:10|[1-9]|na)\b)(?=[^\n]*\bmotion=(?:10|[1-9]|na)\b)(?=[^\n]*\bvariety=(?:10|[1-9]|na)\b)(?=[^\n]*\bcomposition=(?:10|[1-9]|na)\b)(?=[^\n]*\bbrand=(?:10|[1-9]|na)\b)(?=[^\n]*\bsound=(?:10|[1-9]|na)\b)'
---
