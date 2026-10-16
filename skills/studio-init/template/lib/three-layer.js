// lib/three-layer.js (browser) — Three.js scenes inside a seek(t) film. The bridge takes the THREE module as an argument,
// so this file imports nothing and a 2D-only film never loads three. Install a pinned version in the film project
// (npm i -E three@0.160.0); index.html maps 'three' and 'three/addons/' to node_modules through its importmap:
//
//   import * as THREE from 'three';
//   import { threeLayer, studioEnv } from '../lib/three-layer.js';
//   const hero = threeLayer(THREE, { setup: ({ THREE, scene, renderer }) => {...; return state }, update: (t, ctx) => {...} });
//   scene(0, 6, 'hero', hero.draw)                 // draw(g, lt, c), the scene draw signature
//
// The render contract for three: update(t, ...) must set EVERY animated property absolutely from t (position, rotation,
// material values, light intensities, camera). Never accumulate (mesh.rotation.y += 0.01), never use THREE.Clock,
// renderer.setAnimationLoop, AnimationMixer.update(delta) or physics steps: frames are painted out of order and in
// parallel pages, so carried state gives a different film on every render. AnimationMixer.setTime(t) is fine.
// Determinism also needs studio.json "gl": "software" (SwiftShader) and antialias: false (MSAA differs by driver).

const even = (n) => Math.max(2, 2 * Math.round(n / 2));

function toneMappingOf(THREE, name) {
  const map = { none: THREE.NoToneMapping, linear: THREE.LinearToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, cineon: THREE.CineonToneMapping, reinhard: THREE.ReinhardToneMapping };
  if (typeof name === 'number') return name;
  const v = map[String(name ?? 'aces').toLowerCase()];
  if (v === undefined) throw new Error(`threeLayer: toneMapping "${name}" is not available in three r${THREE.REVISION} (use ${Object.keys(map).filter((k) => map[k] !== undefined).join(', ')})`);
  return v;
}

/**
 * A Three.js layer. Options:
 *   setup({ THREE, scene, camera, renderer, c })  once, on the first paint; build meshes, lights, env; may return state
 *   update(t, { THREE, scene, camera, renderer, state, c, lt })  every paint; t = c.t (film time); set everything from t
 *   fov = 30, near = 0.1, far = 100   default PerspectiveCamera (aspect follows the format), or pass camera
 *   scale = 1          GL resolution relative to the stage (0.5–0.75 for drafts)
 *   toneMapping = 'aces', exposure = 1, background = null ('#rrggbb' or null = transparent over the 2D frame)
 *   shadows = false    renderer.shadowMap.enabled (PCFSoftShadowMap)
 * Returns { draw(g, lt, c), dispose(), get renderer/scene/camera/state }.
 */
