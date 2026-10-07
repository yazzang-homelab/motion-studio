# Delivery note template

Fill every line from files on disk (`out/deliver/manifest.json`, `docs/production.json`,
`docs/review_log.md`, `render.json` sidecars). Write "not measured" instead of guessing a number.
Keep it short enough to read in one screen.

```
## <Title> - delivered

Files
- <fmt>: out/deliver/<slug>_<fmt>.mp4  (<W>x<H>, <fps> fps, <duration> s, <size> MB)
- Poster: out/deliver/<poster file>   Contact sheet: out/deliver/<contact file>
- Source: film/film.js (+ film/scenes/*), studio.json, docs/shotlist.md

Checks (from npm run deliver)
- Loudness: <I> LUFS integrated, <TP> dBTP true peak (target -14 +-0.5, <= -1)
- Frames/duration: <frames> frames = <duration> s at <fps> fps
- Loop seam: <pass | n/a>        Size limit: <pass, limit>
- Critique gate: <pass> after <N> rounds; last scores hook=<> readability=<> motion=<>
  variety=<> composition=<> brand=<> sound=<>

How it was made
- Level <L1-L4>, route <A-D>, effort <level>, mode <plan first | autonomous>
- Music: <synthesized style @ BPM | supplied track, measured BPM>
- Assets: <captured from URL | supplied | none>. Reference: <path | none>
- Time: about <h:mm> wall clock; user decisions: <shot list OK, ...>

Open items
- <anything that needed the user and was not answered, e.g. licensed font, logo SVG, metric source>

What I'd improve next
1. <the weakest remaining problem, with timestamp>
2. <second>
3. <third>
```

Guidance for "what I'd improve next": take the highest remaining problems from the last review
round, then anything the metrics flagged as P2 (dead spans, off-grid cues, corner content). Name
the timestamp and the fix, not a vague wish.
