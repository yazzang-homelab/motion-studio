// Regression: film text must be grayscale-antialiased. The stage canvas used to be created with alpha: false, an opaque
// canvas, on which Chrome draws LCD sub-pixel text: small type got red/blue fringes (found by the production E2E run:
// 1.15% of the non-background pixels of a decoded 1080x1920 final frame, 0% once the canvas is not opaque). The fringes
// depend on the OS text setting (ClearType, fontconfig), so they also made frame hashes machine dependent, and 4:2:0
// chroma subsampling smears them into visible colour noise. Two checks:
//  1. static (always runs): the stage context in lib/runtime.js asks for alpha: true and keeps willReadFrequently (CPU raster);
//  2. browser (skips without playwright or a browser): boot the real runtime on a tiny film that draws small Inter and
//     Instrument Serif text in near-neutral colours, read a frame through __studio.frame, and require zero chromatic
//     pixels (max - min channel > 24) while asserting the frame really has ink and antialiased edge pixels, so the
//     check cannot pass on an empty picture. On a machine whose Chrome never uses LCD text the browser check passes
//     with or without the fix; the static check is what guards that case.
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

test('runtime.js: the stage canvas is not opaque (no LCD text) and stays on the CPU raster path', () => {
  const src = fs.readFileSync(path.join(TEMPLATE, 'lib', 'runtime.js'), 'utf8');
  const stage = src.split('\n').filter((l) => /\bcanvas\.getContext\('2d'/.test(l));
  assert.equal(stage.length, 1, `exactly one stage getContext call (found ${stage.length})`);
  assert.match(stage[0], /alpha:\s*true/, 'alpha: true keeps text grayscale-antialiased (alpha: false enables LCD sub-pixel text)');
  assert.doesNotMatch(stage[0], /alpha:\s*false/);
  assert.match(stage[0], /willReadFrequently:\s*true/, 'willReadFrequently forces the software canvas (deterministic hashes)');
});

const FILM = `import { defineFilm, scene } from '../lib/timeline.js';
import { text } from '../lib/draw.js';
export default defineFilm(() => ({
  background: '#141413',
  scenes: [scene(0, 1, 'aa', (g) => {
    const ink = { color: '#F0EEE6' };
    text(g, 'Hamburgefonstiv 0123456789', 40, 120, { ...ink, size: 22, family: 'Inter', weight: 500 });
    text(g, 'The quick brown fox jumps over', 40, 200, { ...ink, size: 30, family: 'Inter', weight: 400 });
    text(g, 'Sphinx of black quartz', 40, 330, { ...ink, size: 48, family: 'Instrument Serif', weight: 400 });
    text(g, 'judge my vow', 40, 420, { ...ink, size: 27, family: 'Instrument Serif', weight: 400 });
  })],
}));
`;

test('boot the real runtime: small film text has no chromatic (LCD) pixels', { timeout: 180000 }, async (t) => {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-aa-'));
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ title: 'AA', duration: 1, fps: 10, subframes: 1, formats: ['1x1'], primaryFormat: '1x1', capture: 'canvas', gate: { enabled: false } }));
  fs.copyFileSync(path.join(TEMPLATE, 'index.html'), path.join(root, 'index.html'));
  fs.cpSync(path.join(TEMPLATE, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.cpSync(path.join(TEMPLATE, 'assets', 'fonts'), path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'film'));
  fs.writeFileSync(path.join(root, 'film', 'film.js'), FILM);
  const link = path.join(root, 'node_modules');
  try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved via the template instead */ }
  const srv = await S.startServer(root);
  let browser = null;
  try {
    try { ({ browser } = await S.launchBrowser(root, S.loadConfig(root))); } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }
    const film = await S.openFilm(browser, srv.url, { format: '1x1' });
    try {
      assert.deepEqual(film.errors.page, [], 'no page errors');
      const r = await film.page.evaluate(async () => {
        const attrs = document.getElementById('stage').getContext('2d').getContextAttributes();
        const url = await window.__studio.frame({ t: 0.5, sub: 1 });
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let ink = 0;
        let edge = 0;
        let chromatic = 0;
        let worst = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]);
          const mn = Math.min(d[i], d[i + 1], d[i + 2]);
          if (mx > 60) ink++;
          if (mx > 60 && mx < 200) edge++;
          if (mx - mn > 24) chromatic++;
          worst = Math.max(worst, mx - mn);
        }
        return { attrs: { alpha: attrs.alpha, willReadFrequently: attrs.willReadFrequently }, w: c.width, h: c.height, ink, edge, chromatic, worst };
      });
      // Pixels first: this is the invariant that matters; the context attributes below only explain a failure.
      assert.ok(r.w >= 1000 && r.h >= 1000, `a full-size frame (${r.w}x${r.h})`);
      assert.ok(r.ink > 300, `the frame has text ink (${r.ink} px)`);
      assert.ok(r.edge > 150, `the text has antialiased edge pixels, so the check is not vacuous (${r.edge} px)`);
      assert.equal(r.chromatic, 0, `grayscale antialiasing only: ${r.chromatic} chromatic pixel(s), worst channel spread ${r.worst} (stage context: ${JSON.stringify(r.attrs)})`);
      assert.equal(r.attrs.alpha, true, 'the stage context is not opaque');
      assert.equal(r.attrs.willReadFrequently, true, 'the stage context is the software canvas');
    } finally { await film.context.close(); }
  } finally {
    if (browser) await browser.close();
    await srv.close();
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched');
  }
});