export function threeLayer(THREE, { setup = null, update = null, fov = 30, near = 0.1, far = 100, camera = null, scale = 1, toneMapping = 'aces', exposure = 1, background = null, shadows = false, name = 'three' } = {}) {
  if (!THREE || typeof THREE.WebGLRenderer !== 'function') throw new Error(`threeLayer "${name}": pass the three module: import * as THREE from 'three' (npm i -E three@0.160.0)`);
  if (update != null && typeof update !== 'function') throw new Error(`threeLayer "${name}": update must be (t, ctx) => void`);
  if (!(scale > 0 && scale <= 4)) throw new Error(`threeLayer "${name}": scale must be in (0, 4] (got ${scale})`);
  let st = null;

  function init(c) {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power', premultipliedAlpha: false });
    } catch (err) {
      throw new Error(`threeLayer "${name}": WebGL is not available (${err.message}); keep studio.json "gl": "software" and run npm run doctor`);
    }
    renderer.setPixelRatio(1);
    if ('outputColorSpace' in renderer && THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = toneMappingOf(THREE, toneMapping);
    renderer.toneMappingExposure = exposure;
    renderer.setClearColor(0x000000, 0);
    if (shadows) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    const gl = renderer.getContext();
    gl.disable(gl.DITHER); // three re-enables nothing per frame that dithers; dithering is driver-defined
    const scene = new THREE.Scene();
    if (background != null) scene.background = new THREE.Color(background);
    const cam = camera ?? new THREE.PerspectiveCamera(fov, c.W / c.H, near, far);
    st = { canvas, renderer, scene, camera: cam, state: undefined };
    if (setup) {
      const r = setup({ THREE, scene, camera: cam, renderer, c });
      if (r && typeof r.then === 'function') throw new Error(`threeLayer "${name}": setup must be synchronous (load assets in the film's setup(ctx), which may be async, and pass them in)`);
      st.state = r;
    }
  }

  const draw = (g, lt, c) => {
    if (!c || !(c.W > 0) || !(c.H > 0)) throw new Error(`threeLayer "${name}": draw(g, lt, c) needs the scene context c`);
    if (!st) init(c);
    const { renderer, scene, camera: cam, canvas } = st;
    if (renderer.getContext().isContextLost()) throw new Error(`threeLayer "${name}": the WebGL context was lost; re-render this frame`);
    const T = typeof g.getTransform === 'function' ? g.getTransform() : { a: 1, d: 1 };
    const w = even(Math.abs(T.a || 1) * c.W * scale);
    const h = even(Math.abs(T.d || 1) * c.H * scale);
    if (canvas.width !== w || canvas.height !== h) renderer.setSize(w, h, false);
    if (cam.isPerspectiveCamera && Math.abs(cam.aspect - c.W / c.H) > 1e-9) {
      cam.aspect = c.W / c.H;
      cam.updateProjectionMatrix();
    }
    const t = Number(c.t ?? lt) || 0;
    if (update) update(t, { THREE, scene, camera: cam, renderer, state: st.state, c, lt });
    renderer.render(scene, cam);
    g.drawImage(canvas, 0, 0, c.W, c.H);
  };

  const dispose = () => {
    if (!st) return;
    st.renderer.dispose();
    st.renderer.forceContextLoss();
    st = null;
  };

  return Object.freeze({
    draw,
    dispose,
    get renderer() { return st ? st.renderer : null; },
    get scene() { return st ? st.scene : null; },
    get camera() { return st ? st.camera : null; },
    get state() { return st ? st.state : undefined; },
  });
}

/**
 * A reflection-only studio environment (scene.environment): a dark room with emissive softboxes, prefiltered with
 * PMREM. It lights PBR materials and shows up only in reflections, never as the background, so a white product keeps
 * its edges against a light backdrop and chrome gets the bright/dark bands that make it read as metal (an even grey
 * environment turns chrome into grey plastic). panels: [{ pos: [x,y,z], size: [w,h], intensity }] (look at the origin).
 * Call it in setup and assign: scene.environment = studioEnv(THREE, renderer).
 */
export function studioEnv(THREE, renderer, { panels = null, room = 0x0b0b0c, blur = 0.04 } = {}) {
  const env = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial({ color: room, side: THREE.BackSide }));
  env.add(box);
  const list = panels ?? [
    { pos: [0, 7, 3], size: [9, 4], intensity: 9 }, // key: large overhead-front softbox
    { pos: [-8, 1, 2], size: [1.4, 9], intensity: 6 }, // left strip: the long highlight down a chrome edge
    { pos: [8, 0.5, 4], size: [2, 7], intensity: 4 }, // right strip, cooler fill
    { pos: [0, 2, -8], size: [12, 1.2], intensity: 3 }, // rim band behind
  ];
  for (const p of list) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(p.size[0], p.size[1]), new THREE.MeshBasicMaterial({ color: new THREE.Color(p.color ?? 0xffffff).multiplyScalar(p.intensity ?? 1), side: THREE.DoubleSide }));
    m.position.set(p.pos[0], p.pos[1], p.pos[2]);
    m.lookAt(0, 0, 0);
    env.add(m);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, blur).texture;
  pmrem.dispose();
  env.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return tex;
}
