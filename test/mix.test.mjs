// mix.mjs end to end on every stem combination (music only, sfx only, music + sfx, music + sfx + voice): a 2 s
// project in os.tmpdir() with a lavfi silent.mp4 + render.json, music from score.mjs, sfx from sfx.mjs --cues and a
// synthetic voice stem. Each final.mp4 must exist, last exactly frames/fps (±1 frame) and measure −14 ±0.5 LUFS
// integrated with true peak ≤ −1 dBTP on ffmpeg's own ebur128 meter; the master itself sits within ±tol/2. Guards the
// ffmpeg input-index bug (two argv entries per input: music + sfx without voice once referenced [2:a:0]).
// A second suite covers what the padding in mix.mjs used to hide or crash on: stems shorter than the film, empty or
// silent (refused unless --allow-short-stems), a true-peak ceiling below loudnorm's -9 dBTP floor, a premix above
// 0 LUFS, config values loudnorm rejects, and out/final.mp4 held open by a player (Windows).
// Skips cleanly without ffmpeg: FFMPEG_PATH, or ffmpeg-static resolvable from the repo root package.json.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const A = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'audio.mjs')).href);
const M = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'mix.mjs')).href);

// Every temp dir is removed by its test or hook; this net catches the ones a timed-out or crashed run leaves behind.
const tmpDirs = new Set();
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.add(d); return d; };
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const SR = 48000;
const DUR = 2;
const FPS = 30;
const FRAMES = DUR * FPS;
const TARGET = { I: -14, tol: 0.5, TP: -1 };

function findFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    const p = createRequire(path.join(REPO, 'package.json'))('ffmpeg-static');
    if (typeof p === 'string') candidates.push(p);
  } catch { /* ffmpeg-static not installed at the repo root */ }
  for (const c of candidates) {
    const r = spawnSync(c, ['-hide_banner', '-version'], { timeout: 30000, windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
}
const FFMPEG = findFfmpeg();
const SKIP = FFMPEG ? false : 'ffmpeg not found (set FFMPEG_PATH or npm install ffmpeg-static at the repo root)';

function run(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, FFMPEG_PATH: FFMPEG, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = []; let stderr = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
  });
}
const tool = (dir, name, args) => run(process.execPath, [path.join(dir, 'tools', name), ...args], { cwd: dir });
const ff = async (args) => {
  const r = await run(FFMPEG, ['-hide_banner', ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed:\n${r.stderr.slice(-2000)}`);
  return r;
};
const lastJson = (buf) => JSON.parse(buf.toString('utf8').trim().split('\n').filter((l) => l.startsWith('{')).pop());

/** ffmpeg ebur128 summary → { I, TP } (independent of mix.mjs's own parser). */
function ebur128(stderr) {
  const s = stderr.slice(stderr.lastIndexOf('Summary:'));
  const I = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(s);
  const TP = /True peak:\s+Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(s);
  assert.ok(I && TP, `no ebur128 summary in:\n${stderr.slice(-1500)}`);
  const n = (m) => (m[1] === '-inf' ? -Infinity : Number(m[1]));
  return { I: n(I), TP: n(TP) };
}

// A voice-like stem: gliding 140 Hz buzz through two formants, 4 syllables per second, 0.3-1.7 s.
function voiceStem() {
  const n = DUR * SR;
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph = (ph + (140 + 20 * Math.sin(2 * Math.PI * 1.3 * t)) / SR) % 1;
    if (t < 0.3 || t > 1.7) continue;
    const env = Math.sin(Math.PI * (t - 0.3) / 1.4) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)) ** 2;
    x[i] = (2 * ph - 1) * env * 0.4;
  }
  const f1 = A.biquad(x, { type: 'bandpass', f: 700, q: 4 }, SR);
  const f2 = A.biquad(x, { type: 'bandpass', f: 1200, q: 5 }, SR);
  const v = Float32Array.from(f1, (s, i) => s + 0.6 * f2[i]);
  return [v, Float32Array.from(v)];
}

const COMBOS = [
  { name: 'music only', args: ['--sfx', 'none', '--voice', 'none'], stems: ['music'] },
  { name: 'sfx only', args: ['--music', 'none', '--voice', 'none'], stems: ['sfx'] },
  { name: 'music + sfx (no voice: the input-index case)', args: ['--voice', 'none'], stems: ['music', 'sfx'] },
  { name: 'music + sfx + voice (ducked)', args: ['--voice', 'audio/voice.wav'], stems: ['music', 'sfx', 'voice'] },
];

describe('mix.mjs: stem combinations → final.mp4 of exact length at −14 LUFS / ≤ −1 dBTP', { skip: SKIP, concurrency: true, timeout: 1800000 }, () => {
  const dirs = [];
  let base;
  before(async () => {
    base = mkTmp('ms-mixc-');
    dirs.push(base);
    fs.cpSync(TEMPLATE, base, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(path.relative(TEMPLATE, src)) });
    const cfgPath = path.join(base, 'studio.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, duration: DUR, fps: FPS, formats: ['9x16'], primaryFormat: '9x16' }, null, 2));
    const fmt = path.join(base, 'out', '9x16');
    fs.mkdirSync(fmt, { recursive: true });
    await ff(['-y', '-f', 'lavfi', '-i', `color=c=gray:s=64x64:r=${FPS}:d=${DUR}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(fmt, 'silent.mp4')]);
    fs.writeFileSync(path.join(fmt, 'render.json'), JSON.stringify({ format: '9x16', frames: FRAMES, fps: FPS, from: 0, to: DUR }));
    const score = await tool(base, 'score.mjs', ['--style', 'pulse', '--json']);
    assert.equal(score.code, 0, score.stderr);
    assert.equal(lastJson(score.stdout).samples, DUR * SR);
    const cues = [{ t: 0.25, type: 'click' }, { t: 0.5, type: 'whoosh' }, { t: 1, type: 'hit' }, { t: 1.25, type: 'pop', pan: 0.3 }, { t: 1.5, type: 'tick' }];
    fs.writeFileSync(path.join(base, 'audio', 'cues.json'), JSON.stringify(cues));
    const sfx = await tool(base, 'sfx.mjs', ['--cues', 'audio/cues.json', '--json']);
    assert.equal(sfx.code, 0, sfx.stderr);
    assert.equal(lastJson(sfx.stdout).cues, cues.length);
    A.writeWav(path.join(base, 'audio', 'voice.wav'), voiceStem(), SR, { bits: 16 });
  });
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  for (const combo of COMBOS) {
    test(combo.name, { timeout: 1200000 }, async (t) => {
      const dir = mkTmp('ms-mixc-');
      dirs.push(dir);
      fs.cpSync(base, dir, { recursive: true });
      const r = await tool(dir, 'mix.mjs', ['--format', '9x16', '--json', ...combo.args]);
      assert.doesNotMatch(r.stderr, /Invalid file index/);
      assert.equal(r.code, 0, r.stderr);
      const j = lastJson(r.stdout);
      assert.deepEqual(Object.keys(j.stems).sort(), [...combo.stems].sort(), 'mixed exactly the requested stems');
      assert.notEqual(j.method, 'silent');
      assert.equal(j.samples, DUR * SR);
      // The master lands well inside the window (AAC still moves it ~0.1-0.2 LU). Music only is the case where
      // loudnorm's linear gain is capped by the true-peak budget (−14.4) and mix.mjs must fall through to the limiter.
      assert.ok(Math.abs(j.I - TARGET.I) <= TARGET.tol / 2, `master ${j.I} LUFS via ${j.method}`);
      assert.ok(j.TP <= TARGET.TP, `master ${j.TP} dBTP`);

      const master = A.readWav(path.join(dir, 'out', 'score.wav'));
      assert.equal(master.channels[0].length, DUR * SR, 'master is exactly frames/fps long');
      const final = path.join(dir, 'out', '9x16', 'final.mp4');
      assert.ok(fs.existsSync(final), 'out/9x16/final.mp4 written');
      assert.ok(fs.existsSync(path.join(dir, 'out', 'final.mp4')), 'primary copied to out/final.mp4');

      const probe = await run(FFMPEG, ['-hide_banner', '-i', final]); // exits 1 (no output file); stderr has the header
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr);
      assert.ok(d, probe.stderr);
      const container = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
      assert.ok(Math.abs(container - DUR) <= 1 / FPS, `container ${container} s vs ${DUR} s`);
      assert.match(probe.stderr, /Audio: aac.*48000 Hz, stereo/);
      const video = await ff(['-i', final, '-map', '0:v:0', '-f', 'null', '-']);
      const frames = [...video.stderr.matchAll(/frame=\s*(\d+)/g)].pop();
      assert.equal(Number(frames?.[1]), FRAMES, 'video keeps every frame');
      const pcm = await ff(['-v', 'error', '-i', final, '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-']);
      const audioSec = pcm.stdout.length / 4 / SR;
      assert.ok(Math.abs(audioSec - DUR) <= 1 / FPS, `audio ${audioSec} s vs ${DUR} s (±1 frame; never -shortest)`);

      const m = ebur128((await ff(['-nostats', '-i', final, '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'])).stderr);
      assert.ok(Math.abs(m.I - TARGET.I) <= TARGET.tol, `${combo.name}: integrated ${m.I} LUFS after AAC`);
      assert.ok(m.TP <= TARGET.TP, `${combo.name}: true peak ${m.TP} dBTP after AAC`);
      assert.ok(Math.abs(j.formats[0].I - m.I) <= 0.1, 'mix.mjs reports the loudness ffmpeg measures');
      t.diagnostic(`master ${j.I} LUFS / ${j.TP} dBTP via ${j.method} · final.mp4 ${m.I} LUFS / ${m.TP} dBTP · container ${container} s · audio ${audioSec.toFixed(4)} s · ${FRAMES} frames`);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (no ffmpeg)

test('stemFindings: short, empty and silent stems are fatal; a silent sfx stem and a too-long stem only warn; 0.25 s of slack', () => {
  const at = (name, duration, peakDb, need = 12) => M.stemFindings(name, { duration, peakDb }, { need, label: `audio/${name}.wav` });
  assert.deepEqual(at('music', 12, -3), [], 'exact');
  assert.deepEqual(at('music', 11.8, -3), [], 'within 0.25 s short');
  assert.deepEqual(at('music', 12.2, -3), [], 'within 0.25 s long');
  const short = at('music', 6, -3);
  assert.equal(short.length, 1);
  assert.equal(short[0].fatal, true);
  assert.equal(short[0].text, 'music stem audio/music.wav is 6.00 s but the film needs 12.00 s: the last 6.00 s would be silent');
  const long = at('music', 20, -3);
  assert.deepEqual(long.map((f) => f.fatal), [false]);
  assert.match(long[0].text, /is 20\.00 s but the film is 12\.00 s: the last 8\.00 s is cut off with no fade/);
  assert.match(at('voice', 0, -Infinity)[0].text, /voice stem audio\/voice\.wav is empty/);
  assert.equal(at('voice', 0, -Infinity).length, 1, 'empty is reported once');
  const silent = at('music', 12, -91);
  assert.deepEqual(silent.map((f) => f.fatal), [true]);
  assert.match(silent[0].text, /is silent \(peak -91\.0 dBFS\)/);
  const sfx = at('sfx', 12, -Infinity);
  assert.deepEqual(sfx.map((f) => f.fatal), [false], 'a film without cues renders a silent sfx stem');
  assert.match(sfx[0].text, /sfx stem .* is silent \(peak -inf dBFS\).*without cues/);
  assert.equal(at('sfx', 6, -Infinity).filter((f) => f.fatal).length, 1, 'but a short sfx stem is still stale');
  assert.equal(M.stemFindings('music', { duration: 5.9, peakDb: -3 }, { need: 6.2, label: 'x' }).length, 1, 'need = render start + length');
});

test('copyWhenFree: waits out a sharing violation, gives up with false, never swallows other errors', async () => {
  const busy = (n) => { let i = 0; return () => { if (++i <= n) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); }; };
  const waits = [];
  const wait = async (ms) => { waits.push(ms); };
  assert.equal(await M.copyWhenFree('a', 'b', { copy: busy(0), wait }), true);
  assert.deepEqual(waits, []);
  assert.equal(await M.copyWhenFree('a', 'b', { copy: busy(2), wait }), true);
  assert.deepEqual(waits, [50, 100]);
  waits.length = 0;
  assert.equal(await M.copyWhenFree('a', 'b', { copy: busy(99), wait, tries: 4 }), false);
  assert.deepEqual(waits, [50, 100, 150], 'tries - 1 pauses, then false');
  await assert.rejects(M.copyWhenFree('a', 'b', { copy: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); }, wait }), /ENOSPC/);
  await assert.rejects(M.copyWhenFree(path.join(os.tmpdir(), 'ms-no-such-source.bin'), path.join(os.tmpdir(), 'ms-never-written.bin'), { wait }), (err) => err.code === 'ENOENT');
});

