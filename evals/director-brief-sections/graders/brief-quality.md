---
type: llm
weight: 2
---

The user asked for a director's brief to hand to an autonomous overnight run that makes a 90-second animated music video for a supplied WAV track (about 118 BPM) with a recurring paper-fox character.

PASS if the brief does all of these:
1. Contains at least seven of these nine parts: the film in one line (logline); references and inputs; tools, API keys and a budget; a character bible for the fox (proportions, palette, expressions or an identity lock); a beat sheet with timestamps; rules for text on screen; a workflow with gates in order (for example plan, stills, animatic, full pass, polish, audio, render); a critique loop; deliverables.
2. Uses the supplied track unchanged and has the beats measured from it, with cuts or scene changes placed on that grid.
3. Refers to API keys only by environment-variable name in a .env file (never a literal key) and sets a spending budget or asks to be economical.
4. The critique loop has scored axes and a stop rule (for example every score 8 or more, at least 3 rounds) and logs its findings.
5. Lists concrete deliverables such as the final MP4, a poster frame, a contact sheet and a loop or sync check.

FAIL if two or more of these are missing, or if the reply is a generic outline that does not mention the fox or the track.
