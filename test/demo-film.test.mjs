// Regression: the shipped demo film (skills/studio-init/template/film/film.js). It is the first thing a user sees, so
// the defects the production E2E critique found stay fixed:
//  - the orange frame outline cut through the chart caption "frames, one function of time" at 00:08.00 (16:9), and the
//    "16:9" label crossed the frame it belongs to while that frame was still moving;
//  - the 9:16 composition was top-heavy (content in the upper 60%), the 1:1 hook hugged the left edge and the lockup
//    sat off-centre;
//  - chart notes, the "1.0" tick and the format labels were 28 to 32 px tall (unreadable at phone width), and in 16:9
//    (shown at 360 px wide as 1/5.3 of its pixels, not 1/3) the small type was 8 px tall at phone width;
//  - a hard cut into the lockup at 00:10.00.
// Two groups:
//  1. static (always runs): duration, downbeat shots and the cue list on the beat grid are unchanged;
//  2. browser (skips without playwright or a browser): boot the real runtime on the demo, then check, per format,
//     text-vs-outline collisions (fillText and stroked rounded rects are recorded while seeking), the smallest
//     top-level type size, where the ink sits in the frame, and the pixel step across 00:10.00.
// Env: MOTION_TEMPLATE_DIR (test another template copy), MOTION_SMOKE_NODE_MODULES=<dir with playwright>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const S = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'studio.mjs')).href);
const T = await import(pathToFileURL(path.join(TEMPLATE, 'lib', 'timeline.js')).href);
const filmMod = await import(pathToFileURL(path.join(TEMPLATE, 'film', 'film.js')).href);
const FORMATS = ['9x16', '1x1', '16x9'];
const CANVAS_W = { '9x16': 1080, '1x1': 1080, '16x9': 1920 };
// Smallest top-level type, in px of the canvas: 44 in 9:16 and 1:1 (14.7 px at 360 px wide), 58 in 16:9 (10.9 px).
const MIN_TYPE = { '9x16': 43.5, '1x1': 43.5, '16x9': 57.5 };

