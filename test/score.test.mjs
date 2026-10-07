// score.mjs: deterministic bytes, −1 dBFS ceiling, exact length, analytic beats.json, form planning, CLI behaviour.
// Pure JS (no ffmpeg, no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const tool = (f) => pathToFileURL(path.join(TEMPLATE, 'tools', f)).href;
const SC = await import(tool('score.mjs'));
const A = await import(tool('audio.mjs'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Every temp dir is removed by its test's finally; this net catches the ones a timed-out or crashed test leaves behind.
const tmpDirs = new Set();
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.add(d); return d; };
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function project(prefix, patch = {}) {
  const dir = mkTmp(prefix);
  fs.cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(path.relative(TEMPLATE, src)) });
  const cfgPath = path.join(dir, 'studio.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), ...patch }, null, 2));
  return dir;
}
function runTool(dir, name, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, 'tools', name), ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// sha256 of the 16-bit WAV for { style, mode, bpm: 120, dur: 5.25, seed: 3 }, recorded before instruments.mjs was
// split out of score.mjs (Node 20, V8's fdlibm Math). A refactor must keep these bytes; a deliberate change to the
// sound updates this table in the same commit.
const GOLDEN = {
  pulse: { minor: '7ad73c0b3778040bbb59f06180bd0dce64031efc3b2898cd3553f89ec33f3aac', major: '19845548512732e6650ee0d9ce2a66a52b1e4a8cdc89d39349f484d93c82468a' },
  piano: { minor: '03feeb77a4b83ca6200f6b68d2e2ed18825cce59a48b6ef9e3740ebe66e7b7b9', major: 'bc300cead8d1fded66f13db60a45ca9900c10ce8229212d3d13f6f35d099a0a4' },
  minimal: { minor: 'eaf6286829f1ea16bab053179fe1bb4ebbc2de7dedafd1b48270611408a9e949', major: 'fb53c5e57aa1bab0fb75e7a955fa28384945387c6db417f593c5b2371b2afeaf' },
  cinematic: { minor: '7e465e51b20bd6b9ee73ba316b37f96b157d285229fa55f419e15a3101afa78e', major: '50b33f80ad38a5708446279b78978a9f00365911f0d2ce245978a8af8a9cd28b' },
};

for (const style of SC.STYLES) {
  test(`score ${style}: same args → same bytes; peak ≤ −1 dBFS; exact length; no DC; starts and ends at silence`, () => {
    const opts = { style, bpm: 120, dur: 5.25, seed: 3 };
    const a = SC.composeScore(opts);
    const b = SC.composeScore(opts);
    const wa = A.encodeWav(a.channels, 48000, { bits: 16 });
    assert.equal(sha(wa), sha(A.encodeWav(b.channels, 48000, { bits: 16 })), 'deterministic');
    assert.equal(a.mode, 'minor');
    assert.equal(sha(wa), GOLDEN[style].minor, `${style} minor bytes match the recorded golden hash`);
    assert.equal(sha(A.encodeWav(SC.composeScore({ ...opts, mode: 'major' }).channels, 48000, { bits: 16 })), GOLDEN[style].major, `${style} major bytes match the recorded golden hash`);
    assert.notEqual(sha(wa), sha(A.encodeWav(SC.composeScore({ ...opts, seed: 4 }).channels, 48000, { bits: 16 })), 'the seed changes the music');
    const back = A.decodeWav(wa);
    assert.equal(back.channels.length, 2);
    assert.equal(back.channels[0].length, Math.round(5.25 * 48000));
    assert.ok(A.peakDb(back.channels) <= -1, `sample peak ${A.peakDb(back.channels)} dBFS`);
    assert.ok(A.peakDb(a.channels, { truePeak: true }) <= -1, 'true peak stays under −1 dBTP');
    assert.ok(Number.isFinite(a.stats.lufs) && a.stats.lufs > -24 && a.stats.lufs < -10, `loudness ${a.stats.lufs} LUFS is in a usable range`);
    const mean = a.channels[0].reduce((s, v) => s + v, 0) / a.channels[0].length;
    assert.ok(Math.abs(mean) < 1e-3, 'no DC offset');
    assert.equal(Math.abs(a.channels[0][a.channels[0].length - 1]), 0, 'faded to exact silence at the end');
    assert.equal(Math.abs(a.channels[0][0]), 0, 'first sample is silent (click-free start)');
    let maxJump = 0;
    for (const c of a.channels) for (let i = 1; i < c.length; i++) maxJump = Math.max(maxJump, Math.abs(c[i] - c[i - 1]));
    assert.ok(maxJump < 0.9, `no full-scale sample steps (max ${maxJump.toFixed(3)})`);
  });
}

