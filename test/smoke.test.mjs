// End-to-end smoke test (opt-in: SMOKE=1). Copies the film template into a temp project, links a node_modules that
// has playwright (+ optional ffmpeg-static), renders 1 s @ 12 fps sub 2 scale 0.25 twice (frame hashes must match),
// checks the mp4 (exact frame count, BT.709 tags), renders a hashed partial clip in two formats (its frames must be the
// full render's), then runs score/sfx/mix/critique/deliver when those tools exist.
// Env: MOTION_SMOKE_NODE_MODULES=<dir with playwright>  FFMPEG_PATH=<ffmpeg>  MOTION_CHROME_PATH=<browser>
//      MOTION_SMOKE_KEEP=1 keeps the temp project for inspection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(REPO, 'skills', 'studio-init', 'template');
const STEP_TIMEOUT = Number(process.env.MOTION_SMOKE_STEP_MS) || 15 * 60 * 1000;

/** The node_modules directory that provides playwright: env override, else whatever resolves from the repo or cwd. */
function findNodeModules() {
  const env = process.env.MOTION_SMOKE_NODE_MODULES;
  if (env) return fs.existsSync(path.join(env, 'playwright')) || fs.existsSync(path.join(env, 'playwright-core')) ? path.resolve(env) : null;
  for (const base of [path.join(REPO, 'package.json'), path.join(process.cwd(), 'package.json')]) {
    for (const name of ['playwright', 'playwright-core']) {
      try {
        const pkg = createRequire(base).resolve(`${name}/package.json`);
        return path.dirname(path.dirname(pkg));
      } catch { /* try the next base */ }
    }
  }
  return null;
}

function runTool(cwd, env, script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('tools', script), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), STEP_TIMEOUT);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const lastJson = (stdout) => {
  const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1);
  return line ? JSON.parse(line) : null;
};
const tail = (s, n = 15) => s.split('\n').slice(-n).join('\n');