function findNodeModules() {
  const env = process.env.MOTION_SMOKE_NODE_MODULES;
  if (env) return fs.existsSync(path.join(env, 'playwright')) || fs.existsSync(path.join(env, 'playwright-core')) ? path.resolve(env) : null;
  for (const base of [path.join(REPO, 'package.json'), path.join(TEMPLATE, 'package.json')]) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return path.dirname(path.dirname(createRequire(base).resolve(`${name}/package.json`))); } catch { /* next */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. static

const EXPECTED_CUES = [
  [0, 'thump'], [2, 'pop'], [4, 'whoosh'], [5, 'click'], [6, 'chime'], [8, 'thump'], [9, 'pop'], [10, 'tick'], [11, 'tick'], [12, 'whoosh'],
  [13, 'tick'], [14, 'tick'], [15, 'pop'], [16, 'thump'], [17, 'pop'], [17, 'riser'], [18, 'pop'], [20, 'hit'], [21, 'type'], [22, 'snap'],
];

test('demo film: 12 s at 120 BPM, six shots on downbeats, the 20 cues on the beat grid', () => {
  const cfg = S.loadConfig(TEMPLATE);
  assert.equal(cfg.duration, 12);
  assert.equal(cfg.bpm, 120);
  for (const fmt of FORMATS) {
    const ctx = T.filmContext(cfg, fmt);
    const built = T.buildFilm(filmMod.default, ctx);
    assert.deepEqual(built.shots.map((s) => [s.name, s.from]), [['hook', 0], ['morph', 2], ['sheet', 4], ['chart', 6], ['formats', 8], ['lockup', 10]], `${fmt}: shots`);
    assert.equal(built.shots[5].to, 12, `${fmt}: the lockup runs to the end`);
    const beat = 60 / cfg.bpm;
    const got = built.cues.map((c) => [Math.round(c.t / beat), c.type]);
    assert.deepEqual(got, EXPECTED_CUES, `${fmt}: cue list`);
    for (const c of built.cues) assert.ok(Math.abs(c.t / beat - Math.round(c.t / beat)) < 1e-9, `${fmt}: cue ${c.type} at ${c.t} is on the beat grid`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 2. browser

// In-page recorder: seek to each time with fillText (its visible glyph box: clipped by the active clip rects, so a line
// still sliding out of its mask does not count) and stroked rounded rects (4 arcs, or one rect) recorded in canvas px.
async function recordFrames(page, times) {
  return page.evaluate((ts) => {
    const P = CanvasRenderingContext2D.prototype;
    const keep = {};
    for (const n of ['beginPath', 'moveTo', 'lineTo', 'arc', 'rect', 'closePath', 'stroke', 'fillText', 'save', 'restore', 'clip']) keep[n] = P[n];
    let cur = null;
    let clips = [null]; // one clip box (canvas px) per save() level
    const boxOf = (ctx, pts) => {
      const m = ctx.getTransform();
      const xs = pts.map((p) => m.a * p[0] + m.c * p[1] + m.e);
      const ys = pts.map((p) => m.b * p[0] + m.d * p[1] + m.f);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    let texts = [];
    let outlines = [];
    P.beginPath = function () { cur = { pts: [], arcs: 0, rects: 0, closed: false }; return keep.beginPath.call(this); };
    P.moveTo = function (x, y) { if (cur) cur.pts.push([x, y]); return keep.moveTo.call(this, x, y); };
    P.lineTo = function (x, y) { if (cur) cur.pts.push([x, y]); return keep.lineTo.call(this, x, y); };
    P.arc = function (x, y, r) { if (cur) { cur.pts.push([x - r, y - r], [x + r, y + r]); cur.arcs++; } return keep.arc.apply(this, arguments); };
    P.rect = function (x, y, w, h) { if (cur) { cur.pts.push([x, y], [x + w, y + h]); cur.rects++; } return keep.rect.apply(this, arguments); };
    P.closePath = function () { if (cur) cur.closed = true; return keep.closePath.call(this); };
    P.save = function () { clips.push(clips[clips.length - 1]); return keep.save.call(this); };
    P.restore = function () { if (clips.length > 1) clips.pop(); return keep.restore.call(this); };
    P.clip = function () {
      if (cur && cur.pts.length) {
        const b = boxOf(this, cur.pts);
        const c = clips[clips.length - 1];
        clips[clips.length - 1] = c ? { x0: Math.max(c.x0, b.x0), x1: Math.min(c.x1, b.x1), y0: Math.max(c.y0, b.y0), y1: Math.min(c.y1, b.y1) } : b;
      }
      return keep.clip.apply(this, arguments);
    };
    P.stroke = function () {
      if (cur && cur.pts.length && ((cur.arcs === 4 && cur.closed) || cur.rects === 1)) {
        outlines.push({ ...boxOf(this, cur.pts), lw: this.lineWidth * this.getTransform().a, style: String(this.strokeStyle).toLowerCase(), alpha: this.globalAlpha });
      }
      return keep.stroke.call(this);
    };
    P.fillText = function (str, x, y) {
      const m = this.getTransform();
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] || 0);
      const w = this.measureText(str).width;
      const size = px * m.d;
      const y0 = m.d * y + m.f - (this.textBaseline === 'middle' ? size * 0.5 : size * 0.72);
      const y1 = m.d * y + m.f + (this.textBaseline === 'middle' ? size * 0.5 : size * 0.2);
      let box = { x0: m.a * x + m.e, x1: m.a * (x + w) + m.e, y0, y1 };
      const c = clips[clips.length - 1];
      if (c) box = { x0: Math.max(box.x0, c.x0), x1: Math.min(box.x1, c.x1), y0: Math.max(box.y0, c.y0), y1: Math.min(box.y1, c.y1) };
      if (box.x1 > box.x0 && box.y1 - box.y0 > size * 0.25) texts.push({ str: String(str), ...box, size, scale: m.a, alpha: this.globalAlpha });
      return keep.fillText.apply(this, arguments);
    };
    const out = [];
    try {
      for (const t of ts) {
        texts = [];
        outlines = [];
        clips = [null];
        window.seek(t);
        out.push({ t, texts, outlines });
      }
    } finally { Object.assign(P, keep); }
    return out;
  }, times);
}

// Ink bounding box of a frame (fractions of the frame), from the runtime's own pixel read at 160 px wide.
async function inkBoxes(page, times) {
  return page.evaluate(async (ts) => {
    const out = [];
    for (const t of ts) {
      const b64 = await window.__studio.pixels(t, 160);
      const s = atob(b64);
      const d = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) d[i] = s.charCodeAt(i);
      const w = 160;
      const h = d.length / 4 / w;
      let x0 = w; let x1 = -1; let y0 = h; let y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (Math.max(Math.abs(d[i] - 20), Math.abs(d[i + 1] - 20), Math.abs(d[i + 2] - 19)) > 40) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      out.push({ t, top: y0 / h, bottom: (y1 + 1) / h, left: x0 / w, right: (x1 + 1) / w });
    }
    return out;
  }, times);
}

async function stepAcross(page, t, dt) {
  return page.evaluate(async ({ a, b }) => {
    const dec = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
    const p = dec(await window.__studio.pixels(a, 160));
    const q = dec(await window.__studio.pixels(b, 160));
    let sum = 0;
    for (let i = 0; i < p.length; i += 4) sum += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
    return sum / ((p.length / 4) * 3);
  }, { a: t - dt, b: t });
}

const ACCENT = '#d97757';
const isAccentOutline = (o) => o.style === ACCENT && o.lw >= 4 && o.alpha > 0.3;
// A text box (glyph run) against the four edges of an outline, drawn as bars of the stroke width.
function crossings(frame, only = () => true) {
  const found = [];
  const top = frame.texts.filter((x) => x.scale > 0.999 && x.alpha > 0.05 && only(x));
  for (const o of frame.outlines.filter(isAccentOutline)) {
    const h = o.lw / 2;
    const bars = [[o.x0 - h, o.y0 - h, o.x0 + h, o.y1 + h], [o.x1 - h, o.y0 - h, o.x1 + h, o.y1 + h], [o.x0 - h, o.y0 - h, o.x1 + h, o.y0 + h], [o.x0 - h, o.y1 - h, o.x1 + h, o.y1 + h]];
    for (const x of top) {
      for (const [bx0, by0, bx1, by1] of bars) {
        if (x.x0 < bx1 && x.x1 > bx0 && x.y0 < by1 && x.y1 > by0) found.push(`t=${frame.t.toFixed(3)} "${x.str}" (${x.x0.toFixed(0)}-${x.x1.toFixed(0)}, ${x.y0.toFixed(0)}-${x.y1.toFixed(0)}) crosses the outline edge (${bx0.toFixed(0)}-${bx1.toFixed(0)}, ${by0.toFixed(0)}-${by1.toFixed(0)})`);
      }
    }
  }
  return found;
}

test('demo film in the real runtime: no text under an outline, readable type, centred composition, no hard cut', { timeout: 420000 }, async (t) => {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-demo-'));
  fs.copyFileSync(path.join(TEMPLATE, 'studio.json'), path.join(root, 'studio.json'));
  fs.copyFileSync(path.join(TEMPLATE, 'index.html'), path.join(root, 'index.html'));
  fs.cpSync(path.join(TEMPLATE, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.cpSync(path.join(TEMPLATE, 'film'), path.join(root, 'film'), { recursive: true });
  fs.cpSync(path.join(TEMPLATE, 'assets', 'fonts'), path.join(root, 'assets', 'fonts'), { recursive: true });
  const link = path.join(root, 'node_modules');
  try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved via the template instead */ }
  const srv = await S.startServer(root);
  let browser = null;
  try {
    try { ({ browser } = await S.launchBrowser(root, S.loadConfig(root))); } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }
    const problems = []; // collected over the three formats so one run lists every defect
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const range = (a, b, step) => Array.from({ length: Math.round((b - a) / step) + 1 }, (_, i) => Math.round((a + i * step) * 1e4) / 1e4);
    for (const fmt of FORMATS) {
      const film = await S.openFilm(browser, srv.url, { format: fmt });
      try {
        check(film.errors.page.length === 0, `${fmt}: page errors ${JSON.stringify(film.errors.page)}`);

        // (a) the chart text is gone or clear of the outline while the plot turns into the frame; labels ride their frame.
        const early = await recordFrames(film.page, range(7.9, 8.4, 1 / 60));
        const clash = early.flatMap((f) => crossings(f));
        check(clash.length === 0, `${fmt}: chart text under the frame outline at the start of the formats shot: ${clash.slice(0, 2).join(' | ')}`);
        const labels = await recordFrames(film.page, range(8.0, 10.0, 1 / 30));
        const lab = labels.flatMap((f) => crossings(f, (x) => /^(9:16|1:1|16:9)$/.test(x.str)));
        check(lab.length === 0, `${fmt}: a format label crosses a frame outline: ${lab.slice(0, 2).join(' | ')}`);

        // (b) type: nothing drawn at full size is smaller than MIN_TYPE (springs scale a chip by 0.9995 at rest, hence the .5).
        const sizes = await recordFrames(film.page, range(0.25, 11.75, 0.25));
        const small = [];
        for (const f of sizes) for (const x of f.texts) if (x.scale > 0.999 && x.alpha > 0.05 && x.size < MIN_TYPE[fmt]) small.push(`t=${f.t} "${x.str}" ${x.size.toFixed(0)} px = ${((x.size * 360) / CANVAS_W[fmt]).toFixed(1)} px at 360 px wide`);
        check(small.length === 0, `${fmt}: type below ${MIN_TYPE[fmt]} px: ${small.slice(0, 4).join(', ')}`);

        // (c) composition: the ink box of every shot sits on the frame centre; 9:16 fills its lower part, inside the safe area.
        const boxes = await inkBoxes(film.page, [1.9, 5.9, 7.9, 9.9, 11.6]);
        for (const b of boxes) {
          const cy = (b.top + b.bottom) / 2;
          const cx = (b.left + b.right) / 2;
          check(cy > 0.45 && cy < 0.55, `${fmt} t=${b.t}: ink box centre y ${cy.toFixed(2)} outside 0.45-0.55 (top ${b.top.toFixed(2)}, bottom ${b.bottom.toFixed(2)})`);
          check(cx > 0.44 && cx < 0.56, `${fmt} t=${b.t}: ink box centre x ${cx.toFixed(2)} outside 0.44-0.56 (left ${b.left.toFixed(2)}, right ${b.right.toFixed(2)})`);
          if (fmt === '9x16') {
            check(b.bottom >= 0.76 && b.bottom <= 0.86, `9x16 t=${b.t}: ink ends at ${b.bottom.toFixed(2)} of the height, want 0.76-0.86 (lower third used, above the 16% safe margin)`);
            check(b.top >= 0.09, `9x16 t=${b.t}: ink starts at ${b.top.toFixed(2)}, inside the 10% top margin`);
          }
        }

        // (d) the hand-over into the lockup is a spring, not a cut: one frame at 60 fps changes the picture by < 4 grey levels.
        const step = await stepAcross(film.page, 10, 1 / 60);
        check(step < 4, `${fmt}: mean pixel step across 00:10.00 is ${step.toFixed(2)} (was 9.09 with the hard cut)`);
      } finally { await film.context.close(); }
    }
    assert.deepEqual(problems, [], 'demo film defects:' + ['', ...problems].join(String.fromCharCode(10)));
  } finally {
    if (browser) await browser.close();
    await srv.close();
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched');
  }
});
