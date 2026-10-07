---
type: regex
match: not_contains
flags: m
pattern: '^[ \t]*```[ \t]*[A-Za-z][^\n]*\n(?:(?![ \t]*```)[^\n]*\n)*?(?![ \t]*(?:\/\/|\/?\*))(?:(?!\/\/|\/\*)[^\n])*?\b(?:requestAnimationFrame|setTimeout|setInterval|Date\.now|performance\.now)\s*\('
---
