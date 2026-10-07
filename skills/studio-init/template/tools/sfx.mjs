#!/usr/bin/env node
// tools/sfx.mjs — synthesize the film's sound effects from its cues onto one stereo bus of exactly the film length.
// Cues come from the film itself (__studio.cues(), read headless) or from --cues <file>. Every voice is synthesized
// from a per-cue seed = hash32(cue key, type, seed). The cue key is hash32(type, round(t·1000), n) with n = the cue's
// rank among cues of the same type and time, so it does not depend on where the cue sits in the time-sorted list:
// adding, removing or reordering OTHER cues never changes a cue's noise, jitter or glitch fragments (the bus limiter
// can still ride differently when cues overlap).
// audio/samples/<type>.wav (licensed recordings) replaces the synthesized voice for that type.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, usage, main, loadConfig, projectRoot, startServer, launchBrowser, openFilm, readJSON, writeJSON, log, fmtTime, UsageError,
} from './studio.mjs';
import {
  SR, makeBuffer, addAt, writeWav, limiter, peakDb, biquad, svf, onePoleLP, onePoleHP, noiseGen, decodeAudio, resample, peakTime, dbToGain,
} from './audio.mjs';
import { normalizeCues, SFX_TYPES } from '../lib/timeline.js';
import { hash32, mulberry32 } from '../lib/rng.js';

const TAU = 2 * Math.PI;
const env = (t, a, tau) => (t < 0 ? 0 : t < a ? Math.sin(0.5 * Math.PI * t / a) ** 2 : Math.exp(-(t - a) / tau));
const noiseArr = (n, noise) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = noise(); return x; };
const len = (sec, sr) => Math.max(1, Math.round(sec * sr));

function endFade(x, sec, sr) {
  for (const c of Array.isArray(x) ? x : [x]) {
    const m = Math.min(c.length, Math.round(sec * sr));
    for (let i = 0; i < m; i++) c[c.length - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / m);
  }
  return x;
}

/** Scale mono or [L,R] so its sample peak sits at `db` dBFS. */
export function normalizeTo(x, db) {
  const list = Array.isArray(x) ? x : [x];
  let m = 0;
  for (const c of list) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
  if (m > 0) { const g = dbToGain(db) / m; for (const c of list) for (let i = 0; i < c.length; i++) c[i] *= g; }
  return x;
}

// Sine with a time-varying frequency (phase accumulated, starts at phase 0 → no click).
function sweep(n, sr, fAt, ampAt) {
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / sr; x[i] = Math.sin(ph) * ampAt(t); ph += TAU * fAt(t) / sr; }
  return x;
}

// ---------------------------------------------------------------------------------------------------------------
// The 12 voices. make(ctx) → { data: Float32Array | [L, R], anchor } where anchor = seconds into the sound that
// lands exactly on the cue time (the transient; the pass-by of a whoosh; the arrival point of a riser).
// level = peak dBFS of the normalized voice before the cue's own gain; it sets the relative balance.

