#!/usr/bin/env node
// tools/mix.mjs — music + sfx (+ voice) → master out/score.wav at the loudness target, muxed into out/<fmt>/final.mp4.
// Loudness: two-pass loudnorm; if pass 2 did not stay linear (steady material has LRA 0, clicks exceed the peak
// budget) → gain + alimiter(level=false, latency=true) at 192 kHz, re-measured with ebur128 and re-gained.
// Length is exact (frames/fps of the render) via apad/atrim and -t — never -shortest, which cuts audio short. Padding
// would hide a stem that ends early (a stale music.wav after a duration edit: the film goes silent halfway), so every
// stem is measured first: one that is short, empty or silent stops the mix unless --allow-short-stems is passed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, usage, main, loadConfig, projectRoot, ffmpeg, resolveFormats, readJSON, writeJSON, ensureDir, renameWithRetry, outDir, log, UsageError,
} from './studio.mjs';

const SR = 48000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : v === '-inf' || v === -Infinity ? -Infinity : v === 'inf' ? Infinity : NaN; };
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));

/** loudnorm prints its JSON as the last {...} block on stderr. */
export function parseLoudnormJson(stderr) {
  const end = stderr.lastIndexOf('}');
  const start = stderr.lastIndexOf('{', end);
  if (start < 0 || end < 0) throw new Error('loudnorm printed no JSON (is this ffmpeg build missing the loudnorm filter?)');
  return JSON.parse(stderr.slice(start, end + 1));
}

/** ebur128 summary → { I (LUFS), LRA, TP (dBTP) }. */
export function parseEbur128(stderr) {
  const s = stderr.slice(stderr.lastIndexOf('Summary:'));
  const grab = (re) => { const m = re.exec(s); return m ? num(m[1]) : NaN; };
  return { I: grab(/I:\s+(-?[\d.]+|-?inf|nan)\s+LUFS/), LRA: grab(/LRA:\s+(-?[\d.]+|-?inf|nan)\s+LU\b/), TP: grab(/True peak:\s+Peak:\s+(-?[\d.]+|-?inf|nan)\s+dBFS/) };
}

export async function measure(root, file) {
  const { stderr } = await ffmpeg(root, ['-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-']);
  return parseEbur128(stderr);
}

/** Exact render span: frames/fps (and `from`) of out/<fmt>/render.json, else the studio duration. */
export function renderSpan(root, cfg, fmt) {
  const rj = readJSON(outDir(root, fmt, 'render.json'), null);
  if (rj && rj.frames > 0 && rj.fps > 0) return { len: rj.frames / rj.fps, from: Number(rj.from) || 0, source: `out/${fmt}/render.json (${rj.frames} frames @ ${rj.fps} fps)` };
  return { len: cfg.duration, from: 0, source: 'studio.json duration' };
}

const samplesOf = (len) => Math.round(len * SR);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STEM_TOL = 0.25; // s: a stem this much shorter or longer than the film is reported
const SILENT_DB = -80; // dBFS: a stem whose peak stays below this is silent
const REGEN = { music: 'npm run score', sfx: 'npm run sfx', voice: 'npm run voice' };

/** One decode pass over a stem: { duration (s, decoded, 48 kHz stereo), peakDb (dBFS; -Infinity when empty or all zero) }. */
export async function probeStem(root, file) {
  let stderr;
  try {
    ({ stderr } = await ffmpeg(root, ['-nostats', '-i', file, '-map', '0:a:0', '-af', `aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo,volumedetect`, '-f', 'null', '-']));
  } catch (err) {
    throw new Error(`cannot read audio from ${file}: ${String(err.message).trim().split('\n').filter(Boolean).pop()}`);
  }
  const last = (re) => { let m = null; for (const x of stderr.matchAll(re)) m = x; return m; }; // volumedetect prints n_samples twice; the last is the total
  const n = Number(last(/n_samples:\s*(\d+)/g)?.[1] ?? 0);
  const peak = last(/max_volume:\s*(-?[\d.]+|-?inf)\s*dB/g);
  return { duration: n / 2 / SR, peakDb: peak ? num(peak[1]) : -Infinity };
}

/**
 * What is wrong with a stem against the span the film needs (`need` = from + length, seconds):
 * [{ fatal, text }]. Short, empty and silent stems are fatal (zero-padding would hide them in the delivered film); a
 * silent sfx stem is not, because sfx.mjs writes silence for a film without cues. A longer stem is only reported.
 */
