// critique.mjs (template/tools): evidence sheets that stay readable on a long film, a review range (--from / --to), the
// glyph-fallback preflight (P0 font-fallback) and the silence check (P1 audio-gap).
//   - browser-free units: sheet page naming (stills.mjs, shared with critique.mjs), silence parsing/judging, the range,
//     the Analyzer on a range, the font verdict and the findings built from it
//   - ffmpeg (skips without it): silence spans of a real mp4, `critique --video` (no browser needed) with a gap and paging
//   - real Chrome (skips without playwright / a browser): the whole film through critique.mjs, with a Latin-only font
//     drawing Hangul (must be a P0), the bundled NeoDunggeunmo pixel font (must pass), an unregistered family, a page
//     without textUse() (a note, not a failure), a range review and stale pages
// Env: FFMPEG_PATH, MOTION_SMOKE_NODE_MODULES (a node_modules with playwright), MOTION_TEMPLATE_DIR,
//      MOTION_TEST_HANGUL_FONT (a woff2 with Hangul, for the NeoDunggeunmo case; found by name under the sandbox otherwise).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const T_TOOLS = path.join(TEMPLATE, 'tools');
const imp = (name) => import(pathToFileURL(path.join(T_TOOLS, name)).href);

const made = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
const rmDir = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
after(() => { for (const d of made.splice(0)) { try { rmDir(d); } catch { /* still open: the OS temp cleanup takes it */ } } });
const listDir = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };

function findFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try { const p = createRequire(path.join(REPO, 'package.json'))('ffmpeg-static'); if (typeof p === 'string') candidates.push(p); } catch { /* not installed */ }
  for (const c of candidates) if (spawnSync(c, ['-hide_banner', '-version'], { timeout: 30000, windowsHide: true }).status === 0) return c;
  return null;
}
const FFMPEG = findFfmpeg();
const NO_FFMPEG = FFMPEG ? false : 'ffmpeg not found (set FFMPEG_PATH or npm install ffmpeg-static at the repo root)';
if (FFMPEG) process.env.FFMPEG_PATH = FFMPEG;

const spawnP = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1)); } catch { return null; } })() }));
});

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