// ---------------------------------------------------------------------------------------------------------------
// mix.mjs end to end on stems the pipeline must not silently pad, on targets loudnorm cannot take, and on a locked output

const SR2 = 48000;
const FILM = 2; // s
const sineStem = (seconds, amp = 0.5, f = 440) => { const n = Math.round(seconds * SR2); const x = Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / SR2)); return [x, Float32Array.from(x)]; };

describe('mix.mjs: stem checks, loudness limits, locked outputs', { skip: SKIP, concurrency: 3, timeout: 3600000 }, () => {
  let base;
  before(async () => {
    base = mkTmp('ms-mixs-');
    fs.cpSync(TEMPLATE, base, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(path.relative(TEMPLATE, src)) });
    const cfgPath = path.join(base, 'studio.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, duration: FILM, fps: FPS, formats: ['9x16'], primaryFormat: '9x16' }, null, 2));
    const fmt = path.join(base, 'out', '9x16');
    fs.mkdirSync(fmt, { recursive: true });
    await ff(['-y', '-f', 'lavfi', '-i', `color=c=gray:s=64x64:r=${FPS}:d=${FILM}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(fmt, 'silent.mp4')]);
    fs.writeFileSync(path.join(fmt, 'render.json'), JSON.stringify({ format: '9x16', frames: FILM * FPS, fps: FPS, from: 0, to: FILM }));
  });
  after(() => { fs.rmSync(base, { recursive: true, force: true }); });

  // A copy of the base project per test, removed by the test.
  async function withProject(fn, { audio = {} } = {}) {
    const dir = mkTmp('ms-mixs-');
    try {
      fs.cpSync(base, dir, { recursive: true });
      if (Object.keys(audio).length) {
        const cfgPath = path.join(dir, 'studio.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, audio: { ...cfg.audio, ...audio } }, null, 2));
      }
      return await fn(dir);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const put = (dir, name, chs) => A.writeWav(path.join(dir, 'audio', name), chs, SR2, { bits: 16 });
  const mixArgs = (...rest) => ['--format', '9x16', '--json', ...rest];
  const nothingWritten = (dir) => {
    assert.ok(!fs.existsSync(path.join(dir, 'out', 'score.wav')), 'no master written');
    assert.ok(!fs.existsSync(path.join(dir, 'out', 'final.mp4')), 'no final.mp4 written');
    assert.ok(!fs.existsSync(path.join(dir, 'out', '.mix')), 'no scratch left');
  };

  test('a stem shorter than the film stops the mix; --allow-short-stems pads it and says so', { timeout: 900000 }, () => withProject(async (dir) => {
    put(dir, 'short.wav', sineStem(1)); // the film is 2 s: this is what a stale music.wav looks like after a duration edit
    const r = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/short.wav', '--sfx', 'none'));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /music stem audio\/short\.wav is 1\.00 s but the film needs 2\.00 s: the last 1\.00 s would be silent/);
    assert.match(r.stderr, /npm run score.*--allow-short-stems/);
    nothingWritten(dir);
    const ok = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/short.wav', '--sfx', 'none', '--allow-short-stems'));
    assert.equal(ok.code, 0, ok.stderr);
    const j = lastJson(ok.stdout);
    assert.ok(j.warnings.some((w) => /music stem audio\/short\.wav is 1\.00 s but the film needs 2\.00 s.*--allow-short-stems/.test(w)), j.warnings.join(' | '));
    assert.equal(j.samples, FILM * SR2);
    assert.equal(j.stemInfo.music.duration, 1);
    assert.ok(fs.existsSync(path.join(dir, 'out', 'final.mp4')));
  }));

  test('empty and silent music/voice stems are refused', { timeout: 900000 }, () => withProject(async (dir) => {
    put(dir, 'empty.wav', [new Float32Array(0), new Float32Array(0)]);
    put(dir, 'zero.wav', [new Float32Array(FILM * SR2), new Float32Array(FILM * SR2)]);
    put(dir, 'music.wav', sineStem(FILM));
    const empty = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/empty.wav', '--sfx', 'none'));
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /music stem audio\/empty\.wav is empty \(no audio samples\)/);
    const zero = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/zero.wav', '--sfx', 'none'));
    assert.equal(zero.code, 1);
    assert.match(zero.stderr, /music stem audio\/zero\.wav is silent \(peak -\d+\.\d dBFS\)/);
    const voice = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/music.wav', '--sfx', 'none', '--voice', 'audio/zero.wav'));
    assert.equal(voice.code, 1);
    assert.match(voice.stderr, /voice stem audio\/zero\.wav is silent/);
    nothingWritten(dir);
  }));

  test('a silent sfx stem (a film without cues) only warns; --allow-short-stems lets a silent mix through', { timeout: 900000 }, () => withProject(async (dir) => {
    put(dir, 'zero.wav', [new Float32Array(FILM * SR2), new Float32Array(FILM * SR2)]);
    put(dir, 'music.wav', sineStem(FILM));
    const cueless = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/music.wav', '--sfx', 'audio/zero.wav'));
    assert.equal(cueless.code, 0, cueless.stderr);
    const j = lastJson(cueless.stdout);
    assert.notEqual(j.method, 'silent');
    assert.ok(j.warnings.some((w) => /sfx stem audio\/zero\.wav is silent.*without cues/.test(w)), j.warnings.join(' | '));
    const forced = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/zero.wav', '--sfx', 'none', '--allow-short-stems'));
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(lastJson(forced.stdout).method, 'silent', 'the flag lets a silent mix through');
  }));

  test('a stem longer than the film is mixed with a warning that its end is cut', { timeout: 900000 }, () => withProject(async (dir) => {
    put(dir, 'long.wav', sineStem(3));
    const r = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/long.wav', '--sfx', 'none'));
    assert.equal(r.code, 0, r.stderr);
    const j = lastJson(r.stdout);
    assert.ok(j.warnings.some((w) => /music stem audio\/long\.wav is 3\.00 s but the film is 2\.00 s: the last 1\.00 s is cut off/.test(w)), j.warnings.join(' | '));
    assert.equal(j.samples, FILM * SR2);
  }));

  test("--tp below loudnorm's -9 dBTP floor (down to -20) is honoured by the limiter path, not a 'Result too large' crash", { timeout: 900000 }, () => withProject(async (dir) => {
    put(dir, 'music.wav', sineStem(FILM));
    // A steady sine peaks at about its loudness, so -20 dBTP needs a quieter target than -14 LUFS to be reachable.
    for (const [tp, lufs] of [['-12', '-14'], ['-20', '-30']]) {
      const r = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/music.wav', '--sfx', 'none', '--tp', tp, '--lufs', lufs));
      assert.equal(r.code, 0, `--tp ${tp}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /Result too large|out of range/);
      const j = lastJson(r.stdout);
      assert.ok(j.TP <= Number(tp), `master ${j.TP} dBTP vs ${tp}`);
      assert.ok(Math.abs(j.I - Number(lufs)) <= 0.5, `master ${j.I} LUFS vs ${lufs}`);
      assert.ok(j.formats[0].TP <= Number(tp) + 0.05, `final.mp4 ${j.formats[0].TP} dBTP vs ${tp}`);
      assert.equal(j.method, 'alimiter');
    }
  }));

  test('studio.json audio.truePeak -12 takes the same route', { timeout: 900000 }, () => withProject(async (dir) => {
    put(dir, 'music.wav', sineStem(FILM));
    const c = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/music.wav', '--sfx', 'none'));
    assert.equal(c.code, 0, c.stderr);
    assert.ok(lastJson(c.stdout).TP <= -12);
  }, { audio: { truePeak: -12 } }));

  test('a premix louder than 0 LUFS (musicGainDb 24) is pre-attenuated: no Result too large, the target is still met', { timeout: 900000 }, () => withProject(async (dir) => {
    put(dir, 'music.wav', sineStem(FILM, 0.5));
    const r = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/music.wav', '--sfx', 'none'));
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /Result too large|out of range/);
    const j = lastJson(r.stdout);
    assert.ok(j.preAttenuationDb < -20, `pre-attenuation ${j.preAttenuationDb} dB`);
    assert.ok(j.warnings.some((w) => /premix integrates at .* LUFS, above loudnorm's 0 LUFS range/.test(w)), j.warnings.join(' | '));
    assert.ok(Math.abs(j.I - -14) <= 0.5 && j.TP <= -1, `master ${j.I} LUFS ${j.TP} dBTP`);
    assert.ok(Math.abs(j.formats[0].I - -14) <= 0.5, `final.mp4 ${j.formats[0].I} LUFS`);
    assert.ok(!fs.existsSync(path.join(dir, 'out', '.mix')), 'no scratch left');
  }, { audio: { musicGainDb: 24 } }));

  test('loudness settings loudnorm cannot take are usage errors that name their source', { timeout: 300000 }, () => withProject(async (dir) => {
    put(dir, 'music.wav', sineStem(FILM));
    const lufs = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/music.wav', '--lufs', '-3'));
    assert.equal(lufs.code, 2);
    assert.match(lufs.stderr, /--lufs must be between -70 and -5 \(got -3\)/);
    const tp = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/music.wav', '--tp', '-25'));
    assert.equal(tp.code, 2);
    assert.match(tp.stderr, /--tp must be between -20 and 0 \(got -25\)/);
  }));

  // A bad studio.json value is a config error (exit 1, from loadConfig / validateConfig before mix reads its flags); only a
  // bad command line is a usage error (exit 2, the test above). Either way the message names the key or the flag.
  test('studio.json audio.lufs above -5 is a config error (exit 1) that names the config key and the range', { timeout: 300000 }, () => withProject(async (dir) => {
    put(dir, 'music.wav', sineStem(FILM));
    const r = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/music.wav'));
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /error: invalid .*studio\.json:\n {2}- audio\.lufs must be between -70 and -5 \(got -3\)/);
    assert.doesNotMatch(r.stderr, /Usage: node tools\/mix\.mjs/, 'a config error is not a usage error: no usage text');
    assert.equal(lastJson(r.stdout).ok, false, '--json: the one-line failure envelope');
    nothingWritten(dir);
    // --lufs on the command line does not rescue a broken studio.json: the file is validated first, everywhere.
    const flagged = await tool(dir, 'mix.mjs', mixArgs('--music', 'audio/music.wav', '--lufs', '-14'));
    assert.equal(flagged.code, 1, flagged.stderr);
    assert.match(flagged.stderr, /audio\.lufs must be between -70 and -5 \(got -3\)/);
  }, { audio: { lufs: -3 } }));

  test('a player holding out/final.mp4 open (Windows) does not fail a finished mix: warning, JSON line, no scratch left', { skip: process.platform !== 'win32' && 'Windows sharing violations only', timeout: 600000 }, () => withProject(async (dir) => {
    const first = await tool(dir, 'mix.mjs', mixArgs('--music', 'none', '--sfx', 'none'));
    assert.equal(first.code, 0, first.stderr);
    const target = path.join(dir, 'out', 'final.mp4');
    assert.ok(fs.existsSync(target));
    // Hold it open for reading without FileShare.Write, as a media player does.
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f = [System.IO.File]::Open('${target.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 120`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    try {
      const ready = await new Promise((resolve) => {
        let out = '';
        const timer = setTimeout(() => resolve(false), 30000);
        holder.stdout.on('data', (d) => { out += d; if (out.includes('locked')) { clearTimeout(timer); resolve(true); } });
        holder.once('exit', () => { clearTimeout(timer); resolve(false); });
      });
      if (!ready) return; // no usable PowerShell: the copyWhenFree unit test covers the logic
      assert.throws(() => fs.copyFileSync(path.join(dir, 'out', '9x16', 'final.mp4'), target), /EBUSY|EPERM|EACCES/, 'the lock is real');
      const r = await tool(dir, 'mix.mjs', mixArgs('--music', 'none', '--sfx', 'none'));
      assert.equal(r.code, 0, r.stderr);
      const j = lastJson(r.stdout);
      assert.ok(j.warnings.some((w) => /out\/final\.mp4 is open in another program.*out\/9x16\/final\.mp4/.test(w)), j.warnings.join(' | '));
      assert.equal(j.final, 'out/9x16/final.mp4', 'the result points at the file that is current');
      assert.ok(fs.existsSync(path.join(dir, 'out', '9x16', 'final.mp4')));
      assert.ok(!fs.existsSync(path.join(dir, 'out', '.mix')), 'scratch removed');
    } finally {
      holder.kill();
      await new Promise((resolve) => { if (holder.exitCode !== null) resolve(); else holder.once('exit', resolve); });
    }
    const released = await tool(dir, 'mix.mjs', mixArgs('--music', 'none', '--sfx', 'none'));
    assert.equal(released.code, 0, released.stderr);
    assert.equal(lastJson(released.stdout).final, 'out/final.mp4', 'released: the copy lands');
  }));
});
