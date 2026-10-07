// beats.mjs: the JS engine on synthesized tracks (128 BPM with and without a pickup bar, silence, score.mjs output)
// runs without ffmpeg; the CLI (ffmpeg decode + cache) skips without ffmpeg; the librosa engine runs only when
// MOTION_PYTHON points at a Python with librosa (cold numba start ≈ 1 min).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const tool = (f) => pathToFileURL(path.join(TEMPLATE, 'tools', f)).href;
const B = await import(tool('beats.mjs'));
const A = await import(tool('audio.mjs'));
const SC = await import(tool('score.mjs'));
const S = await import(tool('studio.mjs'));
const FFMPEG = (() => { try { return S.resolveFfmpeg(REPO); } catch { return null; } })();

// Every temp dir is removed by its test's finally; this net catches the ones a timed-out or crashed test leaves behind.
const tmpDirs = new Set();
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.add(d); return d; };
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// Four-on-the-floor kick, snare on 2 and 4, a bass note + chord change on every downbeat; optional pickup snare one
// beat before the first bar (the case where beats[::4] is one beat off).
function synthTrack({ bpm = 128, bars = 8, pickup = true, sr = 22050, lead = 0.5 } = {}) {
  const beat = 60 / bpm;
  const D0 = lead + (pickup ? beat : 0);
  const dur = D0 + bars * 4 * beat + 1;
  const n = Math.round(dur * sr);
  const x = new Float32Array(n);
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const add = (t, fn, len) => { const a = Math.round(t * sr); for (let i = 0; i < len * sr && a + i < n; i++) x[a + i] += fn(i / sr, len - i / sr); };
  const fadeOut = (left) => Math.min(1, left / 0.01);
  const kick = (tt) => Math.sin(2 * Math.PI * (50 * tt + 3.6 * (1 - Math.exp(-tt / 0.04)))) * Math.exp(-tt / 0.15) * 0.8;
  const snare = (tt) => rnd() * Math.exp(-tt / 0.06) * 0.35 + Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt / 0.03) * 0.2;
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  const beats = [];
  const downbeats = [];
  if (pickup) { add(lead, snare, 0.2); beats.push(lead); }
  for (let b = 0; b < bars; b++) {
    for (let k = 0; k < 4; k++) {
      const t = D0 + (b * 4 + k) * beat;
      beats.push(t);
      add(t, (tt) => kick(tt) * (k === 0 ? 1 : 0.8), 0.5);
      if (k % 2 === 1) add(t, snare, 0.25);
      if (k === 0) {
        downbeats.push(t);
        const bass = hz(chords[b % 4][0] - 24);
        add(t, (tt, left) => Math.sin(2 * Math.PI * bass * tt) * Math.min(1, tt / 0.005) * Math.exp(-tt / 0.8) * 0.5 * fadeOut(left), 4 * beat - 0.01);
        for (const m of chords[b % 4]) add(t, (tt, left) => Math.sin(2 * Math.PI * hz(m) * tt) * Math.min(1, tt / 0.01) * Math.exp(-tt / 1.2) * 0.08 * fadeOut(left), 4 * beat - 0.01);
      }
    }
  }
  for (let i = 0; i < n; i++) x[i] = Math.tanh(x[i]);
  return { x, sr, beats, downbeats, bpm, duration: dur };
}

