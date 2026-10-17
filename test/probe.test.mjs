// tools/probe.mjs and the runtime's probe API in real Chrome (skips without playwright / a browser): probeRun determinism,
// window.renderAt, ?render&t=, motion.png / onion.png, exit codes, the loop seam and the critique's checks section.
// Env: MOTION_SMOKE_NODE_MODULES (a node_modules with playwright), MOTION_TEMPLATE_DIR.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const made = [];
const rmDir = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
after(() => { for (const d of made.splice(0)) { try { rmDir(d); } catch { /* the OS temp cleanup takes it */ } } });
const pngSize = (file) => { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

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

const run = (cmd, args, opts) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1)); } catch { return null; } })() }));
});

// 2 s at 30 fps, 1x1: a square slides on a spring released at 0.5 s; a lamp switches on at frame 30.
const FILM = (checks, extra = '') => `import { defineFilm, scene } from '../lib/timeline.js';
import { sp, loopTrack, clamp } from '../lib/motion.js';
export default defineFilm((ctx) => ({
  background: '#141413',
  scenes: [
    scene(0, ctx.dur, 'main', (g, lt, c) => {
      const x = 100 + 600 * sp(c.t - 0.5, 'snappy');
      g.fillStyle = '#D97757';
      g.fillRect(x, 400, 200, 200);
      const lamp = c.t >= 1 ? 1 : 0;
      g.fillStyle = lamp ? '#F0EEE6' : '#333';
      g.fillRect(900, 100, 80, 80);
      c.probe('square.x', x);
      c.probe('lamp', lamp > 0);
      c.probe('pos', [x, 400]);
      ${extra}
    }),
  ],
  checks: ${checks},
}));
`;

async function withProject(t, { film, studio: extra = {} }, body) {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-probe-'));
  made.push(root);
  fs.cpSync(TEMPLATE, root, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(src) });
  const studio = JSON.parse(fs.readFileSync(path.join(root, 'studio.json'), 'utf8'));
  Object.assign(studio, { title: 'Probe Test', duration: 2, fps: 30, subframes: 1, formats: ['1x1'], primaryFormat: '1x1', gate: { enabled: false } }, extra);
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify(studio, null, 2));
  fs.writeFileSync(path.join(root, 'film', 'film.js'), film);
  const link = path.join(root, 'node_modules');
  try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved through NODE_PATH */ }
  const env = { ...process.env, DEBUG: '', NODE_PATH: nm, MOTION_CLOSE_TIMEOUT_MS: '3000' };
  try {
    const S = await import(pathToFileURL(path.join(root, 'tools', 'studio.mjs')).href);
    let browser;
    try { ({ browser } = await S.launchBrowser(root, S.loadConfig(root))); } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }
    const server = await S.startServer(root);
    try {
      await body({ root, S, browser, server, tool: (name, args) => run(process.execPath, [path.join(root, 'tools', name), ...args], { cwd: root, env }), review: path.join(root, 'out', 'review', '1x1') });
    } finally {
      await browser.close().catch(() => {});
      await Promise.resolve(server.close()).catch(() => {});
    }
  } finally {
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
    try { rmDir(root); } catch { /* the after() hook retries */ }
  }
}

const PASSING = `[
    { name: 'lamp on at 1 s', probe: 'lamp', crosses: 0.5, dir: 'up', frame: 30 },
    { name: 'square rests before release', probe: 'square.x', at: 0.4, eq: 100 },
    { name: 'square arrives', probe: 'square.x', from: 1.6, to: 2, min: 690, max: 710 },
    { name: 'square glides', probe: 'square.x', kind: 'smooth' },
  ]`;

test('runtime: probeRun is deterministic and matches probes(t); renderAt is seek; ?render&t= paints that time', { timeout: 300000 }, async (t) => {
  await withProject(t, { film: FILM(PASSING) }, async ({ S, browser, server }) => {
    const film = await S.openFilm(browser, server.url, { format: '1x1', scale: 0.25 });
    try {
      const r = await film.page.evaluate(() => {
        const S2 = window.__studio;
        const a = S2.probeRun();
        const b = S2.probeRun({ from: 0.5, to: 1 });
        return { a, b, one: S2.probes(0.6), same: window.renderAt === window.seek && S2.renderAt === window.seek, checks: S2.checks() };
      });
      assert.equal(r.same, true);
      assert.equal(r.a.frames, 60);
      assert.equal(r.a.fps, 30);
      assert.deepEqual(r.a.names, ['lamp', 'pos.x', 'pos.y', 'square.x']);
      assert.equal(r.a.series.lamp[29], 0);
      assert.equal(r.a.series.lamp[30], 1);
      assert.equal(r.b.k0, 15);
      assert.equal(r.b.frames, 15);
      assert.deepEqual(r.b.series['square.x'], r.a.series['square.x'].slice(15, 30), 'a range run gives the same values (no state between paints)');
      assert.equal(r.one['square.x'], r.a.series['square.x'][18]);
      assert.equal(r.checks.length, 4);
      assert.equal(r.checks[0].kind, 'event');
    } finally { await film.context.close(); }
    // ?render&t=1.5 shows frame 1.5 s straight after boot (no seek call)
    const at = await S.openFilm(browser, server.url, { format: '1x1', scale: 0.25, query: { t: 1.5 } });
    try {
      const px = await at.page.evaluate(async () => {
        const c = document.querySelector('canvas');
        const boot = c.toDataURL();
        return { boot, t15: await window.__studio.frame({ t: 1.5 }), t0: await window.__studio.frame({ t: 0 }) };
      });
      assert.equal(px.boot, px.t15);
      assert.notEqual(px.boot, px.t0);
    } finally { await at.context.close(); }
  });
});

