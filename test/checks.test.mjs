// Tests for skills/studio-init/template/lib/checks.js (numeric motion checks over probe series) and the probe recording in
// lib/timeline.js renderFrame. Pure: no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChecks, evaluateChecks, seamAnalysis, seriesStats, spikes, diffs, median } from '../skills/studio-init/template/lib/checks.js';
import { buildFilm, renderFrame, filmContext, scene } from '../skills/studio-init/template/lib/timeline.js';
import { sp, track, loopTrack } from '../skills/studio-init/template/lib/motion.js';

const FPS = 60;
const series = (n, f) => Array.from({ length: n }, (_, k) => f(k / FPS, k));
const one = (checks, s, opts = {}) => evaluateChecks(normalizeChecks(checks), s, { fps: FPS, ...opts });

test('normalizeChecks: kinds are inferred, defaults filled, names generated', () => {
  const n = normalizeChecks([
    { probe: 'a', at: 1, eq: 2 },
    { probe: 'a', frame: 3, near: 1, tol: 0.5, name: 'mine' },
    { probe: 'b', from: 0, to: 1, max: 3 },
    { probe: 'c', crosses: 0.5, at: 2 },
    { probe: 'd', kind: 'smooth' },
    { probe: 'd', maxKink: 6, allow: [1.5] },
    { probe: 'e', at: 1, min: 0 },
  ]);
  assert.deepEqual(n.map((c) => c.kind), ['point', 'point', 'range', 'event', 'smooth', 'smooth', 'point']);
  assert.equal(n[0].tol, 1e-3);
  assert.equal(n[1].name, 'mine');
  assert.equal(n[1].eq, 1, 'near is eq');
  assert.equal(n[3].tolFrames, 0);
  assert.equal(n[3].dir, 'any');
  assert.equal(n[4].maxKink, 4);
  assert.deepEqual(n[5].allow, [1.5]);
  assert.match(n[0].name, /point a/);
  assert.deepEqual(normalizeChecks(undefined), []);
});

