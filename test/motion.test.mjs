// Tests for skills/studio-init/template/lib/motion.js — closed-form springs checked against RK4 and the numbers
// read off the course's step-08 figure (research: playful peaks at 1.186 near 0.240 s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../skills/studio-init/template/lib/motion.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);

// RK4 of m·x'' + d·x' + k·(x − target(t)) = 0 from rest at 0; target(t) is piecewise constant.
function rk4(k, d, m, target, T, dt = 1e-4) {
  let x = 0;
  let v = 0;
  const out = [];
  const f = (t, x, v) => [v, (k * (target(t) - x) - d * v) / m];
  const steps = Math.round(T / dt);
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    out.push([t, x, v]);
    const [a1, b1] = f(t, x, v);
    const [a2, b2] = f(t + dt / 2, x + (a1 * dt) / 2, v + (b1 * dt) / 2);
    const [a3, b3] = f(t + dt / 2, x + (a2 * dt) / 2, v + (b2 * dt) / 2);
    const [a4, b4] = f(t + dt, x + a3 * dt, v + b3 * dt);
    x += (dt / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
    v += (dt / 6) * (b1 + 2 * b2 + 2 * b3 + b4);
  }
  return out;
}

function peak(k, d) {
  let best = 0;
  let at = 0;
  for (let t = 0; t <= 2; t += 1e-4) {
    const x = M.spring(t, k, d);
    if (x > best) [best, at] = [x, t];
  }
  return [best, at];
}

test('helpers: clamp, lerp, invLerp, remap, smoothstep', () => {
  assert.equal(M.clamp(-1), 0);
  assert.equal(M.clamp(2), 1);
  assert.equal(M.clamp(5, 0, 10), 5);
  assert.equal(M.lerp(10, 20, 0.25), 12.5);
  assert.equal(M.invLerp(10, 20, 15), 0.5);
  assert.equal(M.invLerp(3, 3, 2), 0); // zero-width range is a step, never NaN
  assert.equal(M.invLerp(3, 3, 3), 1);
  assert.equal(M.remap(5, 0, 10, 100, 200), 150);
  assert.equal(M.remap(20, 0, 10, 100, 200), 200);
  assert.equal(M.remap(20, 0, 10, 100, 200, false), 300);
  assert.equal(M.smoothstep(0, 1, 0.5), 0.5);
  assert.equal(M.smoothstep(0, 1, -1), 0);
  assert.equal(M.easeOutCubic(1), 1);
  assert.equal(M.easeInOutCubic(0.5), 0.5);
});

test('spring presets match the step-08 figure (fig 09)', () => {
  assert.deepEqual(M.SPRINGS, { snappy: { k: 320, d: 30 }, default: { k: 170, d: 26 }, heavy: { k: 90, d: 20 }, playful: { k: 220, d: 14 } });
  assert.ok(Object.isFrozen(M.SPRINGS));
  const [pp, pt] = peak(220, 14);
  close(pp, 1.186, 0.0005, 'playful peak');
  close(pt, 0.24, 0.005, 'playful peak time');
  const [sp] = peak(320, 30);
  assert.ok(sp > 1 && sp < 1.01, `snappy peak ${sp}`);
  assert.ok(peak(170, 26)[0] <= 1.0005, 'default never overshoots visibly');
  assert.ok(peak(90, 20)[0] <= 1.0005, 'heavy never overshoots');
  close(M.overshoot('playful'), 0.18606, 1e-4);
  close(M.overshoot('snappy'), 0.00795, 1e-4);
  assert.equal(M.overshoot('heavy'), 0);
  assert.ok(M.overshoot('default') < 1e-9);
});

test('springPV: t <= 0 is at rest; NaN is safe; degenerate k jumps', () => {
  assert.deepEqual(M.springPV(0), [0, 0]);
  assert.deepEqual(M.springPV(-3), [0, 0]);
  assert.deepEqual(M.springPV(NaN), [0, 0]);
  assert.deepEqual(M.springPV(0.1, 0, 10), [1, 0]);
  close(M.spring(50), 1, 1e-12);
  close(M.springVel(50), 0, 1e-12);
});

