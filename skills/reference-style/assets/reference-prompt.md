# Reference prompt (motion-studio template)

Paste into a session opened in a motion-studio project after copying the reference into `refs/`.
Replace every `[...]`. Pick the block for the rung you have.

## A video

```
Reference: refs/[FILE] (a film I admire; study it, do not reuse it).

1. Run node tools/refs.mjs extract refs/[FILE] --every 0.5 and node tools/refs.mjs analyze refs/[FILE].
   Open refs/contact.png (and every refs/contact-N.png page) and the frames around each cut, and read refs/analysis.json.
2. Write docs/style_guide.md: palette (hex, one accent), type (family class, weight, tracking,
   case), shot lengths, transition types, camera moves, texture and grain, how text enters and
   exits. Quote the measured numbers.
3. Write docs/shotlist.md for a [DURATION]-second film about [SUBJECT] in that style, on the beat
   grid (scene changes on downbeats, hook in the first 2 seconds).
   Take the grammar of the reference: pacing, type treatment, transitions. Never its content,
   logos, characters or copy.
4. Show me both files and wait for my OK before writing any film code. If I reject, rewrite the
   shot list, not the code.
```

## A frame

```
Reference: refs/frame/[FILE] (one still). Take [PALETTE | TYPE | GRAIN | COMPOSITION DENSITY].
Do not take [THE SUBJECT, THE CHARACTERS, THE LOGO].

Run node tools/refs.mjs analyze refs/frame, look at the image, and write docs/style_guide.md from it.
Pacing and transitions are not in a still: propose them from the brief and mark them as proposals.
Then write docs/shotlist.md for [DURATION] seconds about [SUBJECT] and wait for my OK.
```

## A library

```
Reference: refs/[FOLDER]/ (my own images and past work).

Run node tools/refs.mjs analyze refs/[FOLDER] and look through the images. Write
docs/style_guide.md as the house style this library implies: palette, texture, type, composition.
Then write docs/shotlist.md for [DURATION] seconds about [SUBJECT] in that house style and wait
for my OK.
```

## Director notes after the first render

Give notes like a director, not a coder (the habit and the first three examples come from
@rexan_wong's workflow post): camera and timing words get precise changes, vague ones
get random changes. Examples: "slow every zoom to 0.7x", "hard cut here instead of the wipe",
"push in on the button on the downbeat", "hold the headline one more beat".