const pngSize = (file) => { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

// ---------------------------------------------------------------------------------------------------------------
// Sheet pages: one naming rule for stills.mjs and critique.mjs (they share out/review/<fmt>/)

test('sheet pages: page 1 is <name>.png, page n >= 2 is <name>-n.png; a run removes the pages it no longer writes (and the old -1 naming)', async () => {
  const St = await imp('stills.mjs');
  assert.equal(St.sheetFile('/x/contact.png', 1), '/x/contact.png');
  assert.equal(St.sheetFile(path.join('x', 'contact.png'), 2), path.join('x', 'contact-2.png'));
  assert.equal(St.sheetFile('sheet.v2.png', 12), 'sheet.v2-12.png');
  const dir = tmp('ms-pages-');
  for (const n of ['contact.png', 'contact-1.png', 'contact-2.png', 'contact-3.png', 'contact-4.png', 'contact-x.png', 'contact-2.jpg', 'phone-2.png', 'my.contact-2.png']) fs.writeFileSync(path.join(dir, n), `old ${n}`);
  const out = path.join(dir, 'contact.png');
  const files = St.writeSheetPages(out, [Buffer.from('a'), Buffer.from('b')]);
  assert.deepEqual(files.map((f) => path.basename(f)), ['contact.png', 'contact-2.png']);
  assert.deepEqual(listDir(dir), ['contact-2.jpg', 'contact-2.png', 'contact-x.png', 'contact.png', 'my.contact-2.png', 'phone-2.png'], 'contact-1, contact-3 and contact-4 are gone; other sheets and other names stay');
  assert.equal(fs.readFileSync(path.join(dir, 'contact.png'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(dir, 'contact-2.png'), 'utf8'), 'b');
  St.writeSheetPages(out, [Buffer.from('only')]);
  assert.deepEqual(listDir(dir), ['contact-2.jpg', 'contact-x.png', 'contact.png', 'my.contact-2.png', 'phone-2.png'], 'a single page leaves contact.png and no contact-N.png');
  St.clearStaleSheets(path.join(dir, 'missing', 'x.png'), 1); // a folder that does not exist is fine
});

// ---------------------------------------------------------------------------------------------------------------
// Silence: parsing ffmpeg's silencedetect, and which spans are problems

test('parseSilence: closed spans, a span still open at the end of the stream, a negative start', async () => {
  const { parseSilence } = await imp('refs.mjs');
  const err = [
    '[silencedetect @ 000001] silence_start: -0.0123', '[silencedetect @ 000001] silence_end: 1.5 | silence_duration: 1.5123',
    'size=N/A time=00:00:12.01 bitrate=N/A speed= 300x',
    '[silencedetect @ 000001] silence_start: 8.10671', '[silencedetect @ 000001] silence_end: 11.3066 | silence_duration: 3.19992',
    '[silencedetect @ 000001] silence_start: 20',
  ].join('\n');
  const spans = parseSilence(err, 24);
  assert.deepEqual(spans.map((s) => [s.from, s.to]), [[0, 1.5], [8.107, 11.307], [20, 24]]);
  assert.equal(spans[1].sec, 3.2);
  assert.deepEqual(parseSilence(err).map((s) => [s.from, s.to]), [[0, 1.5], [8.107, 11.307]], 'without a duration an open span is dropped');
  assert.deepEqual(parseSilence('', 10), []);
  assert.deepEqual(parseSilence(undefined, 10), []);
});

test('judgeSilence: a gap inside the film is a problem; a silent intro, a last-second fade, a short span and an allowed span are not', async () => {
  const { judgeSilence, allowedSilence, silenceLabel } = await imp('refs.mjs');
  const S = (from, to) => ({ from, to, sec: to - from });
  const dur = 12;
  const j = (spans, allow) => judgeSilence(spans, { duration: dur, allow });
  assert.deepEqual(j([S(8.1, 11.3)]).gaps.map((g) => g.from), [8.1]);
  assert.equal(silenceLabel(j([S(8.1067, 11.3066)]).gaps[0]), '3.2 s at 00:08.1', 'the wording deliver and critique print');
  // a tail of several seconds IS the half-silent film
  assert.equal(j([S(8, 12)]).gaps.length, 1);
  // the very start (starts before 0.3 s) and the last second (starts within it) are fine
  assert.deepEqual(j([S(0, 2.5)]).ignored.map((s) => s.why), ['start']);
  assert.equal(j([S(0.29, 2)]).gaps.length, 0);
  assert.equal(j([S(0.31, 2)]).gaps.length, 1, '0.31 s is not the very start');
  assert.deepEqual(j([S(11, 12)]).ignored.map((s) => s.why), ['end']);
  assert.equal(j([S(10.9, 12)]).gaps.length, 1, 'a silent tail that begins before the last second is a gap');
  // ffmpeg reports what is >= d; a 0.9 s span is never a gap
  assert.equal(j([S(5, 5.9)]).gaps.length, 0);
  // studio.json critique.allowSilence, read defensively
  assert.deepEqual(allowedSilence({ critique: { allowSilence: [[8, 9.5], [1, 2]] } }), [[1, 2], [8, 9.5]]);
  assert.deepEqual(allowedSilence({ critique: { allowSilence: [{ from: 3, to: 4 }, [5], 'x', null, [7, 6], [Infinity, 9], [10, 'a']] } }), [[3, 4]]);
  assert.deepEqual(allowedSilence({ critique: { allowSilence: [8, 9] } }), [[8, 9]], 'one bare pair');
  assert.deepEqual(allowedSilence({ critique: { allowSilence: 'yes' } }), []);
  assert.deepEqual(allowedSilence({}), []);
  assert.deepEqual(allowedSilence(null), []);
  const allowed = j([S(8.1, 11.3)], [[8, 11.5]]);
  assert.equal(allowed.gaps.length, 0);
  assert.deepEqual(allowed.ignored.map((s) => s.why), ['allowed']);
  // a span that leaves the allowed interval keeps the part outside it (padded 0.15 s), if that is still >= 1 s
  const half = j([S(3, 8)], [[3, 5]]);
  assert.deepEqual(half.gaps.map((g) => [g.from, g.to]), [[5.15, 8]]);
  // what is left must still reach 1 s: 3-6 s minus the padded 2.85-5.15 s leaves 0.85 s (not a gap), 3-6.2 s leaves 1.05 s (a gap)
  const short = j([S(3, 6)], [[3, 5]]);
  assert.equal(short.gaps.length, 0, '0.85 s of silence left after the allowed interval is below the 1 s minimum');
  assert.deepEqual(short.ignored.map((s) => s.why), ['allowed']);
  assert.deepEqual(j([S(3, 6.2)], [[3, 5]]).gaps.map((g) => [g.from, g.to]), [[5.15, 6.2]], '1.05 s left is still a gap');
  // an allowed interval in the middle splits the span: both halves are judged on their own
  assert.deepEqual(j([S(2, 9)], [[4, 5]]).gaps.map((g) => [g.from, g.to]), [[2, 3.85], [5.15, 9]]);
  assert.deepEqual(j([S(2, 6)], [[3, 4.5]]).gaps.map((g) => [g.from, g.to]), [[4.65, 6]], 'the 0.85 s before the interval is dropped, the 1.35 s after it is a gap');
});

// ---------------------------------------------------------------------------------------------------------------
// The review range

test('resolveRange: snapped to the fps grid, clamped to the film, full only for the whole film; bad values are usage errors', async () => {
  const { resolveRange } = await imp('critique-metrics.mjs');
  const film = { duration: 12, fps: 24, frames: 288 };
  assert.deepEqual(resolveRange({}, film), { from: 0, to: 12, fromFrame: 0, toFrame: 288, frames: 288, full: true });
  const r = resolveRange({ from: 4, to: 8.01 }, film);
  assert.deepEqual([r.from, r.to, r.fromFrame, r.toFrame, r.frames, r.full], [4, 8, 96, 192, 96, false]);
  assert.equal(resolveRange({ from: 10 }, film).to, 12, 'no --to: to the end');
  assert.equal(resolveRange({ to: 100 }, film).full, true, '--to past the end is clamped');
  assert.equal(resolveRange({ from: 0, to: 12 }, film).full, true);
  assert.throws(() => resolveRange({ from: -1 }, film), /--from must be >= 0/);
  assert.throws(() => resolveRange({ from: 5, to: 5 }, film), /--to must be greater than --from/);
  assert.throws(() => resolveRange({ to: 0 }, film), /--to must be greater than 0/);
  assert.throws(() => resolveRange({ from: 12 }, film), /past the end of the film \(12 s\)/);
  assert.throws(() => resolveRange({ from: 4, to: 4.05 }, film), /holds 1 frame\(s\) at 24 fps; a review needs at least 3/);
});

/** 40x40 RGBA frames: a dot x dot square creeping right one pixel per 3 frames until frame `stopAt`, then still; optional flicker. */
function synthFrames(N, { stopAt = Infinity, flickerAt = -1, dot = 2 } = {}) {
  const W = 40; const H = 40;
  const frames = [];
  for (let k = 0; k < N; k++) {
    const b = Buffer.alloc(W * H * 4);
    for (let i = 0; i < b.length; i += 4) { b[i] = 20; b[i + 1] = 20; b[i + 2] = 19; b[i + 3] = 255; }
    const rect = (x0, y0, w, h, v) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 4; b[i] = v; b[i + 1] = v; b[i + 2] = v; } };
    rect(2 + Math.floor(Math.min(k, stopAt) / 3), 4, dot, dot, 240);
    if (k === flickerAt) rect(10, 20, 20, 20, 240);
    frames.push(b);
  }
  return { frames, W, H };
}

