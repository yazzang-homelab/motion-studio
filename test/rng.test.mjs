// Tests for skills/studio-init/template/lib/rng.js — stable hashes, seeded streams, smooth noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash32, mulberry32, rngFor, range, pick, shuffle, noise1, noise2 } from '../skills/studio-init/template/lib/rng.js';

// The course's step-07 generator, used as the reference implementation of mulberry32.
function articleRng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('hash32 is FNV-1a (reference vectors) over UTF-8, parts joined with \\u0001', () => {
  assert.equal(hash32(''), 0x811c9dc5);
  assert.equal(hash32('a'), 0xe40c292c);
  assert.equal(hash32('foobar'), 0xbf9cf968);
  assert.equal(hash32('tile', 3), hash32('tile\u00013'));
  assert.equal(hash32('a', 'b', 'c'), hash32('a\u0001b\u0001c'));
  assert.notEqual(hash32('ab', 'c'), hash32('a', 'bc'));
  // UTF-8, not UTF-16: 'é' is the two bytes c3 a9
  let h = 0x811c9dc5;
  for (const b of [0xc3, 0xa9]) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  assert.equal(hash32('é'), h);
  assert.equal(typeof hash32('😀'), 'number');
  assert.ok(hash32('😀') >= 0 && hash32('😀') <= 0xffffffff);
  assert.equal(hash32(12), hash32('12'));
});

test('mulberry32 matches the course reference and stays in [0, 1)', () => {
  for (const seed of [0, 1, 42, 0x7fffffff, 0xdeadbeef, hash32('x')]) {
    const a = mulberry32(seed);
    const b = articleRng(seed);
    for (let i = 0; i < 200; i++) assert.equal(a(), b());
  }
  const r = mulberry32(7);
  let min = 1;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < 20000; i++) {
    const x = r();
    min = Math.min(min, x);
    max = Math.max(max, x);
    sum += x;
  }
  assert.ok(min >= 0 && max < 1);
  assert.ok(Math.abs(sum / 20000 - 0.5) < 0.01, 'roughly uniform mean');
});

test('rngFor gives independent, reproducible streams per element', () => {
  const a1 = rngFor('tile', 1);
  const a2 = rngFor('tile', 1);
  const b = rngFor('tile', 2);
  const xs = [a1(), a1(), a1()];
  assert.deepEqual(xs, [a2(), a2(), a2()]);
  assert.notDeepEqual(xs, [b(), b(), b()]);
  // consuming one element's stream does not shift another's (the shared-stream bug)
  const before = rngFor('star', 9)();
  const other = rngFor('star', 8);
  for (let i = 0; i < 1000; i++) other();
  assert.equal(rngFor('star', 9)(), before);
  // neighbouring indices are decorrelated
  const firsts = Array.from({ length: 64 }, (_, i) => rngFor('dot', i)());
  const mean = firsts.reduce((s, x) => s + x, 0) / firsts.length;
  assert.ok(mean > 0.3 && mean < 0.7, `mean ${mean}`);
  assert.equal(new Set(firsts).size, 64);
});

test('range, pick, shuffle', () => {
  const r = rngFor('helpers');
  for (let i = 0; i < 500; i++) {
    const x = range(r, -3, 5);
    assert.ok(x >= -3 && x < 5);
  }
  const arr = ['a', 'b', 'c', 'd'];
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pick(r, arr));
  assert.deepEqual([...seen].sort(), arr);
  assert.equal(pick(r, []), undefined);
  const src = Array.from({ length: 20 }, (_, i) => i);
  const s1 = shuffle(rngFor('sh'), src);
  const s2 = shuffle(rngFor('sh'), src);
  assert.deepEqual(s1, s2, 'deterministic');
  assert.notDeepEqual(s1, src, 'actually shuffled');
  assert.deepEqual([...s1].sort((a, b) => a - b), src, 'a permutation');
  assert.deepEqual(src, Array.from({ length: 20 }, (_, i) => i), 'input untouched (copy)');
});

test('noise1: range, smoothness, determinism, seeds', () => {
  let min = 0;
  let max = 0;
  let prev = noise1(0, 3);
  let maxStep = 0;
  for (let x = 0; x <= 50; x += 0.001) {
    const v = noise1(x, 3);
    min = Math.min(min, v);
    max = Math.max(max, v);
    maxStep = Math.max(maxStep, Math.abs(v - prev));
    prev = v;
  }
  assert.ok(min >= -1 && max <= 1, `range ${min}..${max}`);
  assert.ok(max - min > 1, 'uses most of the range');
  assert.ok(maxStep < 0.01, `continuous (max step ${maxStep})`);
  assert.equal(noise1(12.34, 5), noise1(12.34, 5));
  assert.notEqual(noise1(12.34, 5), noise1(12.34, 6));
  assert.equal(noise1(3.3, 'wobble'), noise1(3.3, hash32('wobble') | 0));
  assert.equal(noise1(NaN), 0);
  assert.equal(noise1(-7.25, 1), noise1(-7.25, 1));
  // first derivative is continuous at lattice points (quintic fade)
  const h = 1e-6;
  const dl = (noise1(4, 2) - noise1(4 - h, 2)) / h;
  const dr = (noise1(4 + h, 2) - noise1(4, 2)) / h;
  assert.ok(Math.abs(dl) < 1e-4 && Math.abs(dr) < 1e-4, 'zero slope at lattice points, no kinks');
});

test('noise2: range, smoothness, determinism', () => {
  let min = 0;
  let max = 0;
  for (let y = 0; y < 8; y += 0.05) {
    for (let x = 0; x < 8; x += 0.05) {
      const v = noise2(x, y, 9);
      min = Math.min(min, v);
      max = Math.max(max, v);
      assert.ok(Math.abs(noise2(x + 0.001, y, 9) - v) < 0.02);
      assert.ok(Math.abs(noise2(x, y + 0.001, 9) - v) < 0.02);
    }
  }
  assert.ok(min >= -1 && max <= 1 && max - min > 1, `range ${min}..${max}`);
  assert.equal(noise2(1.5, 2.5, 1), noise2(1.5, 2.5, 1));
  assert.notEqual(noise2(1.5, 2.5, 1), noise2(2.5, 1.5, 1));
  assert.equal(noise2(Infinity, 1), 0);
});
