// liquid-chrome.film.js — a 6 s seamless loop (1:1, 60 fps): a chrome blob breathes, squashes, splits into one droplet
// per letter, the droplets morph into an extruded word, the word holds while the reflections sweep, melts back into one
// drop, and the drop wobbles into frame 0. Copy to film/film.js of a project made with
//   node <plugin>/skills/studio-init/scripts/init.mjs <dir> --duration 6 --formats 1x1 --loop
//
// One signed distance field for every phase: droplets and letters are blended with smin and mixed per letter, so the
// shape never cross-fades. Every motion value is a loopTrack() of lib/motion.js computed in JavaScript (closed-form,
// periodic: frame 360 == frame 0) and handed to the shader as uniforms; the shader itself never reads a clock.

import { defineFilm, scene } from '../lib/timeline.js';
import { loopTrack, clamp, smoothstep } from '../lib/motion.js';
import { glLayer, sdfText, GLSL } from '../lib/gl.js';

const WORD = 'MOTION';
const N = WORD.length; // one droplet per letter (max 8: the shader arrays are sized 8)
const DUR = 6;
const WORD_W = 2.15; // world width of the word's ink (the frame is ~2.8 wide at the camera distance below)
const R0 = 0.78; // resting drop radius
const R_DROP = 0.17; // droplet radius before it becomes a letter
const DEPTH = 0.16; // half thickness of the extruded letters
const BEVEL = 0.035; // rounds the letter edges (chrome needs a rounded edge to catch a highlight)

// Spring shorthand by damping ratio ζ and natural frequency f (Hz): k = (2πf)², d = 2ζ·2πf.
const zf = (zeta, f) => ({ k: (2 * Math.PI * f) ** 2, d: 2 * zeta * 2 * Math.PI * f });

// Letter centres in world units, measured with the same font as the SDF texture (ink box centred at x = 0).
function letterLayout(font, weight) {
  const g = document.createElement('canvas').getContext('2d');
  g.font = `${weight} 200px "${font}"`;
  const m = g.measureText(WORD);
  const inkL = m.actualBoundingBoxLeft;
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const k = WORD_W / inkW;
  const out = [];
  for (let i = 0; i < N; i++) {
    const a = g.measureText(WORD.slice(0, i)).width;
    const lm = g.measureText(WORD[i]);
    const cx = a + (lm.actualBoundingBoxRight - lm.actualBoundingBoxLeft) / 2; // ink centre of letter i from the pen origin
    out.push({ x: (cx + inkL - inkW / 2) * k, half: (lm.actualBoundingBoxLeft + lm.actualBoundingBoxRight) * k * 0.5 });
  }
  return out;
}

const FRAG = `
#define MAXL ${N}
#define MARCH_STEPS 110
#define MARCH_FAR 12.0
#define NORMAL_EPS 0.002 // ~ one SDF texel in world units: smooths the bilinear facets of the text field
uniform sampler2D uText;
uniform float uTextAspect;
uniform float uTextH;       // world height of the SDF texture
uniform vec3 uDrop[MAXL];   // droplet centres
uniform float uDropR[MAXL]; // droplet radii
uniform vec2 uCell[MAXL];   // letter centre x, half width
uniform float uMorph[MAXL]; // 0 droplet .. 1 letter
uniform float uK;           // smin blend radius
uniform vec3 uSquash;       // per-axis scale of the merged drop (volume-preserving)
uniform float uEnvRot;      // reflection sweep (environment yaw)
uniform vec3 uBg;
${GLSL.sdf}
${GLSL.raymarch}
${GLSL.lighting}
${GLSL.color}
${GLSL.text}

float letter(vec3 p, int i) {
  vec2 uv = vec2(p.x / (uTextH * uTextAspect) + 0.5, p.y / uTextH + 0.5);
  float d2 = textSdf(uText, uv, uTextAspect) * uTextH;
  d2 = max(d2, sdBox2(p.xy - vec2(uCell[i].x, 0.0), vec2(uCell[i].y + 0.03, uTextH))); // only letter i
  vec2 w = vec2(d2 + BEVEL, abs(p.z) - DEPTH + BEVEL);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - BEVEL;
}

float map(vec3 p) {
  float d = 1e5;
  for (int i = 0; i < MAXL; i++) { // a compile-time bound: SwiftShader unrolls it (a uniform bound costs ~2x)
    float m = uMorph[i];
    // Bounding sphere around this droplet/letter: when even its bound is further than d + k, smin(d, di, k) == d, so
    // the expensive letter() is skipped exactly. This culling is most of the frame time saved.
    vec3 c = mix(uDrop[i], vec3(uCell[i].x, 0.0, 0.0), m);
    float bound = length(p - c) - max(uDropR[i] * max(uSquash.x, uSquash.y), uCell[i].y + uTextH * 0.36 + 0.05);
    if (bound > d + uK) continue;
    vec3 q = (p - uDrop[i]) / uSquash;
    float drop = sdSphere(q, uDropR[i]) * min(uSquash.x, min(uSquash.y, uSquash.z));
    float di = m <= 0.0 ? drop : m >= 1.0 ? letter(p, i) : mix(drop, letter(p, i), m);
    d = smin(d, di, uK);
  }
  return d * 0.85; // mixed and scaled fields are not exact distances: smaller steps keep the march from overshooting
}

vec3 background(vec2 uv) {
  float v = 1.0 - 0.55 * length((uv - vec2(0.5, 0.56)) * vec2(1.0, 1.25));
  return toLinear(uBg) * (0.35 + 0.9 * clamp(v, 0.0, 1.0));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 ndc = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  vec3 ro = vec3(0.0, 0.0, 5.2);
  vec3 rd = normalize(vec3(ndc * tan(radians(15.0)), -1.0)); // FOV 30
  vec3 col = background(uv);
  float t = marchBox(ro, rd, vec3(1.45, 0.95, 0.95)); // the word, the drop and the squash all fit in this box
  if (t > 0.0) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 r = reflect(rd, n);
    r.xz = rot2(uEnvRot) * r.xz;
    float cosT = clamp(dot(n, -rd), 0.0, 1.0);
    // Chrome: F0 0.92, roughness ~0.04 (a mirror); the environment does all the work.
    vec3 F = fresnelSchlick(vec3(0.92, 0.91, 0.89), cosT);
    col = envStudio(r) * F * mix(0.55, 1.0, ao(p, n));
  }
  col = tonemapACES(col * 1.1);
  fragColor = vec4(toSrgb(col), 1.0);
}
`.replace(/\bBEVEL\b/g, BEVEL.toFixed(4)).replace(/\bDEPTH\b/g, DEPTH.toFixed(4));

