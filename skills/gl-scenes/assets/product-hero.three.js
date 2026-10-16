// product-hero.three.js — a 6 s seamless-loop product shot in Three.js (1:1, 60 fps, 120 BPM): a ceramic-white earbud
// case squashes a hair (anticipation), the lid springs open 100° (ζ 0.6), the two earbuds rise 4 units out of their
// wells one after the other with a 35° secondary turn, the camera dollies in and drifts while the product holds, then
// everything returns and the lid closes with a small bounce; a light sweep crosses the seam so frame 360 == frame 0.
// All geometry is procedural (no assets). Use it as film/film.js in a project made with
//   node <plugin>/skills/studio-init/scripts/init.mjs <dir> --duration 6 --formats 1x1 --loop
//   cd <dir> && npm i -E three@0.160.0
//
// Pure function of time: update() sets every transform, intensity and camera value absolutely from t, with closed-form
// springs from lib/motion.js (loopTrack keeps them periodic). Nothing accumulates between frames.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { defineFilm, scene } from '../lib/timeline.js';
import { loopTrack, loopT, clamp, smoothstep } from '../lib/motion.js';
import { threeLayer, studioEnv } from '../lib/three-layer.js';

const DUR = 6;
const CASE = { w: 6.0, h: 4.6, d: 2.2 }; // case size in scene units; the lid is the top third
const BASE_H = 3.1;
const COLORS = { ceramic: '#F4F1EC', accent: '#D97757', tray: '#2B2826', tip: '#C9C5BF', bg0: '#26241F', bg1: '#0F0E0D' };
const RAD = Math.PI / 180;

// Spring by damping ratio ζ and natural frequency f (Hz): k = (2πf)², d = 2ζ·2πf.
const zf = (zeta, f) => ({ k: (2 * Math.PI * f) ** 2, d: 2 * zeta * 2 * Math.PI * f });

// Motion: every track returns to its first value within the cycle (loopTrack requires it).
const press = (t) => loopTrack(t, [[0, 0], [0.72, 1, zf(0.9, 5)], [0.95, 0, zf(0.5, 3)]], DUR); // anticipation squash
// Lid: open at 1.0 s with ζ 0.6 (≈9.5% overshoot), close at 4.75 s. abs() turns the closing overshoot into a bounce
// off the base instead of the lid passing through it.
const lid = (t) => Math.abs(loopTrack(t, [[0, 0], [1.0, 100, zf(0.6, 1.4)], [4.75, 0, zf(0.6, 2.0)]], DUR));
const rise = (t, i) => loopTrack(t, [[0, 0], [1.5 + 0.15 * i, 4.0, zf(0.7, 1.1)], [4.0 + 0.12 * (1 - i), 0, zf(0.9, 1.6)]], DUR);
const turn = (t, i) => loopTrack(t, [[0, 0], [1.62 + 0.15 * i, 35 * (i ? -1 : 1), zf(0.5, 0.9)], [3.9, 0, zf(0.85, 1.4)]], DUR);
const dolly = (t) => loopTrack(t, [[0, 18.5], [2.0, 15.5, zf(1, 0.45)], [4.4, 18.5, zf(1, 0.5)]], DUR);
// Light sweep across the seam: 5.5 s → 0.5 s of the next cycle, one continuous pass.
const sweepPhase = (t) => loopT(t - 5.5, DUR); // 0..1 during the sweep, > 1 otherwise

// One rounded capsule cut in two at y = cut: vertices on the far side of the cut are pressed onto the cut plane, which
// gives a closed half with the case's real cross-section as its flat face (normal straight up/down there). Two separate
// rounded boxes read as two pillows, not as one case with a lid.
function caseHalf(cut, keepBelow) {
  const geo = new RoundedBoxGeometry(CASE.w, CASE.h, CASE.d, 10, 1.0);
  geo.translate(0, CASE.h / 2, 0);
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (keepBelow ? y > cut : y < cut) {
      pos.setY(i, cut);
      nrm.setXYZ(i, 0, keepBelow ? 1 : -1, 0);
    }
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  return geo;
}

// Earbud: an egg-shaped head that flows into a long stem, the silicone tip angled inward, a chrome contact ring at the
// stem's foot. A round head with a dark disc on it reads as a creature's face, not an earbud.
function earbud(mat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.46, 48, 32), mat.ceramic);
  body.scale.set(1.12, 0.92, 0.88);
  const stem = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 1.45, 8, 24), mat.ceramic);
  stem.position.set(0.16, -0.9, 0);
  stem.rotation.z = 0.08;
  const tip = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.1, 8, 24), mat.tip); // silicone nozzle, pointing into the ear
  tip.rotation.set(0, 0.5, Math.PI / 2);
  tip.position.set(-0.46, 0.04, -0.12);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.02, 12, 40), mat.chrome);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0.22, -1.62, 0);
  for (const m of [body, stem, tip]) m.castShadow = true;
  g.add(body, stem, tip, ring);
  return g;
}

