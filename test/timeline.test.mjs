// Tests for skills/studio-init/template/lib/timeline.js — beat grid, scenes, chapters, cues, renderFrame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beatGrid, defineFilm, scene, chapter, placeholder, buildFilm, renderFrame, normalizeCues, filmContext, SFX_TYPES } from '../skills/studio-init/template/lib/timeline.js';

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const closeAll = (xs, ys, eps = 1e-9) => {
  assert.equal(xs.length, ys.length, `length ${xs.length} vs ${ys.length}`);
  xs.forEach((x, i) => close(x, ys[i], eps, `[${i}]`));
};

// Recording 2D context: any method call is logged; property writes are kept and logged.
function mockCtx() {
  const state = { calls: [], depth: 0, maxDepth: 0 };
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => {
        t.calls.push([k, ...args]);
        if (k === 'save') t.maxDepth = Math.max(t.maxDepth, ++t.depth);
        if (k === 'restore') t.depth--;
      };
    },
    set(t, k, v) {
      t[k] = v;
      t.calls.push(['set', k, v]);
      return true;
    },
  });
}

test('beatGrid: uniform grid', () => {
  const g = beatGrid({ bpm: 120, offset: 0.25, duration: 12 });
  assert.equal(g.bpm, 120);
  assert.equal(g.spb, 0.5);
  assert.equal(g.measured, false);
  assert.equal(g.offset, 0.25);
  close(g.beat(3), 1.75);
  close(g.beat(2.5), 1.5);
  close(g.beat(-1), -0.25);
  close(g.bar(2), 4.25);
  close(g.position(1.5), 2.5);
  assert.equal(g.index(1.74), 2);
  assert.equal(g.index(1.75), 3);
  assert.equal(g.index(0), -1);
  close(g.nearest(1.6), 1.75);
  close(g.nearest(1.4), 1.25);
  closeAll(g.beatsIn(0, 2), [0.25, 0.75, 1.25, 1.75]);
  closeAll(g.beatsIn(0.75, 1.75), [0.75, 1.25], 1e-12);
  closeAll(g.barsIn(0, 10), [0.25, 2.25, 4.25, 6.25, 8.25]);
  assert.deepEqual(g.beatsIn(3, 3), []);
  assert.ok(g.isOnBeat(1.76));
  assert.ok(!g.isOnBeat(1.8));
  assert.ok(g.isOnBeat(1.8, 0.06));
  assert.equal(g.count, 24);
  const j = g.toJSON();
  assert.equal(j.source, 'bpm');
  assert.equal(j.beats.length, 24);
  assert.equal(j.downbeats.length, 6);
  assert.equal(j.beatsPerBar, 4);
  assert.equal(j.duration, 12);
  assert.deepEqual(JSON.parse(JSON.stringify(g)), j, 'JSON.stringify uses toJSON');
});

test('beatGrid: defaults (120 BPM, 4/4) and the 12 s demo grid', () => {
  const g = beatGrid({ duration: 12 });
  assert.equal(g.bpm, 120);
  assert.equal(g.beatsPerBar, 4);
  assert.equal(g.count, 24);
  closeAll(g.barsIn(0, 12), [0, 2, 4, 6, 8, 10]);
  assert.equal(beatGrid().count, null, 'no duration, no measured beats: count unknown');
  assert.equal(beatGrid({ bpm: 90, beatsPerBar: 3 }).bar(1), 2);
});

test('beatGrid: empty, zero and invalid inputs fall back to 120 BPM', () => {
  for (const opts of [{ bpm: 0 }, { bpm: -5 }, { bpm: NaN }, { bpm: 0, beats: [] }, { bpm: null, beats: null }, { bpm: 0, beats: [NaN, 'x'] }]) {
    const g = beatGrid(opts);
    assert.equal(g.bpm, 120, JSON.stringify(opts));
    assert.equal(g.measured, false);
    close(g.beat(4), 2);
  }
  assert.equal(beatGrid({ beatsPerBar: 0 }).beatsPerBar, 4);
  assert.equal(beatGrid({ beatsPerBar: 2.5 }).beatsPerBar, 4);
  assert.equal(beatGrid({ offset: NaN }).offset, 0);
});