function removeProject(dir) {
  // Remove the node_modules link itself first so the recursive delete can never walk into the shared target.
  const link = path.join(dir, 'node_modules');
  try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

const SMOKE = process.env.SMOKE === '1';

test('smoke: template renders, re-renders identically and flows through audio + QA tools', {
  skip: !SMOKE && 'set SMOKE=1 to run (needs playwright, a Chromium browser and ffmpeg)',
  timeout: 6 * STEP_TIMEOUT,
}, async (t) => {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable: npm install playwright ffmpeg-static, or set MOTION_SMOKE_NODE_MODULES'); return; }
  if (!fs.existsSync(path.join(TEMPLATE, 'lib', 'runtime.js')) || !fs.existsSync(path.join(TEMPLATE, 'film', 'film.js'))) {
    t.skip('template has no lib/runtime.js or film/film.js yet');
    return;
  }

  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-smoke-'));
  fs.cpSync(TEMPLATE, proj, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(path.relative(TEMPLATE, src)) });
  let linked = true;
  try { fs.symlinkSync(nm, path.join(proj, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
  // NODE_PATH is the fallback when a link cannot be made: tools resolve playwright/ffmpeg-static through createRequire.
  const env = { ...process.env, NODE_PATH: nm, DEBUG: '' };
  const cfgPath = path.join(proj, 'studio.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  Object.assign(cfg, { title: 'Smoke Test', duration: 1, fps: 12, subframes: 2, formats: ['9x16'], primaryFormat: '9x16' });
  cfg.gate = { ...(cfg.gate ?? {}), enabled: false };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  t.diagnostic(`project ${proj} (node_modules ${linked ? 'linked' : 'via NODE_PATH'} from ${nm})`);
  let failed = false;
  // node:test records a failing subtest without rejecting the await, so track failures to keep the project for debugging.
  const step = (name, ...rest) => {
    const fn = rest.pop();
    return t.test(name, rest[0] ?? {}, async (st) => { try { await fn(st); } catch (err) { failed = true; throw err; } });
  };

  try {
    const S = await import(pathToFileURL(path.join(proj, 'tools', 'studio.mjs')).href);
    const fmtDir = path.join(proj, 'out', '9x16');

    await step('render twice: identical frame hashes, exact frame count, BT.709', async () => {
      const args = ['--fps', '12', '--sub', '2', '--scale', '0.25', '--hash', '--json'];
      const a = await runTool(proj, env, 'render.mjs', args);
      assert.equal(a.code, 0, `render failed:\n${tail(a.stderr)}`);
      const ja = lastJson(a.stdout);
      assert.equal(ja?.ok, true);
      const first = fs.readFileSync(path.join(fmtDir, 'frames.sha256'), 'utf8');
      const b = await runTool(proj, env, 'render.mjs', [...args, '--workers', '1']);
      assert.equal(b.code, 0, `second render failed:\n${tail(b.stderr)}`);
      assert.equal(fs.readFileSync(path.join(fmtDir, 'frames.sha256'), 'utf8'), first, '4-worker and 1-worker renders give the same frames');
      assert.equal(first.trim().split('\n').length, 12);
      const meta = JSON.parse(fs.readFileSync(path.join(fmtDir, 'render.json'), 'utf8'));
      assert.equal(meta.frames, 12);
      assert.equal(meta.fps, 12);
      assert.equal(meta.duration, 1);
      assert.equal(meta.width % 2, 0);
      assert.equal(meta.height % 2, 0);
      assert.equal(meta.createdBy, 'motion-studio');
      assert.ok(meta.browser, 'browser version recorded');
      assert.ok(fs.statSync(path.join(fmtDir, 'poster.png')).size > 0);
      assert.ok(!fs.existsSync(path.join(fmtDir, '.staging')), 'staging removed');
      const probe = await S.run(S.resolveFfmpeg(proj), ['-hide_banner', '-i', path.join(fmtDir, 'silent.mp4'), '-f', 'null', '-'], { timeoutMs: 120000 });
      assert.equal(probe.code, 0, tail(probe.stderr));
      assert.match(probe.stderr, /yuv420p\(tv, bt709/);
      const frames = [...probe.stderr.matchAll(/frame=\s*(\d+)/g)].map((m) => Number(m[1])).at(-1);
      assert.equal(frames, 12, 'decoded frame count');
    });

    await step('partial range (several formats, --hash) writes clips whose frames are the full render frames', async () => {
      const before = fs.statSync(path.join(fmtDir, 'silent.mp4')).mtimeMs;
      const r = await runTool(proj, env, 'render.mjs', ['--fps', '12', '--sub', '2', '--scale', '0.25', '--from', '0.5', '--to', '1', '--draft', '--hash',
        '--format', '9x16,1x1', '--json', '--out', 'out/check']);
      assert.equal(r.code, 0, tail(r.stderr));
      const j = lastJson(r.stdout);
      assert.equal(j?.ok, true, JSON.stringify(j));
      assert.deepEqual(j.formats.map((f) => [f.format, f.partial, f.frames]), [['9x16', true, 6], ['1x1', true, 6]]);
      for (const f of ['9x16', '1x1']) {
        for (const ext of ['mp4', 'json', 'sha256']) assert.ok(fs.existsSync(path.join(proj, 'out', 'check', f, `clip_0.50-1.00.${ext}`)), `${f} clip .${ext}`);
      }
      // Same fps/sub/scale as the first render: clip frame i must be full-render frame 6 + i (time and pixels).
      const cols = (text) => text.trim().split('\n').map((l) => l.split(' ').slice(1).join(' '));
      const full = cols(fs.readFileSync(path.join(fmtDir, 'frames.sha256'), 'utf8')).slice(6, 12);
      assert.deepEqual(cols(fs.readFileSync(path.join(proj, 'out', 'check', '9x16', 'clip_0.50-1.00.sha256'), 'utf8')), full);
      assert.equal(fs.statSync(path.join(fmtDir, 'silent.mp4')).mtimeMs, before);
    });

    await step('stills contact sheet', async () => {
      const r = await runTool(proj, env, 'stills.mjs', ['--at', '0,0.5', '--width', '160', '--json']);
      assert.equal(r.code, 0, tail(r.stderr));
      assert.equal(lastJson(r.stdout)?.formats?.[0]?.stills?.length, 2);
      assert.ok(fs.statSync(path.join(proj, 'out', 'review', '9x16', 'contact.png')).size > 0);
    });

    const has = (f) => fs.existsSync(path.join(proj, 'tools', f));
    await step('score + sfx + mix', { skip: !(has('sfx.mjs') && has('mix.mjs')) && 'audio tools not present' }, async () => {
      if (has('score.mjs')) {
        const s = await runTool(proj, env, 'score.mjs', ['--if-missing']);
        assert.equal(s.code, 0, tail(s.stderr));
        assert.ok(fs.existsSync(path.join(proj, 'audio', 'music.wav')));
      }
      const x = await runTool(proj, env, 'sfx.mjs', []);
      assert.equal(x.code, 0, tail(x.stderr));
      assert.ok(fs.statSync(path.join(proj, 'audio', 'sfx.wav')).size > 44);
      const m = await runTool(proj, env, 'mix.mjs', ['--format', 'all']);
      assert.equal(m.code, 0, tail(m.stderr));
      for (const f of [path.join(fmtDir, 'final.mp4'), path.join(proj, 'out', 'final.mp4')]) assert.ok(fs.statSync(f).size > 0, f);
      const probe = await S.run(S.resolveFfmpeg(proj), ['-hide_banner', '-i', path.join(fmtDir, 'final.mp4'), '-f', 'null', '-'], { timeoutMs: 120000 });
      assert.match(probe.stderr, /Audio: /, 'final.mp4 has an audio stream');
    });

    await step('critique', { skip: !has('critique.mjs') && 'critique.mjs not present' }, async () => {
      const r = await runTool(proj, env, 'critique.mjs', ['--json']);
      assert.equal(r.code, 0, tail(r.stderr));
      for (const f of ['contact.png', 'metrics.json']) assert.ok(fs.existsSync(path.join(proj, 'out', 'review', '9x16', f)), f);
    });

    await step('deliver', { skip: !(has('deliver.mjs') && fs.existsSync(path.join(fmtDir, 'final.mp4'))) && 'deliver.mjs or final.mp4 missing' }, async (st) => {
      const r = await runTool(proj, env, 'deliver.mjs', ['--json']);
      // Exit 1 = a delivery check failed (reported, not a crash); anything else is a tool error.
      assert.ok(r.code === 0 || r.code === 1, `deliver exited ${r.code}:\n${tail(r.stderr)}`);
      if (r.code === 1) st.diagnostic(`deliver reported failing checks:\n${tail(r.stderr, 10)}`);
      assert.ok(fs.existsSync(path.join(proj, 'out', 'deliver', 'manifest.json')), 'manifest.json written');
    });
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (process.env.MOTION_SMOKE_KEEP === '1' || failed) t.diagnostic(`kept ${proj}`);
    else removeProject(proj);
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched by cleanup');
  }
});
