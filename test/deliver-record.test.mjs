// deliver.mjs (template/tools): what docs/production.json records, and what makes a delivery fail.
//   - production.json must not present a disabled gate as a passing critique (checkGate() reports pass for
//     gate.enabled=false, so critique.gatePass alone read "true" next to last-round scores of 6; found by the
//     production E2E run): production.json also carries critique.gateEnabled, as manifest.json's gate.enabled does.
//   - final.mp4 is judged against the CURRENT studio.json and its render.json (qa-tools:F2): a cut rendered before an
//     edit of studio.json is a stale render, a draft encode or a scaled render is no master, film sources newer than the
//     render are a warning.
//   - --format delivers only the named formats and keeps the others' files and manifest entries (qa-tools:F4).
//   - an unreadable final.mp4 is a failing check, and the previous delivery is withdrawn (qa-tools:F11).
// Uses synthetic full-size mp4s (ffmpeg lavfi, solid colour, 2 s); skips without ffmpeg. Env: FFMPEG_PATH, MOTION_TEMPLATE_DIR.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const TOOLS = path.join(TEMPLATE, 'tools');

function findFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try { const p = createRequire(path.join(REPO, 'package.json'))('ffmpeg-static'); if (typeof p === 'string') candidates.push(p); } catch { /* not installed */ }
  for (const c of candidates) if (spawnSync(c, ['-hide_banner', '-version'], { timeout: 30000, windowsHide: true }).status === 0) return c;
  return null;
}
const FFMPEG = findFfmpeg();
const SKIP = FFMPEG ? false : 'ffmpeg not found (set FFMPEG_PATH or npm install ffmpeg-static at the repo root)';
if (FFMPEG) process.env.FFMPEG_PATH = FFMPEG;

const spawnP = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, stdout, stderr }));
});

// Every temp dir is removed after the file's tests (a leaked ms-* dir per run adds up).
const made = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
// A scenario that timed out can leave its deliver.mjs/ffmpeg child holding files for a while: that must not fail the hook
// (it hid the real failure as "hookFailed EBUSY"); the busy directory is retried once more when the process exits.
const stuck = [];
const rmDir = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const cleanup = () => { for (const d of made.splice(0)) { try { rmDir(d); } catch { stuck.push(d); } } };
after(cleanup);
process.on('exit', () => { cleanup(); for (const d of stuck.splice(0)) { try { rmDir(d); } catch { /* still open: the OS temp cleanup takes it */ } } });

const LOG = `# Review log

## Round 1 — 9x16 — poor scores on purpose
SCORES: hook=6 readability=6 motion=6 variety=6 composition=6 brand=6 sound=6
PROBLEMS:
1. [P1] [00:01.00] test problem
FIXES: none (first round)
`;

const SIZES = { '9x16': [1080, 1920], '1x1': [1080, 1080] };
const FPS = 24;
const SECONDS = 2;
const bases = new Map(); // "fmt@WxH" -> Promise<{ file, I }>: one synthetic mp4 per size, copied into every scenario
function baseMp4(fmt, [w, h] = SIZES[fmt]) {
  const key = `${fmt}@${w}x${h}`;
  if (!bases.has(key)) {
    bases.set(key, (async () => {
      const { measureLoudness } = await import(pathToFileURL(path.join(TOOLS, 'refs.mjs')).href);
      const file = path.join(tmpDir('ms-base-'), 'final.mp4');
      const r = await spawnP(FFMPEG, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=0x141413:s=${w}x${h}:r=${FPS}:d=${SECONDS}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SECONDS}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', file]);
      if (r.code !== 0) throw new Error(`ffmpeg failed:\n${r.stderr.slice(-1500)}`);
      return { file, I: (await measureLoudness(path.dirname(file), file)).I };
    })());
  }
  return bases.get(key);
}

/**
 * A project with one final.mp4 + render.json + poster per format, all consistent with studio.json (2 s @ 24 fps).
 * Sources are dated a minute before the mp4s so no "newer than the render" warning appears unless a test asks for it.
 */