test('beatGrid: measured beats interpolate and extrapolate with the edge intervals', () => {
  const g = beatGrid({ bpm: 0, beats: [1.2, 0.1, 0.6, 1.7, 0.6] }); // unsorted + duplicate on purpose
  assert.equal(g.measured, true);
  close(g.bpm, 120, 1e-9, 'bpm from the median interval');
  close(g.offset, 0.1);
  close(g.beat(0), 0.1);
  close(g.beat(1.5), 0.9);
  close(g.beat(3), 1.7);
  close(g.beat(5), 2.7, 1e-9, 'forward with the last interval (0.5)');
  close(g.beat(-1), -0.4, 1e-9, 'backward with the first interval (0.5)');
  close(g.position(0.9), 1.5);
  close(g.position(2.7), 5);
  close(g.position(-0.4), -1);
  for (const n of [-2, -0.3, 0, 0.7, 1, 2.2, 3, 4.6]) close(g.position(g.beat(n)), n, 1e-9, `inverse at ${n}`);
  assert.equal(g.index(1.19), 1);
  assert.equal(g.index(1.2), 2);
  close(g.nearest(1.0), 1.2);
  close(g.nearest(0.8), 0.6);
  closeAll(g.beatsIn(0, 2.3), [0.1, 0.6, 1.2, 1.7, 2.2]);
  assert.equal(g.count, 4, 'count = measured beats when no duration');
  assert.equal(g.toJSON().source, 'measured');
  closeAll(g.toJSON().beats, [0.1, 0.6, 1.2, 1.7]);
  // bar(n) without measured downbeats = beat(n·beatsPerBar)
  close(g.bar(1), g.beat(4));
  // given bpm wins over the derived one
  assert.equal(beatGrid({ bpm: 128, beats: [0, 0.5] }).bpm, 128);
});

test('beatGrid: measured downbeats and a single measured beat', () => {
  const beats = [0.3, 0.8, 1.3, 1.8, 2.35, 2.9, 3.4, 3.9, 4.4];
  const g = beatGrid({ bpm: 118, beats, downbeats: [0.3, 2.35, 4.4], duration: 5 });
  close(g.bar(1), 2.35);
  close(g.bar(3), 6.45, 1e-9, 'bars extrapolate with the last bar interval');
  close(g.barPosition(3.375), 1.5);
  assert.equal(g.barIndex(2.4), 1);
  closeAll(g.barsIn(0, 5), [0.3, 2.35, 4.4]);
  assert.equal(g.count, 10, 'measured 9 + one extrapolated beat before the 5 s end');
  const one = beatGrid({ bpm: 100, beats: [0.3] });
  close(one.beat(2), 1.5, 1e-9, 'single beat extrapolates with 60/bpm');
  close(one.beat(-1), -0.3);
});

test('defineFilm and scene()', () => {
  const factory = () => ({ scenes: [] });
  assert.deepEqual(defineFilm(factory), { __film: true, factory });
  assert.throws(() => defineFilm({}), /factory must be a function/);
  const draw = () => {};
  assert.deepEqual(scene(0, 2, 'hook', draw), { from: 0, to: 2, name: 'hook', draw });
  const s = scene({ from: 1, to: 3, name: 'x', draw, tag: 'top', layer: 2 });
  assert.equal(s.tag, 'top', 'extra keys survive the object form');
  assert.equal(s.layer, 2);
  assert.equal('layer' in scene(0, 1, 'y', draw), false, 'no layer key unless given (default 0 at sort time)');
  assert.throws(() => scene({ from: 0, to: 1, name: 'z', draw, layer: 'top' }), /scene "z": layer must be a finite number \(got "top"\)/);
  assert.throws(() => scene({ from: 0, to: 1, name: 'z', draw, layer: NaN }), /layer must be a finite number/);
  assert.equal(scene(2, 4, draw).name, 'scene@2');
  assert.throws(() => scene(2, 2, 'zero', draw), /scene "zero": to \(2\) must be greater than from \(2\)/);
  assert.throws(() => scene(0, NaN, 'nan', draw), /finite seconds/);
  assert.throws(() => scene(0, 1, 'nodraw'), /draw must be a function/);
});

