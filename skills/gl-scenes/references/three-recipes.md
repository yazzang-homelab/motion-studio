# Three.js recipes (lib/three-layer.js)

Three.js gives meshes, PBR materials, shadows and loaders; `threeLayer` makes it a seek(t) scene. The reference
implementation is [../assets/product-hero.three.js](../assets/product-hero.three.js).

---

## 1. Install and pin

```bash
npm i -E three@0.160.0      # exact version: a three upgrade changes shading, so hashes and the look change
```

`index.html` already has the importmap, so `import * as THREE from 'three'` and
`import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'` resolve to `node_modules/three`
through the tools' static server. Record the version in the delivery note; upgrading three is a re-review.

---

## 2. Render contract for Three.js

| Allowed | Not allowed |
|---|---|
| `update(t, ctx)` sets `position`, `rotation`, `scale`, material values, light intensities and the camera from `t` | `mesh.rotation.y += 0.01` and any other per-frame accumulation |
| springs from `lib/motion.js` (`sp`, `track`, `loopTrack`) computed from `t` | `THREE.Clock`, `renderer.setAnimationLoop`, `requestAnimationFrame` |
| `mixer.setTime(t)` for a glTF animation clip | `mixer.update(delta)` |
| geometry built once in `setup` | rebuilding geometry every frame (slow; fine only if it is a pure function of `t`) |
| assets loaded in the film's async `setup(ctx)` and passed in | loading inside `update` or the layer's `setup` (must be synchronous) |

Frames are painted out of order and in several pages at once; anything that remembers the previous frame renders a
different film every time.

---

## 3. Product shot numbers (the earbud brief)

| Element | Value |
|---|---|
| case | 6.0 × 4.6 × 2.2 units, one rounded solid cut at y = 3.1 into base and lid |
| ceramic white | `MeshPhysicalMaterial({ color: '#F4F1EC', roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.18 })` |
| chrome (hinge, rings) | `MeshStandardMaterial({ metalness: 1, roughness: 0.05 })` |
| accent | `#D97757` (LED, emissive intensity following the lid angle) |
| camera | FOV 30°, raised three-quarter view (a 100° lid disappears from a level front view), dolly in for the hold, 2% periodic drift |
| lid | 100° spring, ζ 0.6 (≈9.5% overshoot); the closing overshoot is mirrored (`abs`) into a bounce off the base |
| earbuds | rise 4.0 units at ζ 0.7, 150 ms apart, 35° secondary turn at ζ 0.5 |
| anticipation | the case squashes 2.5% for 0.23 s before the lid opens |
| light | low hemisphere (0.18), warm key with a 1024² soft shadow, cool fill, rim from behind, `studioEnv` for reflections |
| tone mapping | ACES, exposure 1, output sRGB |

Springs by damping ratio ζ and natural frequency f: `k = (2πf)²`, `d = 2ζ·2πf`, passed as `{ k, d }`.

---

## 4. Lighting a white product

A white object on a light backdrop disappears; on a dark one it clips. What works:

1. Low ambient (HemisphereLight ≤ 0.2). Ambient flattens a white surface into one tone.
2. Key + rim with a clear direction: the key shapes the form, the rim separates the silhouette.
3. Reflection-only softboxes (`studioEnv`): the clearcoat picks up long bright strips that describe the curvature,
   without raising the diffuse level.
4. A shadow-only floor (`ShadowMaterial`) so the 2D backdrop stays visible and the product still sits on something.
5. Check the brightest area: if the whole front is at 250+ in the frame, lower the key, not the exposure.

---

## 5. Modelling procedurally

- `RoundedBoxGeometry` (addons) for cases and devices; cut one solid in two by pressing the vertices beyond the cut
  onto the cut plane and setting their normals to ±Y (`caseHalf` in the example). Two separately rounded boxes read as
  two pillows.
- Show the inside when something opens: a dark tray and wells under the lid make the opening legible.
- Pivot = a `Group` at the hinge with the mesh offset inside it; rotate the group.
- Mirror a part with `scale.x = -1` (Three.js fixes the winding).
- Avoid a dark disc on a light sphere facing the camera: it reads as an eye.

---

## 6. Debugging

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to resolve module specifier "three"` | three not installed or the importmap was removed | `npm i -E three@0.160.0`; keep the importmap in index.html before the module script |
| frames differ between runs | something accumulates (`+=`, Clock, mixer.update) or `"gl": "gpu"` | set values from `t`; keep `"gl": "software"` |
| everything flat white | ambient too high, no env, tone mapping off | see section 4 |
| shadow acne / peter-panning | shadow bias | `light.shadow.bias = -0.0005`, `normalBias = 0.02` |
| slow frames | large shadow maps, many lights, high segment counts | 1024² shadows, ≤ 4 lights, 8 to 10 segments on rounded boxes; `scale` 0.5 for drafts |