const nearest = (t, arr) => arr.reduce((m, v) => (Math.abs(v - t) < Math.abs(m - t) ? v : m), Infinity);
function assertGrid(res, truth, label) {
  assert.ok(Math.abs(res.bpm - truth.bpm) <= 2, `${label}: bpm ${res.bpm} vs ${truth.bpm}`);
  const inside = res.beats.filter((t) => t >= truth.beats[0] - 0.1 && t <= truth.beats.at(-1) + 0.1);
  assert.equal(inside.length, res.beats.length, `${label}: no beats outside the music`);
  for (const t of res.beats) assert.ok(Math.abs(t - nearest(t, truth.beats)) <= 0.03, `${label}: beat ${t} within ±30 ms`);
  const inner = truth.beats.filter((t) => t > truth.beats[0] + 1 && t < truth.beats.at(-1) - 1);
  const found = inner.filter((t) => Math.abs(nearest(t, res.beats) - t) <= 0.03).length;
  assert.ok(found / inner.length >= 0.9, `${label}: recall ${found}/${inner.length}`);
  assert.ok(res.downbeats.length >= 2, `${label}: downbeats found`);
  for (const d of res.downbeats) assert.ok(Math.abs(d - nearest(d, truth.downbeats)) <= 0.03, `${label}: downbeat ${d} is a true bar start (correct phase)`);
}

test('JS engine: 128 BPM with a pickup beat → bpm ±2, beats ±30 ms, downbeat phase skips the pickup', () => {
  const tr = synthTrack({ pickup: true });
  const r = B.analyzeBeats(tr.x, tr.sr, { beatsPerBar: 4 });
  assertGrid(r, tr, 'pickup');
  assert.ok(Math.abs(r.downbeats[0] - tr.downbeats[0]) <= 0.03, `first downbeat ${r.downbeats[0]} ≈ ${tr.downbeats[0]}`);
  assert.ok(Math.abs(r.offset - r.downbeats[0]) < 1e-9, 'offset = first downbeat');
  assert.ok(r.hits.length >= 8, 'onset hits found');
});

test('JS engine: 128 BPM without a pickup, and a bpm hint', () => {
  const tr = synthTrack({ pickup: false, lead: 0 });
  assertGrid(B.analyzeBeats(tr.x, tr.sr), tr, 'no pickup');
  const slow = synthTrack({ bpm: 96, pickup: false, bars: 6 });
  assertGrid(B.analyzeBeats(slow.x, slow.sr, { bpmHint: 96 }), slow, '96 BPM hinted');
});

test('JS engine: silence and near-silence give an empty grid with a warning', () => {
  for (const x of [new Float32Array(22050 * 4), new Float32Array(1000).fill(0.5)]) {
    const r = B.analyzeBeats(x, 22050);
    assert.deepEqual([r.bpm, r.beats.length, r.downbeats.length], [0, 0, 0]);
    assert.ok(r.warnings.length > 0);
  }
});

test('JS engine on score.mjs output recovers the analytic grid (pulse and minimal)', () => {
  for (const style of ['pulse', 'minimal']) {
    const sc = SC.composeScore({ style, bpm: 120, dur: 12 });
    const mono = new Float32Array(sc.channels[0].length);
    for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (sc.channels[0][i] + sc.channels[1][i]);
    const lp = A.biquad(A.biquad(mono, { type: 'lowpass', f: 9000 }), { type: 'lowpass', f: 9000 });
    const y = A.resample(lp, 48000 / 22050);
    const r = B.analyzeBeats(y, 22050);
    assertGrid(r, { bpm: 120, beats: sc.grid.beats, downbeats: sc.grid.downbeats }, style);
  }
});

test('building blocks: FFT, peak picking, tempo prior', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.cos(2 * Math.PI * 5 * i / 64));
  const im = new Float64Array(64);
  B.fft(re, im);
  assert.ok(Math.abs(re[5] - 32) < 1e-9 && Math.abs(re[59] - 32) < 1e-9 && Math.abs(re[4]) < 1e-9);
  assert.deepEqual(B.peakPick([0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0], { delta: 0.5, wait: 3 }), [2, 14]);
  const fps = 22050 / 512;
  const onset = Array.from({ length: 1200 }, (_, i) => (i % 20 === 0 ? 1 : 0)); // period 20 frames ≈ 129.2 BPM
  const t = B.estimateTempo(onset, fps);
  assert.ok(Math.abs(t.bpm - 60 * fps / 20) < 1, `tempo ${t.bpm}`);
});