test('chapter(): shots span to the next shot, names, placeholder, validation', () => {
  const d = () => {};
  const ch = chapter({ name: 'ch02', from: 10, to: 20, shots: [{ at: 15, name: 'b', draw: d }, { at: 10, name: 'a', draw: d, extra: 1 }], cues: [{ t: 10, type: 'thump' }] });
  assert.deepEqual(ch.scenes.map((s) => [s.name, s.from, s.to]), [['ch02/a', 10, 15], ['ch02/b', 15, 20]]);
  assert.deepEqual(ch.scenes[0].chapter, { name: 'ch02', from: 10, to: 20 });
  assert.equal(ch.scenes[0].extra, 1);
  assert.deepEqual(ch.cues, [{ t: 10, type: 'thump' }]);
  const empty = chapter({ name: 'ch09', from: 30, to: 40 });
  assert.equal(empty.scenes.length, 1);
  assert.equal(empty.scenes[0].name, 'ch09/placeholder');
  assert.equal(chapter({ name: 'n', from: 0, to: 4, shots: [{ at: 1, draw: d }, { at: 2, draw: d }] }).scenes[1].name, 'n/2');
  assert.throws(() => chapter({ name: 'x', from: 0, to: 5, shots: [{ at: 6, name: 's', draw: d }] }), /outside 0\.\.5/);
  assert.throws(() => chapter({ name: 'x', from: 0, to: 5, shots: [{ at: 1, draw: d }, { at: 1, draw: d }] }), /two shots start at 1/);
  assert.throws(() => chapter({ from: 0, to: 1 }), /name is required/);
  assert.throws(() => chapter({ name: 'x', from: 3, to: 1 }), /finite from < to/);
});

test('placeholder(): draws a visible card with a progress bar', () => {
  const ph = placeholder('ch03', 4, 8);
  const g = mockCtx();
  ph.draw(g, 2, { W: 1080, H: 1920, u: 1, p: 0.5, brand: { colors: { accent: '#D97757' }, fonts: { ui: 'Inter' } }, L: { S: { x: 60, y: 190, w: 930, h: 1420 } } });
  const texts = g.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(texts.includes('chapter ch03'));
  assert.ok(texts.some((t) => /not painted yet · 4\.00s–8\.00s/.test(t)));
  const bars = g.calls.filter((c) => c[0] === 'fillRect');
  close(bars[bars.length - 1][3], (930 - 80) * 0.5, 1e-9, 'progress width');
  assert.doesNotThrow(() => ph.draw(mockCtx(), 0, { W: 100, H: 100, p: 0 }), 'works without brand or layout');
});

test('buildFilm(): factory forms, chapter flattening, stable sort, cues, capture, background', () => {
  const d = () => {};
  const grid = beatGrid({ bpm: 120, duration: 8 });
  const ctx = { grid, brand: { colors: { bg: '#101010' } } };
  const ch = chapter({ name: 'c', from: 4, to: 8, shots: [{ at: 4, name: 's', draw: d }], cues: (gr) => [{ t: gr.beat(9), sfx: 'pop', vol: 0.5 }] });
  let seen = null;
  const film = defineFilm((c) => {
    seen = c;
    return { scenes: [scene(2, 4, 'b1', d), ch, [scene(0, 2, 'a', d), scene(2, 3, 'b2', d)]], cues: (gr, c2) => [{ t: gr.beat(4), type: 'thump' }, { t: 0, type: 'hit', extra: c2 === ctx }], setup: async () => {} };
  });
  const built = buildFilm(film, ctx);
  assert.equal(seen, ctx);
  assert.deepEqual(built.scenes.map((s) => s.name), ['a', 'b1', 'b2', 'c/s'], 'sorted by from, stable for ties');
  assert.deepEqual(built.cues, [{ t: 0, type: 'hit', gain: 1, pan: 0, pitch: 1 }, { t: 2, type: 'thump', gain: 1, pan: 0, pitch: 1 }, { t: 4.5, type: 'pop', gain: 0.5, pan: 0, pitch: 1 }]);
  assert.equal(built.capture, 'canvas');
  assert.equal(built.background, '#101010');
  assert.equal(typeof built.setup, 'function');
  assert.equal(buildFilm(() => ({ scenes: [scene(0, 1, 'x', d)] }), {}).background, '#141413', 'raw factory + default bg');
  assert.equal(buildFilm({ scenes: [{ from: 0, to: 1, name: 'y', draw: d }], capture: 'page', background: 'red' }, {}).capture, 'page');
  assert.equal(buildFilm({ scenes: [scene(0, 1, 'x', d)] }, {}).setup, null);
  assert.throws(() => buildFilm({ scenes: [scene(0, 1, 'x', d)], capture: 'video' }, {}), /capture must be 'canvas' or 'page'/);
  assert.throws(() => buildFilm({ scenes: [] }, {}), /no scenes/);
  assert.throws(() => buildFilm(() => null, {}), /must return an object/);
  assert.throws(() => buildFilm({ scenes: [scene(0, 1, 'x', d)], cues: () => 'nope' }, {}), /cues must be an array/);
});

