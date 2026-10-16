---
name: gl-scenes
description: "3D and shader shots inside a seek(t) film: lib/gl.js (GLSL layers, SDF raymarch, liquid chrome, extruded type) and lib/three-layer.js (Three.js product shots), deterministic on software GL. Use for 3D, WebGL, Three.js, shaders."
argument-hint: "[shot or effect, e.g. 'liquid chrome logo' or 'product turntable']"
---

# GL scenes (3D, shaders, Three.js)

The 2D canvas covers type, UI and graphic motion. Glass, liquid metal, product renders and morphing 3D type need a
GPU pipeline. motion-studio keeps one film model for both: a GL layer is a scene draw like any other, it paints into
its own offscreen WebGL2 canvas and is composited onto the stage with `drawImage`, so beats, cues, layers, motion blur,
the critique loop and every delivery format work unchanged.

Two entry points, both in the film project's `lib/`:

| | `lib/gl.js` `glLayer` | `lib/three-layer.js` `threeLayer` |
|---|---|---|
| what you write | one GLSL ES 3.00 fragment shader | a Three.js scene: meshes, materials, lights, camera |
| best for | SDF raymarching, liquid metal, smooth morphs, text that melts, shader backgrounds, grain/gradients | product shots, hard-surface models, PBR materials, shadows, glTF |
| dependency | none | `three`, pinned: `npm i -E three@0.160.0` (index.html already maps `three` and `three/addons/`) |
| motion | uniforms from `uniforms(t, c, lt)` | `update(t, ctx)` sets every property from `t` |

Runnable examples (copy one to `film/film.js` of a project made with `--duration 6 --formats 1x1 --loop`):
[assets/liquid-chrome.film.js](assets/liquid-chrome.film.js) (a chrome drop splits into droplets that morph into an
extruded word and melt back) and [assets/product-hero.three.js](assets/product-hero.three.js) (an earbud case whose lid
springs open 100° at ζ 0.6). Recipes: [references/sdf-recipes.md](references/sdf-recipes.md) and
[references/three-recipes.md](references/three-recipes.md).

## 1. When to use which route

| Request | Route |
|---|---|
| flat type, UI, charts, icons, kinetic text | stay in 2D (`lib/draw.js`) |
| "liquid", "chrome", "metaball", "morph A into B", "melt", "blob" | `glLayer` + `GLSL.sdf` + `GLSL.raymarch` |
| 3D logo or word with depth | `glLayer` + `sdfText` extrusion (any font) |
| a product (device, bottle, case) turning, opening, exploding | `threeLayer` |
| voxel or low-poly mascot | `threeLayer` (InstancedMesh of boxes) or `glLayer` with `sdBox` repetition |
| animated gradient, grain, caustics behind 2D type | `glLayer` on `layer: -1` (a background scene), type on top in 2D |

Mixing is normal: a 2D scene on a higher `layer` draws captions over a GL scene; a 2D draw can call `layer.draw(g, lt, c)`
after its own background (the product example draws a 2D radial gradient, then the Three.js layer on top).

## 2. API

```js
import { glLayer, sdfText, GLSL, glInfo } from '../lib/gl.js';

const blob = glLayer({
  name: 'blob',                                // label for errors
  frag: GLSL.sdf + GLSL.raymarch + GLSL.lighting + GLSL.color + myShader,
  uniforms: (t, c, lt) => ({ uSquash: sp(lt - 1.2, 'snappy'), uTint: '#D97757', uDrops: [[x, y, z], ...] }),
  textures: { uText: sdfText('MOTION', { font: 'Inter', weight: 800, size: 280 }) },
  scale: 1,                                    // GL resolution vs the stage: 0.5 for drafts, > 1 = supersampling
});
scene(0, 6, 'blob', blob.draw);                // draw(g, lt, c): the scene draw signature
```

- The shader writes `fragColor`. A prelude (`#version 300 es`, highp precision, `out vec4 fragColor`) is added unless
  the source starts with `#version`; built-in uniforms are declared only when the shader names them:
  `uTime` (film time `c.t`), `uLt` (scene time), `uP` (scene progress 0..1), `uFrame` (output frame), `uRes`
  (GL canvas px), `uDur` (film length).
- `uniforms()` values: number, boolean, `[x, y(, z, w)]`, matrices (4/9/16 numbers), `'#rrggbb'` (sRGB 0..1; call
  `toLinear()` before lighting), and arrays of any of them for `uniform vec3 uDrop[6]`. The declared GLSL type decides
  the call. Names the compiler optimized away are skipped silently; a wrong length throws with the uniform's name.
