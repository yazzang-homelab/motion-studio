# SDF recipes (lib/gl.js)

Signed distance fields describe a shape as "distance to the surface" at every point; a raymarcher walks each pixel's
ray by that distance until it hits. Everything in one field can blend, so a sphere can become seven droplets and the
droplets can become letters without a single cross-fade. The reference implementation of every recipe here is
[../assets/liquid-chrome.film.js](../assets/liquid-chrome.film.js).

---

## 1. Shader skeleton

```glsl
#define MARCH_STEPS 110
#define MARCH_FAR 12.0
uniform float uSquash;                      // from uniforms(t, c, lt)
${GLSL.sdf}
${GLSL.raymarch}
${GLSL.lighting}
${GLSL.color}

float map(vec3 p) { return sdSphere(p, 0.8); }

void main() {
  vec2 ndc = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  vec3 ro = vec3(0.0, 0.0, 5.2);
  vec3 rd = normalize(vec3(ndc * tan(radians(15.0)), -1.0));   // FOV 30
  vec3 col = vec3(0.01);
  float t = marchBox(ro, rd, vec3(1.0));                       // only inside the shape's bounding box
  if (t > 0.0) {
    vec3 p = ro + rd * t, n = calcNormal(p), r = reflect(rd, n);
    col = envStudio(r) * fresnelSchlick(vec3(0.92), clamp(dot(n, -rd), 0.0, 1.0));
  }
  fragColor = vec4(toSrgb(tonemapACES(col)), 1.0);
}
```

Write it as a JS template string so `${GLSL.sdf}` interpolates; constants from JS can be spliced in the same way.

---

## 2. Liquid chrome

| Parameter | Value | Note |
|---|---|---|
| F0 | 0.92 (slightly warm: `vec3(0.92, 0.91, 0.89)`) | Schlick Fresnel; metals reflect most light at every angle |
| roughness | ~0.04 | a mirror: the look comes entirely from the environment |
| environment | `envStudio(reflect(rd, n))` | dark room + key softbox + two strips + rim + front fill |
| reflection sweep | rotate the reflected vector: `r.xz = rot2(a) * r.xz` with `a` from a spring | moves the highlights over a still shape |
| contact darkening | `mix(0.55, 1.0, ao(p, n))` | keeps blended necks from glowing |
| tone mapping | `tonemapACES(col * 1.1)` then `toSrgb` | HDR softboxes (intensity 4 to 7) need a shoulder |

Chrome never looks like chrome in an even environment: it needs hard bright and dark areas to reflect. The extruded
type case is the extreme: its flat front faces mirror what is behind the camera, so `envStudio` has a front fill panel
(brighter at the top) or the faces go black.

---

## 3. Morphing in one field

| Step | Field | Driver (JS, closed-form) |
|---|---|---|
| breathe | sphere radius × (1 + 0.015·sin(2π·5t/dur)) | integer cycles per loop |
| squash | scale the sample point by `(sx, sy, sx)` with `sy = 1 − 0.1q`, `sx = 1/√sy` (volume kept), multiply the distance by the smallest scale | `q = loopTrack(...)` |
| split | N spheres whose centres go from 0 to the letter centres, radius from R0 to R_drop; `smin` with a blend radius `k` that shrinks as they separate (0.5 → 0.07) | `s = loopTrack(...)` |
| become letters | per item `mix(drop, letter, m_i)`, staggered `m_i` (90 ms apart) | one track per letter |
| melt | `m_i` back to 0 from the centre outwards, then `s` back to 0 | key times later in the same tracks |

Notes:

- `mix(a, b, m)` of two distance fields is not an exact distance: scale the field (`* 0.85`) so the march does not step
  through thin parts.
- N coincident spheres blended by `smin` swell by about `k/4`: subtract it from the radius while they are merged.
- Restrict each letter to its own cell (`max(textSdf, sdBox2(p.xy − centre, halfWidth))`) so letter i can morph
  independently while the word lives in one texture.
- Per-item culling: compute a bounding sphere first and `continue` when `bound > d + k`: `smin(d, x, k) == d` for any
  `x` that far, so the result is exact and the expensive term is skipped.
- Keep the loop bound a compile-time constant (`#define MAXL ${N}`): SwiftShader unrolls it.

---

## 4. Extruded type from any font

```js
const tex = sdfText('MOTION', { font: 'Inter', weight: 800, size: 280, pad: 56 });
const textH = (tex.height * WORD_W) / (tex.width - 2 * 56);   // world height of the texture for a WORD_W-wide word
glLayer({ frag, textures: { uText: tex }, uniforms: () => ({ uTextH: textH }) });
```

```glsl
uniform sampler2D uText; uniform float uTextAspect; uniform float uTextH;
${GLSL.text}
float word(vec3 p) {
  vec2 uv = vec2(p.x / (uTextH * uTextAspect) + 0.5, p.y / uTextH + 0.5);
  float d2 = textSdf(uText, uv, uTextAspect) * uTextH;           // 2D distance in world units
  vec2 w = vec2(d2 + BEVEL, abs(p.z) - DEPTH + BEVEL);           // extrude, then round the edges
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - BEVEL;
}
```

- Raster size: 200 to 320 px per line. Coarser textures show bilinear facets on curved bevels.
- `#define NORMAL_EPS` about one texel in world units (0.002 for a 2.15-unit word at 280 px) smooths those facets;
  the default 0.0006 is for analytic shapes.
- The texture is R32F when the GL can filter it (SwiftShader can), R16F otherwise.
- The text is centred on its ink box; measure letter centres with the same font (`measureText` of the prefixes) to
  place droplets or per-letter effects.

---

## 5. Loops in a shader

- Drive everything from JS with `loopTrack` (exactly periodic, value and velocity) and pass the values as uniforms.
- Shader-side motion uses `uTime / uDur` as a phase: integer cycles (`sin(6.2831853 * n * phase)`) or
  `loopNoise(p, phase)`.
- Verify with the critique's loop check: `hash(0)` must equal `hash(duration)` unwrapped, and `loop.png` shows the seam.

---

## 6. Debugging

| Symptom | Cause | Fix |
|---|---|---|
| holes, speckles near thin parts | the field overestimates distance (mixed, scaled or textured SDF) | multiply `map()` by 0.7 to 0.9; raise `MARCH_STEPS` |
| streaks along curved bevels | normal epsilon below the texture's texel size | raise `NORMAL_EPS` |
| the shape is cut off flat | `marchBox` bounds too small (squash and overshoot grow the shape) | enlarge the box by the overshoot |
| a frame takes seconds | full-frame march, no culling, uniform loop bounds | `marchBox`, bounding spheres, compile-time bounds, `scale` 0.5 for drafts |
| all black | compile error swallowed? No: it throws with numbered lines. Black usually means `ro`/`rd` point away or `MARCH_FAR` is too short | render one frame with `__studio.frame({ t })` and print uniforms |