test('closed forms match RK4 (under-, critically and over-damped, incl. velocity)', () => {
  const cases = [
    [220, 14, 1], // playful ζ 0.47
    [320, 30, 1], // snappy ζ 0.84
    [170, 26, 1], // default ζ 0.997
    [100, 20, 1], // critical ζ = 1
    [90, 20, 1], // heavy ζ 1.05 (the article's "treat as critical" shortcut is wrong here)
    [170, 60, 1], // ζ 2.3: the shortcut is 34% off; the real branch must match
    [50, 200, 1], // ζ 14: cancellation-prone branch
    [120, 30, 2], // mass ≠ 1
  ];
  for (const [k, d, m] of cases) {
    let maxX = 0;
    let maxV = 0;
    for (const [t, x, v] of rk4(k, d, m, () => 1, 2)) {
      if (t === 0) continue;
      const [cx, cv] = M.springPV(t, k, d, m);
      maxX = Math.max(maxX, Math.abs(cx - x));
      maxV = Math.max(maxV, Math.abs(cv - v));
    }
    assert.ok(maxX < 1e-9, `k${k} d${d} m${m}: position error ${maxX}`);
    assert.ok(maxV < 1e-7, `k${k} d${d} m${m}: velocity error ${maxV}`);
  }
  // Overdamped really is slower than the critical approximation the article used.
  const w0 = Math.sqrt(170);
  const critApprox = 1 - Math.exp(-w0 * 0.2) * (1 + w0 * 0.2);
  assert.ok(M.spring(0.2, 170, 60) < critApprox - 0.2, 'true overdamped response lags the critical shortcut');
});

test('critical band is continuous on both sides of ζ = 1', () => {
  const k = 100;
  const dCrit = 20;
  for (const t of [0.05, 0.2, 0.5, 1]) {
    const a = M.spring(t, k, dCrit * (1 - 2e-6));
    const b = M.spring(t, k, dCrit);
    const c = M.spring(t, k, dCrit * (1 + 2e-6));
    close(a, b, 1e-5, `below band t=${t}`);
    close(c, b, 1e-5, `above band t=${t}`);
  }
});

test('resolveSpring: presets, {k,d}, {k} critical, {duration,bounce}, errors', () => {
  assert.equal(M.resolveSpring(), M.SPRINGS.default);
  assert.equal(M.resolveSpring(null), M.SPRINGS.default);
  assert.equal(M.resolveSpring('heavy'), M.SPRINGS.heavy);
  assert.deepEqual(M.resolveSpring({ k: 200, d: 10 }), { k: 200, d: 10 });
  const crit = M.resolveSpring({ k: 100 });
  close(crit.d, 20, 1e-12);
  assert.deepEqual(M.resolveSpring({ k: 100, d: 5, m: 2 }), { k: 100, d: 5, m: 2 });
  const feel = M.resolveSpring({ duration: 0.5, bounce: 0.2 });
  close(feel.k, (2 * Math.PI / 0.5) ** 2, 1e-9);
  assert.throws(() => M.resolveSpring('wobbly'), /unknown spring preset "wobbly"/);
  assert.throws(() => M.resolveSpring(42), /invalid spring/);
  close(M.sp(0.3, 'snappy'), M.spring(0.3, 320, 30), 1e-15);
  close(M.sp(0.3, { k: 220, d: 14 }), M.spring(0.3, 220, 14), 1e-15);
});