test('renderFrame(): background, scene windows, overlaps in order, end-inclusive, context values', () => {
  const log = [];
  const rec = (name) => (g, lt, c) => log.push({ name, lt, t: c.t, p: c.p, dur: c.dur, frame: c.frame, W: c.W, fmt: c.fmt, scene: c.scene });
  const built = buildFilm({ scenes: [scene(0, 2, 'a', rec('a')), scene(1, 3, 'b', rec('b')), scene(3, 4, 'c', rec('c'))], background: '#222' }, {});
  const fctx = { W: 1080, H: 1920, u: 1, fmt: '9x16', fps: 60, dur: 4 };
  const run = (t) => {
    log.length = 0;
    const g = mockCtx();
    renderFrame(built, g, t, fctx);
    assert.equal(g.depth, 0, 'save/restore balanced');
    return { names: log.map((x) => x.name), log: [...log], g };
  };
  assert.deepEqual(run(0).names, ['a']);
  assert.deepEqual(run(1.5).names, ['a', 'b'], 'overlap draws both, array order');
  assert.deepEqual(run(2).names, ['b'], 'to is exclusive');
  assert.deepEqual(run(3).names, ['c']);
  assert.deepEqual(run(4).names, ['c'], 'the scene ending at the film end still draws at t = dur');
  assert.deepEqual(run(-1).names, []);
  const r = run(1.5);
  const b = r.log.find((x) => x.name === 'b');
  close(b.lt, 0.5);
  close(b.p, 0.25);
  assert.equal(b.dur, 2);
  assert.equal(b.frame, 90);
  assert.equal(b.W, 1080);
  assert.equal(b.fmt, '9x16');
  assert.equal(b.scene, 'b');
  const fills = r.g.calls.filter((c) => c[0] === 'fillRect');
  assert.deepEqual(fills[0].slice(1), [0, 0, 1080, 1920], 'background painted first');
  assert.equal(r.g.globalAlpha, 1);
  assert.equal(r.g.globalCompositeOperation, 'source-over');
  // frame index is exact on frame boundaries
  assert.equal(run(1 / 60 * 7).log[0].frame, 7);
  // function background gets (g, t, c)
  let bgArgs = null;
  const b2 = buildFilm({ scenes: [scene(0, 1, 'x', () => {})], background: (g, t, c) => { bgArgs = [t, c.W, c.frame]; } }, {});
  renderFrame(b2, mockCtx(), 0.5, fctx);
  assert.deepEqual(bgArgs, [0.5, 1080, 30]);
});