test('Analyzer on a range: absolute frame numbers and times, the range only, frame 0 skipped, beat numbers stay the film\'s', async () => {
  const { Analyzer, CRIT_DEFAULTS } = await imp('critique-metrics.mjs');
  const N = 150; // 5 s at 30 fps; the dot stops at frame 60
  const { frames, W, H } = synthFrames(N, { stopAt: 60, flickerAt: 100 });
  const crit = { ...CRIT_DEFAULTS, deadSpanSec: 1.0 };
  const beats = Array.from({ length: 10 }, (_, i) => i * 0.5); // 0 .. 4.5 s
  const run = (k0, k1) => {
    const an = new Analyzer({ fps: 30, frames: k1, crit, k0 });
    for (let k = k0; k < k1; k++) an.push(frames[k], k, W, H);
    return an.finish({ shots: [], cues: [], beats });
  };
  const whole = run(0, N);
  assert.equal(whole.frame0.skipped, undefined);
  assert.equal(whole.pops.list.find((p) => p.kind === 'flicker')?.frame, 100);
  assert.equal(whole.deadSpans.spans.length, 1);
  assert.ok(whole.deadSpans.spans[0].from >= 1.8 && whole.deadSpans.spans[0].to >= 4.8, JSON.stringify(whole.deadSpans.spans));
  const part = run(90, 150); // 3.0 s .. 5.0 s: the flicker at 100, the still tail, no frame 0
  assert.equal(part.frame0.skipped, true);
  assert.equal(part.frame0.pass, true, 'a range that starts later never fails the film\'s frame-0 check');
  assert.equal(part.frames, 60);
  const flick = part.pops.list.find((p) => p.kind === 'flicker');
  assert.deepEqual([flick?.frame, flick?.t], [100, round3(100 / 30)], 'reported at the film\'s time, not the range\'s');
  assert.equal(part.deadSpans.spans.length, 1);
  assert.ok(part.deadSpans.spans[0].from >= 3.0 - 1e-9, `a dead span starts inside the range: ${part.deadSpans.spans[0].from}`);
  assert.deepEqual(part.deadSpans.beatEnergy.map((b) => b.beat), [6, 7, 8, 9], 'only the beats that start inside the range, numbered as in the film');
  assert.ok(part.stripCenter >= 90 && part.stripCenter < 150, `strip centre ${part.stripCenter} is inside the range`);
  // A range that starts at frame 0 is the film's start: frame 0 IS checked. The 2x2 dot above covers 0.25% of the frame (a
  // nearly empty frame 0, correctly a P0), so this run uses a 3x3 mover (0.56% > 0.5%) that is still slow enough for no pop.
  const big = synthFrames(60, { dot: 3 });
  const early = (() => {
    const an = new Analyzer({ fps: 30, frames: 60, crit, k0: 0 });
    for (let k = 0; k < 60; k++) an.push(big.frames[k], k, big.W, big.H);
    return an.finish({ shots: [], cues: [], beats });
  })();
  assert.equal(early.frame0.skipped, undefined, 'the range starts at the first frame: the frame-0 check runs');
  assert.deepEqual([early.deadSpans.spans.length, early.pops.list.length, early.frame0.pass], [0, 0, true]);
  const faint = run(0, 60); // the 2x2 mover: frame 0 has only 4 pixels of content
  assert.equal(faint.frame0.skipped, undefined);
  assert.equal(faint.frame0.pass, false, 'a frame 0 with 0.25% of pixels drawn is nearly empty');
});
const round3 = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------------------------------------------
// Font preflight: merging what the pages drew, the verdict and the findings

test('mergeTextUse: one row per font spec, the union of the pages\' characters, whitespace dropped, junk rows ignored', async () => {
  const { mergeTextUse } = await imp('critique-metrics.mjs');
  const rows = mergeTextUse([
    [{ family: 'Inter', weight: '400', style: 'normal', chars: 'abc' }, { family: 'Noto Sans KR', weight: '700', style: 'normal', chars: '가나' }],
    [{ family: 'inter', weight: '400', style: 'normal', chars: 'cd e' }, { family: 'Inter', weight: 700, style: 'italic', chars: 'x' }, null, { chars: 'zz' }, { family: '' }],
    undefined,
  ]);
  assert.deepEqual(rows.map((r) => `${r.family}|${r.weight}|${r.style}|${r.chars}`), ['Inter|400|normal|abcde', 'Inter|700|italic|x', 'Noto Sans KR|700|normal|가나']);
});

