// lib/motion.js — closed-form springs and small math helpers.
// Every function is a pure function of its arguments: a value at time t never depends on earlier frames,
// so seek(t) can paint frame 812 without simulating frames 0..811 (the render contract).
// Self-contained on purpose (no imports) so it can be copied into any project or Node script.

export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, p) => a + (b - a) * p;
// A zero-width input range behaves like a step instead of dividing by zero.
export const invLerp = (a, b, x) => (a === b ? (x < a ? 0 : 1) : (x - a) / (b - a));
export function remap(x, inA, inB, outA = 0, outB = 1, doClamp = true) {
  const p = invLerp(inA, inB, x);
  return lerp(outA, outB, doClamp ? clamp(p) : p);
}
export function smoothstep(e0, e1, x) {
  const p = clamp(invLerp(e0, e1, x));
  return p * p * (3 - 2 * p);
}

// ---------------------------------------------------------------------------------------------------------------
// Springs: unit step 0 -> 1 released at t = 0 with zero velocity, m·x'' + d·x' + k·(x − 1) = 0.
// Exact closed forms for all three regimes. The article's "ζ ≥ 1 treated as critical" shortcut is up to 34% of
// travel wrong for heavily overdamped springs (research/tech-check §8), so the overdamped branch is real here.

const CRIT_BAND = 1e-6; // |ζ − 1| below this uses the critical form (avoids 0/0 in ζω0/ωd)

function step(t, k, d, m, wantVel) {
  if (!(t > 0)) return 0; // also catches NaN
  if (!(k > 0) || !(m > 0)) return wantVel ? 0 : 1; // infinitely stiff: jump to target
  if (!(d > 0)) d = 0;
  const w0 = Math.sqrt(k / m);
  const z = d / (2 * Math.sqrt(k * m));
  if (Math.abs(z - 1) < CRIT_BAND) {
    const e = Math.exp(-w0 * t);
    return wantVel ? w0 * w0 * t * e : 1 - e * (1 + w0 * t);
  }
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    const e = Math.exp(-z * w0 * t);
    const s = Math.sin(wd * t);
    return wantVel ? e * s * ((w0 * w0) / wd) : 1 - e * (Math.cos(wd * t) + ((z * w0) / wd) * s);
  }
  // Overdamped: r2 directly, r1 = ω0²/r2 (Vieta) avoids cancellation in −ζω0 + ω0√(ζ²−1) for large ζ.
  const r2 = -w0 * (z + Math.sqrt(z * z - 1));
  const r1 = (w0 * w0) / r2;
  const e1 = Math.exp(r1 * t);
  const e2 = Math.exp(r2 * t);
  return wantVel ? (r1 * r2 * (e1 - e2)) / (r1 - r2) : 1 + (r2 * e1 - r1 * e2) / (r1 - r2);
}

export function springPV(t, k = 170, d = 26, m = 1) {
  return [step(t, k, d, m, false), step(t, k, d, m, true)];
}
export function spring(t, k = 170, d = 26, m = 1) {
  return step(t, k, d, m, false);
}
export function springVel(t, k = 170, d = 26, m = 1) {
  return step(t, k, d, m, true);
}

// Presets read off the article's step-08 figure (fig 09) and checked numerically (research/media.md §2.09).
export const SPRINGS = Object.freeze({
  snappy: Object.freeze({ k: 320, d: 30 }), // buttons, toggles, leading edges (ζ 0.84, ~0.8% overshoot)
  default: Object.freeze({ k: 170, d: 26 }), // cards, containers, camera (ζ 0.997, no visible overshoot)
  heavy: Object.freeze({ k: 90, d: 20 }), // big type, 3D objects, logo lockups (ζ 1.05, overdamped)
  playful: Object.freeze({ k: 220, d: 14 }), // mascots, stickers (ζ 0.47, 18.6% overshoot)
});

// p: preset name | {k, d?, m?} | {duration, bounce} | {zeta, freq}. Missing d on {k} means critically damped.
export function resolveSpring(p = 'default') {
  if (p == null) return SPRINGS.default;
  if (typeof p === 'string') {
    const s = SPRINGS[p];
    if (!s) throw new Error(`unknown spring preset "${p}" — use ${Object.keys(SPRINGS).join(', ')}, {k,d} or {duration,bounce}`);
    return s;
  }
  if (typeof p === 'object') {
    if (Number.isFinite(p.k)) {
      const m = Number.isFinite(p.m) && p.m > 0 ? p.m : 1;
      const d = Number.isFinite(p.d) ? p.d : 2 * Math.sqrt(Math.max(0, p.k) * m);
      return m === 1 ? { k: p.k, d } : { k: p.k, d, m };
    }
    if ('duration' in p || 'bounce' in p) return springFromFeel(p);
    if ('zeta' in p || 'freq' in p) return springFromRatio(p);
  }
  throw new Error(`invalid spring ${JSON.stringify(p)} — use a preset name, {k,d}, {duration,bounce} or {zeta,freq}`);
}

