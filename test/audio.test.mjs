// Shared DSP (template/tools/audio.mjs) + mix.mjs parsing/mastering + voice.mjs dry run. Pure-JS checks always run;
// the ffmpeg-backed mix run skips when no ffmpeg is resolvable (FFMPEG_PATH, ffmpeg-static or PATH).
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
const A = await import(tool('audio.mjs'));
const M = await import(tool('mix.mjs'));
const S = await import(tool('studio.mjs'));

const FFMPEG = (() => { try { return S.resolveFfmpeg(REPO); } catch { return null; } })();

// Every temp dir is removed by its test's finally; this net catches the ones a timed-out or crashed test leaves behind.
const tmpDirs = new Set();
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.add(d); return d; };
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function project(prefix, patch = {}) {
  const dir = mkTmp(prefix);
  fs.cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(path.relative(TEMPLATE, src)) });
  const cfgPath = path.join(dir, 'studio.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, ...patch, audio: { ...cfg.audio, ...(patch.audio ?? {}) } }, null, 2));
  return dir;
}
function runTool(dir, name, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, 'tools', name), ...args], { cwd: dir, env: { ...process.env, ...(FFMPEG ? { FFMPEG_PATH: FFMPEG } : {}), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const lastJson = (s) => JSON.parse(s.trim().split('\n').filter((l) => l.startsWith('{')).pop());
const sine = (n, f, amp, sr = 48000) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr));

// ---------------------------------------------------------------------------------------------------------------
// WAV I/O

test('encodeWav/decodeWav: 16-bit stereo header and round trip', () => {
  const L = sine(4800, 440, 0.9);
  const R = sine(4800, 660, -0.5);
  const buf = A.encodeWav([L, R], 48000, { bits: 16 });
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(4), 36 + 4800 * 4);
  assert.equal(buf.readUInt16LE(20), 1, 'PCM');
  assert.equal(buf.readUInt16LE(22), 2, 'channels');
  assert.equal(buf.readUInt32LE(28), 48000 * 4, 'byte rate');
  assert.equal(buf.readUInt16LE(32), 4, 'block align');
  assert.equal(buf.readUInt32LE(40), 4800 * 4, 'data size');
  const back = A.decodeWav(buf);
  assert.equal(back.sr, 48000);
  assert.equal(back.channels.length, 2);
  for (let i = 0; i < 4800; i++) {
    assert.ok(Math.abs(back.channels[0][i] - L[i]) < 1 / 16000);
    assert.ok(Math.abs(back.channels[1][i] - R[i]) < 1 / 16000);
  }
});

test('encodeWav/decodeWav: 24-bit and 32-bit float, mono; clamps and NaN', () => {
  const x = Float32Array.from([0, 0.5, -0.5, 1.5, -2, Number.NaN, 0.123456]);
  const b24 = A.decodeWav(A.encodeWav([x], 44100, { bits: 24 }));
  assert.equal(b24.sr, 44100);
  assert.deepEqual(Array.from(b24.channels[0], (v) => Math.round(v * 1e4) / 1e4), [0, 0.5, -0.5, 1, -1, 0, 0.1235]);
  const b32 = A.decodeWav(A.encodeWav([x], 48000, { bits: 32 }));
  assert.equal(b32.channels[0][3], 1.5, 'float WAV keeps overs');
  assert.equal(b32.channels[0][5], 0, 'NaN → 0');
  assert.throws(() => A.encodeWav([x], 48000, { bits: 8 }), /bits/);
  assert.throws(() => A.decodeWav(Buffer.from('not a wav file at all')), /RIFF/);
});