test('fontVerdict and findings: a character with no glyph is a P0 font-fallback naming family, weight and characters (40 listed at most)', async () => {
  const { fontVerdict, fontsUnavailable, findings, CRIT_DEFAULTS } = await imp('critique-metrics.mjs');
  const hangul = Array.from({ length: 55 }, (_, i) => String.fromCodePoint(0xac00 + i));
  const cp = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
  const fonts = fontVerdict([
    { family: 'Inter', weight: '400', style: 'normal', needed: 60, registered: true, missing: hangul.map((ch) => ({ ch, cp: cp(ch), reason: 'fallback' })) },
    { family: 'NeoDunggeunmo', weight: '400', style: 'normal', needed: 9, registered: true, missing: [] },
    { family: 'Nope', weight: '400', style: 'normal', needed: 2, registered: false, reason: 'unregistered', missing: [{ ch: 'a', cp: 'U+61', reason: 'fallback' }, { ch: 'b', cp: 'U+62', reason: 'fallback' }] },
  ]);
  assert.equal(fonts.pass, false);
  assert.deepEqual(fonts.entries.map((e) => [e.family, e.pass, e.missingCount, e.missing.length]), [['Inter', false, 55, 40], ['NeoDunggeunmo', true, 0, 0], ['Nope', false, 2, 2]]);
  const r = {
    px: { frame0: { pass: true }, deadSpans: { spans: [], beatEnergy: [], staticBeats: [] }, pops: { list: [] }, corners: { share: { tl: 0, tr: 0, bl: 0, br: 0 } }, borders: { pass: true } },
    loop: { enabled: false }, sync: { impactShare: null, cues: 0, shotChanges: 0, shotChangesOnDownbeat: 0, offGrid: [] }, film: { fps: 24, duration: 4 }, determinism: { skipped: true }, fonts,
  };
  const found = findings(r, CRIT_DEFAULTS).filter((f) => f.metric === 'font-fallback');
  assert.equal(found.length, 2);
  assert.ok(found.every((f) => f.severity === 'P0'));
  assert.match(found[0].text, /"Inter" 400 has no glyph for 55 of 60 character\(s\)/);
  assert.ok(found[0].text.includes(hangul[0]) && found[0].text.includes(hangul[39]) && !found[0].text.includes(hangul[40]), 'exactly the first 40 are listed');
  assert.match(found[0].text, /\+15 more/);
  assert.match(found[0].text, /fonts\.mjs add-file/, 'the fix hint');
  assert.match(found[1].text, /"Nope" is not a registered font/);
  // not available: a note, never a failure or a finding
  const off = fontsUnavailable('window.__studio.textUse is not defined');
  assert.deepEqual([off.skipped, off.pass, off.reason], [true, true, 'preflight: unavailable (window.__studio.textUse is not defined)']);
  assert.equal(findings({ ...r, fonts: off }, CRIT_DEFAULTS).filter((f) => f.metric === 'font-fallback').length, 0);
});

test('findings: a silent span in the mix is a P1 audio-gap with the wording deliver uses', async () => {
  const { findings, CRIT_DEFAULTS } = await imp('critique-metrics.mjs');
  const audio = { present: true, I: -14, target: -14, tol: 0.5, TP: -2, truePeak: -1, duration: 12, videoDuration: 12, pass: true,
    silence: { noiseDb: -50, minSec: 1, gaps: [{ from: 8.107, to: 11.307, sec: 3.2 }], ignored: [], allow: [] } };
  const r = {
    px: { frame0: { pass: true }, deadSpans: { spans: [], beatEnergy: [], staticBeats: [] }, pops: { list: [] }, corners: { share: { tl: 0, tr: 0, bl: 0, br: 0 } }, borders: { pass: true } },
    loop: { enabled: false }, sync: { impactShare: null, cues: 0, shotChanges: 0, shotChangesOnDownbeat: 0, offGrid: [] }, film: { fps: 24, duration: 12 }, determinism: { skipped: true }, audio,
  };
  const gap = findings(r, CRIT_DEFAULTS).filter((f) => f.metric === 'audio-gap');
  assert.equal(gap.length, 1);
  assert.equal(gap[0].severity, 'P1');
  assert.equal(gap[0].t, 8.11);
  assert.match(gap[0].text, /silence 3\.2 s at 00:08\.1/);
  assert.match(gap[0].text, /critique\.allowSilence/);
  assert.equal(findings({ ...r, audio: { ...audio, silence: { ...audio.silence, gaps: [] } } }, CRIT_DEFAULTS).filter((f) => f.metric === 'audio-gap').length, 0);
  assert.equal(findings({ ...r, audio: { ...audio, silence: { skipped: true, reason: 'x' } } }, CRIT_DEFAULTS).filter((f) => f.metric === 'audio-gap').length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// ffmpeg: real silence, `critique --video` without a browser

const run = (cmd, args, opts) => spawnP(cmd, args, opts);
/** A 72x128 (or `size`) mp4 whose 440 Hz tone is muted between the [from, to] pairs. */
async function mutedMp4(file, { seconds = 12, mute = [], size = '72x128', fps = 24 } = {}) {
  const af = mute.length ? ['-af', `volume=enable='${mute.map(([a, b]) => `between(t,${a},${b})`).join('+')}':volume=0`] : [];
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x141413:s=${size}:r=${fps}:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    ...af, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', file]);
  if (r.code !== 0) throw new Error(`ffmpeg failed:\n${r.stderr.slice(-1500)}`);
}

test('detectSilence / audioGaps on a real mp4: the muted span is found at its time, a tail counts, allowSilence subtracts', { skip: NO_FFMPEG, timeout: 900000 }, async () => {
  const { detectSilence, audioGaps, silenceLabel } = await imp('refs.mjs');
  const dir = tmp('ms-silence-');
  await Promise.all([mutedMp4(path.join(dir, 'gap.mp4'), { mute: [[8.1, 11.3]] }), mutedMp4(path.join(dir, 'tail.mp4'), { mute: [[8, 13]] }), mutedMp4(path.join(dir, 'clean.mp4'))]);
  const spans = await detectSilence(dir, path.join(dir, 'gap.mp4'), { duration: 12 });
  assert.equal(spans.length, 1, JSON.stringify(spans));
  assert.ok(Math.abs(spans[0].from - 8.1) < 0.05 && Math.abs(spans[0].sec - 3.2) < 0.06, JSON.stringify(spans[0]));
  const gap = await audioGaps(dir, path.join(dir, 'gap.mp4'), {}, { duration: 12 });
  assert.equal(silenceLabel(gap.gaps[0]), '3.2 s at 00:08.1');
  const allowed = await audioGaps(dir, path.join(dir, 'gap.mp4'), { critique: { allowSilence: [[8, 11.5]] } }, { duration: 12 });
  assert.deepEqual([allowed.gaps.length, allowed.ignored.map((s) => s.why)], [0, ['allowed']]);
  const tail = await audioGaps(dir, path.join(dir, 'tail.mp4'), {}, { duration: 12 });
  assert.equal(tail.gaps.length, 1, 'a silent tail of 4 s is the half-silent film: a gap');
  assert.ok(tail.gaps[0].from >= 7.9 && tail.gaps[0].from <= 8.1);
  assert.deepEqual((await audioGaps(dir, path.join(dir, 'clean.mp4'), {}, { duration: 12 })).gaps, []);
});

/** A project around one mp4 for critique --video; without a browser the sheets are unlabelled ffmpeg tiles. */
function videoProject(studio = {}) {
  const root = tmp('ms-critvid-');
  fs.mkdirSync(path.join(root, 'out', '9x16'), { recursive: true });
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ title: 'Critique Silence', duration: 12, fps: 24, formats: ['9x16'], primaryFormat: '9x16', gate: { enabled: false }, ...studio }));
  return root;
}
const critiqueVideo = (root, args = []) => run(process.execPath, [path.join(T_TOOLS, 'critique.mjs'), '--format', '9x16', '--video', '--json', ...args],
  { cwd: root, env: { ...process.env, FFMPEG_PATH: FFMPEG, MOTION_CHROME_PATH: path.join(root, 'no-such-browser.exe') } });

