# Motion spec: <working title>

<!--
The numeric spec a film is built and judged against. Fill it in at stage 4 (it heads docs/shotlist.md) or hand it to a
user who wants to write their own prompt. Every line is a number, a name from lib/ or a frame range: an adjective here
is a decision left to the model, and the model's default decision is the banned look.

The experiment behind this template: the same model and subject with a 27-word prompt produced dark background, neon,
glowing particles, a spinning product and invented copy; a 448-word spec of this shape produced the planned film, then
15 visual fixes found frame by frame. The fixes are the lesson: none of them could have been found without numbers to
compare against. Vocabulary and ranges: skills/springs/references/numbers.md.
-->

GOAL:
- <one sentence: what the viewer should feel and remember>

OUTPUT:
- Engine: <motion-studio canvas (route A) | + glLayer shader | + Three.js 0.160.0 via threeLayer>
- Formats: <1x1 1080x1080 | 9x16 1080x1920 | 16x9 1920x1080 | 4x5 1080x1350>
- Delivery: <MP4 H.264 + AAC | + GIF (npm run gif, 25 or 50 fps)>

TIME:
- Duration <6> s · <60> fps · <360> frames (0..359) · loop <yes: frame 360 = frame 0 | no>
- Music <120> BPM → <30> frames per beat · beats at frames <0, 30, 60, ...> · bars at <0, 120, 240>

LOOK:
- Background <#hex>, main <#hex>, accent <#hex> (one accent)
- Materials <ceramic #F4F1EC roughness 0.38 clearcoat 0.35 | chrome metalness 1 roughness 0.05 | flat 2D>
- Lighting <key 45° left, fill at 30%, rim; reflection-only softboxes for chrome>
- Type <display face, UI face, sizes in L units; contrast ≥ 4.5:1>

MODEL (3D or illustrated subjects; n/a for UI films):
- Geometry <rounded box 6.0 × 4.6 × 2.2 units, lid 30% of the height, hinge on the back edge>
- Details <seams, inner cavity, nozzle, grille> (a missing detail reads as a toy or as an animal head)

MOTION:
- Entrance <outQuint 750 ms> · camera <inOutQuart> · exit <inExpo, 400 ms>
- Springs <lid ζ 0.6 2 Hz · parts ζ 0.7 · type default (ζ 1)>
- Hero <one per shot>; secondary <60% of the hero's travel, +150 ms>; background drift < 5%
- Anticipation <11 frames, 6% the other way> · stagger <1 frame per letter, 80 ms per word>

SHOTS (frame ranges; one hero move each):
- Frames <0–30>: <a light sweep crosses the product; nothing else moves>
- Frames <43–57>: <lid presses 6% shut (anticipation)>
- Frames <60–90>: <lid springs open 100° on the downbeat (frame 60)>
- Frames <90–144>: <...>
- Frames <330–359>: <returns to the frame-0 state; the seam is invisible>

CAMERA:
- FOV <30°> · position <(0, 1.2, 9)> · target <the product's centre>
- Moves <dolly in 8% over frames 120–240 on inOutQuart; 2% drift during holds; no orbit unless named>

SOUND:
- <120> BPM · 48 kHz stereo · −14 LUFS integrated · ≤ −1 dBTP after AAC
- Events <lid open: thump at frame 61 (one frame after the picture) · earbuds: two ticks at 91 and 97>
- SFX 3–6 dB above the bed at each event; little energy under 60 Hz (phones drop it)

BANNED:
- neon gradients, decorative particles, lens flares, a turntable spin, heavy bloom, every element moving at once,
  text not in this spec, corner labels, frame borders

QA (what proves it):
- Probes and checks in the film: <lid.angle = 100 ± 1 at frame 90; footY crosses 0 at frames 120, 180 (± 1); seam smooth>
- Frames to look at first: <0, 30, 60, 90, 144, 240, 330, 359>
- Loop: frame 359 → frame 0 continuous in value and velocity (npm run probe, critique loop seam)
- Flashes ≤ 3 per second; every title held ≥ holdTime(words)