test('springFromFeel / feelFromSpring round trip (Apple convention)', () => {
  for (const duration of [0.2, 0.35, 0.5, 1, 2]) {
    for (const bounce of [-0.9, -0.5, -0.1, 0, 0.1, 0.3, 0.6, 0.9]) {
      const s = M.springFromFeel({ duration, bounce });
      const f = M.feelFromSpring(s);
      close(f.duration, duration, 1e-12, 'duration');
      close(f.bounce, bounce, 1e-12, 'bounce');
    }
  }
  const f0 = M.springFromFeel();
  close(f0.k, (2 * Math.PI / 0.5) ** 2, 1e-9);
  close(f0.d, 2 * Math.sqrt(f0.k), 1e-9, 'bounce 0 is critically damped');
  // Research values (tech-check §8): 170/26 -> D 0.482 s, b 0.003; 220/22 -> 0.424 s, 0.258; 320/30 -> 0.351, 0.161; 140/22 -> 0.531, 0.070
  for (const [k, d, D, b] of [[170, 26, 0.482, 0.003], [220, 22, 0.424, 0.258], [320, 30, 0.351, 0.161], [140, 22, 0.531, 0.07]]) {
    const f = M.feelFromSpring({ k, d });
    close(f.duration, D, 0.0006, `D for ${k}/${d}`);
    close(f.bounce, b, 0.0006, `b for ${k}/${d}`);
  }
  assert.throws(() => M.springFromFeel({ duration: 0 }), /duration must be > 0/);
});

test('settleTime matches the research table (1% band) and is memoized', () => {
  close(M.settleTime('default'), 0.505, 0.002);
  close(M.settleTime('snappy'), 0.241, 0.002);
  close(M.settleTime({ k: 140, d: 22 }), 0.47, 0.002);
  close(M.settleTime({ k: 170, d: 60 }), 1.562, 0.002);
  close(M.settleTime({ k: 100, d: 20 }), 0.663, 0.002);
  close(M.settleTime({ k: 260, d: 20 }), 0.392, 0.002);
  const s = M.settleTime('playful');
  for (let t = s + 1e-4; t < s + 3; t += 1e-3) assert.ok(Math.abs(1 - M.sp(t, 'playful')) <= 0.01 + 1e-9, `excursion after settle at ${t}`);
  assert.ok(Math.abs(1 - M.sp(s - 0.002, 'playful')) > 0.0099, 'still outside the band just before');
  assert.equal(M.settleTime({ k: 100, d: 0 }), Infinity);
  assert.equal(M.settleTime('default'), M.settleTime('default'));
});

test('track: superposition equals an RK4 spring retargeted at every key', () => {
  const keys = [[0, 0], [0.2, 100], [0.45, 40], [0.9, 180], [1.3, -20]];
  const target = (t) => {
    let v = keys[0][1];
    for (const [ti, vi] of keys.slice(1)) if (t >= ti) v = vi;
    return v;
  };
  let err = 0;
  for (const [t, x] of rk4(170, 26, 1, target, 3)) err = Math.max(err, Math.abs(M.track(t, keys) - x));
  assert.ok(err < 0.02, `max error ${err} px (RK4 step error only)`);
  // settles to the last value, starts at the first, keys[0] time ignored
  close(M.track(10, keys), -20, 1e-6);
  assert.equal(M.track(-5, keys), 0);
  assert.equal(M.track(0.2, keys), 0);
  assert.equal(M.track(1, []), 0);
  // velocity is continuous through a retarget (no restart kink); only acceleration steps (by k·Δ), so the gap
  // shrinks with the probe width: ~1e-5 at ±1e-9 s, versus the full target jump a restarted spring would show
  const dv = Math.abs(M.trackVel(0.45 + 1e-9, keys) - M.trackVel(0.45 - 1e-9, keys));
  assert.ok(dv < 1e-4, `velocity jump ${dv}`);
  // numeric derivative agrees with trackVel
  const h = 1e-6;
  close((M.track(0.6 + h, keys) - M.track(0.6 - h, keys)) / (2 * h), M.trackVel(0.6, keys), 1e-3);
  // per-key spring override (3rd element) and preset argument
  const k2 = [[0, 0], [1, 10, 'snappy']];
  close(M.track(1.2, k2, 'heavy'), 10 * M.sp(0.2, 'snappy'), 1e-12);
  close(M.track(1.2, [[0, 0], [1, 10]], 'heavy'), 10 * M.sp(0.2, 'heavy'), 1e-12);
});