test('renderFrame(): c.frame is the OUTPUT frame, shared by every motion-blur subframe; sub, subs, frameT and frameLt describe it', () => {
  const seen = [];
  const bg = [];
  const pick = (c) => ({ frame: c.frame, sub: c.sub, subs: c.subs, frameT: c.frameT, t: c.t, lt: c.lt, frameLt: c.frameLt });
  const built = buildFilm({ scenes: [scene(1, 3, 'a', (g, lt, c) => seen.push(pick(c)))], background: (g, t, c) => bg.push(pick(c)) }, {});
  const fctx = { W: 10, H: 10, fps: 60, dur: 4 };
  const at = 1.5;
  const shutter = 0.5;
  // No blur information: the time being painted is the frame time.
  renderFrame(built, mockCtx(), at, fctx);
  assert.deepEqual(seen.pop(), { frame: 90, sub: 0, subs: 1, frameT: 1.5, t: 1.5, lt: 0.5, frameLt: 0.5 });
  assert.deepEqual(bg.pop(), { frame: 90, sub: 0, subs: 1, frameT: 1.5, t: 1.5, lt: undefined, frameLt: 1.5 }, 'the background sees the same fields (frameLt = frameT: it has no scene start)');
  // Four subframes of frame 90 as runtime.js paints them: c.t moves (so motion blurs), everything frame-indexed stays put.
  seen.length = 0;
  for (let j = 0; j < 4; j++) renderFrame(built, mockCtx(), at + (((j + 0.5) / 4 - 0.5) * shutter) / 60, { ...fctx, frameT: at, sub: j, subs: 4 });
  assert.deepEqual(seen.map((s) => s.frame), [90, 90, 90, 90], 'was [89, 89, 90, 90]: the subframes of one frame are one frame');
  assert.deepEqual(seen.map((s) => s.sub), [0, 1, 2, 3]);
  assert.deepEqual(seen.map((s) => s.subs), [4, 4, 4, 4]);
  assert.ok(seen.every((s) => s.frameT === at && s.frameLt === 0.5));
  const ts = seen.map((s) => s.t);
  assert.ok(ts.every((t, i) => i === 0 || t > ts[i - 1]), 'c.t is the subframe time');
  close(ts.reduce((a, b) => a + b) / 4, at, 1e-12, 'centred on the frame');
  close(seen[0].lt, seen[0].t - 1);
  close(seen[3].frameLt - seen[3].lt, seen[3].frameT - seen[3].t, 1e-12);
  // The frame index is taken from the frame time, not the subframe time: a subframe just before a frame boundary is still that frame.
  seen.length = 0;
  renderFrame(built, mockCtx(), 1 + 7 / 60 - 1e-4, { ...fctx, frameT: 1 + 7 / 60, sub: 0, subs: 4 });
  renderFrame(built, mockCtx(), 1 + 7 / 60 + 1e-4, { ...fctx, frameT: 1 + 7 / 60, sub: 3, subs: 4 });
  assert.deepEqual(seen.map((s) => s.frame), [67, 67]);
  // Invalid blur info degrades to "no blur" instead of poisoning the context.
  seen.length = 0;
  renderFrame(built, mockCtx(), at, { ...fctx, frameT: NaN, sub: 9, subs: 4 });
  renderFrame(built, mockCtx(), at, { ...fctx, frameT: undefined, sub: -1, subs: 0 });
  renderFrame(built, mockCtx(), at, { ...fctx, sub: 1.5, subs: 2.5 });
  const plain = { frame: 90, sub: 0, subs: 1, frameT: 1.5, t: 1.5, lt: 0.5, frameLt: 0.5 };
  assert.deepEqual(seen, [{ ...plain, subs: 4 }, plain, plain]);
});

test('buildFilm()/renderFrame(): overlays paint after every scene, in array order, and are never shots', () => {
  const log = [];
  const rec = (name) => (g, lt, c) => log.push([name, Math.round(lt * 1e9) / 1e9, c.scene]);
  const ch = chapter({ name: 'ov', from: 0, to: 4, shots: [{ at: 0, name: 'cap', draw: rec('ov/cap') }], cues: [{ t: 1, type: 'tick' }] });
  const built = buildFilm({
    scenes: [scene(0, 2, 'a', rec('a')), scene(2, 4, 'b', rec('b'))],
    // Declared before the scenes' starts on purpose: overlays still paint last, in this array order.
    overlays: [scene(1, 4, 'caption', rec('caption')), [scene(0, 4, 'grain', rec('grain'))], null, ch],
  }, {});
  assert.deepEqual(built.overlays.map((s) => s.name), ['caption', 'grain', 'ov/cap'], 'array order, nested arrays and chapters flattened');
  assert.deepEqual(built.scenes.map((s) => s.name), ['a', 'b'], 'overlays stay out of scenes');
  assert.deepEqual(built.shots, [{ name: 'a', from: 0, to: 2 }, { name: 'b', from: 2, to: 4 }], 'overlays are never shots');
  assert.deepEqual(built.cues, [{ t: 1, type: 'tick', gain: 1, pan: 0, pitch: 1 }], 'cues of an overlay chapter join the film');
  const fctx = { W: 100, H: 100, fps: 60, dur: 4 };
  const run = (t) => {
    log.length = 0;
    const g = mockCtx();
    renderFrame(built, g, t, fctx);
    assert.equal(g.depth, 0, 'save/restore balanced');
    return log.map((x) => x[0]);
  };
  assert.deepEqual(run(0.5), ['a', 'grain', 'ov/cap'], 'caption not started yet (from <= t)');
  assert.deepEqual(run(1.5), ['a', 'caption', 'grain', 'ov/cap']);
  assert.deepEqual(run(2), ['b', 'caption', 'grain', 'ov/cap'], 'scene b starts after the overlays were declared, still below them');
  assert.deepEqual(run(4), ['b', 'caption', 'grain', 'ov/cap'], 'end-inclusive at dur, like scenes');
  assert.deepEqual(run(4.5), [], 'past the end nothing ends-inclusive');
  run(3);
  assert.deepEqual(log.find((x) => x[0] === 'caption'), ['caption', 2, 'caption'], 'overlay lt and name like a scene');
  const noOverlay = buildFilm({ scenes: [scene(0, 1, 'x', rec('x'))] }, {});
  assert.deepEqual(noOverlay.overlays, []);
  // a built object from an older buildFilm (no overlays key) still renders
  const legacy = { background: '#000', scenes: noOverlay.scenes, cues: [] };
  log.length = 0;
  renderFrame(legacy, mockCtx(), 0.5, fctx);
  assert.deepEqual(log.map((x) => x[0]), ['x']);
});

