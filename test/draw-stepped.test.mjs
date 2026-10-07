// Tests for the stepped reveal helpers in skills/studio-init/template/lib/draw.js: stepProgress(), scanReveal(),
// steppedText(). A mock 2D context records clip rects and fillText calls; no browser is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const D = await import(pathToFileURL(path.join(TEMPLATE, 'lib', 'draw.js')).href);

function mock() {
  const stack = [];
  const g = {
    clips: [], fills: [], rects: [], depth: 0, maxDepth: 0,
    font: '', fillStyle: '', globalAlpha: 1, textBaseline: 'alphabetic', textAlign: 'left', letterSpacing: '0px',
    save() { stack.push({ globalAlpha: this.globalAlpha }); this.depth++; },
    restore() { Object.assign(this, stack.pop()); this.depth--; },
    beginPath() { this.rects = []; },
    rect(x, y, w, h) { this.rects.push([x, y, w, h]); },
    clip() { this.clips.push(this.rects[0]); },
    measureText(s) { return { width: [...s].length * 10 }; },
    fillText(s, x, y) { this.fills.push({ s, x, y, a: this.globalAlpha }); },
  };
  return g;
}
const R = { x: 10.4, y: 20.2, w: 100, h: 60 };

test('stepProgress: quantized up, endpoints, NaN, bad steps', () => {
  assert.equal(D.stepProgress(0, 6), 0);
  assert.equal(D.stepProgress(-1, 6), 0);
  assert.equal(D.stepProgress(NaN, 6), 0);
  assert.equal(D.stepProgress(0.0001, 6), 1 / 6);
  assert.equal(D.stepProgress(0.5, 6), 0.5);
  assert.equal(D.stepProgress(0.51, 6), 4 / 6);
  assert.equal(D.stepProgress(1, 6), 1);
  assert.equal(D.stepProgress(7, 6), 1);
  assert.equal(D.stepProgress(0.3, 0), 1, 'steps < 1 -> one step');
  assert.equal(D.stepProgress(0.3, NaN), 2 / 6, 'NaN steps -> default 6');
});

test('scanReveal: one clip per call, N distinct monotonic steps, integer edges, endpoints', () => {
  const widths = [];
  for (let i = 0; i <= 600; i++) {
    const g = mock();
    let drawn = 0;
    D.scanReveal(g, R, i / 600, { steps: 5, dir: 'right' }, () => { drawn++; });
    if (i === 0) { assert.equal(g.clips.length, 0); assert.equal(drawn, 0, 'p=0 draws nothing'); continue; }
    assert.equal(drawn, 1);
    const [x, y, w, h] = g.clips[0];
    assert.ok([x, y, w, h].every(Number.isInteger), `integer rect ${[x, y, w, h]}`);
    assert.equal(g.depth, 0, 'save/restore balanced');
    widths.push(w);
  }
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i] >= widths[i - 1], 'monotonic');
  assert.equal(new Set(widths).size, 5, 'exactly 5 distinct steps');
  assert.equal(widths.at(-1), Math.round(R.x + R.w) - Math.round(R.x), 'p=1 = the full snapped rect');
});

test('scanReveal: dir conventions match maskReveal and the revealed edge is the right one', () => {
  const full = [10, 20, 100, 60];
  const run = (dir, p) => { const g = mock(); D.scanReveal(g, R, p, { steps: 4, dir }, () => {}); return g.clips[0]; };
  assert.deepEqual(run('down', 1), full);
  assert.deepEqual(run('down', 0.5), [10, 20, 100, 30]);
  assert.deepEqual(run('up', 0.5), [10, 50, 100, 30]);
  assert.deepEqual(run('right', 0.5), [10, 20, 50, 60]);
  assert.deepEqual(run('left', 0.5), [60, 20, 50, 60]);
  const c = run('center', 0.5);
  assert.deepEqual(c, [35, 35, 50, 30]);
  assert.deepEqual(run('center', 1), full);
  assert.throws(() => D.scanReveal(mock(), R, 0.5, { dir: 'sideways' }, () => {}), /unknown dir/);
});

test('scanReveal: NaN progress or rect draws nothing and returns 0; returns quantized q', () => {
  const g = mock();
  let n = 0;
  assert.equal(D.scanReveal(g, R, NaN, {}, () => n++), 0);
  assert.equal(D.scanReveal(g, { ...R, w: NaN }, 0.5, {}, () => n++), 0);
  assert.equal(n, 0);
  assert.equal(D.scanReveal(g, R, 0.3, { steps: 4 }, () => n++), 0.5);
  assert.equal(n, 1);
});

test('steppedText: units appear whole, left to right, full alpha, one y, integer x', () => {
  const counts = [];
  for (let i = 0; i <= 100; i++) {
    const g = mock();
    D.steppedText(g, 'ABCD', 5.4, 40.6, i / 100, { size: 20, family: 'Inter', weight: 400, color: '#fff' });
    counts.push(g.fills.length);
    g.fills.forEach((f, k) => { assert.equal(f.s, 'ABCD'[k]); assert.equal(f.a, 1, 'no alpha ramp'); assert.equal(f.y, 41, 'no rise, snapped'); assert.ok(Number.isInteger(f.x)); });
    assert.equal(g.depth, 0);
  }
  assert.equal(counts[0], 0);
  assert.equal(counts.at(-1), 4);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1] && counts[i] - counts[i - 1] <= 1);
  assert.deepEqual([...new Set(counts)], [0, 1, 2, 3, 4]);
});

test('steppedText: steps groups units, by word keeps whitespace out of the count, alpha scales, NaN draws nothing', () => {
  let g = mock();
  D.steppedText(g, 'ABCDEF', 0, 0, 0.01, { size: 10, family: 'Inter', weight: 400, steps: 2 });
  assert.equal(g.fills.length, 3, '2 steps over 6 chars: first step = 3 chars');
  g = mock();
  D.steppedText(g, 'ab cd ef', 0, 0, 0.4, { size: 10, family: 'Inter', weight: 400, by: 'word' });
  assert.deepEqual(g.fills.map((f) => f.s), ['ab', 'cd']);
  g = mock();
  D.steppedText(g, 'AB', 0, 0, 1, { size: 10, family: 'Inter', weight: 400, alpha: 0.5 });
  assert.ok(g.fills.every((f) => f.a === 0.5));
  g = mock();
  const r = D.steppedText(g, 'AB', 0, 0, NaN, { size: 10, family: 'Inter', weight: 400 });
  assert.equal(g.fills.length, 0);
  assert.equal(r.width, 20);
  g = mock();
  assert.deepEqual(D.steppedText(g, '', 3, 0, 1), { width: 0, left: 3, right: 3 });
  g = mock();
  const c = D.steppedText(g, 'AB', 100, 0, 1, { size: 10, family: 'Inter', weight: 400, align: 'center' });
  assert.equal(c.left, 90);
});

test('steppedText: records the whole string for the font-fallback preflight, like kinetic()', () => {
  D.setTextTracking(true);
  D.resetTextUse();
  try {
    const g = mock();
    D.steppedText(g, '한글ab', 0, 0, 0, { size: 16, family: 'Step Face', weight: 400 }); // p = 0: nothing drawn, still recorded
    const use = D.getTextUse();
    const row = use.find((u) => /step face/i.test(u.family));
    assert.ok(row, JSON.stringify(use));
    assert.equal(row.chars, [...'한글ab'].sort().join(''));
  } finally {
    D.resetTextUse();
    D.setTextTracking(false);
  }
});