function runTool(dir, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, 'tools', 'beats.mjs'), ...args], { cwd: dir, env: { ...process.env, ...(FFMPEG ? { FFMPEG_PATH: FFMPEG } : {}), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
function project() {
  const dir = mkTmp('ms-beats-');
  fs.cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(path.relative(TEMPLATE, src)) });
  const tr = synthTrack({ sr: 48000 });
  A.writeWav(path.join(dir, 'audio', 'song.wav'), [tr.x, tr.x], 48000);
  return { dir, tr };
}

test('beats CLI (js engine): ffmpeg decode → beats.json schema, sha256 cache, exit codes', { skip: !FFMPEG && 'ffmpeg not found (set FFMPEG_PATH)', timeout: 600000 }, async () => {
  const { dir, tr } = project();
  try {
    const r = await runTool(dir, ['audio/song.wav', '--engine', 'js', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.cached, false);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'audio', 'beats.json'), 'utf8'));
    for (const k of ['version', 'source', 'bpm', 'offset', 'beatsPerBar', 'duration', 'beats', 'downbeats', 'downbeatPhase', 'hits', 'audioSha256']) assert.ok(k in doc, `schema key ${k}`);
    assert.equal(doc.version, 1);
    assert.equal(doc.source, 'js');
    assertGrid(doc, tr, 'cli');
    assert.ok(fs.existsSync(path.join(dir, 'audio', '.cache', `beats-${doc.audioSha256}.json`)), 'cached by sha256');
    const again = await runTool(dir, ['audio/song.wav', '--engine', 'js', '--json']);
    assert.equal(JSON.parse(again.stdout.trim().split('\n').pop()).cached, true);
    const fresh = await runTool(dir, ['audio/song.wav', '--engine', 'js', '--no-cache', '--json']);
    assert.equal(JSON.parse(fresh.stdout.trim().split('\n').pop()).cached, false);
    assert.equal((await runTool(dir, ['audio/song.wav', '--engine', 'aubio'])).code, 2);
    assert.equal((await runTool(dir, ['audio/missing.wav'])).code, 1);
    assert.equal((await runTool(dir, ['--nope'])).code, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('beats CLI (librosa engine via tools/beats.py)', { skip: (!process.env.MOTION_PYTHON || !FFMPEG) && 'set MOTION_PYTHON to a Python with librosa (and have ffmpeg)', timeout: 1200000 }, async () => {
  const { dir, tr } = project();
  try {
    const r = await runTool(dir, ['audio/song.wav', '--engine', 'librosa', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'audio', 'beats.json'), 'utf8'));
    assert.equal(doc.source, 'librosa');
    assert.match(doc.librosaVersion, /^\d+\.\d+/);
    assertGrid(doc, tr, 'librosa');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// --bpm-hint outside the 70-180 BPM window (the JS engine's autocorrelation range) must still reach the true tempo.

// A score.mjs track resampled to the analysis rate (the same route as the score.mjs test above).
function scoreTrack(opts) {
  const sc = SC.composeScore(opts);
  const mono = new Float32Array(sc.channels[0].length);
  for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (sc.channels[0][i] + sc.channels[1][i]);
  const lp = A.biquad(A.biquad(mono, { type: 'lowpass', f: 9000 }), { type: 'lowpass', f: 9000 });
  return { y: A.resample(lp, 48000 / 22050), truth: sc.grid.beats };
}

test('JS engine: --bpm-hint 60 / 45 / 200 / 250 BPM reaches the true tempo and beat times (window widens with the hint)', () => {
  for (const [style, bpm, dur] of [['pulse', 60, 16], ['piano', 60, 16], ['pulse', 45, 20], ['pulse', 200, 12], ['pulse', 250, 10]]) {
    const { y, truth } = scoreTrack({ style, bpm, dur });
    const r = B.analyzeBeats(y, 22050, { bpmHint: bpm });
    assert.ok(Math.abs(r.bpm - bpm) <= 1, `${style} ${bpm} BPM hinted: got ${r.bpm}`);
    const inner = truth.filter((t) => t > truth[0] + 1 && t < truth.at(-1) - 1);
    const found = inner.filter((t) => Math.abs(nearest(t, r.beats) - t) <= 0.03).length;
    assert.ok(found / inner.length >= 0.9, `${style} ${bpm} BPM: beat recall ${found}/${inner.length}`);
  }
  // Without a hint a 60 BPM track is heard at double time; the hint is the documented fix.
  const { y } = scoreTrack({ style: 'pulse', bpm: 60, dur: 16 });
  const plain = B.analyzeBeats(y, 22050);
  const hinted = B.analyzeBeats(y, 22050, { bpmHint: 60 });
  assert.ok(Math.abs(hinted.bpm - 60) < Math.abs(plain.bpm - 60), `hint ${hinted.bpm} vs plain ${plain.bpm}`);
});

test('estimateTempo: a hint widens the lag window to hint·0.75 … hint·1.35; without a hint (or inside 70-180) nothing changes', () => {
  const fps = 22050 / 512;
  const train = (period) => Array.from({ length: 1400 }, (_, i) => (i % period === 0 ? 1 : 0));
  const slow = train(43); // 60.07 BPM
  assert.ok(B.estimateTempo(slow, fps).bpm > 100, 'no hint: the 60 BPM lag is outside the window, the double is found');
  assert.ok(Math.abs(B.estimateTempo(slow, fps, { hint: 60 }).bpm - 60.07) < 0.5, 'hint 60 finds the true lag');
  const fast = train(13); // 198.7 BPM
  assert.ok(Math.abs(B.estimateTempo(fast, fps, { hint: 200 }).bpm - 198.7) < 1.5, 'hint 200 finds the true lag');
  const mid = train(20); // 129.2 BPM
  assert.equal(B.estimateTempo(mid, fps, { hint: 130 }).bpm, B.estimateTempo(mid, fps, { hint: 130, minBpm: 70, maxBpm: 180 }).bpm, 'a hint inside the default window keeps it');
  assert.ok(Math.abs(B.estimateTempo(mid, fps).bpm - 129.2) < 1);
});

// ---------------------------------------------------------------------------------------------------------------
// A MOTION_PYTHON pin that does not answer is "no librosa" for beats.mjs: auto falls back to the JS engine.

test('beats CLI: MOTION_PYTHON pointing at nothing → auto uses the JS engine (exit 0), --engine librosa reports the pin', { skip: !FFMPEG && 'ffmpeg not found (set FFMPEG_PATH)', timeout: 600000 }, async () => {
  const { dir, tr } = project();
  const badPin = { MOTION_PYTHON: path.join(dir, 'no-such-venv', 'Scripts', 'python.exe') };
  try {
    const auto = await runTool(dir, ['audio/song.wav', '--no-cache', '--json'], badPin);
    assert.equal(auto.code, 0, auto.stderr);
    assert.match(auto.stderr, /MOTION_PYTHON=.*no-such-venv.* is not usable: .*using the JS engine/);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'audio', 'beats.json'), 'utf8'));
    assert.equal(doc.source, 'js');
    assertGrid(doc, tr, 'js fallback');
    const lib = await runTool(dir, ['audio/song.wav', '--no-cache', '--engine', 'librosa'], badPin);
    assert.equal(lib.code, 1);
    assert.match(lib.stderr, /MOTION_PYTHON=.*no-such-venv.* is not usable/);
    assert.match(lib.stderr, /Fix: point MOTION_PYTHON at a working Python that has librosa, or unset it, or use --engine js/);
    const js = await runTool(dir, ['audio/song.wav', '--no-cache', '--engine', 'js', '--json'], badPin);
    assert.equal(js.code, 0, js.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