test('writeWav/readWav on disk; trimOrPad and makeBuffer give exact lengths', () => {
  const dir = mkTmp('ms-audio-');
  try {
    const p = path.join(dir, 'sub', 'x.wav');
    A.writeWav(p, [sine(480, 1000, 0.25)], 48000);
    const r = A.readWav(p);
    assert.equal(r.channels[0].length, 480);
    assert.equal(A.makeBuffer(12, 2)[1].length, 576000);
    assert.equal(A.trimOrPad(r.channels, 0.02)[0].length, 960);
    assert.equal(A.trimOrPad(r.channels, 0.005)[0].length, 240);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// Placement, gain, envelopes

test('addAt: equal-power pan for mono, balance for stereo, clipping at the edges, wrap', () => {
  const one = Float32Array.from([1]);
  const dst = A.makeBuffer(0.001, 2);
  A.addAt(dst, one, 0);
  assert.ok(Math.abs(dst[0][0] - Math.SQRT1_2) < 1e-6 && Math.abs(dst[1][0] - Math.SQRT1_2) < 1e-6, 'centre = -3 dB per side');
  const hard = A.makeBuffer(0.001, 2);
  A.addAt(hard, one, 0, { pan: -1 });
  assert.ok(Math.abs(hard[0][0] - 1) < 1e-6 && Math.abs(hard[1][0]) < 1e-6);
  const st = A.makeBuffer(0.001, 2);
  A.addAt(st, [one, one], 0, { pan: 0.5, gain: 2 });
  assert.deepEqual([st[0][0], st[1][0]], [1, 2], 'stereo balance: unity at centre side');
  const edge = A.makeBuffer(10 / 48000, 1);
  A.addAt(edge, Float32Array.from([1, 2, 3, 4]), -2 / 48000);
  assert.deepEqual(Array.from(edge[0].slice(0, 3)), [3, 4, 0]);
  const loop = A.makeBuffer(4 / 48000, 1);
  A.addAt(loop, Float32Array.from([1, 2, 3]), 3 / 48000, { wrap: true });
  assert.deepEqual(Array.from(loop[0]), [2, 3, 0, 1]);
});

test('dB helpers, adsr click-free edges, mtof, seeded noise', () => {
  assert.ok(Math.abs(A.gainToDb(A.dbToGain(-6.02)) + 6.02) < 1e-9);
  assert.equal(A.gainToDb(0), -Infinity);
  const env = { a: 0.01, d: 0.1, s: 0.5, r: 0.2, dur: 0.5 };
  assert.equal(A.adsr(0, env), 0);
  assert.ok(Math.abs(A.adsr(0.01, env) - 1) < 1e-9);
  assert.equal(A.adsr(0.7, env), 0);
  let maxStep = 0;
  for (let t = 0; t < 0.75; t += 1 / 48000) maxStep = Math.max(maxStep, Math.abs(A.adsr(t + 1 / 48000, env) - A.adsr(t, env)));
  assert.ok(maxStep < 0.01, `no envelope jumps (max step ${maxStep})`);
  assert.equal(A.mtof(69), 440);
  const a = A.noiseGen(7); const b = A.noiseGen(7);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 1000 }, () => b()));
  assert.ok(xs.every((v) => v >= -1 && v < 1));
});

// ---------------------------------------------------------------------------------------------------------------
// Filters, dynamics, meters

test('biquad and svf: lowpass attenuates, highpass removes DC, stable under sweeps', () => {
  const hi = sine(48000, 10000, 1);
  const lp = A.biquad(hi, { type: 'lowpass', f: 1000 });
  assert.ok(A.rms([lp.subarray(4800)]) < 0.02 * A.rms([hi]), 'LP 1 kHz: 10 kHz down > 30 dB');
  const dc = new Float32Array(48000).fill(0.5);
  assert.ok(Math.abs(A.biquad(dc, { type: 'highpass', f: 30 })[47999]) < 1e-3);
  const noise = A.noiseGen(1);
  const x = Float32Array.from({ length: 48000 }, () => noise());
  const y = A.svf(x, { type: 'bandpass', f: (i) => 100 + 15000 * (i / 48000), q: 8 });
  assert.ok(y.every(Number.isFinite) && A.peak([y]) < 20);
  assert.throws(() => A.biquad(x, { type: 'comb', f: 1 }), /unknown type/);
});

test('limiter: stacked transients stay under the ceiling; quiet material is untouched', () => {
  const n = 48000;
  const x = new Float32Array(n);
  for (const t0 of [1000, 1000, 1001, 20000]) for (let i = 0; i < 2000; i++) x[t0 + i] += Math.sin(i * 0.3) * Math.exp(-i / 300) * 0.9; // in-phase stack
  const chs = [x, Float32Array.from(x)];
  assert.ok(A.peak(chs) > 1.5, 'the stack overshoots before limiting');
  A.limiter(chs, { ceilingDb: -1 });
  assert.ok(A.peak(chs) <= A.dbToGain(-1) + 1e-6, `sample peak ${A.peak(chs)}`);
  const tp = [Float32Array.from({ length: n }, (_, i) => (Math.sin(Math.PI * i / 2 + Math.PI / 4) > 0 ? 1.2 : -1.2) * Math.min(1, i / 480))];
  A.limiter(tp, { ceilingDb: -1, truePeak: true });
  assert.ok(A.peakDb(tp, { truePeak: true }) <= -0.95, 'true-peak mode also bounds inter-sample peaks');
  const quiet = [sine(n, 440, 0.25)];
  const copy = Float32Array.from(quiet[0]);
  A.limiter(quiet, { ceilingDb: -1 });
  assert.deepEqual(quiet[0], copy);
});

