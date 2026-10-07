#!/usr/bin/env node
// tools/beats.mjs — measure a supplied track's beat grid → audio/beats.json (lib/runtime.js reads it).
// The track is always decoded by ffmpeg to mono 22050 Hz float first (librosa 1.0 has no audioread, so m4a/aac would
// otherwise fail). Engines: librosa via tools/beats.py when Python + librosa import, else the built-in JS engine
// (radix-2 STFT → log spectral flux → autocorrelation tempo with a log-normal prior → Ellis DP beat tracking →
// downbeat phase scoring → peak-picked hits). Both engines' beats and hits are snapped to a 5.8 ms-hop onset
// function afterwards. Results are cached by the track's sha256 in audio/.cache/ (librosa cold start ≈ 1 min).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, usage, main, loadConfig, projectRoot, resolvePython, run, sha256, readJSON, writeJSON, log, UsageError } from './studio.mjs';
import { decodeAudio, writeWav } from './audio.mjs';

export const BEATS_SR = 22050;
const HOP = 512;
const NFFT = 2048;
const FINE_HOP = 128;
const FINE_NFFT = 512;
// Constant offsets from flux-peak frame time to the true onset, calibrated on synthetic kick/click tracks
// (test/beats.test.mjs checks the result stays within ±30 ms).
const LAG_COARSE = 0.012;
const LAG_FINE = 0.004;
const ENGINE_VERSION = 3; // 3: --bpm-hint widens the JS tempo window (60 or 200 BPM hints were ignored)

// ---------------------------------------------------------------------------------------------------------------
// FFT + spectral features

const fftCache = new Map();
function fftPlan(n) {
  if (fftCache.has(n)) return fftCache.get(n);
  const bits = Math.log2(n);
  if (!Number.isInteger(bits)) throw new Error(`FFT size must be a power of two (got ${n})`);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1); rev[i] = r; }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos(2 * Math.PI * k / n); sin[k] = Math.sin(2 * Math.PI * k / n); }
  const plan = { n, rev, cos, sin };
  fftCache.set(n, plan);
  return plan;
}