test('probe CLI: checks pass → exit 0, probes.json + motion.png + onion.png; a failing check → exit 1 with the frame', { timeout: 300000 }, async (t) => {
  await withProject(t, { film: FILM(PASSING) }, async ({ root, tool, review }) => {
    const r = await tool('probe.mjs', ['--json', '--onion', '0.4:1.2:4']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.checks, { total: 4, passed: 4, failed: 0, skipped: 0 });
    assert.deepEqual(r.json.images, { motion: 'motion.png', onion: 'onion.png' });
    const doc = JSON.parse(fs.readFileSync(path.join(review, 'probes.json'), 'utf8'));
    assert.equal(doc.series.lamp.length, 60);
    assert.equal(doc.checks.length, 4);
    // 4 channels: the checked probes first (lamp, square.x), then pos.x, pos.y
    assert.deepEqual(pngSize(path.join(review, 'motion.png')), { w: 1600, h: 104 + 4 * 126 + 46 });
    const on = pngSize(path.join(review, 'onion.png'));
    assert.equal(on.w, 900, '1x1 at 900 px wide');
    assert.ok(on.h > 900, 'frame plus the legend');
    const txt = await tool('probe.mjs', ['--channels', 'pos']);
    assert.equal(txt.code, 0);
    assert.match(txt.stdout, /PASS +f30 +lamp on at 1 s/);
    assert.deepEqual(pngSize(path.join(review, 'motion.png')), { w: 1600, h: 104 + 2 * 126 + 46 }, '--channels pos = pos.x, pos.y');
    // a check one frame early fails with the measured frame
    fs.writeFileSync(path.join(root, 'film', 'film.js'), FILM(`[{ name: 'lamp early', probe: 'lamp', crosses: 0.5, frame: 29 }, { probe: 'ghost', at: 1, eq: 0 }]`));
    const bad = await tool('probe.mjs', ['--json']);
    assert.equal(bad.code, 1, bad.stderr);
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.results[0].detail, /at frame 30 .*1 frame\(s\) late/);
    assert.match(bad.json.results[1].detail, /probe "ghost" was never recorded/);
    // usage errors
    const u = await tool('probe.mjs', ['--onion', '2:1']);
    assert.equal(u.code, 2);
    assert.match(u.stderr, /--onion: need 0 <= A < B/);
  });
});

test('probe CLI: loop films get a seam analysis per probe (value and velocity)', { timeout: 300000 }, async (t) => {
  const film = FILM('[]', `c.probe('loop', loopTrack(c.t, [[0, 0], [0.5, 1], [2, 0]], 2));
      c.probe('ramp', c.t / 2);`);
  await withProject(t, { film, studio: { loop: true } }, async ({ tool }) => {
    const r = await tool('probe.mjs', ['--json']);
    assert.equal(r.code, 1, r.stderr);
    const seam = Object.fromEntries(r.json.seam.map((s) => [s.probe, s]));
    assert.equal(seam.loop.pass, true, seam.loop.detail);
    assert.equal(seam.ramp.pass, false);
    assert.match(seam.ramp.detail, /does not return to its frame-0 value/);
    const range = await tool('probe.mjs', ['--json', '--from', '0.5']);
    assert.equal(range.code, 0, 'a range never checks the seam');
    assert.deepEqual(range.json.seam, []);
  });
});

test('critique (live): a film with checks gets metrics checks and a P0 per failing check; a film without checks has no checks key', { timeout: 600000 }, async (t) => {
  await withProject(t, { film: FILM(`[{ name: 'lamp early', probe: 'lamp', crosses: 0.5, frame: 25 }, { probe: 'square.x', at: 0.4, eq: 100 }]`) }, async ({ root, tool, review }) => {
    const r = await tool('critique.mjs', ['--json', '--no-determinism']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.checks, 'fail');
    const p0 = r.json.findings.filter((f) => f.metric === 'checks');
    assert.equal(p0.length, 1);
    assert.equal(p0[0].severity, 'P0');
    assert.match(p0[0].text, /check failed: "lamp early" .*5 frame\(s\) late/);
    const m = JSON.parse(fs.readFileSync(path.join(review, 'metrics.json'), 'utf8'));
    assert.equal(m.checks.total, 2);
    assert.equal(m.checks.passed, 1);
    assert.match(fs.readFileSync(path.join(review, 'metrics.md'), 'utf8'), /\| checks \| FAIL \| 1\/2 numeric checks pass/);
    fs.writeFileSync(path.join(root, 'film', 'film.js'), FILM('[]'));
    const clean = await tool('critique.mjs', ['--json', '--no-determinism']);
    assert.equal(clean.code, 0, clean.stderr);
    assert.equal('checks' in clean.json.summary, false);
    const m2 = JSON.parse(fs.readFileSync(path.join(review, 'metrics.json'), 'utf8'));
    assert.equal('checks' in m2, false);
    assert.doesNotMatch(fs.readFileSync(path.join(review, 'metrics.md'), 'utf8'), /\| checks \||tools\/probe\.mjs/);
  });
});