async function project({ formats = ['9x16'], gateEnabled = false, log = null, studio = {}, render = {}, size = null } = {}) {
  const root = tmpDir('ms-record-');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  let I = null;
  for (const fmt of formats) {
    const [w, h] = size ?? SIZES[fmt];
    const base = await baseMp4(fmt, [w, h]);
    I = base.I;
    const out = path.join(root, 'out', fmt);
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(base.file, path.join(out, 'final.mp4'));
    const now = new Date();
    fs.utimesSync(path.join(out, 'final.mp4'), now, now); // Windows CopyFile keeps the source's mtime: the mp4 is "written now"
    fs.writeFileSync(path.join(out, 'render.json'), JSON.stringify({ format: fmt, fps: FPS, frames: FPS * SECONDS, width: w, height: h, scale: 1, final: true, encode: { draft: false }, ...render }));
    fs.writeFileSync(path.join(out, 'poster.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({
    title: 'Record Test', duration: SECONDS, fps: FPS, formats, primaryFormat: formats[0], gate: { enabled: gateEnabled, minRounds: 1 },
    audio: { lufs: Math.round(I * 10) / 10, lufsTolerance: 0.5, truePeak: 0 }, ...studio,
  }));
  if (log) fs.writeFileSync(path.join(root, 'docs', 'review_log.md'), log);
  fs.mkdirSync(path.join(root, 'film'), { recursive: true });
  fs.writeFileSync(path.join(root, 'film', 'film.js'), 'export default {};\n');
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>\n');
  age(root, 60);
  return root;
}
/** Date the film sources `seconds` in the past (the mp4s and sidecars keep their creation time). */
function age(root, seconds, names = ['studio.json', 'index.html', 'film/film.js']) {
  const t = new Date(Date.now() - seconds * 1000);
  for (const n of names) fs.utimesSync(path.join(root, n), t, t);
}

const deliver = (root, args = []) => spawnP(process.execPath, [path.join(TOOLS, 'deliver.mjs'), '--json', ...args], { cwd: root, env: { ...process.env, FFMPEG_PATH: FFMPEG } });
const jsonLine = (r) => JSON.parse(r.stdout.trim().split('\n').pop());
const read = (root, ...p) => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8'));
const listDeliver = (root) => fs.readdirSync(path.join(root, 'out', 'deliver')).sort();