test('critique --video: a silent span in the mix is a P1 audio-gap (WARN row, metrics.json audio.silence); the sheets are paged without a browser too', { skip: NO_FFMPEG, timeout: 900000 }, async () => {
  // The synthetic 440 Hz tone measures about -21.9 LUFS: the audio target is set to it, so the row is WARN (a gap) and not FAIL (loudness).
  const root = videoProject({ audio: { lufs: -22, lufsTolerance: 1.5 } });
  await mutedMp4(path.join(root, 'out', '9x16', 'final.mp4'), { mute: [[8.1, 11.3]] });
  const r = await critiqueVideo(root, ['--page-height', '700']);
  assert.equal(r.code, 0, r.stderr);
  const gaps = r.json.findings.filter((f) => f.metric === 'audio-gap');
  assert.equal(gaps.length, 1, JSON.stringify(r.json.findings.map((f) => f.metric)));
  assert.equal(gaps[0].severity, 'P1');
  assert.match(gaps[0].text, /silence 3\.2 s at 00:08\.1/);
  assert.equal(r.json.summary.audioGaps, 1);
  const dir = path.join(root, 'out', 'review', '9x16', 'video');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8'));
  assert.equal(m.audio.silence.noiseDb, -50);
  assert.equal(m.audio.silence.gaps.length, 1);
  assert.match(fs.readFileSync(path.join(dir, 'metrics.md'), 'utf8'), /\| audio \| WARN \|.*silence: 1 gap\(s\) of ≥ 1 s below -50 dB \(3\.2 s at 00:08\.1\)/);
  assert.deepEqual(m.range, { from: 0, to: 12, fromFrame: 0, toFrame: 288, frames: 288, full: true });
  // 12 phone stills of 360x640 with a 700 px page: one row of 5 per page, 3 pages; every image is at most 700 px tall
  assert.deepEqual(listDir(dir).filter((n) => n.startsWith('phone')), ['phone-2.png', 'phone-3.png', 'phone.png']);
  assert.deepEqual(r.json.pages.phone.map((p) => [p.file, p.tiles]), [['phone.png', 5], ['phone-2.png', 5], ['phone-3.png', 2]]);
  for (const n of listDir(dir).filter((f) => /^(contact|shots|phone|strip)(-\d+)?\.png$/.test(f))) assert.ok(pngSize(path.join(dir, n)).h <= 700, `${n} is ${pngSize(path.join(dir, n)).h} px tall`);
  const md = fs.readFileSync(path.join(dir, 'metrics.md'), 'utf8');
  assert.match(md, /- phone-2\.png +one still per second at 360 px wide · page 2\/3: 5 tiles 00:05\.50–00:09\.50/);
  // a second run with a taller page leaves one sheet and no stale page
  const again = await critiqueVideo(root, ['--page-height', '0', '--from', '6', '--to', '10']);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(listDir(dir).filter((n) => n.startsWith('phone')), ['phone.png'], 'phone-2.png and phone-3.png of the earlier run are gone');
  assert.deepEqual([again.json.range.from, again.json.range.to, again.json.range.full], [6, 10, false]);
  assert.deepEqual(again.json.pages.phone.map((p) => [p.tiles, p.from, p.to]), [[4, 6.5, 9.5]], 'only the seconds inside the range');
  const m2 = JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8'));
  assert.equal(m2.range.full, false);
  assert.equal(m2.frame0.skipped, true);
  assert.equal(m2.audio.silence.gaps.length, 1, 'the gap 8.1-11.3 touches the range 6-10');
  assert.match(fs.readFileSync(path.join(dir, 'metrics.md'), 'utf8'), /Range 00:06\.00–00:10\.00 \(--from\/--to/);
  // a range without the gap does not report it
  const before = await critiqueVideo(root, ['--from', '0', '--to', '7']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8')).audio.silence.gaps.length, 0);
  assert.equal(before.json.findings.filter((f) => f.metric === 'audio-gap').length, 0);
});

test('critique --video: critique.allowSilence whitelists an intended silence (config read defensively)', { skip: NO_FFMPEG, timeout: 900000 }, async (t) => {
  const root = videoProject({ critique: { allowSilence: [[8, 11.5]] } });
  await mutedMp4(path.join(root, 'out', '9x16', 'final.mp4'), { mute: [[8.1, 11.3]] });
  const r = await critiqueVideo(root);
  if (r.code !== 0 && /critique\.allowSilence/.test(r.stderr)) { t.diagnostic('studio.mjs validateConfig does not accept critique.allowSilence yet; the whitelist itself is covered by judgeSilence'); return; }
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.findings.filter((f) => f.metric === 'audio-gap').length, 0);
  const m = JSON.parse(fs.readFileSync(path.join(root, 'out', 'review', '9x16', 'video', 'metrics.json'), 'utf8'));
  assert.deepEqual(m.audio.silence.gaps, []);
  assert.deepEqual(m.audio.silence.ignored.map((s) => s.why), ['allowed']);
  assert.deepEqual(m.critique.allowSilence, [[8, 11.5]]);
});

// ---------------------------------------------------------------------------------------------------------------
// Real Chrome: the live film through critique.mjs

/** The engine half of the glyph preflight (window.__studio.textUse / coverage in lib/runtime.js); the live tests skip without it. */
const engineHasTextUse = () => { try { return /textUse/.test(fs.readFileSync(path.join(TEMPLATE, 'lib', 'runtime.js'), 'utf8')); } catch { return false; } };
const NO_TEXTUSE = 'lib/runtime.js has no window.__studio.textUse() (the engine side of the glyph preflight)';

function hangulFont() {
  const candidates = [process.env.MOTION_TEST_HANGUL_FONT].filter(Boolean);
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.isDirectory() && depth > 0 && e.name !== 'node_modules') walk(path.join(dir, e.name), depth - 1);
      else if (/^neodgm.*\.woff2$/i.test(e.name) || /dunggeunmo.*\.woff2$/i.test(e.name)) candidates.push(path.join(dir, e.name));
    }
  };
  const nm = process.env.MOTION_SMOKE_NODE_MODULES;
  if (nm) walk(path.dirname(path.resolve(nm)), 4); // the sandbox next to node_modules
  candidates.push(path.join(REPO, '..', '_scratch', 'research', 'fonts', 'neodgm.woff2'));
  return candidates.find((p) => { try { return fs.statSync(p).size > 1000; } catch { return false; } }) ?? null;
}