test('lufs: BS.1770 calibration (stereo 1 kHz sine at -20 dBFS → -20 LUFS), silence, gating', () => {
  const s = sine(48000 * 3, 1000, 0.1);
  assert.ok(Math.abs(A.lufs([s, s]) - -20) < 0.1, `got ${A.lufs([s, s])}`);
  assert.ok(Math.abs(A.lufs([s]) - -23.01) < 0.1, 'mono = one channel');
  assert.equal(A.lufs([new Float32Array(48000 * 2)]), -Infinity);
  const gated = new Float32Array(48000 * 6);
  gated.set(s.subarray(0, 48000 * 3));
  // 27 full blocks + 3 edge blocks (75/50/25 % sine) pass the gates; the silent ones do not: -20 + 10·log10(28.5/30)
  assert.ok(Math.abs(A.lufs([gated, gated]) - (-20 + 10 * Math.log10(28.5 / 30))) < 0.05, `silence is gated out (${A.lufs([gated, gated])})`);
  assert.equal(A.lufs([new Float32Array(1000)]), -Infinity, 'shorter than one block');
});

test('compressor, softClip, reverb and pingPong stay finite and behave', () => {
  const loud = [sine(48000, 200, 0.9), sine(48000, 200, 0.9)];
  A.compressor(loud, { thresholdDb: -20, ratio: 4, attackMs: 1, releaseMs: 50, kneeDb: 0 });
  assert.ok(A.peak([loud[0].subarray(24000)]) < 0.35, 'steady-state gain reduction');
  const sc = [Float32Array.from([0.001, 10])];
  A.softClip(sc, 2);
  assert.ok(Math.abs(sc[0][0] - 0.001) < 1e-6 && sc[0][1] <= 0.5);
  const imp = new Float32Array(48000 * 3); imp[100] = 1;
  const [wl, wr] = A.reverb([imp, imp], { decay: 1 });
  assert.ok(wl.every(Number.isFinite) && wr.every(Number.isFinite));
  const early = A.rms([wl.subarray(4800, 24000)]);
  const late = A.rms([wl.subarray(96000, 144000)]);
  assert.ok(early > 0 && late < early * 0.05, 'the tail decays (RT60 1 s)');
  let diff = 0; for (let i = 0; i < wl.length; i++) diff += Math.abs(wl[i] - wr[i]);
  assert.ok(diff > 0, 'decorrelated stereo');
  const [el, er] = A.pingPong([imp], { time: 0.25, feedback: 0.5 });
  assert.ok(Math.abs(el[100 + 12000]) > 0.4 && Math.abs(er[100 + 24000]) > 0.1, 'echoes alternate sides');
  assert.equal(A.resample(new Float32Array(1000), 2).length, 500);
  assert.ok(Math.abs(A.peakTime([Float32Array.from({ length: 4800 }, (_, i) => (i > 2400 ? Math.exp(-(i - 2400) / 100) : 0))]) - 0.05) < 0.003);
});

// ---------------------------------------------------------------------------------------------------------------
// mix.mjs

test('mix: parses the last loudnorm JSON block and the ebur128 summary', () => {
  const ln = '[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-30.00",\n\t"x": "1"\n}\nnoise\n[Parsed_loudnorm_0 @ 0x2] \n{\n\t"input_i" : "-24.75",\n\t"input_tp" : "-20.91",\n\t"normalization_type" : "dynamic"\n}\nsize=N/A time=00:00:12.00';
  const j = M.parseLoudnormJson(ln);
  assert.equal(j.input_i, '-24.75');
  assert.equal(j.normalization_type, 'dynamic');
  assert.throws(() => M.parseLoudnormJson('nothing here'), /no JSON/);
  const eb = `[Parsed_ebur128_0 @ 0x3] Summary:\n\n  Integrated loudness:\n    I:         -14.1 LUFS\n    Threshold: -24.4 LUFS\n\n  Loudness range:\n    LRA:         6.7 LU\n    Threshold: -34.3 LUFS\n\n  True peak:\n    Peak:       -1.3 dBFS`;
  assert.deepEqual(M.parseEbur128(eb), { I: -14.1, LRA: 6.7, TP: -1.3 });
  const silent = M.parseEbur128('Summary:\n    I:         -70.0 LUFS\n  True peak:\n    Peak:       -inf dBFS');
  assert.equal(silent.I, -70);
  assert.equal(silent.TP, -Infinity);
});