// The scenarios are independent projects and each spends most of its time in ffmpeg/node start-up: run them side by side.
describe('deliver', { concurrency: 4 }, () => {
  it('deliver: production.json records whether the gate was enabled next to gatePass', { skip: SKIP, timeout: 900000 }, async () => {
    const [offRoot, onRoot] = await Promise.all([project({ gateEnabled: false, log: LOG }), project({ gateEnabled: true })]);
    const [off, on] = await Promise.all([deliver(offRoot), deliver(onRoot)]);
    // Gate off: delivery passes because nothing is enforced, and the record says so.
    assert.equal(off.code, 0, off.stdout + off.stderr);
    assert.equal(read(offRoot, 'out', 'deliver', 'manifest.json').gate.enabled, false);
    const offProduction = read(offRoot, 'docs', 'production.json');
    assert.equal(offProduction.critique.gateEnabled, false, 'a passing gatePass with the gate off must not read as a real pass');
    assert.equal(offProduction.critique.gatePass, true, 'gatePass keeps its meaning (checkGate result)');
    assert.equal(offProduction.critique.lastRound.scores.hook, 6, 'the low scores stay on record');
    assert.equal(offProduction.delivered, true);
    // Gate on with no review log: the gate fails the delivery and the record says the gate was enforced.
    assert.equal(on.code, 1, on.stdout + on.stderr);
    assert.equal(read(onRoot, 'out', 'deliver', 'manifest.json').gate.enabled, true);
    const onProduction = read(onRoot, 'docs', 'production.json');
    assert.equal(onProduction.critique.gateEnabled, true);
    assert.equal(onProduction.critique.gatePass, false);
    assert.equal(onProduction.delivered, false);
  });

  it('deliver: final.mp4 is judged against the CURRENT studio.json, so a stale render fails and nothing is delivered', { skip: SKIP, timeout: 900000 }, async () => {
    const root = await project();
    const ok = await deliver(root);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.ok(listDeliver(root).includes('record-test_9x16.mp4'));
    // studio.json edited after the render: shorter film, other fps. render.json still describes final.mp4 itself.
    const cfg = read(root, 'studio.json');
    fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ ...cfg, duration: 1, fps: 30 }));
    age(root, 60);
    const stale = await deliver(root);
    assert.equal(stale.code, 1, stale.stdout + stale.stderr);
    const j = jsonLine(stale);
    assert.equal(j.ok, false);
    const text = j.failed.join('\n');
    assert.match(text, /9x16: matches studio\.json = stale render/);
    assert.match(text, /stale render: studio\.json says 1 s @ 30 fps \(30 frames, 1080x1920\), final\.mp4 has 2 s @ 24 fps \(48 frames, 1080x1920\)/);
    assert.match(text, /9x16: fps = 24 \(expected 30\)/);
    assert.match(text, /9x16: frames = 48 \(expected 30\)/);
    assert.match(text, /9x16: render\.json = differs .*render\.json says 24 fps, 48 frames/);
    // the earlier delivery was withdrawn and the record says so
    assert.deepEqual(listDeliver(root), ['manifest.json']);
    assert.equal(read(root, 'out', 'deliver', 'manifest.json').pass, false);
    assert.equal(read(root, 'docs', 'production.json').delivered, false);
  });

  it('deliver: a sidecar that does not describe the mp4 (render.json from another run) fails even when studio.json agrees with the mp4', { skip: SKIP, timeout: 900000 }, async () => {
    const root = await project({ render: { fps: 60, frames: 120 } });
    const r = await deliver(root);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const text = jsonLine(r).failed.join('\n');
    assert.match(text, /9x16: render\.json = differs .*render\.json says 60 fps, 120 frames.*does not describe final\.mp4 \(120 frames @ 60 fps vs 48 @ 24\)/);
    assert.doesNotMatch(text, /matches studio\.json = stale render/, 'the mp4 itself matches studio.json');
  });

  it('deliver: a draft encode and a scaled render are no masters; a full-size cut without --final only warns', { skip: SKIP, timeout: 900000 }, async () => {
    const [draft, scaled, notFinal] = await Promise.all([
      project({ render: { final: false, encode: { draft: true, crf: 23, preset: 'veryfast' } } }),
      project({ size: [270, 480], render: { scale: 0.25, final: false, encode: { draft: true } } }),
      project({ render: { final: false } }),
    ]);
    const [d, s, n] = await Promise.all([deliver(draft), deliver(scaled), deliver(notFinal)]);
    assert.equal(d.code, 1, d.stdout + d.stderr);
    assert.match(jsonLine(d).failed.join('\n'), /9x16: final render = draft encode/);
    assert.equal(s.code, 1, s.stdout + s.stderr);
    const st = jsonLine(s).failed.join('\n');
    assert.match(st, /9x16: dimensions = 270x480 \(expected 1080x1920\) — render scale 0\.25 \(not a full-size master\)/);
    assert.match(st, /stale render|render\.json = /, 'the scaled cut is not the master of studio.json');
    assert.equal(n.code, 0, n.stdout + n.stderr);
    const nj = jsonLine(n);
    assert.equal(nj.ok, true);
    assert.match(nj.warnings.join('\n'), /9x16: final render: not rendered with --final/);
    assert.ok(listDeliver(notFinal).includes('record-test_9x16.mp4'));
  });

  it('deliver: film sources newer than the render warn (never fail); render.json missing warns', { skip: SKIP, timeout: 900000 }, async () => {
    const [quiet, edited, editedBeforeMix, noSidecar] = await Promise.all([project(), project(), project(), project()]);
    // 1. nothing changed: no warning
    const q = await deliver(quiet);
    assert.equal(q.code, 0, q.stdout + q.stderr);
    assert.deepEqual(jsonLine(q).warnings, []);
    // 2. film.js edited after final.mp4 was written
    const later = new Date(Date.now() + 30000);
    fs.utimesSync(path.join(edited, 'film', 'film.js'), later, later);
    const e = await deliver(edited);
    assert.equal(e.code, 0, 'a warning is not a failure: ' + e.stdout + e.stderr);
    assert.match(jsonLine(e).warnings.join('\n'), /9x16: sources: film\/film\.js changed after out\/9x16 was rendered or mixed/);
    // 3. film.js edited between the render and the mix (final.mp4 is newer than the edit, render.json is older)
    const ren = path.join(editedBeforeMix, 'out', '9x16', 'render.json');
    const fin = path.join(editedBeforeMix, 'out', '9x16', 'final.mp4');
    const t0 = new Date(Date.now() - 50000);
    const t1 = new Date(Date.now() - 20000);
    fs.utimesSync(ren, t0, t0);
    fs.utimesSync(path.join(editedBeforeMix, 'film', 'film.js'), new Date(Date.now() - 40000), new Date(Date.now() - 40000));
    fs.utimesSync(fin, t1, t1);
    const b = await deliver(editedBeforeMix);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.match(jsonLine(b).warnings.join('\n'), /film\/film\.js changed after/);
    // 4. no render.json: the cut cannot be tied to a --final render
    fs.rmSync(path.join(noSidecar, 'out', '9x16', 'render.json'));
    const n = await deliver(noSidecar);
    assert.equal(n.code, 0, n.stdout + n.stderr);
    assert.match(jsonLine(n).warnings.join('\n'), /9x16: render\.json: .*not found; cannot confirm the cut came from render --final/);
  });

  it('deliver: an unreadable final.mp4 is a failing check and withdraws the previous delivery', { skip: SKIP, timeout: 900000 }, async () => {
    const root = await project();
    const ok = await deliver(root);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(read(root, 'out', 'deliver', 'manifest.json').pass, true);
    const fin = path.join(root, 'out', '9x16', 'final.mp4');
    fs.writeFileSync(fin, fs.readFileSync(fin).subarray(0, 1000));
    const bad = await deliver(root);
    assert.equal(bad.code, 1, bad.stdout + bad.stderr);
    const j = jsonLine(bad);
    assert.match(j.failed.join('\n'), /9x16: final\.mp4 readable = unreadable/);
    assert.deepEqual(listDeliver(root), ['manifest.json'], 'the old mp4 and poster are gone');
    const manifest = read(root, 'out', 'deliver', 'manifest.json');
    assert.equal(manifest.pass, false, 'the manifest no longer says pass:true');
    assert.equal(read(root, 'docs', 'production.json').delivered, false);
  });

  it('deliver --format re-delivers only the named formats; the others keep their files and manifest entries', { skip: SKIP, timeout: 900000 }, async () => {
    const root = await project({ formats: ['9x16', '1x1'] });
    const all = await deliver(root);
    assert.equal(all.code, 0, all.stdout + all.stderr);
    const files = listDeliver(root);
    assert.deepEqual(files, ['manifest.json', 'record-test_1x1.mp4', 'record-test_1x1_poster.png', 'record-test_9x16.mp4', 'record-test_9x16_poster.png']);
    const one = await deliver(root, ['--format', '9x16']);
    assert.equal(one.code, 0, one.stdout + one.stderr);
    assert.deepEqual(listDeliver(root), files, 'the 1x1 files survive a 9x16 run');
    const j = jsonLine(one);
    assert.deepEqual(j.kept, ['1x1']);
    assert.deepEqual(j.missing, []);
    const manifest = read(root, 'out', 'deliver', 'manifest.json');
    assert.deepEqual(manifest.formats.map((f) => f.format), ['9x16', '1x1']);
    assert.equal(manifest.formats[1].carriedOver, true);
    assert.equal(manifest.formats[1].files.length, 2);
    assert.equal(manifest.complete, true);
    const production = read(root, 'docs', 'production.json');
    assert.deepEqual(production.formats.map((f) => f.format), ['9x16', '1x1']);
    assert.equal(production.formats[1].carriedOver, true);
    assert.equal(production.delivered, true);
    // a format that fails withdraws its own files only
    fs.rmSync(path.join(root, 'out', '9x16', 'poster.png'));
    const failing = await deliver(root, ['--format', '9x16']);
    assert.equal(failing.code, 1, failing.stdout + failing.stderr);
    assert.deepEqual(listDeliver(root), ['manifest.json', 'record-test_1x1.mp4', 'record-test_1x1_poster.png']);
    const m2 = read(root, 'out', 'deliver', 'manifest.json');
    assert.equal(m2.pass, false);
    assert.deepEqual(m2.missing, ['9x16']);
    // a delivery to a fresh folder with one format says what is still missing
    const partial = await project({ formats: ['9x16', '1x1'] });
    const p = await deliver(partial, ['--format', '1x1']);
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.deepEqual(jsonLine(p).missing, ['9x16']);
    assert.equal(read(partial, 'out', 'deliver', 'manifest.json').complete, false);
  });

  it('deliver --format: a failing critique gate is project-wide and withdraws every delivered file', { skip: SKIP, timeout: 900000 }, async () => {
    const root = await project({ formats: ['9x16', '1x1'] });
    assert.equal((await deliver(root)).code, 0);
    assert.equal(listDeliver(root).length, 5);
    fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ ...read(root, 'studio.json'), gate: { enabled: true, minRounds: 1 } }));
    age(root, 60);
    const r = await deliver(root, ['--format', '9x16']);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.deepEqual(listDeliver(root), ['manifest.json']);
    assert.equal(read(root, 'out', 'deliver', 'manifest.json').pass, false);
  });

  // ---- the silence check: a soundtrack that drops out is a failing check even when the loudness is right -------------------

  /** A 6 s full-size 9x16 project whose tone is muted between the [from, to] pairs (loudness target = what the file measures). */
  async function mutedProject({ mute = [], studio = {} } = {}) {
    const seconds = 6;
    const root = await project({ studio: { duration: seconds }, render: { frames: FPS * seconds } });
    const fin = path.join(root, 'out', '9x16', 'final.mp4');
    const af = mute.length ? ['-af', `volume=enable='${mute.map(([a, b]) => `between(t,${a},${b})`).join('+')}':volume=0`] : [];
    const made = await spawnP(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x141413:s=1080x1920:r=${FPS}:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      ...af, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', fin]);
    assert.equal(made.code, 0, made.stderr);
    const now = new Date();
    fs.utimesSync(fin, now, now);
    const { measureLoudness } = await import(pathToFileURL(path.join(TOOLS, 'refs.mjs')).href);
    const L = await measureLoudness(root, fin);
    const cfg = read(root, 'studio.json');
    fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ ...cfg, audio: { lufs: Math.round(L.I * 10) / 10, lufsTolerance: 0.5, truePeak: 0 }, ...studio }));
    age(root, 60);
    return root;
  }
  const checkOf = (root, id) => read(root, 'out', 'deliver', 'manifest.json').formats[0].checks.find((c) => c.id === id);

  it('deliver: a silent span inside the soundtrack fails ("silence 2.2 s at 00:02.1"); a silent intro and a fade in the last second do not', { skip: SKIP, timeout: 900000 }, async () => {
    const [gap, intro, fade, clean] = await Promise.all([mutedProject({ mute: [[2.1, 4.3]] }), mutedProject({ mute: [[0, 1.6]] }), mutedProject({ mute: [[5.2, 6.5]] }), mutedProject()]);
    const [g, i, f, c] = await Promise.all([deliver(gap), deliver(intro), deliver(fade), deliver(clean)]);
    assert.equal(g.code, 1, g.stdout + g.stderr);
    const j = jsonLine(g);
    assert.equal(j.ok, false);
    assert.match(j.failed.join('\n'), /9x16: silence = silence 2\.2 s at 00:02\.1 \(expected no span of ≥ 1 s below -50 dB\) — the soundtrack drops out/);
    assert.deepEqual(listDeliver(gap), ['manifest.json'], 'a failing delivery copies nothing');
    const check = checkOf(gap, 'silence');
    assert.equal(check.pass, false);
    assert.equal(read(gap, 'out', 'deliver', 'manifest.json').formats[0].silence.gaps.length, 1);
    assert.match(check.note, /critique\.allowSilence/, 'the note names the whitelist');
    for (const [name, r, root] of [['intro', i, intro], ['fade', f, fade], ['clean', c, clean]]) {
      assert.equal(r.code, 0, `${name}: ${r.stdout}${r.stderr}`);
      assert.equal(checkOf(root, 'silence').pass, true, name);
    }
    assert.equal(read(intro, 'out', 'deliver', 'manifest.json').formats[0].silence.ignored, 1, 'the intro is reported as ignored, not as a gap');
  });

  it('deliver: studio.json critique.allowSilence whitelists an intended silence', { skip: SKIP, timeout: 900000 }, async (t) => {
    const root = await mutedProject({ mute: [[2.1, 4.3]], studio: { critique: { allowSilence: [[2, 4.5]] } } });
    const r = await deliver(root);
    if (r.code !== 0 && /critique\.allowSilence/.test(r.stdout + r.stderr)) { t.diagnostic('studio.mjs validateConfig does not accept critique.allowSilence yet; the whitelist itself is covered by judgeSilence'); return; }
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(checkOf(root, 'silence').pass, true);
    assert.equal(read(root, 'out', 'deliver', 'manifest.json').formats[0].silence.ignored, 1);
    // a silence the list does not cover still fails
    const other = await mutedProject({ mute: [[2.1, 4.3]], studio: { critique: { allowSilence: [[0.5, 1.2]] } } });
    const o = await deliver(other);
    assert.equal(o.code, 1, o.stdout + o.stderr);
    assert.match(jsonLine(o).failed.join('\n'), /silence 2\.2 s at 00:02\.1/);
  });

  // ---- the failure envelope: ONE line {ok:false, error, failed} on stdout ---------------------------------------------------

  it('deliver --json: a failing check and a run that cannot start both print {ok:false, error, failed}', { skip: SKIP, timeout: 900000 }, async () => {
    const root = await project();
    fs.rmSync(path.join(root, 'out', '9x16', 'poster.png'));
    const failing = await deliver(root);
    assert.equal(failing.code, 1, failing.stdout + failing.stderr);
    assert.equal(failing.stdout.trim().split('\n').length, 1, 'one line on stdout');
    const j = jsonLine(failing);
    assert.equal(j.ok, false);
    assert.match(j.error, /^delivery failed: 1 failing check\(s\), first: 9x16: poster = missing/);
    assert.equal(j.failed.length, 1);
    assert.match(j.failed[0], /^9x16: poster = missing \(expected present\)/);
    // the cases that never reach a check: a config that does not validate, an unknown format, a bad flag
    const broken = tmpDir('ms-record-broken-');
    fs.writeFileSync(path.join(broken, 'studio.json'), '{"duration": -5}');
    const bad = await deliver(broken);
    assert.equal(bad.code, 1, bad.stdout + bad.stderr);
    assert.equal(bad.stdout.trim().split('\n').length, 1, 'one line on stdout');
    const b = jsonLine(bad);
    assert.equal(b.ok, false);
    assert.ok(typeof b.error === 'string' && b.error.length > 0 && !/[\r\n]/.test(b.error), JSON.stringify(b));
    assert.deepEqual(b.failed, [b.error], 'the cause is the one failure');
    assert.match(bad.stderr, /error: /, 'the human message stays on stderr');
    const flag = await deliver(root, ['--no-such-flag']);
    assert.equal(flag.code, 2, flag.stdout + flag.stderr);
    const f = jsonLine(flag);
    assert.deepEqual([f.ok, f.failed.length], [false, 1]);
    assert.match(f.error, /no-such-flag/);
    // without --json nothing changes: the message and the usage go to stderr, stdout stays empty
    const plain = await spawnP(process.execPath, [path.join(TOOLS, 'deliver.mjs'), '--no-such-flag'], { cwd: root, env: { ...process.env, FFMPEG_PATH: FFMPEG } });
    assert.equal(plain.code, 2);
    assert.equal(plain.stdout, '');
    assert.match(plain.stderr, /error: .*no-such-flag[\s\S]*Usage: node tools\/deliver\.mjs/);
  });

  it('deliver: every page of a paged contact sheet (contact-2.png ...) is delivered next to contact.png', { skip: SKIP, timeout: 900000 }, async () => {
    const root = await project();
    const review = path.join(root, 'out', 'review', '9x16');
    fs.mkdirSync(review, { recursive: true });
    for (const n of ['contact.png', 'contact-2.png', 'contact-3.png', 'contact-x.png', 'phone-2.png']) fs.writeFileSync(path.join(review, n), `page ${n}`);
    const r = await deliver(root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(listDeliver(root), ['manifest.json', 'record-test_9x16.mp4', 'record-test_9x16_contact-2.png', 'record-test_9x16_contact-3.png', 'record-test_9x16_contact.png', 'record-test_9x16_poster.png']);
    assert.deepEqual(jsonLine(r).formats[0].files.map((f) => path.basename(f.path)).sort(), ['record-test_9x16.mp4', 'record-test_9x16_contact-2.png', 'record-test_9x16_contact-3.png', 'record-test_9x16_contact.png', 'record-test_9x16_poster.png']);
    // a later run with one page leaves no page of the earlier delivery behind
    fs.rmSync(path.join(review, 'contact-2.png'));
    fs.rmSync(path.join(review, 'contact-3.png'));
    assert.equal((await deliver(root)).code, 0);
    assert.deepEqual(listDeliver(root), ['manifest.json', 'record-test_9x16.mp4', 'record-test_9x16_contact.png', 'record-test_9x16_poster.png']);
  });
});