export function sp(t, preset = 'default') {
  const s = resolveSpring(preset);
  return step(t, s.k, s.d, s.m ?? 1, false);
}

// Apple's perceptual parameters (SwiftUI Spring(duration:bounce:)): duration ≈ settle time, bounce 0 = critical,
// > 0 bouncier (1 = undamped), < 0 overdamped. k = (2π/D)², d = 4π(1−b)/D (b ≥ 0), d = 4π/(D(1+b)) (b < 0), m = 1.
export function springFromFeel({ duration = 0.5, bounce = 0 } = {}) {
  if (!(duration > 0)) throw new Error(`springFromFeel: duration must be > 0 (got ${duration})`);
  const b = clamp(Number.isFinite(bounce) ? bounce : 0, -0.999, 1);
  const k = ((2 * Math.PI) / duration) ** 2;
  const d = b >= 0 ? (4 * Math.PI * (1 - b)) / duration : (4 * Math.PI) / (duration * (1 + b));
  return { k, d };
}

export function feelFromSpring(spec) {
  const { k, d, m = 1 } = resolveSpring(spec);
  const w0 = Math.sqrt(k / m);
  const z = d / (2 * Math.sqrt(k * m));
  return { duration: (2 * Math.PI) / w0, bounce: z <= 1 ? 1 - z : 1 / z - 1 };
}

// Engineering parameters: damping ratio ζ = d / (2√(km)) and undamped natural frequency f in Hz (ω0 = 2πf), m = 1.
// k = ω0², d = 2ζω0. ζ ≥ 1 no bounce, 0.7–0.85 restrained, 0.4–0.6 lively, < 0.3 cartoon. A brief that says "damping
// 0.6" means ζ; without a frequency, 2 Hz (a 0.5 s period) is the neutral choice.
export function springFromRatio({ zeta = 0.7, freq = 2 } = {}) {
  if (!(freq > 0) || !Number.isFinite(freq)) throw new Error(`springFromRatio: freq must be a finite number > 0 Hz (got ${freq})`);
  if (!(zeta >= 0) || !Number.isFinite(zeta)) throw new Error(`springFromRatio: zeta must be a finite number ≥ 0 (got ${zeta})`);
  const w0 = 2 * Math.PI * freq;
  return { k: w0 * w0, d: 2 * zeta * w0 };
}

export function ratioFromSpring(spec) {
  const { k, d, m = 1 } = resolveSpring(spec);
  return { zeta: d / (2 * Math.sqrt(k * m)), freq: Math.sqrt(k / m) / (2 * Math.PI) };
}

// ---------------------------------------------------------------------------------------------------------------
// Multi-target values. keys = [[time, value, spring?], ...] sorted by time. Each change adds one spring that starts
// at its own time, so motion stays continuous (value AND velocity) through every retarget. keys[0] is the rest value
// (its time is ignored). An optional 3rd element overrides the spring for that change.

function keySpring(key, s) {
  return key.length > 2 && key[2] != null ? resolveSpring(key[2]) : s;
}

function trackSum(t, keys, springSpec, wantVel) {
  const n = keys ? keys.length : 0;
  if (n === 0) return 0;
  const s = resolveSpring(springSpec);
  let v = wantVel ? 0 : keys[0][1];
  for (let i = 1; i < n; i++) {
    const ti = keys[i][0];
    if (!(t > ti)) break; // sorted: every later key has not started yet
    const dv = keys[i][1] - keys[i - 1][1];
    if (dv === 0) continue;
    const ks = keySpring(keys[i], s);
    v += dv * step(t - ti, ks.k, ks.d, ks.m ?? 1, wantVel);
  }
  return v;
}

export function track(t, keys, spring = 'default') {
  return trackSum(t, keys, spring, false);
}
export function trackVel(t, keys, spring = 'default') {
  return trackSum(t, keys, spring, true);
}