test('score: beats.json grid is analytic and matches the schema', () => {
  const r = SC.composeScore({ style: 'minimal', bpm: 128, dur: 12 });
  const g = r.grid;
  assert.equal(g.version, 1);
  assert.equal(g.source, 'grid');
  assert.equal(g.bpm, 128);
  assert.equal(g.offset, 0);
  assert.equal(g.beatsPerBar, 4);
  assert.equal(g.duration, 12);
  assert.equal(g.downbeatPhase, 0);
  assert.equal(g.beats.length, Math.ceil(12 / (60 / 128)));
  g.beats.forEach((t, k) => assert.ok(Math.abs(t - k * 60 / 128) < 1e-6));
  assert.deepEqual(g.downbeats, g.beats.filter((_, k) => k % 4 === 0));
  assert.ok(g.beats.every((t) => t < 12));
  assert.ok(g.hits.length > 0 && g.hits.every((t) => g.downbeats.some((d) => Math.abs(d - t) < 1e-6)), 'hits sit on downbeats');
  assert.deepEqual(g.sections.map((s) => s.name), ['intro', 'build', 'drop', 'outro']);
});

test('score: form — drop near 40 %, final hit on the last downbeat ≤ dur − 0.5, validation', () => {
  const p = SC.planScore({ bpm: 120, dur: 12 });
  assert.equal(p.finalBar, 5, 'final hit at 10 s');
  assert.equal(p.dropBar, 2, 'drop at 4 s');
  assert.equal(SC.sectionOf(p, 0), 'intro');
  assert.equal(SC.sectionOf(p, 1), 'build');
  assert.equal(SC.sectionOf(p, 3), 'drop');
  assert.equal(SC.sectionOf(p, 5), 'final');
  const long = SC.planScore({ bpm: 120, dur: 60 });
  assert.ok(long.finalBar * long.bar <= 59.5 && (long.finalBar + 1) * long.bar > 59.5);
  assert.ok(Math.abs(long.dropBar * long.bar / 60 - 0.4) < 0.05);
  assert.throws(() => SC.planScore({ bpm: 120, dur: 12, drop: 9 }), /--drop/);
  assert.throws(() => SC.planScore({ bpm: 0, dur: 12 }), /--bpm/);
  const tiny = SC.planScore({ bpm: 120, dur: 1 });
  assert.equal(tiny.finalBar, 0, 'a 1 s film is a single stinger');
  const r = SC.composeScore({ style: 'pulse', dur: 1 });
  assert.equal(r.channels[0].length, 48000);
  assert.throws(() => SC.composeScore({ style: 'disco' }), /--style/);
});

test('score: keys and modes', () => {
  assert.deepEqual(SC.parseKey('A'), { pc: 9, name: 'A', mode: null });
  assert.deepEqual(SC.parseKey('F#m'), { pc: 6, name: 'F#', mode: 'minor' });
  assert.deepEqual(SC.parseKey('Bb'), { pc: 10, name: 'Bb', mode: null });
  assert.equal(SC.parseKey('cmaj').mode, 'major');
  assert.throws(() => SC.parseKey('H'), /--key/);
  const r = SC.composeScore({ style: 'piano', key: 'Ebm', dur: 3 });
  assert.equal(r.key, 'Eb');
  assert.equal(r.mode, 'minor');
  assert.equal(SC.composeScore({ style: 'piano', key: 'C', mode: 'major', dur: 3 }).mode, 'major');
});