test('loopTrack: seamless across the seam (value and velocity), periodic, validated', () => {
  const dur = 6;
  const keys = [[0, 0], [1, 100], [3, 40], [5, 0]];
  const f = (t) => M.loopTrack(t, keys, dur);
  close(f(dur - 1e-7), f(0), 1e-4, 'value at the seam');
  const vl = (f(dur - 1e-6) - f(dur - 2e-6)) / 1e-6;
  const vr = (f(1e-6) - f(0)) / 1e-6;
  close(vl, vr, 1e-2, 'velocity at the seam');
  for (const t of [0.3, 1.7, 4.2, 5.9]) {
    close(f(t + dur), f(t), 1e-9, `periodic at ${t}`);
    close(f(t - 2 * dur), f(t), 1e-9, `periodic backwards at ${t}`);
  }
  // an unsettled last change: loopTrack stays continuous where a naive wrap would jump
  const late = [[0, 0], [2, 50], [5.8, 0]];
  const g = (t) => M.loopTrack(t, late, dur);
  const jumpLoop = Math.abs(g(dur - 1e-6) - g(0));
  const jumpNaive = Math.abs(M.track(dur - 1e-6, late) - M.track(0, late));
  assert.ok(jumpLoop < 1e-3, `loopTrack seam ${jumpLoop}`);
  assert.ok(jumpNaive > 5, `naive seam ${jumpNaive}`);
  assert.throws(() => M.loopTrack(1, [[0, 0], [1, 5]], dur), /last value \(5\) must equal the first \(0\)/);
  assert.throws(() => M.loopTrack(1, keys, 0), /dur must be > 0/);
  // explicit cycles parameter
  close(M.loopTrack(2, keys, dur, 'default', 6), f(2), 1e-9);
});

test('loopTrack: key times stay unwrapped, so a key exactly at dur is the seam change', () => {
  const dur = 6;
  const keys = [[0, 0], [2, 100], [4, 40], [6, 0]];
  const f = (t) => M.loopTrack(t, keys, dur);
  // Wrapping the key at 6 to 0 used to give -40 / 60 / 0 here.
  close(f(1), 0, 0.01, 't=1');
  close(f(3), 100, 0.01, 't=3');
  close(f(5), 40, 0.01, 't=5');
  // The 40 → 0 change starts at the seam: frame 0 still holds 40, then eases down with the plain spring.
  close(f(0), 40, 1e-6, 'value at t = 0');
  for (const t of [0.05, 0.2, 0.4]) close(f(t), 40 * (1 - M.sp(t)), 1e-6, `seam spring at ${t}`);
  // Same curve as writing the seam change as a key at 0 (the other seam form).
  const atZero = [[0, 40], [0, 0], [2, 100], [4, 40]];
  for (const t of [0, 0.3, 1.9, 2.2, 4.1, 5.5, 5.999]) close(f(t), M.loopTrack(t, atZero, dur), 1e-9, `seam forms agree at ${t}`);
  for (const t of [0.7, 3.3]) close(f(t + dur), f(t), 1e-9, `periodic at ${t}`);
  // A grid-derived time a hair past dur is accepted.
  assert.doesNotThrow(() => M.loopTrack(1, [[0, 0], [3, 5], [dur + 1e-12, 0]], dur));
});

test('loopTrack: seam continuity (value and velocity) with a key at dur while another spring still moves', () => {
  const dur = 6;
  const keys = [[0, 0], [2, 50], [5.8, 80], [6, 0]]; // the 50 → 80 spring is only 0.2 s old at the seam
  const f = (t) => M.loopTrack(t, keys, dur);
  const h = 1e-7;
  close(f(dur - h), f(0), 1e-4, 'value at the seam');
  const vl = (f(dur - h) - f(dur - 2 * h)) / h;
  const vr = (f(h) - f(0)) / h;
  assert.ok(Math.abs(vl) > 10, `the test needs a moving value at the seam (v = ${vl})`);
  close(vl, vr, 1e-2, 'velocity at the seam');
});