// Seamless loops. Wrapping t with loopT() alone jumps at the seam because springs started in the previous cycle are
// cut off. The periodic sum adds every change from the last M cycles: v(t) = v0 + Σ_i Δ_i Σ_{m=0..M} s(tt − t_i + m·dur),
// tt = loopT(t, dur). Key times stay UNWRAPPED in [0, dur]: a change at dur is the seam change, felt at the start of the
// next cycle (m = 1), while wrapping dur to 0 would start it in the current cycle and offset every state by its Δ.
// Requires last value == first (ΣΔ = 0), so the settled history cancels and the result is exactly periodic.
export function loopTrack(t, keys, dur, spring = 'default', cycles = null) {
  const n = keys ? keys.length : 0;
  if (n === 0) return 0;
  if (!(dur > 0)) throw new Error(`loopTrack: dur must be > 0 (got ${dur})`);
  const first = keys[0][1];
  const last = keys[n - 1][1];
  if (Math.abs(last - first) > 1e-9 * Math.max(1, Math.abs(first))) {
    throw new Error(`loopTrack: the last value (${last}) must equal the first (${first}) so the loop closes`);
  }
  const tol = 1e-9 * Math.max(1, dur); // grid-derived times can land a hair past dur
  let tMax = 0;
  for (let i = 0; i < n; i++) {
    const ti = keys[i][0];
    if (!(ti >= -tol && ti <= dur + tol)) {
      throw new Error(`loopTrack: key ${i} time ${ti} is outside 0..${dur} — keys are times within one cycle (put a seam change at 0 or at dur)`);
    }
    if (i > 0) tMax = Math.max(tMax, ti);
  }
  const s = resolveSpring(spring);
  let M = cycles;
  if (M == null) {
    let settle = settleTime(s, 1e-4); // tighter than the 1% default: the residual shows up as a seam error
    for (let i = 1; i < n; i++) if (keys[i].length > 2 && keys[i][2] != null) settle = Math.max(settle, settleTime(keys[i][2], 1e-4));
    // The oldest spring still moving at tt = 0 started at tMax − m·dur; it has settled once m·dur − tMax ≥ settle.
    M = Number.isFinite(settle) ? Math.ceil((settle + tMax) / dur) + 1 : 8;
  }
  const tt = loopT(t, dur);
  let v = first;
  for (let i = 1; i < n; i++) {
    const dv = keys[i][1] - keys[i - 1][1];
    if (dv === 0) continue;
    const ks = keySpring(keys[i], s);
    const ti = keys[i][0];
    let acc = 0;
    for (let m = 0; m <= M; m++) acc += step(tt - ti + m * dur, ks.k, ks.d, ks.m ?? 1, false);
    v += dv * acc;
  }
  return v;
}

// Tab indicator that stretches: the leading edge is stiffer than the trailing edge (article step 08).
export function indicator(t, stops, { width = 120, lead = 'snappy', trail = { k: 140, d: 22 } } = {}) {
  const a = track(t, stops, lead);
  const b = track(t, stops, trail);
  return { left: Math.min(a, b), right: Math.max(a, b) + width };
}

// Text inside a morphing container: in shortly after the morph starts, out just before the next one.
// Pass tIn = null for "already in" and tOut = null for "never leaves".
export function swapAlpha(t, tIn, tOut, { inDelay = 0.08, inDur = 0.12, outLead = 0.1, outDur = 0.1 } = {}) {
  const ramp = (x, dur) => (dur > 0 ? clamp(x / dur) : x >= 0 ? 1 : 0);
  const aIn = tIn == null ? 1 : ramp(t - tIn - inDelay, inDur);
  const aOut = tOut == null ? 1 : ramp(tOut - outLead - t, outDur);
  return Math.min(aIn, aOut);
}

export const loopT = (t, dur) => (dur > 0 ? ((t % dur) + dur) % dur : t);
export const stagger = (i, step = 0.03) => i * step;
// "On twos" for drawings only (boil, hand-drawn frames). Never step camera moves or global fades (they judder).
export const stepTime = (t, rate = 12) => Math.floor(t * rate + 1e-7) / rate;

// Time after which |x − 1| stays below eps. Numeric but exact to ~1e-9 s; memoized per (k, d, m, eps).
const settleCache = new Map();
export function settleTime(spring = 'default', eps = 0.01) {
  const s = resolveSpring(spring);
  const m = s.m ?? 1;
  const key = `${s.k}|${s.d}|${m}|${eps}`;
  let v = settleCache.get(key);
  if (v === undefined) {
    v = computeSettle(s.k, s.d, m, eps);
    settleCache.set(key, v);
  }
  return v;
}

