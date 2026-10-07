---
type: regex
target: { source: file, path: film/film.js }
match: not_contains
flags: m
weight: 2
pattern: '^(?![ \t]*(?:\/\/|\/?\*))(?:(?!\/\/|\/\*)[^\n])*?\b(?:Math\.random|Date\.now|performance\.now|setTimeout|setInterval|requestAnimationFrame|getRandomValues|randomUUID|new\s+Date)\b'
---