- `textures`: `sdfText()` results, canvases, images. `<name>Size` (vec2) and `<name>Aspect` (float) are set too when
  declared.
- Compile errors throw with the driver log and the numbered lines of your source around each reported line.
- `sdfText(text, { font, weight, style, size, pad, letterSpacing, width, height })`: exact Euclidean signed distance
  of the rendered text (Felzenszwalb–Huttenlocher), negative inside, in texture-height units, rows bottom-up. Sample with
  `textSdf(uText, uv, uTextAspect)` from `GLSL.text`, exact outside the texture too. Build it in the film factory: the
  brand fonts are loaded by then. Memoized per argument set.
- `glInfo()` → `{ renderer, version, software }`. `npm run doctor` prints the renderer on the browser row.

GLSL chunks (concatenate what you need, `GLSL.raymarch` requires a `float map(vec3 p)` after it):

| Chunk | Contents |
|---|---|
| `GLSL.sdf` | `sdSphere sdBox sdRoundBox sdTorus sdCapsule sdBox2`, `smin` (= `opSmoothUnion`), `opSmoothSubtraction`, `rot2` |
| `GLSL.raymarch` | `march`, `marchRange`, `marchBox` (clip to a bounding box: the cheapest speed-up), `rayBox`, `calcNormal`, `softShadow`, `ao`; tune with `#define MARCH_STEPS / MARCH_FAR / NORMAL_EPS` before it |
| `GLSL.lighting` | `fresnelSchlick` (float and vec3 F0), `softbox`, `envStudio(dir)`: dark room, key softbox, two strips, rim band, front fill |
| `GLSL.color` | `toLinear`, `toSrgb`, `tonemapACES` |
| `GLSL.noise` | `hash13`, `vnoise` (3D value noise), `loopNoise(p, phase[, r])`: phase 0 and 1 give the same value |
| `GLSL.text` | `textSdf(tex, uv, aspect)` |

Three.js:

```js
import * as THREE from 'three';
import { threeLayer, studioEnv } from '../lib/three-layer.js';
const hero = threeLayer(THREE, {
  fov: 30, toneMapping: 'aces', exposure: 1, shadows: true, scale: 1,
  setup: ({ scene, camera, renderer }) => { scene.environment = studioEnv(THREE, renderer); /* meshes, lights */ return state; },
  update: (t, { scene, camera, state, c, lt }) => { /* set every animated value from t */ },
});
```

`setup` runs once on the first paint and must be synchronous (load files in the film's async `setup(ctx)` and pass them
in). `studioEnv()` builds a PMREM environment of emissive softboxes in a dark room: it lights PBR materials and shows
only in reflections, never as the background.

## 3. Determinism rules for GL

A GL frame is deterministic when it is a function of its uniforms and the GL implementation is fixed. The plugin pins
both; you keep the film code honest.

| Rule | Why |
|---|---|
| studio.json `"gl": "software"` (default): Chrome runs ANGLE on SwiftShader (`--use-angle=swiftshader --enable-unsafe-swiftshader`) | GPU drivers differ in precision, MSAA patterns and dithering, so a GPU frame hashes differently on every machine. Chrome 137+ no longer falls back to SwiftShader without the flag. `"gl": "gpu"` is faster but not reproducible across machines |
| time enters only through uniforms (`uTime`, values from `uniforms()`) | never `performance.now()`, `Date`, timers or `requestAnimationFrame` (the film lint flags them) |
| no MSAA (`antialias: false`), dithering off, highp floats | all three are implementation-defined; the layer sets them |
| seeded noise only: `hash13`, `vnoise`, `loopNoise`, or `rngFor()` values passed as uniforms | `Math.random` in JS breaks the frame; GLSL has no random source |
| Three.js: set positions, rotations, material values, lights and camera absolutely from `t` in `update` | `+=` per frame, `THREE.Clock`, `setAnimationLoop`, `AnimationMixer.update(dt)`, physics steps all carry state; frames are painted out of order and in parallel pages. `mixer.setTime(t)` is fine |
| one GL context per layer, created once | contexts are limited (~16 per page); a lost context throws a clear error instead of painting black |

Check it like any film: `node tools/critique.mjs` runs the determinism passes (same hash for the same `t` across pages)
and, for loop films, the seam check (`hash(0) === hash(duration, unwrapped)`).

## 4. Performance

