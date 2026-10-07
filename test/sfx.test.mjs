// sfx.mjs: the 12 voices, the bus (exact film length, limiter, pan/gain/pitch, aliases), empty cues, unknown types,
// per-cue seeds, riser arrival, loop wrap, sample overrides and the CLI exit codes. No browser: cues come from files.
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
const X = await import(tool('sfx.mjs'));
const A = await import(tool('audio.mjs'));
const { SFX_TYPES } = await import(pathToFileURL(path.join(TEMPLATE, 'lib', 'timeline.js')).href);
const sha = (chs) => crypto.createHash('sha256').update(A.encodeWav(chs, 48000, { bits: 16 })).digest('hex');
const SR = 48000;

// Every temp dir is removed by its test's finally; this net catches the ones a timed-out or crashed test leaves behind.
const tmpDirs = new Set();
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.add(d); return d; };
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function project(prefix) {
  const dir = mkTmp(prefix);
  fs.cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(path.relative(TEMPLATE, src)) });
  return dir;
}
function runTool(dir, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, 'tools', 'sfx.mjs'), ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const segPeak = (c, a, b) => { let m = 0; for (let i = Math.max(0, Math.round(a * SR)); i < Math.min(c.length, Math.round(b * SR)); i++) m = Math.max(m, Math.abs(c[i])); return m; };

test('every SFX type in lib/timeline.js has a deterministic, finite, audible voice', () => {
  assert.deepEqual(Object.keys(X.VOICES).sort(), [...SFX_TYPES].sort());
  for (const type of SFX_TYPES) {
    const a = X.synthVoice(type, { seed: 5, i: 2 });
    const b = X.synthVoice(type, { seed: 5, i: 2 });
    const chs = Array.isArray(a.data) ? a.data : [a.data];
    assert.deepEqual(a.data, b.data, `${type} is deterministic`);
    assert.ok(chs.every((c) => c.every(Number.isFinite)), `${type} is finite`);
    assert.ok(Math.abs(A.peakDb(chs) - X.VOICES[type].level) < 0.01, `${type} is normalized to its level`);
    assert.ok(a.anchor >= 0 && a.anchor <= chs[0].length / SR, `${type} anchor inside the sound`);
    for (const c of chs) assert.ok(Math.abs(c[c.length - 1]) < 1e-3, `${type} ends at silence`);
  }
  assert.throws(() => X.synthVoice('boom'), /unknown SFX type "boom".*click/);
});

test('empty cues → silence of exactly the film length', () => {
  const { channels, placed } = X.renderSfx([], { duration: 12 });
  assert.equal(channels.length, 2);
  assert.equal(channels[0].length, 12 * SR);
  assert.equal(A.peak(channels), 0);
  assert.equal(placed.length, 0);
  assert.throws(() => X.renderSfx([], { duration: 0 }), /duration/);
});

test('unknown type → error that lists the valid types', () => {
  assert.throws(() => X.renderSfx([{ t: 1, type: 'boom' }], { duration: 2 }), (err) => /unknown SFX type "boom"/.test(err.message) && SFX_TYPES.every((t) => err.message.includes(t)));
  assert.throws(() => X.renderSfx([{ t: 1 }], { duration: 2 }), /missing type/);
});

test('bus: all 12 voices, true-peak limited to −1 dBFS, deterministic bytes, exact length', () => {
  const cues = SFX_TYPES.map((type, i) => ({ t: 0.3 + i * 0.8, type, pan: (i % 3) - 1, pitch: i % 4 === 3 ? 1.2 : 1 }));
  const a = X.renderSfx(cues, { duration: 10.5 });
  const b = X.renderSfx([...cues].reverse(), { duration: 10.5 });
  assert.equal(a.channels[0].length, 10.5 * SR);
  assert.equal(sha(a.channels), sha(b.channels), 'cue order in the file does not matter');
  assert.ok(A.peakDb(a.channels, { truePeak: true }) <= -1, 'true peak ≤ −1 dBFS');
  for (const [i, type] of SFX_TYPES.entries()) {
    const t = 0.3 + i * 0.8;
    const p = Math.max(segPeak(a.channels[0], t - 0.4, Math.min(10.5, t + 0.5)), segPeak(a.channels[1], t - 0.4, Math.min(10.5, t + 0.5)));
    assert.ok(p > 0.01, `${type} is audible around ${t}s`);
  }
  const stacked = X.renderSfx([{ t: 1, type: 'thump' }, { t: 1.005, type: 'hit' }, { t: 1.01, type: 'thump', gain: 3 }], { duration: 2 });
  assert.ok(A.peak(stacked.channels) <= A.dbToGain(-1) + 1e-6, 'stacked cues never clip');
});