test('loopTrack equals track() inside the first cycle when every change settles before dur', () => {
  const dur = 6;
  const keys = [[0, 0], [1, 100], [3, 40], [4.5, 0]]; // 4.5 s + settle (0.89 s at 1e-4) < 6 s
  let err = 0;
  for (let t = 0; t < dur; t += 0.01) err = Math.max(err, Math.abs(M.loopTrack(t, keys, dur) - M.track(t, keys)));
  assert.ok(err < 1e-4, `max |loopTrack − track| = ${err}`);
  const snappy = [[0, 0], [0.5, 30, 'playful'], [2, 0]];
  err = 0;
  for (let t = 0; t < 3; t += 0.01) err = Math.max(err, Math.abs(M.loopTrack(t, snappy, 3, 'snappy') - M.track(t, snappy, 'snappy')));
  assert.ok(err < 1e-4, `per-key spring: max diff ${err}`);
});

test('loopTrack: key times must lie within one cycle', () => {
  const dur = 6;
  assert.throws(() => M.loopTrack(1, [[0, 0], [7, 5], [8, 0]], dur), /loopTrack: key 1 time 7 is outside 0\.\.6/);
  assert.throws(() => M.loopTrack(1, [[0, 0], [-1, 5], [3, 0]], dur), /key 1 time -1 is outside 0\.\.6/);
  assert.throws(() => M.loopTrack(1, [[0, 0], [NaN, 5], [3, 0]], dur), /key 1 time NaN is outside/);
  assert.throws(() => M.loopTrack(1, [[0, 0], [2, 5], [6.5, 0]], dur), /key 2 time 6\.5 is outside/);
  assert.throws(() => M.loopTrack(1, [[-2, 0], [2, 5], [3, 0]], dur), /key 0 time -2 is outside/);
});

test('indicator stretches between stops and settles to the width', () => {
  const stops = [[0, 0], [1, 300]];
  const settled = M.indicator(5, stops, { width: 120 });
  close(settled.left, 300, 1e-6);
  close(settled.right, 420, 1e-6);
  const mid = M.indicator(1.08, stops, { width: 120 });
  assert.ok(mid.right - mid.left > 120 + 20, `stretched ${mid.right - mid.left}`);
  assert.ok(mid.left <= mid.right);
  const at0 = M.indicator(0.5, stops);
  assert.deepEqual([at0.left, at0.right], [0, 120]);
});

test('swapAlpha: in after the morph starts, out before the next one', () => {
  assert.equal(M.swapAlpha(1.0, 1, 2), 0);
  close(M.swapAlpha(1.08, 1, 2), 0, 1e-12);
  close(M.swapAlpha(1.14, 1, 2), 0.5, 1e-9);
  assert.equal(M.swapAlpha(1.5, 1, 2), 1);
  close(M.swapAlpha(1.85, 1, 2), 0.5, 1e-9);
  close(M.swapAlpha(1.9, 1, 2), 0, 1e-12);
  assert.equal(M.swapAlpha(1.95, 1, 2), 0);
  assert.equal(M.swapAlpha(5, 1, null), 1);
  assert.equal(M.swapAlpha(-5, null, 2), 1);
  assert.equal(M.swapAlpha(1.2, 1, 2, { inDelay: 0, inDur: 0 }), 1);
});

test('loopT, stagger, stepTime', () => {
  assert.equal(M.loopT(13, 12), 1);
  assert.equal(M.loopT(-1, 12), 11);
  assert.equal(M.loopT(12, 12), 0);
  assert.equal(M.loopT(-1e-17, 12), 0);
  assert.equal(M.loopT(5, 0), 5);
  close(M.stagger(4), 0.12, 1e-12);
  assert.equal(M.stagger(3, 0.5), 1.5);
  assert.equal(M.stepTime(0.1), 1 / 12);
  assert.equal(M.stepTime(7 / 12), 7 / 12, 'exact multiples are not floored down by float error');
  assert.equal(M.stepTime(0.26, 4), 0.25);
});

test('pure functions: same input, same output, no hidden state', () => {
  const keys = [[0, 0], [0.3, 1], [0.8, 0.2]];
  const a = [0.1, 0.5, 0.9, 1.4].map((t) => M.track(t, keys));
  M.settleTime({ k: 333, d: 17 });
  M.loopTrack(0.4, [[0, 1], [0.5, 2], [1, 1]], 2);
  const b = [1.4, 0.9, 0.5, 0.1].map((t) => M.track(t, keys)).reverse();
  assert.deepEqual(a, b);
});