export function stemFindings(name, info, { need, label }) {
  const s = (x) => x.toFixed(2);
  const out = [];
  if (!(info.duration > 0)) return [{ fatal: true, text: `${name} stem ${label} is empty (no audio samples)` }];
  const gap = need - info.duration;
  if (gap > STEM_TOL) out.push({ fatal: true, text: `${name} stem ${label} is ${s(info.duration)} s but the film needs ${s(need)} s: the last ${s(gap)} s would be silent` });
  else if (-gap > STEM_TOL) out.push({ fatal: false, text: `${name} stem ${label} is ${s(info.duration)} s but the film is ${s(need)} s: the last ${s(-gap)} s is cut off with no fade` });
  if (info.peakDb < SILENT_DB) {
    const db = Number.isFinite(info.peakDb) ? `${info.peakDb.toFixed(1)} dBFS` : '-inf dBFS';
    out.push({ fatal: name !== 'sfx', text: `${name} stem ${label} is silent (peak ${db})${name === 'sfx' ? ': a film without cues renders silence' : ''}` });
  }
  return out;
}

/** renameWithRetry with a message that says what to do when a player holds the target open (Windows). */
function replaceFile(from, to) {
  try { renameWithRetry(from, to); } catch (err) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw new Error(`cannot replace ${to}: it is open in another program (close the player and run again) [${err.code}]`);
    throw err;
  }
}

/** copyFileSync that waits out a Windows sharing violation (a player holds the target open); false when it never lets go. */
export async function copyWhenFree(src, dst, { copy = fs.copyFileSync, wait = sleep, tries = 6 } = {}) {
  for (let i = 0; ; i++) {
    try { copy(src, dst); return true; } catch (err) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      if (i >= tries - 1) return false;
      await wait(50 * (i + 1));
    }
  }
}