/** In-place iterative radix-2 FFT (forward, e^{-iωt}). */
export function fft(re, im) {
  const { n, rev, cos, sin } = fftPlan(re.length);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j;
        const b = a + half;
        const tr = re[b] * cos[k] + im[b] * sin[k];
        const ti = im[b] * cos[k] - re[b] * sin[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/**
 * Centred STFT (frame k ↔ time k·hop/sr) → half-wave-rectified log-magnitude flux, optionally the flux of the
 * band below `lowHz` and a per-frame chroma vector (for downbeat novelty).
 */
function spectralFlux(y, sr, { n, hop, lowHz = 0, chroma = false }) {
  const frames = 1 + Math.floor(y.length / hop);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  const scale = 2 / (n / 2); // a full-scale sine → magnitude ≈ 1
  const bins = n / 2;
  const hz = sr / n;
  const lowBin = Math.max(1, Math.floor(lowHz / hz));
  const flux = new Float64Array(frames);
  const low = lowHz ? new Float64Array(frames) : null;
  const chr = chroma ? new Float32Array(frames * 12) : null;
  const pcOf = new Int8Array(bins + 1).fill(-1);
  if (chroma) for (let b = 1; b <= bins; b++) { const f = b * hz; if (f >= 100 && f <= 5000) pcOf[b] = ((Math.round(12 * Math.log2(f / 440)) + 69) % 12 + 12) % 12; }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let prev = new Float64Array(bins + 1);
  let cur = new Float64Array(bins + 1);
  for (let k = 0; k < frames; k++) {
    const start = k * hop - n / 2;
    for (let i = 0; i < n; i++) { const j = start + i; re[i] = j >= 0 && j < y.length ? y[j] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    let f = 0;
    let fl = 0;
    for (let b = 1; b <= bins; b++) {
      const mag = Math.hypot(re[b % n], im[b % n]) * scale;
      cur[b] = Math.log1p(1000 * mag);
      const d = cur[b] - prev[b]; // frame -1 is silence, so sound at t = 0 counts as an onset
      if (d > 0) { f += d; if (b <= lowBin) fl += d; }
      if (chr && pcOf[b] >= 0) chr[k * 12 + pcOf[b]] += mag * mag;
    }
    flux[k] = f;
    if (low) low[k] = fl;
    const t = prev; prev = cur; cur = t;
  }
  return { flux, low, chroma: chr, frames, fps: sr / hop };
}

// ---------------------------------------------------------------------------------------------------------------
// Tempo, beats, downbeats, hits

const mean = (a) => { let s = 0; for (const v of a) s += v; return a.length ? s / a.length : 0; };
const std = (a) => { const m = mean(a); let s = 0; for (const v of a) s += (v - m) * (v - m); return a.length ? Math.sqrt(s / a.length) : 0; };
const median = (a) => { const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

/**
 * Autocorrelation tempo in [minBpm, maxBpm] weighted by a log-normal prior; parabolic lag refinement. The window is
 * 70–180 BPM, and a hint widens it (to hint·0.75 … hint·1.35 when those reach past it) so a slow or fast track can be
 * named: a fixed window would never make the true lag a candidate, and the prior only reweights candidates.
 */
export function estimateTempo(onset, fps, { hint = null, minBpm, maxBpm } = {}) {
  if (!(minBpm > 0)) minBpm = hint > 0 ? Math.min(70, hint * 0.75) : 70;
  if (!(maxBpm > 0)) maxBpm = hint > 0 ? Math.max(180, hint * 1.35) : 180;
  const o = Float64Array.from(onset);
  const m = mean(o);
  for (let i = 0; i < o.length; i++) o[i] -= m;
  const minLag = Math.max(1, Math.floor(fps * 60 / maxBpm));
  const maxLag = Math.min(o.length - 2, Math.ceil(fps * 60 / minBpm));
  const ac = new Float64Array(maxLag + 2);
  for (let l = 0; l <= maxLag + 1; l++) { let s = 0; for (let i = 0; i + l < o.length; i++) s += o[i] * o[i + l]; ac[l] = s / (o.length - l); }
  const center = hint > 0 ? hint : 120;
  const sigma = hint > 0 ? 0.35 : 1.0; // octaves
  let best = -1;
  let bestScore = -Infinity;
  for (let l = minLag; l <= maxLag; l++) {
    if (!(ac[l] > 0) || ac[l] < ac[l - 1] || ac[l] < ac[l + 1]) continue; // local maxima only
    const bpm = 60 * fps / l;
    const score = ac[l] * Math.exp(-0.5 * (Math.log2(bpm / center) / sigma) ** 2);
    if (score > bestScore) { bestScore = score; best = l; }
  }
  if (best < 0) return { bpm: center, period: 60 * fps / center, confident: false };
  const a = ac[best - 1]; const b = ac[best]; const c = ac[best + 1];
  const d = a - 2 * b + c;
  const lag = best + (d < 0 ? 0.5 * (a - c) / d : 0);
  return { bpm: 60 * fps / lag, period: lag, confident: true };
}

/** Ellis (2007) dynamic-programming beat tracker (the algorithm behind librosa.beat.beat_track). */
export function trackBeats(onset, period, tightness = 100) {
  const n = onset.length;
  const W = Math.max(1, Math.round(period));
  const g = [];
  for (let k = -W; k <= W; k++) g.push(Math.exp(-0.5 * (k * 32 / period) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -W; k <= W; k++) { const j = i + k; if (j >= 0 && j < n) s += onset[j] * g[k + W]; } local[i] = s; }
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.max(lo, Math.round(2 * period));
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let dd = lo; dd <= hi; dd++) {
      const j = i - dd;
      if (j < 0) break;
      const s = cum[j] - tightness * Math.log(dd / period) ** 2;
      if (s > best) { best = s; arg = j; }
    }
    cum[i] = local[i] + (arg >= 0 ? best : 0);
    back[i] = arg;
  }
  // last beat: the last local maximum of cum above half the median local-maximum value
  const peaks = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) peaks.push(i);
  if (!peaks.length) return { frames: [], local };
  const thr = 0.5 * median(peaks.map((i) => cum[i]));
  let last = peaks[peaks.length - 1];
  for (let p = peaks.length - 1; p >= 0; p--) if (cum[peaks[p]] >= thr) { last = peaks[p]; break; }
  const frames = [];
  for (let i = last; i >= 0; i = back[i]) frames.push(i);
  frames.reverse();
  return { frames, local };
}

// Drop beats the DP extrapolated into silence before/after the music (librosa's trim=True). Each edge beat is judged
// by its own onset score: smoothing with neighbours (librosa's way) lets a strong first beat keep a silent one alive.
function trimBeats(frames, local) {
  if (frames.length < 3) return frames;
  const v = frames.map((f) => local[f]);
  const thr = 0.3 * median(v);
  let a = 0;
  let b = frames.length;
  while (a < b && v[a] < thr) a++;
  while (b > a && v[b - 1] < thr) b--;
  return frames.slice(a, b);
}

/** Phase p ∈ [0, bpb) maximizing mean z(low-band onset) + mean z(chroma novelty) over beats[p::bpb]. */
export function downbeatPhase(frames, low, chroma, bpb, period) {
  const nb = frames.length;
  if (nb < 2 * bpb || bpb < 2) return { phase: 0, scores: [], weak: true };
  const lb = frames.map((f) => { let m = 0; for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < low.length && low[k] > m) m = low[k]; return m; });
  const nf = chroma.length / 12;
  const seg = frames.map((f, j) => {
    const end = j + 1 < nb ? frames[j + 1] : Math.min(nf, f + Math.round(period));
    const v = new Float64Array(12);
    for (let k = f; k < end && k < nf; k++) for (let c = 0; c < 12; c++) v[c] += chroma[k * 12 + c];
    const m = Math.max(...v);
    if (m > 0) for (let c = 0; c < 12; c++) v[c] /= m;
    return v;
  });
  const nov = seg.map((v, j) => { if (j === 0) return 0; let s = 0; for (let c = 0; c < 12; c++) s += (v[c] - seg[j - 1][c]) ** 2; return Math.sqrt(s); });
  const z = (a) => { const m = mean(a); const s = std(a) || 1; return a.map((x) => (x - m) / s); };
  const zl = z(lb);
  const zn = z(nov);
  const scores = [];
  for (let p = 0; p < bpb; p++) { const idx = []; for (let j = p; j < nb; j += bpb) idx.push(j); scores.push(mean(idx.map((j) => zl[j])) + mean(idx.map((j) => zn[j]))); }
  let phase = 0;
  for (let p = 1; p < bpb; p++) if (scores[p] > scores[phase]) phase = p;
  return { phase, scores: scores.map((s) => Math.round(s * 1000) / 1000), weak: false };
}