export const VOICES = {
  click: {
    desc: 'UI click: bright transient over a short 2.1 kHz body', level: -8,
    make({ sr, noise, pitch }) {
      const n = len(0.06, sr);
      const hp = onePoleHP(noiseArr(n, noise), 3000, sr);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        x[i] = 0.7 * hp[i] * env(t, 0.0003, 0.0022) + 0.55 * Math.sin(TAU * 2100 * pitch * t) * env(t, 0.0005, 0.009)
          + 0.25 * Math.sin(TAU * 650 * pitch * t) * env(t, 0.001, 0.012);
      }
      return { data: endFade(x, 0.004, sr), anchor: 0.0012 };
    },
  },
  tick: {
    desc: 'light tick: 3.3 kHz ping, 5 ms', level: -12,
    make({ sr, noise, pitch }) {
      const n = len(0.045, sr);
      const hp = onePoleHP(noiseArr(n, noise), 6000, sr);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) { const t = i / sr; x[i] = Math.sin(TAU * 3300 * pitch * t) * env(t, 0.0003, 0.005) + 0.5 * hp[i] * env(t, 0.0002, 0.0012); }
      return { data: endFade(x, 0.004, sr), anchor: 0.0006 };
    },
  },
  pop: {
    desc: 'bubble pop: upward pitch flick 360 → 1180 Hz', level: -9,
    make({ sr, noise, pitch }) {
      const n = len(0.16, sr);
      const f = (t) => pitch * (360 + 820 * (1 - Math.exp(-t / 0.018)));
      const x = sweep(n, sr, f, (t) => env(t, 0.002, 0.035));
      const h = sweep(n, sr, (t) => 2 * f(t), (t) => 0.15 * env(t, 0.002, 0.02));
      const tick = onePoleHP(noiseArr(n, noise), 4000, sr);
      for (let i = 0; i < n; i++) x[i] += h[i] + 0.2 * tick[i] * env(i / sr, 0.0002, 0.0008);
      return { data: endFade(x, 0.01, sr), anchor: 0.003 };
    },
  },
  thump: {
    desc: 'low thump: 150 → 46 Hz body with a soft knock (scene downbeats)', level: -4,
    make({ sr, noise, pitch }) {
      const n = len(0.6, sr);
      const x = sweep(n, sr, (t) => pitch * (46 + 104 * Math.exp(-t / 0.045)), (t) => env(t, 0.0015, 0.18));
      const knock = onePoleLP(noiseArr(n, noise), 1200, sr);
      for (let i = 0; i < n; i++) x[i] = Math.tanh(1.4 * (x[i] + 0.3 * knock[i] * env(i / sr, 0.0005, 0.006)));
      return { data: endFade(x, 0.03, sr), anchor: 0.004 };
    },
  },
  whoosh: {
    desc: 'air whoosh: band sweep with a left→right pass, peak at 0.31 s (transitions)', level: -10,
    make({ sr, noise, pitch }) {
      const dur = 0.5; const pk = 0.62; const n = len(dur, sr);
      const e = new Float32Array(n);
      for (let i = 0; i < n; i++) { const p = i / n; e[i] = p < pk ? (p / pk) ** 1.8 : ((1 - p) / (1 - pk)) ** 1.2; }
      const fc = e.map((v) => pitch * (320 + 3600 * v));
      const out = [0, 1].map(() => svf(noiseArr(n, noise), { type: 'bandpass', f: fc, q: 0.8 }, sr));
      const body = onePoleLP(noiseArr(n, noise), 500, sr);
      for (let i = 0; i < n; i++) {
        const p = i / n;
        const th = Math.PI / 4 + 0.45 * (p - pk); // slight pan travel across the peak
        const b = 0.5 * body[i] * e[i] * e[i];
        out[0][i] = (out[0][i] * e[i] + b) * Math.cos(th) * Math.SQRT2;
        out[1][i] = (out[1][i] * e[i] + b) * Math.sin(th) * Math.SQRT2;
      }
      return { data: endFade(out, 0.01, sr), anchor: pk * dur };
    },
  },
  swoosh: {
    desc: 'fast bright swipe: rising band 1.8 → 7.5 kHz, peak at 0.2 s', level: -12,
    make({ sr, noise, pitch }) {
      const dur = 0.28; const pk = 0.7; const n = len(dur, sr);
      const e = new Float32Array(n);
      const fc = new Float32Array(n);
      for (let i = 0; i < n; i++) { const p = i / n; e[i] = p < pk ? (p / pk) ** 1.4 : ((1 - p) / (1 - pk)) ** 2; fc[i] = pitch * (1800 + 5700 * p); }
      const out = [0, 1].map(() => svf(onePoleHP(noiseArr(n, noise), 1200, sr), { type: 'bandpass', f: fc, q: 1.2 }, sr));
      for (const c of out) for (let i = 0; i < n; i++) c[i] *= e[i];
      return { data: endFade(out, 0.006, sr), anchor: pk * dur };
    },
  },
  riser: {
    desc: 'build-up: noise band 250 Hz → 7 kHz + octave glide; starts on the cue, swells into the next hit/thump/snap (≤ 4 s, else 1.6 s)', level: -8,
    make({ sr, noise, pitch, length = 1.6 }) {
      const dur = Math.max(0.2, length); const n = len(dur, sr);
      const fc = new Float32Array(n);
      for (let i = 0; i < n; i++) fc[i] = pitch * 250 * Math.pow(28, (i / n) ** 1.6);
      const out = [0, 1].map(() => svf(noiseArr(n, noise), { type: 'bandpass', f: fc, q: 1.6 }, sr));
      const air = [0, 1].map(() => onePoleHP(noiseArr(n, noise), 4000, sr));
      const tone = [-1.5, 1.5].map((det) => sweep(n, sr, (t) => pitch * 110 * Math.pow(2, 2 * t / dur) + det, (t) => 0.18 * (t / dur) ** 2));
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < n; i++) { const p = i / n; out[c][i] = out[c][i] * p ** 2.2 + 0.6 * air[c][i] * p ** 5 + tone[c][i]; }
      }
      return { data: endFade(out, 0.012, sr), anchor: 0 };
    },
  },
  hit: {
    desc: 'impact: sub drop + body + crack + wide decaying tail (lockups, final beats)', level: -3,
    make({ sr, noise, pitch }) {
      const n = len(1.8, sr);
      const sub = sweep(n, sr, (t) => pitch * (42 + 80 * Math.exp(-t / 0.05)), (t) => env(t, 0.002, 0.5));
      const body = onePoleLP(noiseArr(n, noise), 900, sr);
      const crack = onePoleHP(noiseArr(n, noise), 2500, sr);
      const out = [0, 1].map(() => svf(noiseArr(n, noise), { type: 'lowpass', f: (i) => 200 + 6000 * Math.exp(-i / sr / 0.35), q: 0.7 }, sr));
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          out[c][i] = Math.tanh(1.3 * (sub[i] + 0.6 * body[i] * env(t, 0.001, 0.08) + 0.45 * crack[i] * env(t, 0.0005, 0.012) + 0.3 * out[c][i] * env(t, 0.004, 0.45)));
        }
      }
      return { data: endFade(out, 0.05, sr), anchor: 0.002 };
    },
  },
  chime: {
    desc: 'success chime: two bell notes a fifth apart (C6 → G6 at pitch 1)', level: -11,
    make({ sr, pitch }) {
      const n = len(1.3, sr);
      const x = new Float32Array(n);
      const partials = [[1, 1, 0.6], [2, 0.3, 0.35], [2.76, 0.2, 0.22], [5.4, 0.07, 0.1]];
      for (const [t0, f0, amp] of [[0, 1046.5, 1], [0.085, 1567.98, 0.8]]) {
        const s0 = Math.round(t0 * sr);
        for (const [ratio, a, tau] of partials) {
          const w = TAU * f0 * pitch * ratio / sr;
          if (w >= Math.PI * 0.98) continue;
          for (let i = s0; i < n; i++) { const t = (i - s0) / sr; x[i] += amp * a * Math.sin(w * (i - s0)) * env(t, 0.0012, tau); }
        }
      }
      return { data: endFade(x, 0.05, sr), anchor: 0.0015 };
    },
  },
  type: {
    desc: 'keystroke: tack + low thock + release click, jittered per cue', level: -14,
    make({ sr, noise, rnd, pitch }) {
      const n = len(0.07, sr);
      const j = 1 + (rnd() - 0.5) * 0.12;
      const lvl = 1 + (rnd() - 0.5) * 0.3;
      const tack = biquad(noiseArr(n, noise), { type: 'bandpass', f: 3200 * pitch * j, q: 1.3 }, sr);
      const rel = onePoleHP(noiseArr(n, noise), 3000, sr);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        x[i] = lvl * (0.9 * tack[i] * env(t, 0.0004, 0.006) + 0.35 * Math.sin(TAU * 240 * pitch * j * t) * env(t, 0.001, 0.012)
          + 0.25 * rel[i] * env(t - 0.018, 0.0003, 0.002));
      }
      return { data: endFade(x, 0.005, sr), anchor: 0.0008 };
    },
  },
  glitch: {
    desc: 'digital glitch: up to 6 stuttered, crushed fragments on alternating sides (seeded per cue)', level: -12,
    make({ sr, noise, rnd, pitch }) {
      const n = len(0.3, sr);
      const out = [new Float32Array(n), new Float32Array(n)];
      let s = 0;
      for (let seg = 0; s < n * 0.87 && seg < 6; seg++) {
        const m = Math.min(n - s, len(0.012 + rnd() * 0.035, sr));
        const kind = Math.floor(rnd() * 3);
        const f = pitch * (180 + rnd() * 1800);
        const hold = 1 + Math.floor(rnd() * (kind === 1 ? 14 : 6));
        const side = seg % 2;
        const ramp = Math.min(m >> 1, len(0.001, sr));
        let held = 0;
        for (let i = 0; i < m; i++) {
          if (i % hold === 0) {
            const t = i / sr;
            held = kind === 0 ? (Math.sin(TAU * f * t) >= 0 ? 0.6 : -0.6)
              : kind === 1 ? Math.round(noise() * 2) / 2
                : Math.sin(TAU * f * t + 3 * Math.sin(TAU * 2.7 * f * t));
          }
          const g = Math.min(1, i / ramp, (m - 1 - i) / ramp);
          out[side][s + i] += held * g;
          out[1 - side][s + i] += 0.25 * held * g;
        }
        s += m + len(rnd() * 0.012, sr);
      }
      return { data: out, anchor: 0 };
    },
  },
  snap: {
    desc: 'tight snap: 2.3 kHz band burst with a crack (elements locking into place)', level: -9,
    make({ sr, noise, pitch }) {
      const n = len(0.09, sr);
      const band = biquad(noiseArr(n, noise), { type: 'bandpass', f: 2300 * pitch, q: 1.4 }, sr);
      const crack = onePoleHP(noiseArr(n, noise), 5000, sr);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        x[i] = band[i] * env(t, 0.0003, 0.011) + 0.7 * crack[i] * env(t, 0.0002, 0.0015) + 0.25 * Math.sin(TAU * 1650 * pitch * t) * env(t, 0.0005, 0.02);
      }
      return { data: endFade(x, 0.006, sr), anchor: 0.0008 };
    },
  },
};