test('aliases {sfx, vol}, gain and pan act per cue', () => {
  const ref = X.renderSfx([{ t: 0.5, type: 'click', gain: 0.5 }], { duration: 1 });
  const alias = X.renderSfx([{ t: 0.5, sfx: 'click', vol: 0.5 }], { duration: 1 });
  assert.equal(sha(ref.channels), sha(alias.channels));
  const left = X.renderSfx([{ t: 0.5, type: 'pop', pan: -1 }], { duration: 1 });
  assert.ok(segPeak(left.channels[0], 0.4, 0.8) > 0.05 && segPeak(left.channels[1], 0.4, 0.8) < 1e-6, 'hard left');
});

test('per-cue seeds: appending a later cue does not change earlier sounds; anchors land on the cue time', () => {
  const base = [{ t: 0.5, type: 'whoosh' }, { t: 1.2, type: 'glitch' }];
  const a = X.renderSfx(base, { duration: 3 });
  const b = X.renderSfx([...base, { t: 2.5, type: 'type' }], { duration: 3 });
  for (let c = 0; c < 2; c++) for (let i = 0; i < 2.4 * SR; i++) assert.equal(a.channels[c][i], b.channels[c][i]);
  const click = X.renderSfx([{ t: 1, type: 'click' }], { duration: 2 });
  let at = 0; let m = 0;
  for (let i = 0; i < 2 * SR; i++) { const v = Math.abs(click.channels[0][i]); if (v > m) { m = v; at = i; } }
  assert.ok(Math.abs(at / SR - 1) < 0.004, `click transient at ${at / SR}s`);
  const ws = X.renderSfx([{ t: 1, type: 'whoosh' }], { duration: 2 });
  assert.ok(segPeak(ws.channels[0], 0.6, 0.95) > 0.005, 'a whoosh starts before its cue (peak on the cue)');
});

test('riser starts on its cue and arrives on the next hit', () => {
  const r = X.renderSfx([{ t: 2, type: 'riser' }, { t: 3.5, type: 'hit' }], { duration: 6 });
  const riser = r.placed.find((p) => p.type === 'riser');
  assert.equal(riser.start, 2);
  const lone = X.renderSfx([{ t: 2, type: 'riser' }], { duration: 6 });
  assert.ok(segPeak(lone.channels[0], 3.4, 3.58) > segPeak(lone.channels[0], 2.0, 2.5), 'swells toward 1.6 s after the cue');
  assert.ok(segPeak(lone.channels[0], 3.62, 6) < 1e-4, 'default riser lasts 1.6 s');
  const onHit = X.renderSfx([{ t: 2, type: 'riser' }], { duration: 6 }).channels[0];
  assert.ok(segPeak(onHit, 1, 1.99) === 0, 'nothing before the cue');
});

test('cues past the end are skipped with a warning; loop films wrap tails to the start', () => {
  const late = X.renderSfx([{ t: 5, type: 'click' }], { duration: 2 });
  assert.equal(late.placed.length, 0);
  assert.match(late.warnings[0], /past the end/);
  const loop = X.renderSfx([{ t: 1.9, type: 'hit' }], { duration: 2, loop: true });
  assert.ok(segPeak(loop.channels[0], 0, 0.5) > 0.01, 'the hit tail wraps to the start');
  const cut = X.renderSfx([{ t: 1.9, type: 'hit' }], { duration: 2 });
  assert.equal(segPeak(cut.channels[0], 0, 0.5), 0);
});