/** librosa.util.peak_pick semantics (greedy, with `wait`). */
export function peakPick(x, { preMax = 3, postMax = 3, preAvg = 3, postAvg = 5, delta = 0.5, wait = 10 } = {}) {
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++) {
    let mx = -Infinity;
    for (let k = Math.max(0, i - preMax); k <= Math.min(x.length - 1, i + postMax); k++) if (x[k] > mx) mx = x[k];
    if (x[i] < mx) continue;
    let s = 0; let c = 0;
    for (let k = Math.max(0, i - preAvg); k <= Math.min(x.length - 1, i + postAvg); k++) { s += x[k]; c++; }
    if (x[i] < s / c + delta || i - last <= wait) continue;
    out.push(i);
    last = i;
  }
  return out;
}

/** Snap a time to the strongest fine-resolution onset within ±win s (unchanged when there is no clear onset). */
function makeRefiner(y, sr) {
  const { flux: f, fps } = spectralFlux(y, sr, { n: FINE_NFFT, hop: FINE_HOP });
  const med = median(f);
  const thr = med + 4 * median(Array.from(f, (v) => Math.abs(v - med)));
  return (t, win = 0.035) => {
    const W = Math.round(win * fps);
    const c = Math.round((t - LAG_FINE) * fps);
    let best = -1;
    let bv = thr;
    for (let k = Math.max(1, c - W); k <= Math.min(f.length - 2, c + W); k++) if (f[k] > bv && f[k] >= f[k - 1] && f[k] >= f[k + 1]) { bv = f[k]; best = k; }
    if (best < 0) return { t, snapped: false };
    const a = f[best - 1]; const b = f[best]; const cc = f[best + 1];
    const d = a - 2 * b + cc;
    return { t: (best + (d < 0 ? 0.5 * (a - cc) / d : 0)) / fps + LAG_FINE, snapped: true };
  };
}

const r3 = (x) => Math.round(x * 1000) / 1000;

// Beat period by least squares over (index, time), refit once without > 30 ms outliers (tails, fills, pickups).
function slopeBpm(times) {
  const fit = (idx) => {
    const mx = mean(idx);
    const my = mean(idx.map((i) => times[i]));
    let sxy = 0; let sxx = 0;
    for (const i of idx) { sxy += (i - mx) * (times[i] - my); sxx += (i - mx) ** 2; }
    const slope = sxx > 0 ? sxy / sxx : 0;
    return { slope, icpt: my - slope * mx };
  };
  const all = times.map((_, i) => i);
  const a = fit(all);
  const keep = all.filter((i) => Math.abs(times[i] - (a.icpt + a.slope * i)) <= 0.03);
  const b = keep.length >= Math.max(4, all.length / 2) ? fit(keep) : a;
  return b.slope > 0 ? 60 / b.slope : 0;
}