function computeSettle(k, d, m, eps) {
  if (!(k > 0) || !(m > 0) || !(eps > 0)) return 0;
  if (!(d > 0)) return Infinity; // undamped: never settles
  const w0 = Math.sqrt(k / m);
  const z = d / (2 * Math.sqrt(k * m));
  const err = (t) => Math.abs(1 - step(t, k, d, m, false));
  const bisect = (lo, hi) => {
    for (let i = 0; i < 80 && hi - lo > 1e-12; i++) {
      const mid = (lo + hi) / 2;
      if (err(mid) > eps) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  if (z >= 1 - CRIT_BAND) {
    // Critical/overdamped approach is monotone: one crossing of the eps band.
    let hi = 1 / w0;
    while (err(hi) > eps && hi < 1e7) hi *= 2;
    return bisect(0, hi);
  }
  // Underdamped: the envelope A·e^(−ζω0t), A = 1/√(1−ζ²), bounds |1 − x|, so nothing exceeds eps after tEnv.
  // Walk back from there to the last excursion, then bisect inside that step.
  const wd = w0 * Math.sqrt(1 - z * z);
  const tEnv = Math.max(0, Math.log(1 / Math.sqrt(1 - z * z) / eps) / (z * w0));
  const dt = Math.max(Math.min(1e-3, (2 * Math.PI) / wd / 400), tEnv / 5e6);
  for (let t = tEnv; t > 0; t -= dt) if (err(t) > eps) return bisect(t, Math.min(tEnv, t + dt));
  return 0;
}

// Peak overshoot as a fraction of travel (0.186 = 18.6%). 0 when ζ ≥ 1.
export function overshoot(spring = 'default') {
  const s = resolveSpring(spring);
  const m = s.m ?? 1;
  if (!(s.k > 0)) return 0;
  const z = Math.max(0, s.d) / (2 * Math.sqrt(s.k * m));
  if (z >= 1 - CRIT_BAND) return 0;
  if (z === 0) return 1;
  return Math.exp((-z * Math.PI) / Math.sqrt(1 - z * z));
}

// Only for non-physical ramps (a colour cross-fade, a progress bar). Prefer springs for anything that moves.
export const easeOutCubic = (p) => 1 - (1 - clamp(p)) ** 3;
export function easeInOutCubic(p) {
  const x = clamp(p);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Timing curves. Springs are for things with mass (they settle when physics says so); a named curve is for moves whose
// landing frame is part of the choreography: kinetic type and logo entrances, camera dollies, exits, beat-locked moves.
// Entrances ease out, exits ease in (and run 40–50% shorter than the entrance), moves across the frame ease in-out.

// CSS cubic-bezier(x1, y1, x2, y2) as a function of progress p in [0, 1]: x(s) = p is solved exactly (Newton, with a
// bisection fallback where the slope is flat), so the curve matches a browser's to ~1e-7. p ≤ 0 → 0 and p ≥ 1 → 1;
// in between y may leave [0, 1] (overshooting curves such as outBack).
export function cubicBezier(x1, y1, x2, y2) {
  for (const v of [x1, y1, x2, y2]) if (!Number.isFinite(v)) throw new Error(`cubicBezier: control points must be finite numbers (got ${[x1, y1, x2, y2].join(', ')})`);
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) throw new Error(`cubicBezier: x1 and x2 must be within 0..1, or time would run backwards (got ${x1}, ${x2})`);
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s;
  const dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  const Y = (s) => ((ay * s + by) * s + cy) * s;
  return function bezier(p) {
    if (!(p > 0)) return 0; // also NaN
    if (p >= 1) return 1;
    let s = p;
    for (let i = 0; i < 8; i++) {
      const err = X(s) - p;
      if (Math.abs(err) < 1e-9) return Y(s);
      const slope = dX(s);
      if (Math.abs(slope) < 1e-7) break;
      s -= err / slope;
      if (s < 0 || s > 1) break;
    }
    let lo = 0;
    let hi = 1;
    s = p;
    for (let i = 0; i < 64 && hi - lo > 1e-12; i++) {
      s = (lo + hi) / 2;
      if (X(s) < p) lo = s;
      else hi = s;
    }
    return Y((lo + hi) / 2);
  };
}

// Named curves (easings.net control points). Use the name in briefs and code so a reviewer can read the intent.
export const EASES = Object.freeze({
  linear: (p) => clamp(p),
  outCubic: cubicBezier(0.33, 1, 0.68, 1),
  outQuint: cubicBezier(0.22, 1, 0.36, 1), // premium entrances
  outExpo: cubicBezier(0.16, 1, 0.3, 1), // text and logo entrances
  outBack: cubicBezier(0.34, 1.56, 0.64, 1), // a pop with ~10% overshoot (UI badges; never body text)
  inOutCubic: cubicBezier(0.65, 0, 0.35, 1),
  inOutQuart: cubicBezier(0.76, 0, 0.24, 1), // camera moves, repositioning
  inQuint: cubicBezier(0.64, 0, 0.78, 0),
  inExpo: cubicBezier(0.7, 0, 0.84, 0), // fast exits
});

const easeCache = new Map();
// e: a name from EASES | a function p => y | [x1, y1, x2, y2] (cached per control-point set).
export function resolveEase(e = 'outQuint') {
  if (typeof e === 'function') return e;
  if (typeof e === 'string') {
    const f = EASES[e];
    if (!f) throw new Error(`unknown ease "${e}" — use ${Object.keys(EASES).join(', ')}, a function or [x1, y1, x2, y2]`);
    return f;
  }
  if (Array.isArray(e) && e.length === 4) {
    const key = e.join(',');
    let f = easeCache.get(key);
    if (!f) easeCache.set(key, (f = cubicBezier(...e)));
    return f;
  }
  throw new Error(`invalid ease ${JSON.stringify(e)} — use a name (${Object.keys(EASES).join(', ')}), a function or [x1, y1, x2, y2]`);
}

// from → to over [t0, t0 + dur] on a timing curve; holds `from` before t0 and `to` after. dur ≤ 0 is a cut at t0.
export function tween(t, t0, dur, from = 0, to = 1, ease = 'outQuint') {
  const p = dur > 0 ? (t - t0) / dur : t >= t0 ? 1 : 0;
  return lerp(from, to, resolveEase(ease)(clamp(p)));
}

// ---------------------------------------------------------------------------------------------------------------
// Animation principles as numbers (references in skills/springs/references/numbers.md).

// Squash and stretch: scale along the motion axis by `s` (> 1 stretch, < 1 squash) and compensate across it so the
// form keeps its mass: 'area' (2D shapes, 1/s), 'volume' (3D bodies seen from one side, 1/√s) or 'none'.
// Returns { along, across }; a jump that takes off at 1.28 along gets ~0.78 (area) across.
export function squash(s, { preserve = 'area' } = {}) {
  if (!(s > 0) || !Number.isFinite(s)) throw new Error(`squash: s must be a finite number > 0 (got ${s})`);
  if (preserve === 'area') return { along: s, across: 1 / s };
  if (preserve === 'volume') return { along: s, across: 1 / Math.sqrt(s) };
  if (preserve === 'none') return { along: s, across: 1 };
  throw new Error(`squash: preserve must be 'area', 'volume' or 'none' (got ${JSON.stringify(preserve)})`);
}

// Anticipation: a value that dips the opposite way for `lead` seconds before `at`, then springs to 1 (0 → −depth → 1).
// Continuous in value and velocity: both legs are springs summed by track(). The guide's mascot crouches 11 frames
// (0.18 s at 60 fps) before a jump; a lid presses ~6% shut before it opens.
export function windup(t, at, { lead = 0.18, depth = 0.1, spring = 'playful' } = {}) {
  if (!(lead > 0)) return track(t, [[0, 0], [at, 1, spring]]);
  return track(t, [[0, 0], [at - lead, -depth, { duration: lead, bounce: 0 }], [at, 1, spring]]);
}

// A sine with a whole number of cycles per loop of `dur` seconds: value and velocity match at the seam by construction.
// phase is in cycles (0.25 = a quarter turn). A non-integer cycle count is refused: it is the classic loop-seam jump.
export function loopWave(t, dur, cycles = 1, phase = 0) {
  if (!(dur > 0)) throw new Error(`loopWave: dur must be > 0 (got ${dur})`);
  if (!Number.isInteger(cycles)) throw new Error(`loopWave: cycles must be a whole number so the loop closes (got ${cycles})`);
  return Math.sin(2 * Math.PI * ((cycles * loopT(t, dur)) / dur + phase));
}

// Minimum on-screen hold for a line of text: 0.3 s per word + 0.5 s (a two-word title holds ≥ 1.1 s).
export const holdTime = (words, { perWord = 0.3, base = 0.5 } = {}) => base + perWord * Math.max(0, Number(words) || 0);

// Frames per beat (60 fps at 120 BPM = 30). Not always whole (30 fps at 128 BPM = 14.0625): never step beats by a
// rounded count, round each beat's own absolute time (Math.round(grid.beat(n) * fps)) so the error cannot accumulate.
export const framesPerBeat = (fps, bpm) => (fps * 60) / bpm;