export default defineFilm((ctx) => {
  const font = (ctx.brand.fonts && (ctx.brand.fonts.ui || ctx.brand.fonts.display)) || 'Inter';
  const weight = 800;
  // The factory runs in the page after the brand fonts loaded, so the SDF raster uses the real face.
  const PAD = 56;
  const tex = sdfText(WORD, { font, weight, size: 280, pad: PAD });
  const cells = letterLayout(font, weight);
  const textH = (tex.height * WORD_W) / (tex.width - 2 * PAD); // world height of the texture: ink width = WORD_W
  // Every track closes on itself (last value = first) and its key times lie in 0..DUR: loopTrack is exactly periodic.
  const squash = (t) => loopTrack(t, [[0, 0], [1.2, 1, zf(0.7, 4)], [1.42, 0, zf(0.45, 3)], [5.62, -0.7, zf(0.8, 5)], [5.72, 0, zf(0.35, 3)]], DUR);
  const split = (t) => loopTrack(t, [[0, 0], [1.4, 1, zf(0.72, 1.4)], [5.0, 0, zf(0.85, 1.6)]], DUR);
  const morph = (t, i) => {
    const a = 2.2 + 0.09 * i; // letters form left to right, 90 ms apart
    const b = 4.8 + 0.07 * Math.abs(i - (N - 1) / 2); // and melt from the centre outwards
    return loopTrack(t, [[0, 0], [a, 1, zf(0.75, 2.2)], [b, 0, zf(0.9, 2.4)]], DUR);
  };
  const sweep = (t) => loopTrack(t, [[0, 0], [2.6, 1.1, zf(1, 0.45)], [5.1, 0, zf(1, 0.6)]], DUR);

  const chrome = glLayer({
    name: 'liquid-chrome',
    frag: FRAG,
    textures: { uText: tex },
    uniforms: (t) => {
      const s = split(t);
      const q = squash(t);
      const breathe = 0.015 * Math.sin((2 * Math.PI * 5 * t) / DUR) * (1 - clamp(s * 4)); // 5 breaths per loop
      const sy = 1 - 0.1 * q + breathe;
      const sx = 1 / Math.sqrt(Math.max(0.2, sy)); // volume kept: sx·sy·sz = 1
      const drops = [];
      const radii = [];
      const cell = [];
      const m = [];
      for (let i = 0; i < N; i++) {
        const c = cells[i];
        drops.push([c.x * s, 0, 0]);
        // Coincident drops blended with smin swell by k/4: shrink them so the merged drop is R0.
        radii.push(R0 + (R_DROP - R0) * clamp(s));
        cell.push([c.x, c.half]);
        m.push(clamp(morph(t, i)));
      }
      const mAvg = m.reduce((a, b) => a + b, 0) / N;
      const k = (0.5 + (0.07 - 0.5) * smoothstep(0, 1, s)) * (1 - 0.6 * mAvg); // one drop → separate droplets → crisp letters
      return {
        uDrop: drops, uDropR: radii.map((r) => r - k / 4 * (1 - clamp(s))), uCell: cell, uMorph: m, uK: k,
        uSquash: [sx, sy, sx], uEnvRot: sweep(t) * 1.4, uTextH: textH, uBg: '#17171a',
      };
    },
  });

  return {
    background: '#17171a',
    scenes: [scene(0, DUR, 'liquid chrome', chrome.draw)],
  };
});