test('buildFilm()/renderFrame(): layer orders drawing (stable by layer, then from); shots stay in time order', () => {
  const log = [];
  const rec = (name) => () => log.push(name);
  const built = buildFilm({
    scenes: [
      scene({ from: 0, to: 6, name: 'frame', draw: rec('frame'), layer: 1 }),
      scene(0, 3, 'one', rec('one')),
      scene(3, 6, 'two', rec('two')),
      scene({ from: 2, to: 6, name: 'under', draw: rec('under'), layer: -1 }),
      scene({ from: 1, to: 6, name: 'frame2', draw: rec('frame2'), layer: 1 }),
      scene({ from: 0, to: 6, name: 'frame3', draw: rec('frame3'), layer: 1 }),
    ],
  }, {});
  assert.deepEqual(built.scenes.map((s) => s.name), ['under', 'one', 'two', 'frame', 'frame3', 'frame2'], '(layer, from), ties in declaration order');
  assert.deepEqual(built.shots.map((s) => s.name), ['frame', 'one', 'frame3', 'frame2', 'under', 'two'], 'shots by from, ties in declaration order');
  const run = (t) => {
    log.length = 0;
    renderFrame(built, mockCtx(), t, { W: 10, H: 10, dur: 6 });
    return [...log];
  };
  assert.deepEqual(run(0.5), ['one', 'frame', 'frame3']);
  assert.deepEqual(run(4), ['under', 'two', 'frame', 'frame3', 'frame2'], 'a later layer-0 scene still paints under layer 1');
  assert.deepEqual(run(6), ['under', 'two', 'frame', 'frame3', 'frame2'], 'end-inclusive');
  assert.throws(() => buildFilm({ scenes: [{ from: 0, to: 1, name: 'bad', draw: rec('bad'), layer: 'top' }] }, {}), /layer must be a finite number/);
});

test('beatGrid: measured hits (grid.hits, grid.hitsIn, toJSON)', () => {
  const g = beatGrid({ bpm: 120, duration: 4, hits: [2.5, 0.75, 'x', NaN, 0.75, -0.2, 3.999, 4, 7.1] });
  assert.deepEqual([...g.hits], [0.75, 2.5, 3.999], 'sorted, deduplicated, finite, limited to [0, duration)');
  assert.ok(Object.isFrozen(g.hits), 'film code cannot mutate the shared list between frames');
  assert.deepEqual(g.hitsIn(0.75, 2.5), [0.75], '[a, b) like beatsIn');
  assert.deepEqual(g.hitsIn(0, 10), [0.75, 2.5, 3.999]);
  assert.deepEqual(g.hitsIn(3, 3), []);
  assert.deepEqual(g.toJSON().hits, [0.75, 2.5, 3.999]);
  const none = beatGrid({ bpm: 120, duration: 4 });
  assert.deepEqual([...none.hits], []);
  assert.deepEqual(none.hitsIn(0, 4), []);
  assert.deepEqual(none.toJSON().hits, []);
  assert.deepEqual([...beatGrid({ hits: [9, 1] }).hits], [1, 9], 'no duration: no upper limit');
});