test('instruments.mjs: every voice is finite, deterministic, fades to exact silence; score.mjs imports rather than redefines them', async () => {
  const I = await import(tool('instruments.mjs'));
  const { mulberry32 } = await import(pathToFileURL(path.join(TEMPLATE, 'lib', 'rng.js')).href);
  const nz = (k) => A.noiseGen('instruments-test', k);
  const voices = {
    kick: () => I.kick({ noise: nz(1) }),
    clap: () => I.clap(nz(2), nz(3)),
    hat: () => I.hat({ noise: nz(4) }),
    openHat: () => I.hat({ open: true, noise: nz(5) }),
    shaker: () => I.shaker(nz(6)),
    taiko: () => I.taiko({ noise: nz(7) }),
    boom: () => I.boom(nz(8)),
    impact: () => I.impact(nz(9), nz(10)),
    pluckNote: () => I.pluckNote(440, 0.2),
    pianoNote: () => I.pianoNote(60, 0.7, 0.5, mulberry32(1), nz(11)),
    bowNote: () => I.bowNote(220, 0.5, { rnd: mulberry32(2), noise: nz(12) }),
    blip: () => I.blip(880, 0.8, nz(13)),
  };
  const crackOnset = new Set(['boom', 'impact']); // these open on a noise crack by design
  for (const [name, make] of Object.entries(voices)) {
    const a = make();
    const chs = Array.isArray(a) ? a : [a];
    assert.equal(chs.length, name === 'clap' || name === 'impact' ? 2 : 1, `${name} channel count`);
    assert.deepEqual(make(), a, `${name} is deterministic`);
    assert.ok(chs.every((c) => c.length > 0 && c.every(Number.isFinite)), `${name} is finite`);
    assert.ok(A.peak(chs) > 0.1 && A.peak(chs) <= 1.1, `${name} is audible and near full scale (${A.peak(chs)})`);
    for (const c of chs) assert.equal(Math.abs(c[c.length - 1]), 0, `${name} tail ends at exact silence`);
    if (!crackOnset.has(name)) for (const c of chs) assert.equal(Math.abs(c[0]), 0, `${name} attack starts from silence`);
  }
  const line = I.monoLine(48000, [{ t: 0.1, dur: 0.3, midi: 40, vel: 1 }, { t: 0.5, dur: 0.3, midi: 43, vel: 0.8 }]);
  assert.equal(line.length, 48000);
  assert.equal(line[0], 0, 'silent before the first note');
  let maxStep = 0;
  for (let i = 1; i < line.length; i++) maxStep = Math.max(maxStep, Math.abs(line[i] - line[i - 1]));
  assert.ok(maxStep < 0.05, `monoLine note changes do not click (max step ${maxStep})`);
  const bus = [new Float32Array(48000).fill(1), new Float32Array(48000).fill(1)];
  I.pump(bus, [0.25, 0.75], 0.8, 0.1);
  assert.equal(bus[0][0], 1, 'no gain change before the first kick');
  assert.ok(Math.abs(bus[1][Math.round(0.255 * 48000)] - 0.2) < 1e-6, 'full depth 5 ms after a kick');
  assert.equal(I.N(1), 48000);
  const src = fs.readFileSync(path.join(TEMPLATE, 'tools', 'score.mjs'), 'utf8');
  for (const name of ['kick', 'clap', 'hat', 'shaker', 'taiko', 'boom', 'impact', 'pluckNote', 'pianoNote', 'bowNote', 'blip', 'monoLine', 'pump']) {
    assert.equal(typeof I[name], 'function', `instruments.mjs exports ${name}`);
    assert.ok(!new RegExp(`function ${name}\\(`).test(src), `score.mjs does not redefine ${name}`);
  }
});

test('score: --loop wraps tails so the seam is continuous', () => {
  const r = SC.composeScore({ style: 'pulse', bpm: 120, dur: 8, loop: true });
  assert.equal(r.channels[0].length, 8 * 48000);
  assert.deepEqual(r.grid.sections.map((s) => s.name), ['loop']);
  const c = r.channels[0];
  const steps = [];
  for (let i = 1; i < c.length; i += 7) steps.push(Math.abs(c[i] - c[i - 1]));
  steps.sort((x, y) => x - y);
  const p999 = steps[Math.floor(steps.length * 0.999)];
  assert.ok(Math.abs(c[0] - c[c.length - 1]) <= p999 + 1e-4, 'end → start jump is no larger than ordinary sample steps');
});