test('samples: audio/samples/<type>.wav replaces the voice and keeps pitch/pan/gain', async () => {
  const dir = project('ms-sfx-samples-');
  try {
    const n = 4800;
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 500 * i / SR) * Math.exp(-i / 960) * 0.5);
    fs.mkdirSync(path.join(dir, 'audio', 'samples'), { recursive: true });
    A.writeWav(path.join(dir, 'audio', 'samples', 'click.wav'), [x, x]);
    const samples = await X.loadSamples(dir, 'audio/samples');
    assert.deepEqual(Object.keys(samples), ['click']);
    const r = X.renderSfx([{ t: 0.5, type: 'click' }, { t: 1, type: 'pop' }], { duration: 2, samples });
    assert.equal(r.placed[0].sample, true);
    assert.equal(r.placed[1].sample, false);
    let zc = 0;
    for (let i = Math.round(0.502 * SR); i < Math.round(0.512 * SR); i++) if ((r.channels[0][i - 1] < 0) !== (r.channels[0][i] < 0)) zc++;
    assert.ok(zc >= 8 && zc <= 12, `the 500 Hz sample plays (${zc} zero crossings in 10 ms)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sfx CLI: --list, --cues with empty/unknown files, exact WAV length, exit codes', { timeout: 300000 }, async () => {
  const dir = project('ms-sfx-');
  try {
    const list = await runTool(dir, ['--list', '--json']);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).voices.length, 12);
    fs.writeFileSync(path.join(dir, 'audio', 'empty.json'), '[]');
    const e = await runTool(dir, ['--cues', 'audio/empty.json', '--json']);
    assert.equal(e.code, 0, e.stderr);
    const w = A.readWav(path.join(dir, 'audio', 'sfx.wav'));
    assert.equal(w.channels[0].length, 12 * SR, 'studio.json duration');
    assert.equal(A.peak(w.channels), 0);
    fs.writeFileSync(path.join(dir, 'audio', 'bad.json'), JSON.stringify([{ t: 1, type: 'kaboom' }]));
    const u = await runTool(dir, ['--cues', 'audio/bad.json']);
    assert.equal(u.code, 1);
    assert.match(u.stderr, /unknown SFX type "kaboom" at t=1 \(valid: click, tick/);
    fs.writeFileSync(path.join(dir, 'audio', 'obj.json'), JSON.stringify({ duration: 3, cues: [{ t: 0.5, sfx: 'snap', vol: 0.8 }] }));
    const o = await runTool(dir, ['--cues', 'audio/obj.json', '--out', 'audio/o.wav', '--json']);
    assert.equal(o.code, 0, o.stderr);
    assert.equal(JSON.parse(o.stdout.trim()).samples, 3 * SR, 'duration from the cue file');
    const d = await runTool(dir, ['--cues', 'audio/obj.json', '--dur', '1.5', '--out', 'audio/o.wav', '--json']);
    assert.equal(JSON.parse(d.stdout.trim()).samples, 1.5 * SR, '--dur wins');
    const bad = await runTool(dir, ['--volume', '3']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown option --volume[\s\S]*Options:/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// Noise seeds follow the cue (type, time, rank among identical cues), not its position in the time-sorted list.

test('cue keys: stable when other cues are added or removed, distinct for identical (type, time) cues', () => {
  const base = [{ t: 1, type: 'click' }, { t: 2, type: 'whoosh' }, { t: 2.7, type: 'glitch' }];
  const before = X.cueKeys(base);
  const withEarlier = X.cueKeys([{ t: 0.5, type: 'tick' }, ...base]);
  assert.deepEqual(withEarlier.slice(1), before, 'an earlier cue does not re-key the later ones');
  assert.deepEqual(X.cueKeys([{ t: 1, type: 'click' }, { t: 1.5, type: 'pop' }, { t: 2, type: 'whoosh' }]).filter((_, i) => i !== 1), [before[0], before[1]], 'nor does a cue in between');
  const twins = X.cueKeys([{ t: 2, type: 'whoosh' }, { t: 2, type: 'whoosh' }, { t: 2.0004, type: 'whoosh' }, { t: 2, type: 'pop' }]);
  assert.equal(new Set(twins).size, 4, 'same type and time → ranked apart; same time, other type → apart');
  assert.equal(X.cueKeys([{ t: 2.0004, type: 'whoosh' }])[0], X.cueKeys([{ t: 2, type: 'whoosh' }])[0], 'times are keyed in whole milliseconds');
});

test('sfx: inserting or removing an EARLIER cue leaves the noise of every later cue bit-identical', () => {
  const base = [{ t: 1, type: 'click' }, { t: 2, type: 'whoosh' }, { t: 2.7, type: 'glitch' }, { t: 3.4, type: 'type' }];
  const a = X.renderSfx(base, { duration: 4 });
  const b = X.renderSfx([{ t: 0.5, type: 'tick' }, ...base], { duration: 4 });
  for (const [from, to, what] of [[0.95, 1.2, 'click'], [1.6, 2.6, 'whoosh'], [2.65, 3.0, 'glitch'], [3.35, 3.5, 'type']]) {
    for (let c = 0; c < 2; c++) {
      const i0 = Math.round(from * SR);
      const i1 = Math.round(to * SR);
      assert.ok(A.peak(a.channels[c].subarray(i0, i1)) > 0.001 || c === 1, `${what} is audible`);
      assert.deepEqual(a.channels[c].subarray(i0, i1), b.channels[c].subarray(i0, i1), `${what} (channel ${c}) is unchanged by an earlier cue`);
    }
  }
  const c = X.renderSfx(base.filter((q) => q.type !== 'click'), { duration: 4 });
  const i0 = Math.round(1.6 * SR);
  const i1 = Math.round(3.5 * SR);
  assert.deepEqual(a.channels[0].subarray(i0, i1), c.channels[0].subarray(i0, i1), 'removing an earlier cue changes nothing after it');
  // Cues at the same time keep their own noise: two identical whooshes are not a doubled copy of one.
  const one = X.renderSfx([{ t: 2, type: 'whoosh', gain: 0.5 }], { duration: 3 });
  const two = X.renderSfx([{ t: 2, type: 'whoosh', gain: 0.5 }, { t: 2, type: 'whoosh', gain: 0.5 }], { duration: 3 });
  let same = 0;
  let n = 0;
  for (let i = Math.round(1.7 * SR); i < Math.round(2.2 * SR); i++) { n++; if (Math.abs(two.channels[0][i] - 2 * one.channels[0][i]) < 1e-9) same++; }
  assert.ok(same / n < 0.05, `identical cues use different noise (${same}/${n} samples were an exact doubling)`);
});

test('sfx: loadSamples(null | "none") skips the sample folder; --no-samples does not crash and ignores an existing folder', { timeout: 300000 }, async () => {
  assert.deepEqual(await X.loadSamples(process.cwd(), null), {});
  assert.deepEqual(await X.loadSamples(process.cwd(), undefined), {});
  assert.deepEqual(await X.loadSamples(process.cwd(), 'none'), {});
  const dir = project('ms-sfx-nosamples-');
  try {
    const click = Float32Array.from({ length: 2400 }, (_, i) => Math.sin(2 * Math.PI * 500 * i / SR) * Math.exp(-i / 500) * 0.5);
    fs.mkdirSync(path.join(dir, 'audio', 'samples'), { recursive: true });
    A.writeWav(path.join(dir, 'audio', 'samples', 'click.wav'), [click, click]);
    fs.writeFileSync(path.join(dir, 'audio', 'cues.json'), JSON.stringify([{ t: 0.5, type: 'click' }, { t: 1, type: 'whoosh' }]));
    const withSamples = await runTool(dir, ['--cues', 'audio/cues.json', '--out', 'audio/a.wav', '--json']);
    assert.equal(withSamples.code, 0, withSamples.stderr);
    assert.deepEqual(JSON.parse(withSamples.stdout.trim()).overrides, ['click']);
    const no = await runTool(dir, ['--cues', 'audio/cues.json', '--no-samples', '--out', 'audio/b.wav', '--json']);
    assert.equal(no.code, 0, no.stderr);
    assert.doesNotMatch(no.stderr, /must be of type string/);
    assert.deepEqual(JSON.parse(no.stdout.trim()).overrides, [], '--no-samples synthesizes every voice');
    const none = await runTool(dir, ['--cues', 'audio/cues.json', '--samples', 'none', '--out', 'audio/c.wav', '--json']);
    assert.deepEqual(JSON.parse(none.stdout.trim()).overrides, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