test('normalizeChecks: helpful errors', () => {
  const bad = (c, re) => assert.throws(() => normalizeChecks([c]), re);
  bad({ at: 1, eq: 1 }, /check #0: probe .* is required/);
  bad({ probe: 'a', at: 1, frame: 2, eq: 1 }, /not both/);
  bad({ probe: 'a', at: 1 }, /needs eq \(or near\) and\/or min \/ max/);
  bad({ probe: 'a', at: 1, eq: 1, near: 1 }, /same; give one/);
  bad({ probe: 'a', from: 0, to: 1 }, /range check needs min and\/or max/);
  bad({ probe: 'a', from: 2, to: 1, max: 1 }, /to \(1\) must be greater than from \(2\)/);
  bad({ probe: 'a', at: 1, eq: 1, foo: 2 }, /unknown key\(s\) foo for a point check/);
  bad({ probe: 'a', crosses: 1 }, /needs at \(seconds\) or frame/);
  bad({ probe: 'a', crosses: 1, at: 1, dir: 'left' }, /dir must be/);
  bad({ probe: 'a', frame: 1.5, eq: 1 }, /frame must be an integer/);
  bad({ probe: 'a' }, /cannot tell the kind/);
  bad({ probe: 'a', kind: 'blob' }, /unknown kind "blob"/);
  bad({ name: 'n', probe: 'a', kind: 'smooth', allow: ['x'] }, /check "n": allow must be an array/);
  bad({ probe: 'a', at: 1, min: 2, max: 1 }, /min \(2\) is greater than max \(1\)/);
  assert.throws(() => normalizeChecks({}), /checks must be an array/);
});

test('point: eq/tol and min/max at a time or a frame; a frame outside the range is skipped, an unrecorded one fails', () => {
  const s = { x: series(120, (t) => t * 10) }; // x = 10 t
  let r = one([{ probe: 'x', at: 1, eq: 10, tol: 1e-9 }], s);
  assert.equal(r[0].pass, true);
  assert.equal(r[0].frame, 60);
  r = one([{ probe: 'x', frame: 30, eq: 5.2, tol: 0.1 }], s);
  assert.equal(r[0].pass, false);
  assert.match(r[0].detail, /frame 30 \(0\.5 s\): 5 ≠ 5\.2 ±0\.1/);
  assert.equal(one([{ probe: 'x', at: 1.5, min: 14, max: 16 }], s)[0].pass, true);
  assert.equal(one([{ probe: 'x', at: 1.5, max: 14 }], s)[0].pass, false);
  assert.equal(one([{ probe: 'x', at: 5, eq: 1 }], s)[0].pass, null, 'frame 300 is past the series');
  const holes = { x: [1, NaN, 3] };
  assert.match(one([{ probe: 'x', frame: 1, eq: 2 }], holes)[0].detail, /not recorded/);
  // series of a range: index 0 = frame k0
  assert.equal(one([{ probe: 'x', frame: 61, eq: 1 }], { x: [0, 1, 2] }, { k0: 60 })[0].pass, true);
  assert.equal(one([{ probe: 'x', frame: 10, eq: 1 }], { x: [0, 1, 2] }, { k0: 60 })[0].pass, null);
  // check frames refer to the film fps when sampling at another rate
  assert.equal(evaluateChecks(normalizeChecks([{ probe: 'x', frame: 60, eq: 1 }]), { x: series(60, (t, k) => (k === 30 ? 1 : 0)) }, { fps: 30, filmFps: 60 })[0].pass, true);
});

test('point: a probe that was never recorded fails and lists what was', () => {
  const r = one([{ probe: 'nope', at: 0, eq: 0 }], { a: [0], b: [1] });
  assert.equal(r[0].pass, false);
  assert.match(r[0].detail, /never recorded \(recorded: a, b\)/);
  assert.match(one([{ probe: 'nope', at: 0, eq: 0 }], {})[0].detail, /no probes at all/);
});

test('range: every recorded frame in [from, to) inside the bounds; the worst frame is reported', () => {
  const s = { y: series(120, (t) => Math.sin(t * Math.PI)) }; // peak 1 at t = 0.5
  assert.equal(one([{ probe: 'y', from: 0, to: 2, min: -1, max: 1 }], s)[0].pass, true);
  const r = one([{ probe: 'y', from: 0, to: 1, max: 0.9 }], s)[0];
  assert.equal(r.pass, false);
  assert.equal(r.frame, 30, 'the peak frame is the worst');
  // to is exclusive: frame 60 (t = 1) is outside [0.5, 1)
  const step = { z: series(120, (t, k) => (k >= 60 ? 5 : 0)) };
  assert.equal(one([{ probe: 'z', from: 0.5, to: 1, max: 0 }], step)[0].pass, true);
  assert.equal(one([{ probe: 'z', from: 0.5, to: 1.0001, max: 0 }], step)[0].pass, false);
  assert.equal(one([{ probe: 'z', from: 3, to: 4, max: 0 }], step)[0].pass, null);
});

test('event: the first crossing frame vs the expected frame, direction and tolerance; never crossing fails', () => {
  const s = { f: series(120, (t, k) => (k >= 45 ? 0 : 1)), r: series(120, (t) => t) }; // foot lands on frame 45; r crosses 0.5 at frame 30
  assert.equal(one([{ probe: 'f', crosses: 0.5, dir: 'down', frame: 45 }], s)[0].pass, true);
  const late = one([{ probe: 'f', crosses: 0.5, frame: 44 }], s)[0];
  assert.equal(late.pass, false);
  assert.match(late.detail, /at frame 45 .* 1 frame\(s\) late/);
  assert.equal(one([{ probe: 'f', crosses: 0.5, frame: 44, tolFrames: 1 }], s)[0].pass, true);
  assert.match(one([{ probe: 'f', crosses: 0.5, dir: 'up', frame: 45 }], s)[0].detail, /never crosses 0\.5 going up/);
  // crossing is prev < v <= cur: r = k / 60 reaches 0.5 exactly on frame 30
  const r = one([{ probe: 'r', crosses: 0.5, at: 0.5 }], s)[0];
  assert.equal(r.pass, true);
  assert.equal(r.frame, 30);
  // from: search after an earlier crossing
  const bounce = { b: series(120, (t, k) => (k < 20 ? 0 : k < 40 ? 1 : k < 80 ? 0 : 1)) };
  assert.equal(one([{ probe: 'b', crosses: 0.5, dir: 'up', at: 80 / 60, from: 1 }], bounce)[0].pass, true);
  assert.equal(one([{ probe: 'b', crosses: 0.5, dir: 'up', at: 80 / 60 }], bounce)[0].pass, false, 'without from the first crossing (frame 20) counts');
});

test('smooth: a spring release and a retarget are legal; a linear start/stop is a kink, a teleport is a jump; shot boundaries and allow skip', () => {
  const spring = series(120, (t) => sp(t - 0.3, 'snappy'));
  const retarget = series(120, (t) => track(t, [[0, 0], [0.2, 1], [0.6, 0.3]]));
  const linear = series(120, (t) => Math.min(1, Math.max(0, (t - 0.5) / 0.5)));
  const teleport = series(120, (t, k) => sp(t - 0.2, 'default') + (k >= 70 ? 2 : 0));
  const s = { spring, retarget, linear, teleport };
  assert.equal(one([{ probe: 'spring', kind: 'smooth' }], s)[0].pass, true);
  assert.equal(one([{ probe: 'retarget', kind: 'smooth' }], s)[0].pass, true);
  const lin = one([{ probe: 'linear', kind: 'smooth' }], s)[0];
  assert.equal(lin.pass, false);
  assert.deepEqual(lin.frames, [31, 61], 'the start and the stop of the linear ramp');
  const tp = one([{ probe: 'teleport', kind: 'smooth' }], s)[0];
  assert.equal(tp.pass, false);
  assert.match(tp.detail, /frame 70 .*value jumps 2/);
  assert.equal(one([{ probe: 'teleport', kind: 'smooth', allow: [70 / 60] }], s)[0].pass, true, 'allow names an intended cut');
  assert.equal(one([{ probe: 'teleport', kind: 'smooth' }], s, { shots: [{ from: 0, to: 70 / 60 }, { from: 70 / 60, to: 2 }] })[0].pass, true, 'a shot boundary may cut');
  assert.equal(one([{ probe: 'linear', kind: 'smooth', from: 0.6, to: 0.9 }], s)[0].pass, true, 'inside the ramp the velocity is constant');
  assert.equal(one([{ probe: 'linear', kind: 'smooth', from: 0, to: 0.02 }], s)[0].pass, null, 'too few frames');
});

test('seamAnalysis: a periodic loopTrack is smooth across frame N−1 → 0; a value that does not return or arrives moving fails', () => {
  const dur = 2;
  const N = dur * FPS;
  const keys = [[0, 0], [0.5, 1], [1.2, 0.4], [dur, 0]];
  const loop = series(N, (t) => loopTrack(t, keys, dur));
  const sine = series(N, (t) => Math.sin((2 * Math.PI * t) / dur));
  const open = series(N, (t) => t / dur); // ramps 0 → ~1 and snaps back
  const brake = series(N, (t) => Math.sin((Math.PI * t) / dur) ** 2); // closes at rest at both ends
  const kink = series(N, (t) => Math.abs(Math.sin((Math.PI * t) / dur))); // |sin|: closes in value, velocity flips at the seam
  const res = Object.fromEntries(seamAnalysis({ loop, sine, open, brake, kink }, { fps: FPS }).map((r) => [r.probe, r]));
  assert.equal(res.loop.pass, true, res.loop.detail);
  assert.equal(res.sine.pass, true, res.sine.detail);
  assert.equal(res.brake.pass, true, res.brake.detail);
  assert.equal(res.open.pass, false);
  assert.match(res.open.detail, /does not return to its frame-0 value/);
  assert.equal(res.kink.pass, false);
  assert.match(res.kink.detail, /velocity changes/);
  assert.deepEqual(seamAnalysis({ flat: series(N, () => 3), holes: [NaN, 1, 2, 3, NaN] }, { fps: FPS }).map((r) => [r.probe, r.pass]), [['flat', true]], 'constant passes, unrecorded ends are skipped');
});

test('series helpers', () => {
  assert.deepEqual(diffs([1, 3, NaN, 4]).map((x) => (Number.isNaN(x) ? 'n' : x)), ['n', 2, 'n', 'n']);
  assert.equal(median([3, 1, NaN, 2]), 2);
  assert.ok(Number.isNaN(median([])));
  const st = seriesStats([0, 1, null, 3], 10);
  assert.deepEqual([st.min, st.max, st.recorded, st.peakSpeed], [0, 3, 3, 10]);
  assert.deepEqual(spikes([0, 0, 5, 0, 0], 4).map((x) => x.i), [2]);
  assert.deepEqual(spikes([1, 1.2, 1.1, 1], 4), [], 'no spike in a steady series');
  assert.deepEqual(spikes([0, 0.01, 0, 10, 10], 4).map((x) => x.i), [], 'under 10% of the peak, or as large as a neighbour');
});

test('renderFrame: c.probe records numbers, booleans and vectors into frameCtx.probes (Map or object); a no-op without a sink', () => {
  const film = { scenes: [scene(0, 2, 'a', (g, lt, c) => { c.probe('x', lt * 2); c.probe('on', lt > 1); c.probe('pos', [1, 2, 3]); }), scene(1, 2, 'b', (g, lt, c) => { c.probe('x', -1); })] };
  const ctx = filmContext({ duration: 2, fps: 60 }, '1x1');
  const built = buildFilm(film, ctx);
  const g = new Proxy({}, { get: () => () => {}, set: () => true });
  const m = new Map();
  renderFrame(built, g, 0.5, { W: 10, H: 10, probes: m });
  assert.deepEqual(Object.fromEntries(m), { x: 1, on: 0, 'pos.x': 1, 'pos.y': 2, 'pos.z': 3 });
  const o = {};
  renderFrame(built, g, 1.5, { W: 10, H: 10, probes: o });
  assert.deepEqual(o, { x: -1, on: 1, 'pos.x': 1, 'pos.y': 2, 'pos.z': 3 }, 'names are global: the later scene wins');
  assert.doesNotThrow(() => renderFrame(built, g, 0.5, { W: 10, H: 10 }), 'no sink: no-op');
  const bad = buildFilm({ scenes: [scene(0, 1, (gg, lt, c) => c.probe('nan', NaN))] }, ctx);
  assert.throws(() => renderFrame(bad, g, 0.5, { W: 10, H: 10, probes: new Map() }), /probe\("nan"\): value must be a finite number/);
  assert.doesNotThrow(() => renderFrame(bad, g, 0.5, { W: 10, H: 10 }), 'without a sink a bad value costs nothing');
  const bad2 = buildFilm({ scenes: [scene(0, 1, (gg, lt, c) => c.probe('v', [1, 2, 3, 4, 5]))] }, ctx);
  assert.throws(() => renderFrame(bad2, g, 0.5, { W: 10, H: 10, probes: new Map() }), /\[x, y, z\?, w\?\]/);
});

test('buildFilm: checks from an array or (grid, ctx) => array are normalized; a bad check fails the build', () => {
  const ctx = filmContext({ duration: 4, fps: 60, bpm: 120 }, '1x1');
  const scenes = [scene(0, 4, () => {})];
  assert.deepEqual(buildFilm({ scenes }, ctx).checks, []);
  const b = buildFilm({ scenes, checks: (grid) => [{ probe: 'p', crosses: 1, at: grid.beat(2) }] }, ctx);
  assert.equal(b.checks[0].kind, 'event');
  assert.equal(b.checks[0].at, 1);
  assert.throws(() => buildFilm({ scenes, checks: [{ probe: 'p' }] }, ctx), /check #0: cannot tell the kind/);
});

test('a range run skips checks outside it, even when their probe was not recorded there', () => {
  const s = { a: [1, 2, 3] }; // frames 60..62
  const r = evaluateChecks(normalizeChecks([
    { probe: 'other', at: 0.2, eq: 1 },
    { probe: 'other', from: 3, to: 4, max: 1 },
    { probe: 'other', crosses: 1, frame: 10 },
    { probe: 'other', kind: 'smooth', to: 0.5 },
    { probe: 'other', at: 1.01, eq: 1 },
  ]), s, { fps: 60, k0: 60, frames: 3 });
  assert.deepEqual(r.map((x) => x.pass), [null, null, null, null, false], 'only the check inside the range fails as never recorded');
});