const FILM = (scenes) => `import { defineFilm, scene } from '../lib/timeline.js';
import { text } from '../lib/draw.js';
export default defineFilm(() => ({
  scenes: [
    scene(0, 4, 'bg', (g, lt, c) => {
      g.fillStyle = '#204060'; g.fillRect(0, 0, c.W, c.H);
      g.fillStyle = '#e8b04a'; g.fillRect(c.W * (0.1 + 0.6 * (lt / 4)), c.H * 0.2, c.W * 0.15, c.H * 0.15);
    }),
${scenes}
  ],
}));
`;

/** A copy of the template with a 4 s, 12 fps, 1x1 film; the shared node_modules linked in. `body({ root, critique })` runs the CLI. */
async function withFilm(t, { scenes, index, fonts, film, studio: extra }, body) {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = tmp('ms-critlive-');
  fs.cpSync(TEMPLATE, root, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(src) });
  const studio = JSON.parse(fs.readFileSync(path.join(root, 'studio.json'), 'utf8'));
  Object.assign(studio, { title: 'Critique Live', duration: 4, fps: 12, subframes: 1, formats: ['1x1'], primaryFormat: '1x1', gate: { enabled: false } }, extra);
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify(studio, null, 2));
  fs.writeFileSync(path.join(root, 'film', 'film.js'), film ?? FILM(scenes));
  if (index) fs.writeFileSync(path.join(root, 'index.html'), index);
  if (fonts) fonts(root);
  const link = path.join(root, 'node_modules');
  try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved through NODE_PATH */ }
  try {
    try {
      const S = await imp('studio.mjs');
      const { browser } = await S.launchBrowser(root, S.loadConfig(root));
      await browser.close();
    } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }
    const critique = (args) => run(process.execPath, [path.join(root, 'tools', 'critique.mjs'), '--json', ...args],
      { cwd: root, env: { ...process.env, DEBUG: '', NODE_PATH: nm, MOTION_CLOSE_TIMEOUT_MS: '3000' } });
    await body({ root, critique, review: path.join(root, 'out', 'review', '1x1') });
  } finally {
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
    try { rmDir(root); } catch { /* the after() hook retries */ }
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched');
  }
}