export default defineFilm(() => {
  const hero = threeLayer(THREE, {
    name: 'product-hero',
    fov: 30,
    toneMapping: 'aces',
    exposure: 1.0,
    shadows: true,
    setup: ({ scene: s, renderer }) => {
      s.environment = studioEnv(THREE, renderer); // reflections only: softboxes never appear as the background
      const mat = {
        ceramic: new THREE.MeshPhysicalMaterial({ color: COLORS.ceramic, roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.18, envMapIntensity: 0.9 }),
        chrome: new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 1, roughness: 0.05, envMapIntensity: 1.4 }),
        tray: new THREE.MeshStandardMaterial({ color: COLORS.tray, roughness: 0.7 }),
        grille: new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 0.9 }),
        tip: new THREE.MeshPhysicalMaterial({ color: COLORS.tip, roughness: 0.55, sheen: 0.4 }),
        led: new THREE.MeshStandardMaterial({ color: COLORS.accent, emissive: COLORS.accent, emissiveIntensity: 0 }),
      };
      const rig = new THREE.Group(); // the whole product: squash happens here
      s.add(rig);
      const base = new THREE.Mesh(caseHalf(BASE_H, true), mat.ceramic);
      base.castShadow = true;
      base.receiveShadow = true;
      const tray = new THREE.Mesh(new RoundedBoxGeometry(CASE.w - 1.0, 0.02, CASE.d - 0.45, 2, 0.008), mat.tray); // inside, seen when open
      tray.position.y = BASE_H + 0.006;
      const wells = [-1, 1].map((sx) => {
        const w = new THREE.Mesh(new THREE.CircleGeometry(0.42, 40), mat.grille);
        w.rotation.x = -Math.PI / 2;
        w.position.set(sx * 1.25, BASE_H + 0.02, 0.05);
        return w;
      });
      const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 24), mat.chrome);
      hinge.rotation.z = Math.PI / 2;
      hinge.position.set(0, BASE_H, -CASE.d / 2 + 0.05);
      const led = new THREE.Mesh(new THREE.CircleGeometry(0.06, 24), mat.led);
      led.position.set(0, BASE_H * 0.62, CASE.d / 2 + 0.003);
      // The lid pivots on the back edge: the group sits on the hinge, the mesh hangs forward from it.
      const lidPivot = new THREE.Group();
      lidPivot.position.set(0, BASE_H + 0.006, -CASE.d / 2); // a hairline seam, not a black band
      const lidMesh = new THREE.Mesh(caseHalf(BASE_H, false), mat.ceramic);
      lidMesh.position.set(0, -BASE_H, CASE.d / 2); // the cut face sits on the pivot
      lidMesh.castShadow = true;
      lidPivot.add(lidMesh);
      const buds = [earbud(mat), earbud(mat)];
      buds[1].scale.x = -1; // mirrored right earbud
      rig.add(base, tray, ...wells, hinge, led, lidPivot, ...buds);
      // Floor that only shows the shadow (the 2D backdrop stays visible).
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.32 }));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      s.add(floor);
      // Three-point light with a low ambient: a white product only separates from its surroundings by contrast.
      s.add(new THREE.HemisphereLight('#f3efe8', '#2a2622', 0.18));
      const key = new THREE.DirectionalLight('#fff4e6', 2.4);
      key.position.set(-6, 10, 8);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 40 });
      key.shadow.radius = 4;
      const fill = new THREE.DirectionalLight('#dfe8ff', 0.5);
      fill.position.set(8, 3, 6);
      const rim = new THREE.DirectionalLight('#ffffff', 1.6);
      rim.position.set(2, 6, -10);
      const sweep = new THREE.SpotLight('#ffffff', 0, 40, 0.22, 0.6, 1.5);
      sweep.target.position.set(0, 2, 0);
      s.add(key, fill, rim, sweep, sweep.target);
      return { rig, lidPivot, buds, mat, sweep };
    },
    update: (t, { camera, state }) => {
      const { rig, lidPivot, buds, mat, sweep } = state;
      const p = press(t);
      rig.scale.set(1 + 0.012 * p, 1 - 0.025 * p, 1 + 0.012 * p); // volume-preserving squash
      const a = lid(t);
      lidPivot.rotation.x = -a * RAD;
      mat.led.emissiveIntensity = 2.2 * clamp(a / 100);
      buds.forEach((b, i) => {
        const x = (i ? 1 : -1) * 1.25;
        b.position.set(x, BASE_H - 0.55 + rise(t, i), 0.05);
        b.rotation.set(0, turn(t, i) * RAD, (i ? -1 : 1) * 0.05);
      });
      // Camera: dolly in for the hold, plus a slow periodic drift so the hold never looks frozen (2% of the frame).
      const z = dolly(t);
      const drift = (2 * Math.PI * t) / DUR;
      // A raised three-quarter view: from straight ahead a 100° lid swings out of sight behind the case.
      const az = 0.42 + 0.02 * Math.sin(drift);
      camera.position.set(z * Math.sin(az), 7.2 + 0.12 * Math.sin(2 * drift), z * Math.cos(az));
      camera.lookAt(0, 2.7 + 0.5 * clamp((18.5 - z) / 3), 0);
      // Light sweep: a hard spot travelling left → right across the seam (0.5 s on each side of it).
      const ph = sweepPhase(t);
      const on = ph < 1 ? Math.sin(Math.PI * ph) : 0;
      sweep.intensity = 60 * on;
      sweep.position.set(-9 + 18 * smoothstep(0, 1, Math.min(1, ph)), 6, 9);
    },
  });

  return {
    scenes: [
      scene(0, DUR, 'product hero', (g, lt, c) => {
        const grad = g.createRadialGradient(c.W / 2, c.H * 0.42, 0, c.W / 2, c.H * 0.42, c.W * 0.75);
        grad.addColorStop(0, COLORS.bg0);
        grad.addColorStop(1, COLORS.bg1);
        g.fillStyle = grad;
        g.fillRect(0, 0, c.W, c.H);
        hero.draw(g, lt, c);
      }),
    ],
  };
});
