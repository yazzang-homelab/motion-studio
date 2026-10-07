---
type: regex
target: { source: file, path: docs/review_log.md }
flags: im
pattern: '^## Round 2\b[\s\S]*?(?:dead|static|empty|frozen|identical|nothing (?:happens|moves|changes)|no motion|no change)'
---