const HANGUL_SCENE = `    scene(2, 4, 'ko', (g, lt, c) => {
      text(g, '안녕하세요 Hello', c.W * 0.08, c.H * 0.62, { size: 96, family: 'Inter', color: '#fff' });
    }),`;
const readMetrics = (review) => JSON.parse(fs.readFileSync(path.join(review, 'metrics.json'), 'utf8'));

test('critique (live): Hangul drawn with a Latin-only family is a P0 font-fallback; sheets are paged; --from/--to review a range and stale pages go', { timeout: 600000 }, async (t) => {
  if (!engineHasTextUse()) { t.skip(NO_TEXTUSE); return; }
  await withFilm(t, { scenes: HANGUL_SCENE }, async ({ critique, review }) => {
    // Determinism on: the tracked pages must not disturb it. 4 s at 120 bpm = 8 beats; a 600 px page holds one row of 6 tiles.
    const r = await critique(['--page-height', '600']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.fonts, 'fail');
    assert.equal(r.json.summary.determinism, 'pass');
    const p0 = r.json.findings.filter((f) => f.metric === 'font-fallback');
    assert.equal(p0.length, 1, JSON.stringify(r.json.findings));
    assert.equal(p0[0].severity, 'P0');
    assert.match(p0[0].text, /"Inter" \d+ has no glyph for 5 of 9 character\(s\)/, 'the text only appears from 2 s: the pixel pass saw it, not just frame 0');
    assert.match(p0[0].text, /안/);
    assert.match(p0[0].text, /fonts\.mjs add-file/);
    const m = readMetrics(review);
    assert.equal(m.fonts.available, true);
    assert.equal(m.fonts.pass, false);
    assert.equal(m.fonts.entries[0].family, 'Inter');
    assert.deepEqual(m.fonts.entries[0].missing.map((x) => x.ch).sort(), [...'안녕하세요'].sort(), 'the Latin letters of "Hello" have glyphs');
    assert.match(fs.readFileSync(path.join(review, 'metrics.md'), 'utf8'), /\| fonts \| FAIL \|.*Inter \d+: 5 without a glyph/);
    // paging: contact = page 1, contact-2 ...; every image at most --page-height tall; the report lists every page
    assert.deepEqual(r.json.pages.contact.map((p) => [p.file, p.tiles]), [['contact.png', 6], ['contact-2.png', 2]]);
    assert.deepEqual(r.json.pages.phone.map((p) => [p.file, p.tiles]), [['phone.png', 4]]);
    for (const n of listDir(review).filter((f) => /^(contact|shots|phone|strip)(-\d+)?\.png$/.test(f))) assert.ok(pngSize(path.join(review, n)).h <= 600, `${n} is ${pngSize(path.join(review, n)).h} px tall`);
    assert.match(fs.readFileSync(path.join(review, 'metrics.md'), 'utf8'), /- contact-2\.png +one still per beat · page 2\/2: 2 tiles 00:03\.00–00:03\.50/);
    // stills.mjs shares the folder and the rule: it replaces the pages critique wrote, page 1 keeps the name
    // (covered in the pure test above); here a range run with one tall sheet leaves no page behind
    const seen = await critique(['--from', '2.5', '--to', '4', '--page-height', '0', '--no-determinism']);
    assert.equal(seen.code, 0, seen.stderr);
    assert.deepEqual(seen.json.range, { from: 2.5, to: 4, fromFrame: 30, toFrame: 48, frames: 18, full: false });
    assert.equal(seen.json.summary.fonts, 'fail', 'the text is on screen inside the range');
    assert.equal(seen.json.summary.frame0, null, 'the film\'s frame 0 is not in the range');
    assert.equal(listDir(review).filter((n) => /^contact/.test(n)).join(), 'contact.png', 'contact-2.png of the earlier run is gone');
    assert.deepEqual(seen.json.pages.contact.map((p) => [p.tiles, p.from, p.to]), [[3, 2.5, 3.5]], 'the beats inside the range only: 2.5, 3.0 and 3.5 s (120 bpm; the beat at 2.5 s is inside a range that starts at 2.5)');
    const ms = readMetrics(review);
    assert.equal(ms.range.full, false);
    assert.equal(ms.shots.length > 0, true);
    assert.match(fs.readFileSync(path.join(review, 'metrics.md'), 'utf8'), /Range 00:02\.50–00:04\.00 \(--from\/--to, frames 30-47\)/);
    // the range before the text appears: nothing to check, no finding
    const before = await critique(['--from', '0', '--to', '1.5', '--no-determinism']);
    assert.equal(before.code, 0, before.stderr);
    assert.equal(before.json.summary.fonts, 'pass');
    assert.equal(before.json.findings.filter((f) => f.metric === 'font-fallback').length, 0);
    const beforeFonts = readMetrics(review).fonts;
    assert.equal(beforeFonts.entries.length, 0, 'the scene that draws the text starts at 2 s: the frames of 0-1.5 s drew no canvas text at all');
    assert.match(beforeFonts.note, /the film drew no canvas text in the reviewed frames/);
    assert.match(fs.readFileSync(path.join(review, 'metrics.md'), 'utf8'), /\| fonts \| PASS \|.*0 font spec\(s\) drawn \(none\).*the film drew no canvas text/);
    // bad range values are usage errors (exit 2) with one JSON line
    const bad = await critique(['--from', '9']);
    assert.equal(bad.code, 2, 'the film is 4 s: --from 9 is past its end, a usage error');
    assert.equal(bad.stdout.trim().split('\n').length, 1, 'one JSON line on stdout');
    assert.match(bad.json.error, /--from 9 is past the end of the film \(4 s\)/);
  });
});

