# Brand reel brief (motion-studio template)

Two uses: (1) the main session fills it and hands it to `motion-studio:motion-director` as the
brief for `docs/shotlist.md`; (2) a user can paste the filled block into a fresh session in a
motion-studio project. Replace every `[...]`. Delete lines that do not apply. Facts only: if a
field is unknown, ask the user rather than inventing it.

```
Make a [DURATION]-second motion film for [PRODUCT] ([URL]) with the pace and craft of a motion
designer's showreel. Treat it as a real production, not a demo.

Brand
- Use only real material from the site: screenshots, logo, colors, fonts, copy. The capture is in
  assets/manifest.json and assets/brand/. Tell me what you found before animating anything.
- Animate parts, not whole screenshots: crop cards, buttons, charts and panels and move them
  individually. Never draw a product screen that does not exist.
- Palette: bg [HEX], ink [HEX], accent [HEX] (one accent), muted [HEX].
  Display face: [FAMILY]. UI face: [FAMILY].

Story (one beat each, 2 to 4 seconds, scene changes on downbeats)
1. Hook: [THE PROBLEM IN AT MOST 5 WORDS], huge kinetic type; the first frame is already composed.
2. Reveal: the product UI assembles itself piece by piece.
3. Features: [FEATURE 1], [FEATURE 2], [FEATURE 3]; each one is a UI moment in which a cursor
   does the real action ([ACTION 1], [ACTION 2], [ACTION 3]).
4. Proof: [ONE REAL NUMBER] ([SOURCE OF THE NUMBER]).
5. Lockup: logo + "[CTA]".

Sound
- [Original music synthesized in code at 120 BPM | the supplied track audio/[FILE], unchanged].
  The motion follows the music: every visible hit has a cue on a beat.
- UI clicks on presses, whooshes into transitions, a final hit on the last downbeat.
- [Optional voice: one short line per beat from audio/voice.json. The ElevenLabs key is
  ELEVENLABS_API_KEY in .env.]
- [Optional mascot: [STYLE], one fixed identity across every shot and format.]

Formats
- [9x16] first, then [1x1] and [16x9] from the same timeline, reframed per format, never cropped.

Workflow
- Show me the shot list on the beat grid and wait for my OK before writing film code.
- Before the final render, run at least 3 critique rounds with contact sheets until every score
  is 8 or higher and nothing is P0.
```

## Beat worksheet

Fill this with the user before writing the brief; each row becomes one shot. The times assume
20 s at 120 BPM, where a bar (4 beats) lasts 2 s, so every row starts on a downbeat. With a
measured track, move the rows to the nearest downbeats in `audio/beats.json`.

| Beat | Seconds | Bars | On-screen words (exact) | Real asset used | Cursor action | Cues |
|---|---|---|---|---|---|---|
| Hook | 0-2 | 1 | | | none | thump @ 0.0 |
| Reveal | 2-4 | 2 | | `assets/brand/components/...` | | whoosh @ 1.5, pop per part on beats |
| Feature 1 | 4-8 | 3-4 | | | | thump @ 4.0, click @ |
| Feature 2 | 8-12 | 5-6 | | | | thump @ 8.0, click @ |
| Feature 3 | 12-16 | 7-8 | | | | thump @ 12.0, click @ |
| Proof | 16-18 | 9 | | | none | tick or chime @ 16.0 |
| Lockup | 18-20 | 10 | CTA: | logo file | none | riser @ 16.5, hit @ 18.0 |

Checks before handing it over: every word appears on the site or was approved by the user; the
number has a source; every asset path exists; every row starts on a downbeat; something new
happens at least every 2 to 4 s (inside a 4 s feature, split the moment into press, result and
detail); the final hit lands on the last downbeat at least 0.5 s before the end.