test('mix: music + sfx → exact length, −14 ±0.5 LUFS, ≤ −1 dBTP after AAC, never -shortest', { skip: !FFMPEG && 'ffmpeg not found (set FFMPEG_PATH)', timeout: 900000 }, async () => {
  const dir = project('ms-mix-', { duration: 4, formats: ['9x16', '1x1'], primaryFormat: '9x16' });
  try {
    const sr = 48000;
    const n = 4 * sr;
    const beat = new Float32Array(n);
    for (let k = 0; k < 8; k++) for (let i = 0; i < 12000; i++) beat[k * 24000 + i] += Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-i / 1500)) * i / sr) * Math.exp(-i / 5000) * 0.5;
    const pad = sine(n, 220, 0.05);
    for (let i = 0; i < n; i++) pad[i] += beat[i];
    A.writeWav(path.join(dir, 'audio', 'music.wav'), [pad, Float32Array.from(pad)], sr);
    const clicks = new Float32Array(Math.round(3.5 * sr)); // shorter than the film: mix refuses it, or pads it with --allow-short-stems
    for (let k = 0; k < 14; k++) for (let i = 0; i < 400; i++) clicks[k * 12000 + i] = Math.sin(i * 0.8) * Math.exp(-i / 60) * 0.3;
    A.writeWav(path.join(dir, 'audio', 'sfx.wav'), [clicks, clicks], sr);
    for (const f of ['9x16', '1x1']) {
      fs.mkdirSync(path.join(dir, 'out', f), { recursive: true });
      await S.ffmpeg(dir, ['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir, 'out', f, 'silent.mp4')]);
      fs.writeFileSync(path.join(dir, 'out', f, 'render.json'), JSON.stringify({ format: f, frames: 120, fps: 30, from: 0, to: 4 }));
    }
    const refused = await runTool(dir, 'mix.mjs', ['--format', 'all', '--json']);
    assert.equal(refused.code, 1, 'a stem 0.5 s short of the film stops the mix');
    assert.match(refused.stderr, /sfx stem audio\/sfx\.wav is 3\.50 s but the film needs 4\.00 s: the last 0\.50 s would be silent/);
    assert.match(refused.stderr, /--allow-short-stems/);
    assert.ok(!fs.existsSync(path.join(dir, 'out', 'score.wav')), 'nothing was written');
    const r = await runTool(dir, 'mix.mjs', ['--format', 'all', '--allow-short-stems', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = lastJson(r.stdout);
    assert.ok(j.warnings.some((w) => /sfx stem audio\/sfx\.wav is 3\.50 s but the film needs 4\.00 s.*--allow-short-stems/.test(w)), 'the padded stem is reported');
    assert.equal(j.samples, 4 * sr);
    assert.ok(Math.abs(j.I - -14) <= 0.5, `master ${j.I} LUFS`);
    assert.ok(j.TP <= -1, `master ${j.TP} dBTP`);
    assert.equal(j.formats.length, 2);
    for (const f of j.formats) {
      assert.ok(Math.abs(f.I - -14) <= 0.5 && f.TP <= -1, `${f.format}: ${f.I} LUFS ${f.TP} dBTP`);
      const probe = await S.run(FFMPEG, ['-hide_banner', '-i', path.join(dir, f.final)]);
      assert.match(probe.stderr, /Duration: 00:00:04\.00/);
      assert.match(probe.stderr, /Audio: aac.*48000 Hz, stereo/);
    }
    const master = A.readWav(path.join(dir, 'out', 'score.wav'));
    assert.equal(master.channels[0].length, 4 * sr, 'master is exactly frames/fps long');
    assert.ok(fs.existsSync(path.join(dir, 'out', 'final.mp4')));
    assert.ok(!fs.existsSync(path.join(dir, 'out', '.mix')), 'scratch removed');
    const src = fs.readFileSync(path.join(TEMPLATE, 'tools', 'mix.mjs'), 'utf8');
    assert.ok(!src.includes("'-shortest'"), 'mix.mjs never passes -shortest');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mix: no stems → a silent track of the exact length (with a warning)', { skip: !FFMPEG && 'ffmpeg not found (set FFMPEG_PATH)', timeout: 300000 }, async () => {
  const dir = project('ms-mix0-', { duration: 2 });
  try {
    const r = await runTool(dir, 'mix.mjs', ['--music', 'none', '--sfx', 'none', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = lastJson(r.stdout);
    assert.equal(j.method, 'silent');
    assert.ok(j.warnings.some((w) => /no stems/.test(w)));
    assert.equal(A.readWav(path.join(dir, 'out', 'score.wav')).channels[0].length, 96000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// voice.mjs (ElevenLabs is never called here: dry run and the missing-key error only)

test('voice: --dry-run plans without network or key; a real run without a key fails clearly', async () => {
  const dir = project('ms-voice-');
  try {
    fs.writeFileSync(path.join(dir, 'audio', 'voice.json'), JSON.stringify([{ t: 0.5, text: 'Meet the new dashboard.' }, { t: 3, text: 'Ship it today.', voiceId: 'abc' }]));
    const env = { ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '' };
    const dry = await runTool(dir, 'voice.mjs', ['--dry-run', '--voice-id', 'VOICE1', '--json'], env);
    assert.equal(dry.code, 0, dry.stderr);
    const j = lastJson(dry.stdout);
    assert.equal(j.dryRun, true);
    assert.equal(j.chars, 'Meet the new dashboard.'.length + 'Ship it today.'.length);
    assert.deepEqual(j.lines.map((l) => l.voiceId), ['VOICE1', 'abc']);
    assert.equal(j.keyPresent, false);
    const run = await runTool(dir, 'voice.mjs', ['--voice-id', 'VOICE1'], env);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /ELEVENLABS_API_KEY is not set/);
    const noVoice = await runTool(dir, 'voice.mjs', [], env);
    assert.equal(noVoice.code, 2, 'a missing voice id is a usage error');
    const bad = await runTool(dir, 'voice.mjs', ['--nope'], env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /Options:/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// decodeAudio: one level rule per file, whatever its container or sample rate

test("decodeAudio: mono → stereo is ffmpeg's −3 dB per side at any sample rate; a same-rate stereo WAV is untouched; surround is downmixed", { skip: !FFMPEG && 'ffmpeg not found (set FFMPEG_PATH)', timeout: 300000 }, async () => {
  const dir = mkTmp('ms-audio-dec-');
  try {
    const rmsOf = (chs) => A.rms([chs[0]]);
    const want = 0.5 / Math.SQRT2 / Math.SQRT2; // sine amplitude 0.5: RMS 0.3536, minus 3 dB
    const mono = (sr) => A.writeWav(path.join(dir, `mono${sr}.wav`), [sine(sr, 440, 0.5, sr)], sr, { bits: 32 });
    mono(48000); mono(44100);
    const a = await A.decodeAudio(dir, 'mono48000.wav', { sr: 48000, channels: 2 });
    const b = await A.decodeAudio(dir, 'mono44100.wav', { sr: 48000, channels: 2 });
    assert.equal(a.channels.length, 2);
    assert.ok(Math.abs(rmsOf(a.channels) - want) < 0.005, `48 kHz mono → RMS ${rmsOf(a.channels)} (want ${want})`);
    assert.ok(Math.abs(rmsOf(b.channels) - rmsOf(a.channels)) < 0.005, `44.1 kHz mono ${rmsOf(b.channels)} matches 48 kHz mono ${rmsOf(a.channels)}`);
    assert.deepEqual(a.channels[0].subarray(1000, 1010), a.channels[1].subarray(1000, 1010), 'both sides carry the same signal');
    // Control: stereo at the target rate takes the no-ffmpeg path and is bit-exact.
    const st = sine(48000, 440, 0.5);
    A.writeWav(path.join(dir, 'stereo48.wav'), [st, st], 48000, { bits: 32 });
    const c = await A.decodeAudio(dir, 'stereo48.wav', { sr: 48000, channels: 2 });
    assert.deepEqual(c.channels[0], st);
    // A 6-channel WAV with sound only in the centre: the downmix keeps it (remix() used to keep channels 0 and 1 only).
    const silent = new Float32Array(48000);
    A.writeWav(path.join(dir, 'surround.wav'), [silent, silent, sine(48000, 440, 0.5), silent, silent, silent], 48000, { bits: 32 });
    const d = await A.decodeAudio(dir, 'surround.wav', { sr: 48000, channels: 2 });
    assert.ok(rmsOf(d.channels) > 0.1, `centre channel survives the downmix (RMS ${rmsOf(d.channels)})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