// Measured beats → schema fields shared by both engines: snapped times, edge trim, regression tempo, bar grid.
// weak[i] (JS engine) marks beats with little onset support; unsnapped weak beats at either end are extrapolations
// into intros/tails, so they are dropped and the downbeat phase is re-indexed.
function finish(y, sr, { beats, hits, phase, bpm0, beatsPerBar, warnings, refine, weak = null }) {
  // An engine's systematic lag (librosa lands ≈ +20–35 ms on synthetic kicks) would push true onsets to the edge of
  // the snap window: measure it with a wide first pass, remove it, then snap tightly.
  const wide = beats.map((t) => { const r = refine(t, 0.05); return r.snapped ? r.t - t : null; }).filter((d) => d !== null);
  const bias = wide.length >= 5 ? median(wide) : 0;
  const snaps = beats.map((t) => refine(t + bias));
  let a = 0;
  let b = beats.length;
  if (weak) {
    while (a < b && weak[a] && !snaps[a].snapped) a++;
    while (b > a && weak[b - 1] && !snaps[b - 1].snapped) b--;
  }
  const kept = snaps.slice(a, b);
  const bt = kept.map((r) => r3(r.t));
  for (let i = 1; i < bt.length; i++) if (bt[i] <= bt[i - 1]) bt[i] = r3(bt[i - 1] + 0.001); // keep strictly increasing
  let snapped = kept.filter((r) => r.snapped).length;
  const ht = [...new Set(hits.map((t) => { const r = refine(t + bias); if (r.snapped) snapped++; return r3(r.t); }))].filter((t) => t >= 0).sort((p, q) => p - q);
  let bpm = bpm0;
  if (bt.length >= 8) { const s = slopeBpm(bt); if (s > 0 && Math.abs(s - bpm0) / bpm0 < 0.1) bpm = s; }
  const ph = (((phase - a) % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const downbeats = bt.filter((_, i) => i % beatsPerBar === ph);
  return { bpm: Math.round(bpm * 100) / 100, offset: downbeats[0] ?? bt[0] ?? 0, beatsPerBar, duration: r3(y.length / sr), beats: bt, downbeats, downbeatPhase: ph, hits: ht, snapped, warnings, shift: a };
}

const isSilent = (y) => { let m = 0; for (let i = 0; i < y.length; i++) { const a = Math.abs(y[i]); if (a > m) m = a; } return m < 1e-5 || y.length < BEATS_SR / 2; };
const silentResult = (y, sr, beatsPerBar, why) => ({ bpm: 0, offset: 0, beatsPerBar, duration: r3(y.length / sr), beats: [], downbeats: [], downbeatPhase: 0, hits: [], snapped: 0, warnings: [why] });

/** Built-in engine: mono Float32Array at `sr` → schema body (without version/source/sha). */
export function analyzeBeats(y, sr = BEATS_SR, { bpmHint = null, beatsPerBar = 4 } = {}) {
  if (isSilent(y)) return silentResult(y, sr, beatsPerBar, 'no beats: the track is silent or shorter than 0.5 s — the film falls back to the bpm grid');
  const coarse = spectralFlux(y, sr, { n: NFFT, hop: HOP, lowHz: 150, chroma: true });
  const s = std(coarse.flux);
  if (!(s > 1e-9)) return silentResult(y, sr, beatsPerBar, 'no onsets found — the film falls back to the bpm grid');
  const onset = Array.from(coarse.flux, (v) => v / s);
  const warnings = [];
  const tempo = estimateTempo(onset, coarse.fps, { hint: bpmHint });
  if (!tempo.confident) warnings.push('no clear periodicity — tempo defaulted to the hint/120 BPM');
  const { frames: raw, local } = trackBeats(onset, tempo.period, 100);
  const frames = trimBeats(raw, local);
  if (frames.length < 2) warnings.push('fewer than 2 beats tracked');
  const db = downbeatPhase(frames, coarse.low, coarse.chroma, beatsPerBar, tempo.period);
  if (db.weak && frames.length) warnings.push(`too few beats for downbeat detection — assuming the first tracked beat is a downbeat`);
  const toT = (f) => f / coarse.fps + LAG_COARSE;
  const hits = peakPick(onset, { delta: 0.5, wait: 10 }).map(toT);
  const med = median(frames.map((f) => local[f]));
  const weak = frames.map((f) => local[f] < 0.6 * med);
  const res = finish(y, sr, { beats: frames.map(toT), hits, phase: db.phase, bpm0: tempo.bpm, beatsPerBar, warnings, refine: makeRefiner(y, sr), weak });
  const { shift, ...rest } = res;
  return { ...rest, phaseScores: db.scores.map((_, p) => db.scores[(p + shift) % beatsPerBar]) };
}

// ---------------------------------------------------------------------------------------------------------------
// librosa engine (tools/beats.py)

const TOOLS = path.dirname(fileURLToPath(import.meta.url));

// resolvePython throws `MOTION_PYTHON=<path> is not usable: <why>` for a broken pin (a pin is never a hint, so no other
// Python is tried). That is "no librosa" for this tool: auto logs it and uses the JS engine, --engine librosa reports it.
async function librosaStatus(root) {
  let py;
  try { py = resolvePython(root); } catch (err) { return { ok: false, pinned: true, why: err.message }; }
  if (!py) return { ok: false, why: 'no Python found (set MOTION_PYTHON or create .venv)' };
  const r = await run(py, ['-c', 'import librosa, soundfile, numpy, sys; sys.stdout.write(librosa.__version__)'], { timeoutMs: 180000 });
  if (r.code !== 0) return { ok: false, py, why: `librosa is not importable with ${py}: ${String(r.stderr).trim().split('\n').pop()}` };
  return { ok: true, py, version: String(r.stdout).trim() };
}

async function analyzeLibrosa(root, py, y, sha, { bpmHint, beatsPerBar }) {
  const tmp = path.join(root, 'audio', '.cache', `decoded-${sha.slice(0, 16)}-${process.pid}.wav`);
  writeWav(tmp, [y], BEATS_SR, { bits: 32 });
  try {
    const r = await run(py, [path.join(TOOLS, 'beats.py'), tmp, String(bpmHint ?? 0), String(beatsPerBar)], { timeoutMs: 900000, env: { PYTHONIOENCODING: 'utf-8' } });
    if (r.code !== 0) throw new Error(`beats.py failed (${r.timedOut ? 'timed out' : `exit ${r.code}`}):\n${String(r.stderr).trim().split('\n').slice(-8).join('\n')}`);
    const line = String(r.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop();
    if (!line) throw new Error('beats.py printed no JSON');
    return JSON.parse(line);
  } finally { fs.rmSync(tmp, { force: true }); }
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const SPEC = {
  out: { type: 'string', default: 'audio/beats.json', desc: 'beat-grid JSON to write' },
  engine: { type: 'string', default: 'auto', desc: 'auto | librosa | js (auto = librosa when importable, else js)' },
  'bpm-hint': { type: 'number', desc: 'expected tempo (30-300); narrows the tempo prior (octave errors). Without a hint the JS engine searches 70-180 BPM' },
  cache: { type: 'boolean', default: true, desc: 'reuse audio/.cache/beats-<sha256>.json (--no-cache recomputes)' },
  json: { type: 'boolean', desc: 'print one JSON result line on stdout' },
};

async function cli() {
  const title = 'node tools/beats.mjs <track> [--out audio/beats.json] [--engine auto|librosa|js] [--bpm-hint N] [--no-cache] [--json]';
  const extra = 'Default track: studio.json audio.music. Any format ffmpeg reads (wav, mp3, m4a, flac, ogg).\n' +
    'Schema: { version, source, bpm, offset, beatsPerBar, duration, beats[], downbeats[], downbeatPhase, hits[], audioSha256, librosaVersion? }';
  const { flags, positionals } = parseArgs(process.argv.slice(2), SPEC);
  if (flags.help) { process.stdout.write(usage(title, SPEC, extra)); return 0; }
  if (!['auto', 'librosa', 'js'].includes(flags.engine)) throw new UsageError(`--engine must be auto, librosa or js (got "${flags.engine}")`, usage(title, SPEC, extra));
  if (positionals.length > 1) throw new UsageError(`expected one track (got ${positionals.length})`, usage(title, SPEC, extra));
  const hint = flags['bpm-hint'] ?? null;
  if (hint !== null && !(hint >= 30 && hint <= 300)) throw new UsageError(`--bpm-hint must be between 30 and 300 (got ${hint})`);
  const root = projectRoot();
  const cfg = loadConfig(root);
  const bpb = cfg.beatsPerBar ?? 4;
  const trackRel = positionals[0] ?? (cfg.audio.music && cfg.audio.music !== 'none' ? cfg.audio.music : null);
  if (!trackRel) throw new UsageError('no track: pass a file (node tools/beats.mjs audio/song.wav) or set studio.json audio.music', usage(title, SPEC, extra));
  const track = path.resolve(root, trackRel);
  if (!fs.existsSync(track)) throw new Error(`track not found: ${track}`);
  const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
  const sha = sha256(fs.readFileSync(track));
  const cacheFile = path.join(root, 'audio', '.cache', `beats-${sha}.json`);
  const out = path.resolve(root, flags.out);
  const emit = (res, cached) => {
    const doc = { ...res, track: rel(track) };
    writeJSON(out, doc);
    for (const w of doc.warnings ?? []) log(`beats: warning: ${w}`);
    log(`beats: ${doc.source} · ${doc.bpm} BPM · ${doc.beats.length} beats · ${doc.downbeats.length} downbeats (phase ${doc.downbeatPhase}, first ${doc.downbeats[0] ?? '-'} s) · ${doc.hits.length} hits${cached ? ' · cached' : ''} → ${rel(out)}`);
    if (flags.json) process.stdout.write(JSON.stringify({ out: rel(out), source: doc.source, bpm: doc.bpm, beats: doc.beats.length, downbeats: doc.downbeats.length, hits: doc.hits.length, downbeatPhase: doc.downbeatPhase, cached, audioSha256: sha }) + '\n');
    return 0;
  };
  if (flags.cache && fs.existsSync(cacheFile)) {
    const c = readJSON(cacheFile, null);
    const k = c?.cacheKey;
    if (k && k.engineVersion === ENGINE_VERSION && k.bpmHint === hint && k.beatsPerBar === bpb && (flags.engine === 'auto' || c.source === flags.engine)) {
      const { cacheKey, ...res } = c;
      return emit(res, true);
    }
  }
  const { channels } = await decodeAudio(root, track, { sr: BEATS_SR, channels: 1 });
  const y = channels[0];
  let source = 'js';
  let body = null;
  let librosaVersion;
  if (flags.engine !== 'js') {
    const st = await librosaStatus(root);
    if (!st.ok && flags.engine === 'librosa') {
      throw new Error(`${st.why}\nFix: ${st.pinned ? 'point MOTION_PYTHON at a working Python that has librosa, or unset it' : 'pip install librosa soundfile  (librosa 1.0 needs Python ≥ 3.12)'}, or use --engine js`);
    }
    if (st.ok) {
      log(`beats: librosa ${st.version} (${st.py}) — the first run in a fresh venv can take a minute (numba JIT); results are cached`);
      try {
        const lr = await analyzeLibrosa(root, st.py, y, sha, { bpmHint: hint, beatsPerBar: bpb });
        const warnings = lr.warnings ?? [];
        body = lr.beats.length
          ? finish(y, BEATS_SR, { beats: lr.beats, hits: lr.hits, phase: lr.downbeatPhase, bpm0: lr.bpm, beatsPerBar: bpb, warnings, refine: makeRefiner(y, BEATS_SR) })
          : silentResult(y, BEATS_SR, bpb, warnings[0] ?? 'librosa found no beats — the film falls back to the bpm grid');
        delete body.shift;
        if (lr.phaseScores) body.phaseScores = lr.phaseScores;
        source = 'librosa';
        librosaVersion = lr.librosaVersion ?? st.version;
      } catch (err) {
        if (flags.engine === 'librosa') throw err;
        log(`beats: warning: librosa failed, using the JS engine: ${err.message.split('\n')[0]}`);
      }
    } else log(`beats: ${st.why} — using the JS engine`);
  }
  if (!body) body = analyzeBeats(y, BEATS_SR, { bpmHint: hint, beatsPerBar: bpb });
  const res = { version: 1, source, ...body, audioSha256: sha, ...(librosaVersion ? { librosaVersion } : {}) };
  writeJSON(cacheFile, { ...res, cacheKey: { engineVersion: ENGINE_VERSION, bpmHint: hint, beatsPerBar: bpb } });
  return emit(res, false);
}

const isMain = () => {
  try {
    const a = fs.realpathSync.native(process.argv[1] ?? '');
    const b = fs.realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
};
if (isMain()) main(cli);