for (const t of SFX_TYPES) if (!VOICES[t]) throw new Error(`sfx.mjs has no voice for SFX type "${t}" listed in lib/timeline.js`);

/**
 * Synthesize one voice, normalized to its level: { data, anchor }. Shared with score.mjs. `length` sizes the riser.
 * `i` is a stable per-voice key (score.mjs passes the bar index, renderSfx the cue key), not a list position.
 */
export function synthVoice(type, { seed = 1, i = 0, pitch = 1, sr = SR, length } = {}) {
  const v = VOICES[type];
  if (!v) throw new Error(`unknown SFX type "${type}" (valid: ${Object.keys(VOICES).join(', ')})`);
  const h = hash32(i, type, seed);
  const { data, anchor } = v.make({ sr, pitch, length, noise: noiseGen(h), rnd: mulberry32(hash32(h, 'rnd')) });
  return { data: normalizeTo(data, v.level), anchor };
}

const LANDINGS = new Set(['hit', 'thump', 'snap']);
// A riser lasts until the next landing cue (so it arrives exactly on the impact), 0.4-4 s; otherwise 1.6 s.
function riserLength(cues, k) {
  const t = cues[k].t;
  const next = cues.find((c, j) => j !== k && LANDINGS.has(c.type) && c.t > t + 0.35);
  return next && next.t - t <= 4 ? next.t - t : 1.6;
}