SwiftShader runs the shader on the CPU. Measured on a 6-core i5-9500 (Chrome 156 headless shell, other jobs running):

| Film | 1080×1080, 1 subframe | 540×540 | Full draft render |
|---|---|---|---|
| liquid chrome (raymarched SDF, 6 droplets/letters, AO) | 0.7 to 1.8 s per frame | 0.23 to 0.36 s | 360 frames at `--scale 0.5 --sub 1 --workers 2`: 2 min 27 s |
| product hero (Three.js, PBR, PMREM env, 1024² shadow map) | 0.25 s per frame | 0.09 s | |

Motion blur multiplies the cost by the subframe count (studio.json `subframes`, default 4). Plan with it:

- drafts and critique rounds: `--scale 0.5 --sub 1` (`npm run animatic` already does both);
- final: `subframes: 2` is usually enough for GL films (`shutter` 0.5); measure one frame first with
  `__studio.hash(t)` timing or a 1-second `--from/--to` render, and quote the estimate to the user;
- raymarching: clip with `marchBox`, cull per item with a bounding sphere before an expensive SDF (`if (bound > d + k) continue;`
  is exact for `smin`), keep loop bounds compile-time constants, lower `MARCH_STEPS`;
- anti-aliasing: there is no MSAA; moving edges are smoothed by the subframes, still edges by `scale` 1.5 (2.25× cost)
  or by drawing the GL layer at `scale` 1 and accepting it.

## 5. Look: numbers instead of adjectives

The guide's product and chrome experiments failed in predictable ways; the fixes are numbers.

| Problem | Fix |
|---|---|
| white product vanishes into the background | darker backdrop or lower ambient (HemisphereLight ≤ 0.2), separation from key + rim, contrast from reflection-only softboxes (`studioEnv`) |
| chrome looks grey or plastic | chrome needs bright and dark bands to reflect: `envStudio` / `studioEnv`, not an even grey environment; F0 0.92, roughness 0.04–0.05, metalness 1 |
| extruded chrome type turns black | flat faces mirror whatever is behind the camera: keep the front fill panel (in `envStudio`) or tilt the type |
| highlight blows out the whole product | reflection-only light (env softboxes) instead of a stronger key; ACES tone mapping, exposure 1 |
| a lid looks like a flat plate | cut one rounded solid in two (see `caseHalf` in the product example), show the inside (tray, wells) when open |
| an earbud looks like an animal head | no dark disc facing the camera; egg-shaped head into a long stem, the tip angled inward |
| camera feels frozen in the hold | a periodic drift of about 2% of the frame (`sin(2πt/dur)`) |
| 3D move lands a frame late on the beat | the move's start is a key time on `c.grid`; check the strip around it in the critique |

Materials from the earbud brief: ceramic white `#F4F1EC` roughness 0.38 clearcoat 0.35; chrome metalness 1 roughness
0.05; accent `#D97757`; FOV 30°; lid 100° spring ζ 0.6; earbuds rise 4.0 units at ζ 0.7 with a 35° secondary turn at
ζ 0.5. Springs by damping ratio: `k = (2πf)²`, `d = 2ζ·2πf` (`{ k, d }` works everywhere a spring is accepted).

## 6. Loops

Every GL loop film obeys the same rule as a 2D one: all motion is periodic in one cycle.

- springs: `loopTrack(t, keys, dur, spring)` with the last key value equal to the first (the examples do this for every
  track);
- oscillations: whole cycles per loop, `sin(2π·n·t/dur)` with integer `n`;
- noise: `loopNoise(p, t / dur)` (GLSL) samples a circle through the noise volume, so phase 1 equals phase 0;
- an event that crosses the seam (a light sweep from 5.5 s into 0.5 s) uses `loopT(t - start, dur)` as its phase.

## 7. Workflow

1. Pick the route (section 1), copy the closest example, and change one thing at a time.
2. Draft: `npm run animatic` (half scale, 30 fps, no blur) and `npm run critique -- --format <f>`.
3. Look at `contact.png`, `strip.png` and `loop.png`. For a GL problem at frame N, render frames N−1, N, N+1 with
   `__studio.frame({ t })` and compare geometry, normals and lighting before changing code.
4. Final: `npm run render:final` with `subframes` set for GL (2 is a good start), then the mix and delivery as usual.

Delegate render failures (black frames, context loss, WebGL unavailable) to the `render-engineer` subagent with the
error text and `npm run doctor` output.

Next: `/motion-studio:springs` to tune the motion values you feed the uniforms, then `/motion-studio:critique-loop`.
