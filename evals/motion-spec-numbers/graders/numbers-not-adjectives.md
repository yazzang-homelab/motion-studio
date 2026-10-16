---
type: llm
weight: 2
---

The user asked for the spec of a 6-second, 60-fps-or-similar looping earbud ad described with adjectives ("premium", "dynamic", "some bounce", "cinematic", "seamless"), and wants to approve it before any build.

PASS if all of these hold:
1. The adjectives are translated into numbers: at least a named easing curve or cubic-bezier for entrances or the camera, a spring given as a damping ratio (ζ, about 0.4 to 0.7 for the lid bounce) or as stiffness/damping, a camera field of view in degrees, and durations or frame counts.
2. Time is stated as frames: a total frame count (360 at 60 fps, or the equivalent at the fps chosen) and the shots as frame ranges, with the loop rule that the last rendered frame flows into frame 0 (frame N equals frame 0 and is not rendered twice).
3. There is an explicit list of things to avoid (for example neon gradients, particles, lens flares, a turntable spin, everything moving at once).
4. There is a QA or verification section that names concrete checks (frames to inspect, a value at a frame, the loop seam, beat sync), and the answer stops for the user's approval instead of building.

FAIL if any of the four is missing, or if the spec mostly restates adjectives without numbers.