// ---------------------------------------------------------------------------------------------------------------
// Bus

/** Licensed-sample overrides: <dir>/<type>.(wav|flac|mp3|ogg) → { type: { data:[L,R], anchor, file } }. */
export async function loadSamples(root, dir) {
  const out = {};
  if (!dir || dir === 'none') return out; // --no-samples parses to null, --samples none is the spelled-out form
  const abs = path.resolve(root, dir);
  if (!fs.existsSync(abs)) return out;
  for (const type of Object.keys(VOICES)) {
    const file = ['wav', 'flac', 'mp3', 'ogg'].map((e) => path.join(abs, `${type}.${e}`)).find((f) => fs.existsSync(f));
    if (!file) continue;
    const { channels } = await decodeAudio(root, file, { sr: SR, channels: 2 });
    out[type] = { data: channels, anchor: peakTime(channels, SR), file };
  }
  return out;
}

/**
 * Noise-seed key per cue: hash32(type, time in ms, rank among cues with the same type and time). It never uses the
 * position in the time-sorted list, which shifts for every later cue when an earlier one is added or removed.
 */
export function cueKeys(cues) {
  const seen = new Map();
  return cues.map((c) => {
    const ms = Math.round(c.t * 1000);
    const id = `${c.type}@${ms}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return hash32(c.type, ms, n);
  });
}

/**
 * cues → stereo bus of exactly round(duration·sr) samples, true-peak limited to −1 dBFS.
 * Returns { channels, placed, warnings }. Throws on an unknown cue type (listing the valid ones).
 */
export function renderSfx(rawCues, { duration, seed = 1, samples = {}, loop = false, sr = SR } = {}) {
  if (!(duration > 0)) throw new Error(`sfx: duration must be > 0 (got ${duration})`);
  const cues = normalizeCues(rawCues);
  for (const c of cues) {
    if (!VOICES[c.type] && !samples[c.type]) throw new Error(`unknown SFX type "${c.type}" at t=${c.t} (valid: ${Object.keys(VOICES).join(', ')})`);
  }
  const bus = makeBuffer(duration, 2, sr);
  const placed = [];
  const warnings = [];
  const keys = cueKeys(cues);
  cues.forEach((c, i) => {
    if (c.t >= duration && !loop) { warnings.push(`cue ${c.type} at ${fmtTime(c.t)} is past the end (${fmtTime(duration)}) — skipped`); return; }
    let data;
    let anchor;
    if (samples[c.type]) {
      const s = samples[c.type];
      data = c.pitch === 1 ? s.data : s.data.map((ch) => resample(ch, c.pitch));
      anchor = s.anchor / c.pitch;
      if (c.type === 'riser') anchor -= riserLength(cues, i); // a sampled riser peaks where a synthesized one ends
    } else ({ data, anchor } = synthVoice(c.type, { seed, i: keys[i], pitch: c.pitch, sr, length: c.type === 'riser' ? riserLength(cues, i) : undefined }));
    const start = c.t - anchor;
    addAt(bus, data, loop ? ((start % duration) + duration) % duration : start, { gain: c.gain, pan: c.pan, sr, wrap: loop });
    placed.push({ t: c.t, type: c.type, start: Math.round(start * 1e4) / 1e4, gain: c.gain, pan: c.pan, pitch: c.pitch, sample: !!samples[c.type] });
  });
  limiter(bus, { ceilingDb: -1.05, truePeak: true, sr });
  return { channels: bus, placed, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

async function cuesFromFilm(root, cfg, format) {
  const server = await startServer(root);
  let browser;
  try {
    ({ browser } = await launchBrowser(root, cfg));
    const { page, context, meta } = await openFilm(browser, server.url, { format, scale: 0.25 });
    const cues = await page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.cues())));
    await context.close();
    return { cues, duration: meta.duration, loop: meta.loop === true };
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }
}

function readCuesFile(file) {
  const j = readJSON(file);
  const cues = Array.isArray(j) ? j : j && Array.isArray(j.cues) ? j.cues : null;
  if (!cues) throw new Error(`${file}: expected an array of cues [{ "t": 0.5, "type": "click" }, ...] or { "cues": [...] }`);
  return { cues, duration: Array.isArray(j) ? undefined : j.duration };
}

const SPEC = {
  cues: { type: 'string', arg: '<file>', desc: 'read cues from a JSON file instead of opening the film' },
  format: { type: 'string', desc: 'film format to open for cues (default: primaryFormat)' },
  out: { type: 'string', desc: 'output WAV (default: studio.json audio.sfx or audio/sfx.wav)' },
  dur: { type: 'number', desc: 'length in seconds (default: film duration)' },
  seed: { type: 'number', default: 1, desc: 'noise seed for every voice' },
  samples: { type: 'string', default: 'audio/samples', desc: 'folder of licensed <type>.wav overrides (none or --no-samples: synthesize everything)' },
  'dump-cues': { type: 'boolean', desc: 'write audio/cues.json from the film and exit (no audio)' },
  list: { type: 'boolean', desc: 'print the voice table and exit' },
  json: { type: 'boolean', desc: 'print one JSON result line on stdout' },
};

const EXTRA = `Cue: { "t": seconds, "type": ${SFX_TYPES.join('|')}, "gain"=1, "pan"=0 (-1..1), "pitch"=1 }
Aliases { "sfx": type, "vol": gain } (claude-animation format) are accepted. Each cue lands its anchor on t:
the transient for hits, the pass-by for whoosh/swoosh. A riser starts on its cue and swells into the next hit, thump or
snap cue (0.4-4 s later; else it lasts 1.6 s), so it always arrives on the impact.
Samples: audio/samples/<type>.wav replaces a voice — use only sounds whose license allows your use.`;

async function cli() {
  const { flags } = parseArgs(process.argv.slice(2), SPEC);
  const title = 'node tools/sfx.mjs [--cues audio/cues.json] [--format f] [--out audio/sfx.wav] [--dur S] [--seed N] [--samples DIR] [--dump-cues] [--list]';
  if (flags.help) { process.stdout.write(usage(title, SPEC, EXTRA)); return 0; }
  if (flags.list) {
    const rows = Object.entries(VOICES).map(([name, v]) => {
      const { data, anchor } = synthVoice(name);
      const n = (Array.isArray(data) ? data[0] : data).length;
      return { name, seconds: +(n / SR).toFixed(3), anchor: +anchor.toFixed(4), level: v.level, desc: v.desc };
    });
    if (flags.json) process.stdout.write(JSON.stringify({ voices: rows }) + '\n');
    else process.stdout.write(rows.map((r) => `${r.name.padEnd(7)} ${String(r.seconds).padStart(5)} s  anchor ${String(r.anchor).padEnd(6)} ${r.desc}`).join('\n') + '\n');
    return 0;
  }
  const root = projectRoot();
  const cfg = loadConfig(root);
  const format = flags.format ?? cfg.primaryFormat;
  if (!cfg.formats.includes(format) && !flags.cues) throw new UsageError(`--format ${format} is not in studio.json formats (${cfg.formats.join(', ')})`);
  const cuesPath = path.join(root, 'audio', 'cues.json');
  let src;
  if (flags.cues) {
    if (flags['dump-cues']) throw new UsageError('--dump-cues reads the film; do not combine it with --cues');
    src = { ...readCuesFile(path.resolve(root, flags.cues)), loop: cfg.loop, from: path.relative(root, path.resolve(root, flags.cues)).replace(/\\/g, '/') };
  } else {
    log(`sfx: reading cues from the film (${format})…`);
    src = { ...(await cuesFromFilm(root, cfg, format)), from: 'film' };
    writeJSON(cuesPath, src.cues);
    log(`sfx: ${src.cues.length} cue(s) → audio/cues.json`);
    if (flags['dump-cues']) {
      if (flags.json) process.stdout.write(JSON.stringify({ cues: src.cues.length, file: 'audio/cues.json', duration: src.duration }) + '\n');
      return 0;
    }
  }
  const duration = flags.dur ?? src.duration ?? cfg.duration;
  if (!(duration > 0)) throw new UsageError(`--dur must be > 0 (got ${duration})`);
  const samples = await loadSamples(root, flags.samples);
  for (const [type, s] of Object.entries(samples)) log(`sfx: sample override ${type} ← ${path.relative(root, s.file).replace(/\\/g, '/')}`);
  const { channels, placed, warnings } = renderSfx(src.cues, { duration, seed: flags.seed, samples, loop: src.loop === true });
  for (const w of warnings) log(`sfx: warning: ${w}`);
  if (!placed.length) log('sfx: no cues — writing silence of the film length');
  const outRel = flags.out ?? (cfg.audio.sfx && cfg.audio.sfx !== 'none' ? cfg.audio.sfx : 'audio/sfx.wav');
  if (!flags.out && (!cfg.audio.sfx || cfg.audio.sfx === 'none')) log('sfx: note: studio.json audio.sfx is none, so mix.mjs will ignore this file');
  const out = path.resolve(root, outRel);
  writeWav(out, channels, SR, { bits: 16 });
  const byType = {};
  for (const p of placed) byType[p.type] = (byType[p.type] ?? 0) + 1;
  const pk = peakDb(channels, { truePeak: true });
  log(`sfx: ${placed.length} cue(s) ${JSON.stringify(byType)} · ${duration.toFixed(3)} s · peak ${Number.isFinite(pk) ? pk.toFixed(1) : '-inf'} dBTP → ${path.relative(root, out).replace(/\\/g, '/')}`);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ out: path.relative(root, out).replace(/\\/g, '/'), duration, samples: channels[0].length, cues: placed.length, byType,
      from: src.from, overrides: Object.keys(samples), truePeakDb: Number.isFinite(pk) ? +pk.toFixed(2) : null, warnings }) + '\n');
  }
  return 0;
}

const isMain = () => {
  try {
    const a = fs.realpathSync.native(process.argv[1] ?? '');
    const b = fs.realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
};
if (isMain()) main(cli);