// Stems → one float WAV of exactly `len` seconds (volumes, voice ducking, amix without its default input scaling).
async function premix(root, stems, { len, from, duck, dst }) {
  const inputs = [];
  const chains = [];
  const labels = {};
  for (const [name, s] of Object.entries(stems)) {
    if (!s) continue;
    const i = inputs.length / 2; // ffmpeg input index (two argv entries per input)
    inputs.push('-i', s.file);
    const trim = from > 0 ? `,atrim=start=${from},asetpts=PTS-STARTPTS` : '';
    chains.push(`[${i}:a:0]aresample=${SR},aformat=sample_fmts=fltp:channel_layouts=stereo${trim},volume=${s.gainDb}dB[${name}0]`);
    labels[name] = `${name}0`;
  }
  if (labels.voice && labels.music && duck) {
    chains.push(`[${labels.voice}]asplit=2[voice1][voicesc]`, `[${labels.music}][voicesc]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350:knee=4[music1]`);
    labels.voice = 'voice1';
    labels.music = 'music1';
  }
  const names = Object.values(labels);
  const N = samplesOf(len);
  const tail = `apad=whole_len=${N},atrim=end_sample=${N}`;
  chains.push(names.length === 1 ? `[${names[0]}]${tail}[out]` : `${names.map((l) => `[${l}]`).join('')}amix=inputs=${names.length}:normalize=0:duration=longest,${tail}[out]`);
  await ffmpeg(root, ['-y', '-nostats', ...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-c:a', 'pcm_f32le', '-ar', String(SR), '-ac', '2', dst]);
}

/**
 * premix.wav → master WAV at target I/TP. Returns { method, gainDb, I, TP, attempts }. `limitDb` lowers the limiter
 * ceiling (post-AAC retry); `force` skips the linear attempt.
 */
async function loudness(root, srcIn, dst, { I, TP, tol, len, limitDb = TP - 0.5, force = false }) {
  const N = samplesOf(len);
  const tail = `apad=whole_len=${N},atrim=end_sample=${N}`;
  const enc = ['-c:a', 'pcm_s24le', '-ar', String(SR), '-ac', '2'];
  // loudnorm takes a true-peak target only in [-9, 0] and a measured_I only in [-99, 0] ("Result too large" otherwise).
  // A lower ceiling is the limiter path's job (the linear result is checked against the real TP, so skip that attempt);
  // a premix above 0 LUFS is scaled down to -20 LUFS first and the applied gain is reported against the original.
  const tpNorm = Math.max(TP, -9);
  if (TP < -9) force = true;
  const pass1 = async (file) => parseLoudnormJson((await ffmpeg(root, ['-nostats', '-i', file, '-af', `loudnorm=I=${I}:TP=${tpNorm}:LRA=11:print_format=json`, '-f', 'null', '-'])).stderr);
  let src = srcIn;
  let p1 = await pass1(src);
  let inI = num(p1.input_i);
  const input = { I: inI, TP: num(p1.input_tp), LRA: num(p1.input_lra) };
  let preDb = 0;
  if (inI > -1) {
    preDb = -20 - inI;
    src = path.join(path.dirname(dst), 'premix-att.wav');
    await ffmpeg(root, ['-y', '-nostats', '-i', srcIn, '-af', `volume=${preDb.toFixed(3)}dB`, '-c:a', 'pcm_f32le', src]);
    p1 = await pass1(src);
    inI = num(p1.input_i);
  }
  if (!(inI > -70)) {
    await ffmpeg(root, ['-y', '-nostats', '-i', src, '-af', tail, ...enc, dst]);
    return { method: 'silent', gainDb: 0, I: -Infinity, TP: -Infinity, attempts: 1, input };
  }
  let attempts = preDb ? 2 : 1;
  if (!force) {
    const af = `loudnorm=I=${I}:TP=${tpNorm}:LRA=11:measured_I=${p1.input_i}:measured_TP=${p1.input_tp}:measured_LRA=${p1.input_lra}` +
      `:measured_thresh=${p1.input_thresh}:offset=${p1.target_offset}:linear=true:print_format=json,aresample=${SR},${tail}`;
    const p2 = parseLoudnormJson((await ffmpeg(root, ['-y', '-nostats', '-i', src, '-af', af, ...enc, dst])).stderr);
    attempts++;
    if (p2.normalization_type === 'linear') {
      const m = await measure(root, dst);
      // Keep it only well inside the window: linear mode caps the gain at the true-peak budget (peaky material lands
      // short, e.g. −14.4), and the AAC encode moves I by another ~0.1–0.2 LU. The limiter path below aims at ±0.1.
      if (Math.abs(m.I - I) <= tol / 2 && m.TP <= TP) return { method: 'loudnorm-linear', gainDb: +(I - inI + preDb).toFixed(2), I: m.I, TP: m.TP, attempts, input, ...(preDb ? { preAttenuationDb: +preDb.toFixed(2) } : {}) };
    }
  }
  // Fallback: plain gain into a 4x-oversampled true-peak limiter. Iterate the gain (secant) until I lands, and lower
  // the ceiling when heavy limiting still overshoots after the 192 → 48 kHz resample.
  // Loudness is monotonic in G for a fixed ceiling, so bracket the target and use regula falsi; a true-peak over
  // lowers the ceiling (and resets the bracket, since it changes the curve). The best compliant render wins.
  let G = I - inI;
  let lDb = limitDb;
  let lo = null; // { G, I } too quiet
  let hi = null; // { G, I } too loud
  let best = null;
  let last = null;
  const render = async (g, l) => {
    const lim = Math.max(0.0625, Math.min(1, Math.pow(10, l / 20)));
    const af = `aresample=192000,volume=${g.toFixed(3)}dB,alimiter=limit=${lim.toFixed(5)}:attack=1:release=50:level=false:latency=true,aresample=${SR},${tail}`;
    await ffmpeg(root, ['-y', '-nostats', '-i', src, '-af', af, ...enc, dst]);
    attempts++;
    last = { G: g, lDb: l, ...(await measure(root, dst)) };
    return last;
  };
  for (let k = 0; k < 8; k++) {
    const m = await render(G, lDb);
    const err = I - m.I;
    const over = m.TP - TP;
    if (!Number.isFinite(err)) break;
    if (over <= 0 && (!best || Math.abs(err) < Math.abs(I - best.I))) best = m;
    if (over <= 0 && Math.abs(err) <= Math.min(0.1, tol / 2)) break;
    if (over > 0) { lDb -= over + 0.1; lo = null; hi = null; continue; }
    if (err > 0) lo = m; else hi = m;
    const step = lo && hi && hi.I > lo.I ? lo.G + (I - lo.I) * (hi.G - lo.G) / (hi.I - lo.I) - G : err * (lo && !hi ? 1.5 : 1);
    G += step;
    if (G > 60) break; // nothing audible to raise
  }
  if (best && (last.G !== best.G || last.lDb !== best.lDb)) await render(best.G, best.lDb); // leave the best on disk
  const m = last;
  return { method: 'alimiter', gainDb: +(m.G + preDb).toFixed(2), I: m.I, TP: m.TP, attempts, input, limitDb: +m.lDb.toFixed(2), ...(preDb ? { preAttenuationDb: +preDb.toFixed(2) } : {}) };
}

async function mux(root, silent, master, dst, len) {
  const stage = path.join(path.dirname(dst), '.staging', path.basename(dst));
  ensureDir(path.dirname(stage));
  await ffmpeg(root, ['-y', '-nostats', '-i', silent, '-i', master, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', `apad=whole_dur=${len}`,
    '-c:a', 'aac', '-b:a', '256k', '-ar', String(SR), '-t', len.toFixed(6), '-movflags', '+faststart', stage]);
  try { replaceFile(stage, dst); } finally { fs.rmSync(path.dirname(stage), { recursive: true, force: true }); }
}

const SPEC = {
  format: { type: 'string', desc: 'format, all, or a,b list to mux (default: primaryFormat)' },
  music: { type: 'string', desc: 'music stem or none (default: studio.json audio.music)' },
  sfx: { type: 'string', desc: 'sfx stem or none (default: studio.json audio.sfx)' },
  voice: { type: 'string', desc: 'voice stem or none (default: studio.json audio.voice)' },
  lufs: { type: 'number', desc: 'integrated loudness target (default: studio.json audio.lufs)' },
  tp: { type: 'number', desc: 'true-peak ceiling in dBTP (default: studio.json audio.truePeak)' },
  duck: { type: 'boolean', desc: 'duck music under the voice (default: studio.json audio.duck; --no-duck disables)' },
  'allow-short-stems': { type: 'boolean', desc: 'mix a stem that is shorter than the film, empty or silent anyway (warns; the missing part is silence)' },
  json: { type: 'boolean', desc: 'print one JSON result line on stdout' },
};

async function cli() {
  const title = 'node tools/mix.mjs [--format f|all] [--music P|none] [--sfx P|none] [--voice P|none] [--lufs -14] [--tp -1] [--no-duck] [--allow-short-stems] [--json]';
  const extra = 'Writes the master (studio.json audio.master, default out/score.wav) and out/<fmt>/final.mp4 for every format that has\n' +
    'out/<fmt>/silent.mp4, then copies the primary format to out/final.mp4 and out/poster.png.\n' +
    'Every stem is measured first. A stem that is shorter than the film by more than 0.25 s, empty or silent (peak below\n' +
    '-80 dBFS) stops the mix (regenerate it: npm run score / sfx / voice) unless --allow-short-stems is passed. A silent sfx\n' +
    'stem only warns (a film without cues renders silence). A stem longer than the film warns that its end is cut.';
  const { flags, positionals } = parseArgs(process.argv.slice(2), SPEC);
  if (flags.help) { process.stdout.write(usage(title, SPEC, extra)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}"`, usage(title, SPEC, extra));
  const root = projectRoot();
  const cfg = loadConfig(root);
  const a = cfg.audio;
  const T = { I: flags.lufs ?? a.lufs, TP: flags.tp ?? a.truePeak, tol: a.lufsTolerance ?? 0.5 };
  // loudnorm's own range is I -70..-5 (studio.json validation allows up to 0, so name where a bad value came from)
  if (!(T.I <= -5 && T.I >= -70)) throw new UsageError(`${flags.lufs !== undefined ? '--lufs' : 'audio.lufs'} must be between -70 and -5 (got ${T.I})`);
  if (!(T.TP <= 0 && T.TP >= -20)) throw new UsageError(`${flags.tp !== undefined ? '--tp' : 'audio.truePeak'} must be between -20 and 0 (got ${T.TP})`);
  if (!(T.tol > 0)) throw new UsageError(`audio.lufsTolerance must be greater than 0 (got ${T.tol})`);
  const explicitFormat = flags.format !== undefined;
  const formats = resolveFormats(cfg, flags.format);
  const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
  const warnings = [];
  const warn = (w) => { warnings.push(w); log(`mix: warning: ${w}`); };

  const stems = {};
  for (const [name, gainDb] of [['music', a.musicGainDb], ['sfx', a.sfxGainDb], ['voice', a.voiceGainDb]]) {
    const v = flags[name] ?? a[name];
    if (v === null || v === undefined || v === '' || v === 'none') continue;
    const file = path.resolve(root, v);
    if (!fs.existsSync(file)) {
      if (flags[name] !== undefined) throw new Error(`--${name} ${v}: file not found`);
      warn(`${name} stem ${rel(file)} not found — mixing without it${name === 'music' ? ' (npm run score)' : name === 'sfx' ? ' (npm run sfx)' : ''}`);
      continue;
    }
    stems[name] = { file, gainDb: Number(gainDb) || 0 };
  }
  const span = renderSpan(root, cfg, cfg.primaryFormat);
  if (span.source.startsWith('studio')) warn(`no out/${cfg.primaryFormat}/render.json — using the studio duration ${cfg.duration} s`);
  const names = Object.keys(stems);

  // Measure every stem before mixing: apad/atrim would turn a stem that ends early (stale after a duration edit),
  // an empty one or an all-zero one into silence in the delivered film, and loudnorm would still pass it.
  const stemInfo = {};
  await Promise.all(names.map(async (n) => { stemInfo[n] = await probeStem(root, stems[n].file); }));
  const need = span.from + span.len;
  const blocking = [];
  for (const n of names) {
    for (const f of stemFindings(n, stemInfo[n], { need, label: rel(stems[n].file) })) {
      if (f.fatal && !flags['allow-short-stems']) blocking.push(f.text);
      else warn(f.fatal ? `${f.text} (mixing anyway: --allow-short-stems)` : f.text);
    }
  }
  if (blocking.length) {
    throw new Error(`refusing to mix: ${blocking.length === 1 ? 'a stem does' : `${blocking.length} stem problems do`} not fit the ${need.toFixed(2)} s film\n${blocking.map((b) => `  - ${b}`).join('\n')}\n` +
      `Regenerate the stem (music: ${REGEN.music} · sfx: ${REGEN.sfx} · voice: ${REGEN.voice}), or pass --allow-short-stems to mix it as it is.`);
  }

  const work = ensureDir(path.join(root, 'out', '.mix'));
  const pre = path.join(work, 'premix.wav');
  const cand = path.join(work, 'master.wav');
  const masterPath = path.resolve(root, a.master && a.master !== 'none' ? a.master : 'out/score.wav');

  try {
    let result;
    if (!names.length) {
      warn('no stems (music, sfx, voice) — writing a silent track of the exact length');
      await ffmpeg(root, ['-y', '-nostats', '-f', 'lavfi', '-i', `anullsrc=r=${SR}:cl=stereo`, '-af', `atrim=end_sample=${samplesOf(span.len)}`, '-c:a', 'pcm_s24le', cand]);
      result = { method: 'silent', gainDb: 0, I: -Infinity, TP: -Infinity, attempts: 1 };
    } else {
      log(`mix: ${names.map((n) => `${n} ${rel(stems[n].file)} (${stems[n].gainDb} dB)`).join(' + ')} · ${span.len.toFixed(3)} s from ${span.source}`);
      await premix(root, stems, { len: span.len, from: span.from, duck: flags.duck ?? a.duck !== false, dst: pre });
      result = await loudness(root, pre, cand, { ...T, len: span.len });
      if (result.preAttenuationDb) warn(`the premix integrates at ${f2(result.input.I)} LUFS, above loudnorm's 0 LUFS range: check audio.musicGainDb, sfxGainDb and voiceGainDb (measured after ${result.preAttenuationDb} dB)`);
    }
    const install = () => { ensureDir(path.dirname(masterPath)); replaceFile(cand, masterPath); };
    install();
    const report = (r) => (r.method === 'silent' ? 'silent' : `${f2(r.I)} LUFS · ${f2(r.TP)} dBTP via ${r.method}${r.gainDb ? ` (${r.gainDb > 0 ? '+' : ''}${r.gainDb} dB)` : ''}`);
    log(`mix: master → ${rel(masterPath)} · ${report(result)}`);

    // Mux every format that has a render; the AAC encode can add inter-sample overshoot, so check after encoding.
    const done = [];
    const muxAll = async () => {
      done.length = 0;
      for (const fmt of formats) {
        const silent = outDir(root, fmt, 'silent.mp4');
        if (!fs.existsSync(silent)) {
          if (explicitFormat && formats.length === 1) throw new Error(`${rel(silent)} not found — render it first: node tools/render.mjs --format ${fmt}`);
          warn(`${rel(silent)} not found — skipped ${fmt} (render it first)`);
          continue;
        }
        const len = renderSpan(root, cfg, fmt).len;
        const dst = outDir(root, fmt, 'final.mp4');
        await mux(root, silent, masterPath, dst, len);
        const m = await measure(root, dst);
        done.push({ format: fmt, final: rel(dst), duration: +len.toFixed(6), I: m.I, TP: m.TP });
      }
    };
    await muxAll();
    for (let retry = 0; retry < 2 && names.length && done.some((d) => d.TP > T.TP + 0.05); retry++) {
      const over = Math.max(...done.map((d) => d.TP)) - T.TP;
      const limitDb = (result.limitDb ?? T.TP - 0.5) - over - 0.2;
      log(`mix: AAC true peak ${f2(T.TP + over)} dBTP is over ${T.TP} — re-mastering with the limiter at ${f2(limitDb)} dBFS`);
      result = await loudness(root, pre, cand, { ...T, len: span.len, limitDb, force: true });
      install();
      log(`mix: master → ${rel(masterPath)} · ${report(result)}`);
      await muxAll();
    }
    for (const d of done) {
      log(`mix: ${d.final} · ${d.duration.toFixed(3)} s · ${f2(d.I)} LUFS · ${f2(d.TP)} dBTP (after AAC)`);
      if (d.TP > T.TP) warn(`${d.final}: true peak ${f2(d.TP)} dBTP exceeds ${T.TP} dBTP after AAC encoding`);
      if (Number.isFinite(d.I) && Math.abs(d.I - T.I) > T.tol) warn(`${d.final}: ${f2(d.I)} LUFS is outside ${T.I} ±${T.tol}`);
    }
    if (result.method !== 'silent' && (Math.abs(result.I - T.I) > T.tol || result.TP > T.TP)) warn(`master misses the target (${f2(result.I)} LUFS, ${f2(result.TP)} dBTP; want ${T.I} ±${T.tol}, ≤ ${T.TP})`);
    const primary = done.find((d) => d.format === cfg.primaryFormat) ?? done[0];
    let finalCopied = false;
    if (primary) {
      // The copies are a convenience: a player holding out/final.mp4 open (Windows) must not fail a finished mix.
      const poster = outDir(root, primary.format, 'poster.png');
      const inUse = (name) => warn(`out/${name} is open in another program - close the player and run npm run mix again. The finished file is ${primary.final}`);
      finalCopied = await copyWhenFree(path.join(root, primary.final), path.join(root, 'out', 'final.mp4'));
      if (!finalCopied) inUse('final.mp4');
      const posterCopied = fs.existsSync(poster) && await copyWhenFree(poster, path.join(root, 'out', 'poster.png'));
      if (fs.existsSync(poster) && !posterCopied) inUse('poster.png');
      log(`mix: ${primary.final}${finalCopied ? ' → out/final.mp4' : ''}${posterCopied ? ' + out/poster.png' : ''}`);
    } else warn('no final.mp4 was written (no out/<format>/silent.mp4 yet) — the master is ready for the mux');
    if (flags.json) {
      const clean = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null);
      process.stdout.write(JSON.stringify({
        master: rel(masterPath), duration: +span.len.toFixed(6), samples: samplesOf(span.len), target: T, method: result.method, gainDb: result.gainDb,
        I: clean(result.I), TP: clean(result.TP), stems: Object.fromEntries(names.map((n) => [n, rel(stems[n].file)])),
        formats: done.map((d) => ({ ...d, I: clean(d.I), TP: clean(d.TP) })), final: finalCopied ? 'out/final.mp4' : primary ? primary.final : null, warnings,
        stemInfo: Object.fromEntries(names.map((n) => [n, { duration: +stemInfo[n].duration.toFixed(3), peakDb: clean(stemInfo[n].peakDb) }])),
        ...(result.preAttenuationDb ? { preAttenuationDb: result.preAttenuationDb } : {}),
      }) + '\n');
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true }); // also when a step throws: no half-written out/.mix left behind
  }
  return 0;
}

const isMain = () => {
  try {
    const x = fs.realpathSync.native(process.argv[1] ?? '');
    const y = fs.realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch { return false; }
};
if (isMain()) main(cli);
