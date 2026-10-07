// Tests for skills/studio-init/template/lib/layout.js — formats, safe rects, pick/split/cols, fitFontSize.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMATS, DEFAULT_SAFE, layout, fitFontSize, safeProblems } from '../skills/studio-init/template/lib/layout.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = JSON.parse(fs.readFileSync(path.join(here, '..', 'skills', 'studio-init', 'template', 'studio.json'), 'utf8'));
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a}`);
const closeRect = (r, e) => ['x', 'y', 'w', 'h'].forEach((k) => close(r[k], e[k], 1e-9));

test('FORMATS and DEFAULT_SAFE (same values as studio.json "safe")', () => {
  assert.deepEqual(Object.keys(FORMATS), ['9x16', '1x1', '16x9', '4x5']);
  assert.deepEqual([FORMATS['9x16'].w, FORMATS['9x16'].h], [1080, 1920]);
  assert.deepEqual([FORMATS['1x1'].w, FORMATS['1x1'].h], [1080, 1080]);
  assert.deepEqual([FORMATS['16x9'].w, FORMATS['16x9'].h], [1920, 1080]);
  assert.deepEqual([FORMATS['4x5'].w, FORMATS['4x5'].h], [1080, 1350]);
  assert.equal(FORMATS['9x16'].label, '9:16 · Reels, TikTok, Shorts');
  assert.equal(FORMATS['1x1'].label, '1:1 · X / feed');
  assert.equal(FORMATS['16x9'].label, '16:9 · YouTube, site');
  assert.equal(FORMATS['4x5'].label, '4:5 · feed portrait');
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_SAFE)), studio.safe);
  for (const f of studio.formats) assert.ok(FORMATS[f], `studio.json format ${f} is known`);
  assert.ok(Object.isFrozen(FORMATS) && Object.isFrozen(DEFAULT_SAFE));
});

test('layout(): size, unit, orientation and safe rect per format', () => {
  const p = layout('9x16');
  assert.equal(p.W, 1080);
  assert.equal(p.H, 1920);
  assert.equal(p.u, 1);
  assert.equal(p.cx, 540);
  assert.equal(p.cy, 960);
  assert.ok(p.portrait && !p.landscape && !p.square);
  assert.equal(p.orientation, 'portrait');
  closeRect(p.S, { x: 1080 * 0.06, y: 1920 * 0.1, w: 1080 * (1 - 0.06 - 0.08), h: 1920 * (1 - 0.1 - 0.16) });
  const sq = layout('1x1');
  assert.ok(sq.square);
  closeRect(sq.S, { x: 75.6, y: 75.6, w: 928.8, h: 928.8 });
  const ls = layout('16x9');
  assert.ok(ls.landscape);
  closeRect(ls.S, { x: 115.2, y: 86.4, w: 1689.6, h: 907.2 });
  const fp = layout('4x5');
  assert.ok(fp.portrait);
  closeRect(fp.S, { x: 75.6, y: 94.5, w: 928.8, h: 1350 * 0.84 });
  for (const f of Object.keys(FORMATS)) assert.equal(layout(f).u, Math.min(FORMATS[f].w, FORMATS[f].h) / 1080);
});

test('layout(): custom and partial safe margins, validation', () => {
  const L = layout('16x9', { top: 0, bottom: 0.2 });
  closeRect(L.S, { x: 1920 * 0.06, y: 0, w: 1920 * 0.88, h: 1080 * 0.8 });
  close(layout('1x1', null).S.x, 75.6);
  assert.throws(() => layout('3x2'), /unknown format "3x2"/);
  assert.throws(() => layout('1x1', { left: 0.6 }), /^Error: safe\.1x1\.left must be a fraction in \[0, 0\.5\) \(got 0\.6\)$/);
  assert.throws(() => layout('1x1', { top: -0.1 }), /safe\.1x1\.top/);
  assert.throws(() => layout('1x1', { left: 0.49, right: 0.49, top: 0 }), /no room/);
  assert.throws(() => layout('1x1', { left: null }), /safe\.1x1\.left must be a fraction/, 'null is not "zero"');
});

test('safeProblems(): the one safe-inset rule (sides in [0, 0.5), at least 10% per axis), as readable messages', () => {
  assert.deepEqual(safeProblems('9x16', undefined), []);
  assert.deepEqual(safeProblems('9x16', {}), []);
  assert.deepEqual(safeProblems('9x16', DEFAULT_SAFE['9x16']), []);
  assert.deepEqual(safeProblems('unknown', { top: 0.1 }), [], 'an unknown format falls back to the 1:1 defaults');
  assert.deepEqual(safeProblems('16x9', { left: 0.45, right: 0.45 }), [], 'exactly 10% left is fine');
  assert.deepEqual(safeProblems('16x9', { top: 0.495 }), []);
  assert.deepEqual(safeProblems('16x9', { left: 0.45, right: 0.46 }), ['safe.16x9: left + right = 0.91 leaves no room (only 9% of the width; keep at least 10%, so left + right <= 0.9)']);
  assert.deepEqual(safeProblems('16x9', { top: 0.5, bottom: 0.45 }), ['safe.16x9.top must be a fraction in [0, 0.5) (got 0.5)'], 'a bad side is reported alone, not as a sum');
  assert.equal(safeProblems('16x9', { top: 0.48, bottom: 0.48 }).length, 1);
  assert.equal(safeProblems('16x9', { top: 0.48, bottom: 0.48, left: 0.48, right: 0.48 }).length, 2, 'one message per axis');
  assert.match(safeProblems('16x9', { top: 'x' })[0], /safe\.16x9\.top must be a fraction in \[0, 0\.5\) \(got "x"\)/);
  // layout() throws exactly the first message
  assert.throws(() => layout('16x9', { left: 0.45, right: 0.46 }), new Error(safeProblems('16x9', { left: 0.45, right: 0.46 })[0]));
});

test('pos(): fractions of the safe rect', () => {
  const L = layout('9x16');
  assert.deepEqual(L.pos(0, 0), [L.S.x, L.S.y]);
  const [x, y] = L.pos(1, 1);
  close(x, L.S.x + L.S.w);
  close(y, L.S.y + L.S.h);
  const [mx, my] = L.pos(0.5, 0.5);
  close(mx, L.S.x + L.S.w / 2);
  close(my, L.S.y + L.S.h / 2);
});

test('pick(): exact format, then orientation, then default; falsy values are valid', () => {
  const map = { '16x9': 'wide', portrait: 'tall', default: 'any' };
  assert.equal(layout('16x9').pick(map), 'wide');
  assert.equal(layout('9x16').pick(map), 'tall');
  assert.equal(layout('4x5').pick(map), 'tall');
  assert.equal(layout('1x1').pick(map), 'any');
  assert.equal(layout('1x1').pick({ square: 0, default: 5 }), 0);
  assert.equal(layout('16x9').pick({ landscape: '', default: 'x' }), '');
  assert.equal(layout('1x1').pick({ portrait: 1 }), undefined);
  assert.equal(layout('1x1').pick(null), undefined);
});

test('split(): stacked in portrait/square, side by side in landscape, ratio and gap', () => {
  const P = layout('9x16');
  const sp = P.split();
  assert.equal(sp.dir, 'column');
  const hh = P.S.h;
  closeRect(sp.a, { x: P.S.x, y: P.S.y, w: P.S.w, h: hh / 2 });
  closeRect(sp.b, { x: P.S.x, y: P.S.y + hh / 2, w: P.S.w, h: hh / 2 });
  assert.equal(layout('1x1').split().dir, 'column');
  const Lw = layout('16x9');
  const s2 = Lw.split('auto', 0.3, 40);
  assert.equal(s2.dir, 'row');
  close(s2.a.w, (Lw.S.w - 40) * 0.3);
  close(s2.b.x, Lw.S.x + (Lw.S.w - 40) * 0.3 + 40);
  close(s2.a.w + 40 + s2.b.w, Lw.S.w);
  close(s2.a.h, Lw.S.h);
  assert.equal(P.split('row').dir, 'row');
  assert.equal(Lw.split('column').dir, 'column');
  assert.equal(Lw.split('vertical').dir, 'column');
  assert.throws(() => P.split('diagonal'), /unknown direction/);
  const clamped = P.split('column', 2);
  close(clamped.a.h, P.S.h);
  close(clamped.b.h, 0);
});

test('cols() and rows(): equal tracks across the safe rect', () => {
  const L = layout('16x9');
  const c = L.cols(4, 20);
  assert.equal(c.length, 4);
  close(c[0].x, L.S.x);
  close(c[3].x + c[3].w, L.S.x + L.S.w);
  close(c[1].x - (c[0].x + c[0].w), 20);
  for (const col of c) close(col.w, (L.S.w - 60) / 4);
  const r = layout('9x16').rows(3, 10);
  assert.equal(r.length, 3);
  close(r[2].y + r[2].h, layout('9x16').S.y + layout('9x16').S.h);
  assert.equal(L.cols(0).length, 1);
});

test('fitFontSize(): largest size that fits, lines, bounds, font restored', () => {
  // Mock context: each glyph is 0.5 em wide, so width = size * len * 0.5.
  const g = {
    font: '10px sans-serif',
    measureText(s) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]);
      return { width: size * s.length * 0.5 };
    },
  };
  const mk = (s) => `700 ${s}px "Inter"`;
  const s = fitFontSize(g, 'ABCDEFGHIJ', 500, mk); // 10 chars -> 5·size <= 500 -> 100
  assert.ok(s <= 100 && s > 99.98, `got ${s}`);
  assert.equal(g.font, '10px sans-serif', 'font restored');
  const multi = fitFontSize(g, ['AB', 'ABCDEFGHIJKLMNOPQRST'], 500, mk); // widest line (20 chars) wins -> 50
  assert.ok(multi <= 50 && multi > 49.98, `got ${multi}`);
  assert.equal(fitFontSize(g, 'AB', 5000, mk, 8, 300), 300, 'hi bound');
  assert.equal(fitFontSize(g, 'ABCDEFGHIJ', 1, mk, 8, 300), 8, 'lo bound when nothing fits');
  const width = g.measureText.call({ font: mk(s) }, 'ABCDEFGHIJ').width;
  assert.ok(width <= 500);
});

test('fitFontSize(): step quantizes down to a multiple (bitmap fonts), options can replace lo/hi', () => {
  const g = { font: '10px sans-serif', measureText(s) { return { width: Number(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]) * s.length * 0.5 }; } };
  const mk = (s) => `700 ${s}px "Inter"`;
  assert.equal(fitFontSize(g, 'ABCDEFGHIJ', 500, mk, 8, 1000, { step: 16 }), 96, 'the fit is 100: 96 is the multiple of 16 below');
  assert.equal(fitFontSize(g, 'ABCDEFGHIJ', 500, mk, { step: 16 }), 96, 'options as the 5th argument');
  assert.equal(fitFontSize(g, 'ABCDEFGHIJ', 480, mk, { step: 16 }), 96, 'an exact fit stays (no float round-off at the grid)');
  assert.equal(fitFontSize(g, 'ABCDEFGHIJ', 479, mk, { step: 16 }), 80);
  assert.equal(fitFontSize(g, 'ABCDEFGHIJ', 1, mk, { step: 16 }), 16, 'nothing fits: the smallest step');
  assert.equal(fitFontSize(g, 'AB', 5000, mk, 8, 300, { step: 16 }), 288);
  assert.equal(fitFontSize(g, 'AB', 5000, mk, { hi: 100, step: 16 }), 96);
  assert.equal(fitFontSize(g, 'AB', 5000, mk, { lo: 40, hi: 40.5, step: 16 }), 48, 'lo rounds up to a step');
  for (const step of [8, 16, 32]) assert.equal(fitFontSize(g, 'ABCDEFGHIJKLM', 700, mk, { step }) % step, 0);
  assert.ok(Number.isInteger(fitFontSize(g, 'ABCDEFGHIJ', 500, mk, { step: 1 })));
  assert.notEqual(fitFontSize(g, 'ABCDEFGHIJ', 500, mk) % 1, 0, 'without step the result is fractional');
  assert.throws(() => fitFontSize(g, 'A', 100, mk, { step: -1 }), RangeError);
  assert.equal(g.font, '10px sans-serif');
});