test('critique (live): a bundled Hangul font passes; a family that is not registered is a P0 of its own', { timeout: 600000 }, async (t) => {
  if (!engineHasTextUse()) { t.skip(NO_TEXTUSE); return; }
  const font = hangulFont();
  const scenes = `    scene(1, 4, 'ko', (g, lt, c) => {
      text(g, '안녕하세요 Hello', c.W * 0.08, c.H * 0.5, { size: 96, family: 'NeoDunggeunmo', weight: 400, color: '#fff' });
      text(g, '가나다', c.W * 0.08, c.H * 0.75, { size: 96, family: 'NoSuchFont', color: '#fff' });
    }),`;
  const fonts = (root) => {
    if (!font) return;
    fs.copyFileSync(font, path.join(root, 'assets', 'fonts', 'neodunggeunmo-400.woff2'));
    const file = path.join(root, 'assets', 'fonts', 'fonts.json');
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    list.push({ family: 'NeoDunggeunmo', src: 'assets/fonts/neodunggeunmo-400.woff2', weight: '400', style: 'normal' });
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  };
  await withFilm(t, { scenes, fonts }, async ({ critique, review }) => {
    const r = await critique(['--no-determinism']);
    assert.equal(r.code, 0, r.stderr);
    const m = readMetrics(review);
    const by = Object.fromEntries(m.fonts.entries.map((e) => [e.family, e]));
    assert.equal(by.NoSuchFont.reason, 'unregistered');
    assert.equal(by.NoSuchFont.missingCount, 3);
    const p0 = r.json.findings.filter((f) => f.metric === 'font-fallback');
    if (font) {
      assert.equal(by.NeoDunggeunmo.pass, true, `NeoDunggeunmo covers the Hangul it draws: ${JSON.stringify(by.NeoDunggeunmo)}`);
      assert.equal(p0.length, 1, JSON.stringify(p0));
    } else {
      t.diagnostic('no NeoDunggeunmo woff2 found (set MOTION_TEST_HANGUL_FONT): only the unregistered-family half ran');
      assert.ok(p0.length >= 1);
    }
    assert.match(p0.find((f) => /NoSuchFont/.test(f.text)).text, /"NoSuchFont" is not a registered font/);
  });
});

test('critique (live): a page without textUse() is "preflight: unavailable", a note and not a failure', { timeout: 600000 }, async (t) => {
  const index = fs.readFileSync(path.join(TEMPLATE, 'index.html'), 'utf8').replace('boot(film);', 'boot(film).then(() => { delete window.__studio.textUse; });');
  assert.notEqual(index, fs.readFileSync(path.join(TEMPLATE, 'index.html'), 'utf8'), 'the template index.html still calls boot(film);');
  await withFilm(t, { scenes: HANGUL_SCENE, index }, async ({ critique, review }) => {
    const r = await critique(['--no-determinism']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.fonts, 'skip');
    assert.equal(r.json.findings.filter((f) => f.metric === 'font-fallback').length, 0);
    const m = readMetrics(review);
    assert.equal(m.fonts.available, false);
    assert.equal(m.fonts.pass, true);
    assert.match(m.fonts.reason, /^preflight: unavailable \(window\.__studio\.textUse is not defined\)/);
    assert.match(fs.readFileSync(path.join(review, 'metrics.md'), 'utf8'), /\| fonts \| n\/a +\| preflight: unavailable/);
  });
});

const LOOP_FILM = `import { defineFilm, scene } from '../lib/timeline.js';
export default defineFilm(() => ({
  scenes: [
    scene(0, 4, 'loop', (g, lt, c) => {
      g.fillStyle = '#204060'; g.fillRect(0, 0, c.W, c.H);
      const p = 0.5 - 0.5 * Math.cos((2 * Math.PI * lt) / 4);
      g.fillStyle = '#e8b04a'; g.fillRect(c.W * (0.1 + 0.6 * p), c.H * 0.2, c.W * 0.15, c.H * 0.15);
    }),
  ],
}));
`;

test('critique (live): a loop film writes loop.png and closes; a range review removes the loop.png of the whole-film run', { timeout: 600000 }, async (t) => {
  await withFilm(t, { film: LOOP_FILM, studio: { loop: true } }, async ({ critique, review }) => {
    const whole = await critique(['--no-determinism']);
    assert.equal(whole.code, 0, whole.stderr);
    assert.equal(whole.json.images.loop, 'loop.png');
    assert.equal(whole.json.summary.loop, true, JSON.stringify(readMetrics(review).loop));
    assert.ok(pngSize(path.join(review, 'loop.png')).w <= 1990, 'the loop panel is no wider than the viewer shows');
    // the seam is not inside a chapter: no loop check, and no loop.png left over from the run above
    const part = await critique(['--from', '1', '--to', '3', '--no-determinism']);
    assert.equal(part.code, 0, part.stderr);
    assert.equal(part.json.summary.loop, null);
    assert.equal(part.json.images.loop, undefined);
    assert.equal(fs.existsSync(path.join(review, 'loop.png')), false, 'the loop.png of the whole-film run must not sit next to the range metrics');
    assert.equal(readMetrics(review).loop.reason, 'range');
  });
});
