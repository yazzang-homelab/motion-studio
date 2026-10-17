---
type: llm
weight: 2
---

The user wants a 6-second liquid-chrome loop in a motion-studio project: a blob that splits into droplets, morphs into the word OPUS, holds, and melts back so the last frame flows into the first, with every frame deterministic and no popping in the morph.

PASS if all of these hold:
1. The shapes live in ONE signed distance field rendered by raymarching (or sphere tracing), and the blob/droplet/letter transitions come from smooth-min (or an equivalent continuous blend of distances), not from cross-fading two renders or swapping meshes.
2. The text is an SDF in the same field (an extruded 2D text distance field, a text distance texture, or letter SDFs), so droplets can merge into it.
3. Time enters the shader only through a uniform set from the film's seek time (the scene draw), never from a clock, requestAnimationFrame or an accumulating counter, and every periodic value completes whole cycles in the 6-second loop so frame 360 equals frame 0 (frames 0..359 are rendered).
4. The chrome look is addressed concretely: a Fresnel term (Schlick or equivalent, high F0), low roughness, and an environment with bright and dark areas so the metal does not read as grey plastic.

FAIL if any of the four is missing or contradicted.