test('score CLI: identical files across runs, beats.json written, --if-missing keeps a supplied track, bad flags exit 2', { timeout: 600000 }, async () => {
  const dir = project('ms-score-', { duration: 4 });
  try {
    const a = await runTool(dir, 'score.mjs', ['--style', 'minimal', '--json']);
    assert.equal(a.code, 0, a.stderr);
    const ja = JSON.parse(a.stdout.trim().split('\n').pop());
    const file = path.join(dir, 'audio', 'music.wav');
    const first = sha(fs.readFileSync(file));
    assert.equal(ja.sha256, first);
    const beats = JSON.parse(fs.readFileSync(path.join(dir, 'audio', 'beats.json'), 'utf8'));
    assert.equal(beats.source, 'grid');
    assert.equal(beats.audioSha256, first);
    const tpl = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'studio.json'), 'utf8'));
    assert.equal(tpl.audio.style, 'pulse', 'the template studio.json names the default score style');
    assert.ok(SC.STYLES.includes(tpl.audio.style));
    const cfgPath = path.join(dir, 'studio.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, audio: { ...cfg.audio, style: 'minimal' } }, null, 2));
    const b = await runTool(dir, 'score.mjs', ['--json']); // no --style: studio.json audio.style decides
    assert.equal(b.code, 0, b.stderr);
    assert.equal(JSON.parse(b.stdout.trim().split('\n').pop()).style, 'minimal');
    assert.equal(sha(fs.readFileSync(file)), first, 'second run (style from studio.json) writes the same bytes');
    fs.writeFileSync(file, Buffer.from('user track'));
    const c = await runTool(dir, 'score.mjs', ['--if-missing', '--json']);
    assert.equal(c.code, 0, c.stderr);
    assert.equal(JSON.parse(c.stdout.trim()).skipped, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'user track', 'a supplied track is never overwritten');
    const d = await runTool(dir, 'score.mjs', ['--tempo', '90']);
    assert.equal(d.code, 2);
    assert.match(d.stderr, /unknown option --tempo[\s\S]*Options:/);
    const e = await runTool(dir, 'score.mjs', ['--style', 'polka']);
    assert.equal(e.code, 2);
    const h = await runTool(dir, 'score.mjs', ['--help']);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /--style/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// --if-missing must not keep a score generated with other settings (a stale music.wav made `npm run build` ship a film
// whose music ended halfway or ran off the beat grid), and must never touch a supplied track.

test('score: scoreParams resolves key/mode/drop bar; paramDiff names what changed; unchanged parameters keep their bytes', () => {
  const p = SC.scoreParams({ bpm: 120, dur: 12, style: 'pulse', key: 'F#m', seed: 3 });
  assert.deepEqual(p, { bpm: 120, dur: 12, style: 'pulse', key: 'F#', mode: 'minor', seed: 3, loop: false, beatsPerBar: 4, dropBar: 2 });
  assert.equal(SC.scoreParams({ bpm: 120, dur: 12, style: 'pulse', key: 'F#m', mode: 'major' }).mode, 'major', 'an explicit mode wins over the key suffix');
  assert.deepEqual(SC.paramDiff(p, p), []);
  assert.deepEqual(SC.paramDiff({ ...p, dur: 6, dropBar: 1 }, p), ['duration 6 → 12', 'drop bar 1 → 2']);
  assert.deepEqual(SC.paramDiff({ bpm: 90 }, p).slice(0, 2), ['bpm 90 → 120', 'duration unknown → 12'], 'a missing field counts as different');
  assert.throws(() => SC.scoreParams({ bpm: 0, dur: 12, style: 'pulse' }), /--bpm/);
  assert.equal(path.basename(SC.metaPathFor(path.join('x', 'audio', 'music.wav'))), 'music.meta.json');
  assert.equal(path.basename(SC.metaPathFor(path.join('x', 'other.v2.wav'))), 'other.v2.meta.json');
  // The sidecar is bookkeeping only: composing the same parameters again gives the same bytes.
  const opts = { style: 'minimal', bpm: 120, dur: 3, seed: 2 };
  assert.equal(sha(A.encodeWav(SC.composeScore(opts).channels, 48000)), sha(A.encodeWav(SC.composeScore(opts).channels, 48000)));
});

test('score CLI: --if-missing regenerates a stale score (duration/bpm/style change), keeps a matching one and a supplied track', { timeout: 600000 }, async () => {
  const dir = project('ms-score-stale-', { duration: 3 });
  const cfgPath = path.join(dir, 'studio.json');
  const setCfg = (patch) => fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')), ...patch }, null, 2));
  const file = path.join(dir, 'audio', 'music.wav');
  const beatsFile = path.join(dir, 'audio', 'beats.json');
  const metaFile = path.join(dir, 'audio', 'music.meta.json');
  const last = (r) => JSON.parse(r.stdout.trim().split('\n').pop());
  try {
    const first = await runTool(dir, 'score.mjs', ['--if-missing', '--style', 'minimal', '--json']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(last(first).skipped, undefined, 'nothing existed: generated');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.equal(meta.tool, 'score.mjs');
    assert.equal(meta.audioSha256, sha(fs.readFileSync(file)));
    assert.equal(meta.params.dur, 3);
    assert.equal(A.decodeWav(fs.readFileSync(file)).channels[0].length, 3 * 48000);

    // Same settings: kept, same bytes.
    const kept = sha(fs.readFileSync(file));
    const same = await runTool(dir, 'score.mjs', ['--if-missing', '--style', 'minimal', '--json']);
    assert.equal(last(same).skipped, true);
    assert.equal(sha(fs.readFileSync(file)), kept);

    // The reproduction: the film grows from 3 s to 5 s. The old file is 3 s long and beats.json still says 3.
    setCfg({ duration: 5 });
    const grown = await runTool(dir, 'score.mjs', ['--if-missing', '--style', 'minimal', '--json']);
    assert.equal(grown.code, 0, grown.stderr);
    assert.match(grown.stderr, /generated with other settings \(duration 3 → 5.*\) — regenerating/);
    assert.match(last(grown).regenerated, /duration 3 → 5/);
    assert.equal(A.decodeWav(fs.readFileSync(file)).channels[0].length, 5 * 48000, 'music.wav is the new length');
    assert.equal(JSON.parse(fs.readFileSync(beatsFile, 'utf8')).duration, 5, 'beats.json follows');
    assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).params.dur, 5);

    // bpm and style changes count too.
    setCfg({ bpm: 96 });
    const bpm = await runTool(dir, 'score.mjs', ['--if-missing', '--style', 'minimal', '--json']);
    assert.match(last(bpm).regenerated, /bpm 120 → 96/);
    assert.equal(JSON.parse(fs.readFileSync(beatsFile, 'utf8')).bpm, 96);
    const style = await runTool(dir, 'score.mjs', ['--if-missing', '--style', 'pulse', '--json']);
    assert.match(last(style).regenerated, /style minimal → pulse/);

    // A file from before the sidecar existed is recognised by beats.json (generator.tool + audioSha256).
    fs.writeFileSync(metaFile, '{ not json');
    setCfg({ duration: 4 });
    const legacy = await runTool(dir, 'score.mjs', ['--if-missing', '--style', 'pulse', '--json']);
    assert.match(last(legacy).regenerated, /duration 5 → 4/);
    assert.equal(A.decodeWav(fs.readFileSync(file)).channels[0].length, 4 * 48000);

    // A replaced (supplied) track is never overwritten, whatever studio.json says: the hash no longer matches.
    fs.writeFileSync(file, Buffer.from('user track'));
    setCfg({ duration: 9, bpm: 140 });
    const supplied = await runTool(dir, 'score.mjs', ['--if-missing', '--json']);
    assert.equal(supplied.code, 0, supplied.stderr);
    assert.equal(last(supplied).skipped, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'user track');
    // ... and neither is one that never had a sidecar or a score.mjs beats.json.
    fs.writeFileSync(metaFile, '{}');
    fs.writeFileSync(beatsFile, JSON.stringify({ version: 1, source: 'librosa', bpm: 100, duration: 3, beats: [] }));
    const measured = await runTool(dir, 'score.mjs', ['--if-missing', '--json']);
    assert.equal(last(measured).skipped, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'user track');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