test('filmContext(): beats.json hits reach grid.hits', () => {
  const cfg = { duration: 8, bpm: 100 };
  const m = filmContext(cfg, '1x1', { bpm: 128, beats: [0.2, 0.67, 1.14], downbeats: [0.2], beatsPerBar: 4, hits: [0.2, 1.14, 5.5, 9] });
  assert.deepEqual([...m.grid.hits], [0.2, 1.14, 5.5], 'hits past the film end are dropped');
  assert.deepEqual(m.grid.hitsIn(1, 6), [1.14, 5.5]);
  const peaksOnly = filmContext(cfg, '1x1', { bpm: 0, beats: [], hits: [3.2] });
  assert.equal(peaksOnly.grid.measured, false, 'no tracked beats: bpm grid');
  assert.deepEqual([...peaksOnly.grid.hits], [3.2], 'peaks do not need a tempo');
  assert.deepEqual([...filmContext(cfg, '1x1', { bpm: 128, beats: [0.2, 0.67] }).grid.hits], [], 'beats.json without hits');
  assert.deepEqual([...filmContext(cfg, '1x1').grid.hits], [], 'no beats.json');
});

test('normalizeCues(): aliases, sorting, dropping, validation', () => {
  const out = normalizeCues([
    { t: 2, type: 'pop' },
    { t: 1, sfx: 'click', vol: 0.4, pan: 3 },
    { t: -1, type: 'hit' },
    { t: NaN, type: 'hit' },
    { t: Infinity, type: 'hit' },
    { time: 1, type: 'tick', pitch: -2, gain: -1 },
    null,
    { t: 1, type: 'whoosh', pitch: 1.5 },
  ]);
  assert.deepEqual(out, [
    { t: 1, type: 'click', gain: 0.4, pan: 1, pitch: 1 },
    { t: 1, type: 'tick', gain: 1, pan: 0, pitch: 1 },
    { t: 1, type: 'whoosh', gain: 1, pan: 0, pitch: 1.5 },
    { t: 2, type: 'pop', gain: 1, pan: 0, pitch: 1 },
  ]);
  assert.deepEqual(normalizeCues(null), []);
  assert.deepEqual(normalizeCues([]), []);
  assert.throws(() => normalizeCues({}), /cues must be an array/);
  assert.throws(() => normalizeCues([{ t: 1 }]), /cue #0 at t=1: missing type/);
  assert.deepEqual(normalizeCues([{ t: '0.5', type: 'snap' }]), [{ t: 0.5, type: 'snap', gain: 1, pan: 0, pitch: 1 }]);
});

test('SFX_TYPES', () => {
  assert.deepEqual([...SFX_TYPES], ['click', 'tick', 'pop', 'thump', 'whoosh', 'swoosh', 'riser', 'hit', 'chime', 'type', 'glitch', 'snap']);
  assert.ok(Object.isFrozen(SFX_TYPES));
});

test('filmContext(): config, layout, measured beats win over bpm', () => {
  const cfg = { title: 'T', duration: 8, fps: 30, bpm: 100, loop: true, safe: { '1x1': { top: 0.2, bottom: 0.2, left: 0.1, right: 0.1 } }, brand: { colors: { bg: '#000' } } };
  const c = filmContext(cfg, '1x1');
  assert.equal(c.dur, 8);
  assert.equal(c.fps, 30);
  assert.equal(c.bpm, 100);
  assert.equal(c.loop, true);
  assert.equal(c.fmt, '1x1');
  assert.equal(c.title, 'T');
  assert.equal(c.W, 1080);
  close(c.L.S.y, 216);
  assert.equal(typeof c.rngFor, 'function');
  assert.equal(c.grid.count, 14, '100 BPM for 8 s');
  const m = filmContext(cfg, '1x1', { bpm: 128, beats: [0.2, 0.67, 1.14], downbeats: [0.2], beatsPerBar: 4 });
  assert.equal(m.grid.measured, true);
  assert.equal(m.bpm, 128);
  close(m.grid.beat(1), 0.67);
  const silent = filmContext(cfg, '9x16', { bpm: 0, beats: [] });
  assert.equal(silent.grid.measured, false);
  assert.equal(silent.bpm, 100, 'silent beats.json falls back to studio.json bpm');
  const d = filmContext({}, undefined);
  assert.equal(d.fmt, '9x16');
  assert.equal(d.dur, 12);
  assert.equal(d.fps, 60);
  assert.equal(d.loop, false);
});
