// tools/audio.mjs — shared DSP for score / sfx / mix / voice / beats: WAV I/O, ffmpeg decode, buffers, filters,
// dynamics, loudness (ITU-R BS.1770-4), reverb and seeded noise. Deterministic by construction: no clocks, no
// Math.random, fixed iteration order, so the same arguments always produce the same bytes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg, writeFileAtomic } from './studio.mjs';
import { mulberry32, hash32 } from '../lib/rng.js';

export const SR = 48000;
const TAU = 2 * Math.PI;

// ---------------------------------------------------------------------------------------------------------------
// WAV I/O (explicit little-endian; 16/24-bit PCM or 32-bit float, any channel count)

export function encodeWav(channels, sr = SR, { bits = 16 } = {}) {
  if (!Array.isArray(channels) || !channels.length) throw new Error('encodeWav: channels must be a non-empty array of Float32Array');
  if (![16, 24, 32].includes(bits)) throw new Error(`encodeWav: bits must be 16, 24 or 32 (float), got ${bits}`);
  const nch = channels.length;
  const n = channels[0].length;
  for (const c of channels) if (c.length !== n) throw new Error('encodeWav: channels differ in length');
  const bps = bits / 8;
  const block = nch * bps;
  const data = n * block;
  if (44 + data > 0xffffffff) throw new Error('encodeWav: WAV would exceed 4 GiB');
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(bits === 32 ? 3 : 1, 20);
  buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * block, 28);
  buf.writeUInt16LE(block, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      let v = channels[c][i];
      if (!Number.isFinite(v)) v = 0;
      if (bits === 32) { dv.setFloat32(o, v, true); o += 4; continue; }
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      if (bits === 16) { dv.setInt16(o, Math.round(v * 32767), true); o += 2; } else {
        const s = Math.round(v * 8388607);
        dv.setUint8(o, s & 255); dv.setUint8(o + 1, (s >> 8) & 255); dv.setUint8(o + 2, (s >> 16) & 255);
        o += 3;
      }
    }
  }
  return buf;
}

export function writeWav(p, channels, sr = SR, { bits = 16 } = {}) {
  writeFileAtomic(p, encodeWav(channels, sr, { bits }));
  return p;
}

export function decodeWav(buf, name = 'wav') {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${name}: not a RIFF/WAVE file`);
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const body = o + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = { tag: buf.readUInt16LE(body), nch: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4), block: buf.readUInt16LE(body + 12), bits: buf.readUInt16LE(body + 14) };
      if (fmt.tag === 0xfffe && size >= 26 && body + 26 <= buf.length) fmt.tag = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE sub-format
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, buf.length - body); // piped WAVs carry a placeholder size
      if (fmt) break;
    }
    o = body + size + (size & 1);
  }
  if (!fmt) throw new Error(`${name}: no fmt chunk`);
  if (dataOff < 0) throw new Error(`${name}: no data chunk`);
  const { tag, nch, sr, bits } = fmt;
  const bps = bits / 8;
  const ok = (tag === 1 && [8, 16, 24, 32].includes(bits)) || (tag === 3 && (bits === 32 || bits === 64));
  if (!ok || nch < 1) throw new Error(`${name}: unsupported WAV encoding (format ${tag}, ${bits}-bit, ${nch} ch) — convert it with ffmpeg`);
  const block = nch * bps;
  const n = Math.floor(dataLen / block);
  const channels = Array.from({ length: nch }, () => new Float32Array(n));
  const dv = new DataView(buf.buffer, buf.byteOffset + dataOff, n * block);
  for (let i = 0, o = 0; i < n; i++) {
    for (let c = 0; c < nch; c++, o += bps) {
      let v;
      if (tag === 3) v = bits === 32 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 24) v = (((dv.getUint8(o + 2) << 24) | (dv.getUint8(o + 1) << 16) | (dv.getUint8(o) << 8)) >> 8) / 8388608;
      else if (bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else v = (dv.getUint8(o) - 128) / 128;
      channels[c][i] = v;
    }
  }
  return { sr, channels };
}

export const readWav = (p) => decodeWav(fs.readFileSync(p), p);

/** Channel count adapter: mono ↔ stereo (duplicate / average at unity), extra channels dropped. decodeAudio does not use it (see there). */
export function remix(chs, n) {
  if (chs.length === n) return chs;
  if (n === 1) {
    const out = new Float32Array(chs[0].length);
    for (const c of chs) for (let i = 0; i < out.length; i++) out[i] += c[i] / chs.length;
    return [out];
  }
  return Array.from({ length: n }, (_, k) => Float32Array.from(chs[Math.min(k, chs.length - 1)]));
}

/**
 * Any audio (wav/mp3/m4a/…) → float channels at `sr` via ffmpeg. A WAV that is already at `sr` with the wanted channel
 * count skips ffmpeg. Every channel adaptation (mono → stereo at −3 dB per side, surround downmix) is ffmpeg's `-ac`, so
 * the level of a file never depends on its container or sample rate; remix() duplicates at unity and would make a
 * 48 kHz mono WAV 3 dB louder than the same sound at 44.1 kHz or as mp3.
 */
export async function decodeAudio(root, file, { sr = SR, channels = 2 } = {}) {
  const abs = path.resolve(root ?? process.cwd(), file);
  if (!fs.existsSync(abs)) throw new Error(`audio file not found: ${abs}`);
  if (/\.wav$/i.test(abs)) {
    try { const w = readWav(abs); if (w.sr === sr && w.channels.length === channels) return { sr, channels: w.channels }; } catch { /* unusual WAV flavour: let ffmpeg read it */ }
  }
  const bin = resolveFfmpeg(root ?? process.cwd());
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-i', abs, '-vn', '-map', '0:a:0', '-ac', String(channels), '-ar', String(sr),
    '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'];
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let err = '';
    const ff = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.setEncoding('utf8');
    ff.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    ff.once('error', (e) => reject(new Error(`cannot start ffmpeg (${bin}): ${e.message}`)));
    ff.once('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg could not decode ${abs}:\n${err.trim().split('\n').slice(-8).join('\n')}`))));
  });
  const n = Math.floor(raw.length / 4 / channels);
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  const le = os.endianness() === 'LE';
  const all = le ? new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * channels * 4)) : null;
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[c][i] = le ? all[i * channels + c] : raw.readFloatLE((i * channels + c) * 4);
  return { sr, channels: out };
}

// ---------------------------------------------------------------------------------------------------------------
// Buffers, gain, placement

export const makeBuffer = (seconds, nch = 2, sr = SR) => Array.from({ length: nch }, () => new Float32Array(Math.max(0, Math.round(seconds * sr))));
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

export function peak(chs) {
  let m = 0;
  for (const c of [].concat(chs)) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > m) m = a; }
  return m;
}

export function rms(chs) {
  let s = 0;
  let n = 0;
  for (const c of [].concat(chs)) { for (let i = 0; i < c.length; i++) s += c[i] * c[i]; n += c.length; }
  return n ? Math.sqrt(s / n) : 0;
}

/**
 * Mix src (mono Float32Array or [L,R]) into dst channels at startSec. Mono sources use the equal-power pan law
 * (−3 dB per side at centre); stereo sources use a balance control (unity at centre). wrap=true folds samples past
 * the end back to the start (seamless loops).
 */
export function addAt(dst, src, startSec, { gain = 1, pan = 0, sr = SR, wrap = false } = {}) {
  const srcs = Array.isArray(src) ? src : [src];
  const n = dst[0].length;
  if (!n || !(gain !== 0)) return dst;
  const p = Math.max(-1, Math.min(1, Number(pan) || 0));
  let gl;
  let gr;
  if (srcs.length === 1) { const th = (p + 1) * Math.PI / 4; gl = Math.cos(th); gr = Math.sin(th); } else { gl = Math.min(1, 1 - p); gr = Math.min(1, 1 + p); }
  const start = Math.round(startSec * sr);
  for (let c = 0; c < dst.length; c++) {
    const s = srcs.length === 1 ? srcs[0] : srcs[Math.min(c, srcs.length - 1)];
    const g = gain * (dst.length === 1 ? 1 : c === 0 ? gl : c === 1 ? gr : 1);
    const d = dst[c];
    if (wrap) {
      for (let i = 0; i < s.length; i++) d[(((start + i) % n) + n) % n] += g * s[i];
      continue;
    }
    const i0 = Math.max(0, -start);
    const i1 = Math.min(s.length, n - start);
    for (let i = i0; i < i1; i++) d[start + i] += g * s[i];
  }
  return dst;
}

/** New channels of exactly round(seconds·sr) samples (copy, truncate or zero-pad). */
export function trimOrPad(chs, seconds, sr = SR) {
  const n = Math.max(0, Math.round(seconds * sr));
  return chs.map((c) => { const out = new Float32Array(n); out.set(c.length > n ? c.subarray(0, n) : c); return out; });
}

/** Fold everything past `n` samples back onto the start (loop tails), returning channels of length n. */
export function foldLoop(chs, n) {
  return chs.map((c) => {
    const out = new Float32Array(n);
    for (let i = 0; i < c.length; i++) out[i % n] += c[i];
    return out;
  });
}

/** In-place raised-cosine fades; guarantees the first/last sample is exactly 0 when a fade is requested. */
export function fade(chs, { inSec = 0, outSec = 0, sr = SR } = {}) {
  for (const c of chs) {
    const n = c.length;
    const fi = Math.min(n, Math.round(inSec * sr));
    const fo = Math.min(n, Math.round(outSec * sr));
    for (let i = 0; i < fi; i++) c[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fi);
    for (let i = 0; i < fo; i++) c[n - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fo);
  }
  return chs;
}

// ---------------------------------------------------------------------------------------------------------------
// Filters

export function biquadCoefs({ type, f, q = 0.707, gainDb = 0 }, sr = SR) {
  const w0 = TAU * Math.min(Math.max(Number(f) || 1, 1), sr * 0.4999) / sr;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(q, 1e-4));
  const A = Math.pow(10, gainDb / 40);
  const s = 2 * Math.sqrt(A) * alpha;
  let b0; let b1; let b2; let a0; let a1; let a2;
  switch (type) {
    case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break; // 0 dB peak
    case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf':
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
    case 'highshelf':
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
    default: throw new Error(`biquad: unknown type "${type}" (lowpass, highpass, bandpass, notch, peaking, lowshelf, highshelf)`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** RBJ-cookbook biquad (transposed direct form II, double-precision state) → new Float32Array. */
export function biquad(x, opts, sr = SR) {
  return applyBiquad(x, biquadCoefs(opts, sr));
}

function applyBiquad(x, { b0, b1, b2, a1, a2 }) {
  const y = new Float32Array(x.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + z1;
    z1 = b1 * xi - a1 * yi + z2;
    z2 = b2 * xi - a2 * yi;
    y[i] = yi;
  }
  return y;
}

/**
 * Zero-delay-feedback state-variable filter (Simper/Zavalishin) with a per-sample cutoff: `f` is Hz, a
 * Float32Array of Hz, or (i) => Hz. Stable under fast sweeps, which is why synth voices use it instead of biquad().
 */
export function svf(x, { type = 'lowpass', f, q = 0.707 } = {}, sr = SR) {
  const y = new Float32Array(x.length);
  const k = 1 / Math.max(q, 1e-3);
  const fAt = typeof f === 'function' ? f : ArrayBuffer.isView(f) ? (i) => f[Math.min(i, f.length - 1)] : () => f;
  const nyq = sr * 0.49;
  let ic1 = 0;
  let ic2 = 0;
  let g = 0; let a1 = 0; let a2 = 0; let a3 = 0; let lastF = NaN;
  for (let i = 0; i < x.length; i++) {
    const fc = Math.min(nyq, Math.max(5, fAt(i)));
    if (fc !== lastF) { g = Math.tan(Math.PI * fc / sr); a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2; lastF = fc; }
    const v3 = x[i] - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    y[i] = type === 'lowpass' ? v2 : type === 'bandpass' ? v1 * k : type === 'highpass' ? x[i] - k * v1 - v2 : x[i] - k * v1; // notch
  }
  return y;
}

export function onePoleLP(x, f, sr = SR) {
  const a = Math.exp(-TAU * f / sr);
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) { s = (1 - a) * x[i] + a * s; y[i] = s; }
  return y;
}

export function onePoleHP(x, f, sr = SR) {
  const lp = onePoleLP(x, f, sr);
  for (let i = 0; i < lp.length; i++) lp[i] = x[i] - lp[i];
  return lp;
}

/** Cubic-Hermite resampler: ratio > 1 plays faster (higher pitch, shorter), used for sample pitch. */
export function resample(x, ratio) {
  if (!(ratio > 0) || ratio === 1) return Float32Array.from(x);
  const n = Math.max(1, Math.floor((x.length - 1) / ratio) + 1);
  const y = new Float32Array(n);
  const at = (i) => (i < 0 ? x[0] : i >= x.length ? x[x.length - 1] : x[i]);
  for (let j = 0; j < n; j++) {
    const p = j * ratio;
    const i = Math.floor(p);
    const t = p - i;
    const xm = at(i - 1); const x0 = at(i); const x1 = at(i + 1); const x2 = at(i + 2);
    const c1 = 0.5 * (x1 - xm);
    const c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    y[j] = ((c3 * t + c2) * t + c1) * t + x0;
  }
  return y;
}

// ---------------------------------------------------------------------------------------------------------------
// Dynamics and metering

// 4x oversampling taps (Hann-windowed sinc, 16 taps per phase) for inter-sample ("true") peak detection.
const TP_PHASES = [0.25, 0.5, 0.75].map((ph) => {
  const taps = [];
  for (let k = -7; k <= 8; k++) {
    const u = ph - k;
    const sinc = Math.abs(u) < 1e-12 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    taps.push(sinc * (0.5 + 0.5 * Math.cos(Math.PI * u / 8.5)));
  }
  const sum = taps.reduce((a, b) => a + b, 0);
  return taps.map((t) => t / sum);
});

const TP_L1 = Math.max(...TP_PHASES.map((t) => t.reduce((a, b) => a + Math.abs(b), 0)));

// |x| with inter-sample peaks folded in. An interpolated value can never exceed (window max)·L1, so windows that
// cannot beat `floor` are skipped — that keeps true-peak work proportional to the loud passages only.
function interPeaks(c, floor = 0) {
  const n = c.length;
  const out = new Float32Array(n);
  const win = new Float32Array(n); // max |c| over [i-7, i+8]
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n + 8; j++) {
    if (j < n) { const a = Math.abs(c[j]); while (tail > head && Math.abs(c[dq[tail - 1]]) <= a) tail--; dq[tail++] = j; }
    const i = j - 8;
    if (i >= 0) { while (dq[head] < i - 7) head++; win[i] = Math.abs(c[dq[head]]); }
  }
  for (let i = 0; i < n; i++) {
    let m = Math.abs(c[i]);
    out[i] = m;
    if (win[i] * TP_L1 <= floor || win[i] === 0) continue;
    for (const taps of TP_PHASES) {
      let acc = 0;
      if (i >= 7 && i + 8 < n) for (let k = 0; k < 16; k++) acc += c[i - 7 + k] * taps[k];
      else for (let k = 0; k < 16; k++) { const j = i - 7 + k; if (j >= 0 && j < n) acc += c[j] * taps[k]; }
      const a = Math.abs(acc);
      if (a > m) m = a;
    }
    out[i] = m;
  }
  return out;
}

/** Peak level in dBFS; truePeak=true estimates inter-sample peaks at 4x oversampling (≈ dBTP). */
export function peakDb(chs, { truePeak = false } = {}) {
  let m = peak(chs);
  if (truePeak) for (const c of chs) { const p = peak([interPeaks(c, m)]); if (p > m) m = p; }
  return gainToDb(m);
}

/**
 * Offline look-ahead peak limiter, stereo-linked, in place (returns chs). Gain = release-smoothed moving average of
 * the look-ahead minimum of the required gain, so the ceiling holds on every sample without a delay line.
 * truePeak=true limits 4x-interpolated peaks as well.
 */
export function limiter(chs, { ceilingDb = -1, releaseMs = 60, lookaheadMs = 5, sr = SR, truePeak = false } = {}) {
  const n = chs[0]?.length ?? 0;
  if (!n) return chs;
  const ceil = dbToGain(ceilingDb);
  const L = Math.max(1, Math.round(lookaheadMs * sr / 1000));
  const need = new Float32Array(n).fill(1);
  for (const c of chs) {
    const det = truePeak ? interPeaks(c, ceil) : c;
    for (let i = 0; i < n; i++) { const a = Math.abs(det[i]); if (a > ceil) { const g = ceil / a; if (g < need[i]) need[i] = g; } }
  }
  // look-ahead minimum over [i, i+L] (monotonic deque)
  const hold = new Float32Array(n);
  const dq = new Int32Array(n + L + 1);
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n + L; j++) {
    if (j < n) { while (tail > head && need[dq[tail - 1]] >= need[j]) tail--; dq[tail++] = j; }
    const i = j - L;
    if (i >= 0) { while (dq[head] < i) head++; hold[i] = need[dq[head]]; }
  }
  // moving average over [i-L, i] keeps gain(i) ≤ need(peak) because every held value in the window covers the peak
  const release = Math.exp(-1 / Math.max(1, releaseMs * sr / 1000));
  let sum = hold[0] * (L + 1);
  let env = 1;
  const gains = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i > 0) sum += hold[i] - (i - L - 1 >= 0 ? hold[i - L - 1] : hold[0]);
    const target = Math.min(1, sum / (L + 1));
    env = target < env ? target : target + (env - target) * release;
    gains[i] = env;
  }
  for (const c of chs) for (let i = 0; i < n; i++) { const v = c[i] * gains[i]; c[i] = v > ceil ? ceil : v < -ceil ? -ceil : v; }
  return chs;
}

/** Feed-forward peak compressor, stereo-linked, smoothing in the gain domain; in place. */
export function compressor(chs, { thresholdDb = -18, ratio = 2, attackMs = 10, releaseMs = 120, kneeDb = 6, makeupDb = 0, sr = SR } = {}) {
  const n = chs[0]?.length ?? 0;
  const aA = Math.exp(-1 / Math.max(1, attackMs * sr / 1000));
  const aR = Math.exp(-1 / Math.max(1, releaseMs * sr / 1000));
  const slope = 1 / ratio - 1;
  let gs = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const c of chs) { const a = Math.abs(c[i]); if (a > m) m = a; }
    const x = m > 1e-9 ? 20 * Math.log10(m) : -180;
    const over = x - thresholdDb;
    let gc = 0;
    if (2 * over > kneeDb) gc = slope * over;
    else if (2 * Math.abs(over) <= kneeDb && kneeDb > 0) gc = slope * (over + kneeDb / 2) ** 2 / (2 * kneeDb);
    gs = gc < gs ? aA * gs + (1 - aA) * gc : aR * gs + (1 - aR) * gc;
    const g = Math.pow(10, (gs + makeupDb) / 20);
    for (const c of chs) c[i] *= g;
  }
  return chs;
}

/** tanh saturation with unity small-signal gain (output bounded by ±1/drive); in place. */
export function softClip(chs, drive = 1) {
  const d = Math.max(1e-3, drive);
  for (const c of [].concat(chs)) for (let i = 0; i < c.length; i++) c[i] = Math.tanh(d * c[i]) / d;
  return chs;
}

/** Integrated loudness (ITU-R BS.1770-4: K-weighting, 400 ms blocks at 75 % overlap, −70 LUFS / −10 LU gates). */
export function lufs(chs, sr = SR) {
  const block = Math.round(0.4 * sr);
  const step = Math.round(0.1 * sr);
  const n = chs[0]?.length ?? 0;
  if (n < block) return -Infinity;
  // K-weighting in the bilinear form used by BS.1770 meters (libebur128): reproduces the ITU 48 kHz coefficients
  // exactly at any rate (the RBJ shelf is ~0.25 dB off at 1 kHz).
  let K = Math.tan(Math.PI * 1681.974450955533 / sr);
  let Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  K = Math.tan(Math.PI * 38.13547087602444 / sr);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const rlb = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  const cums = chs.map((c) => {
    const y = applyBiquad(applyBiquad(c, shelf), rlb);
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + y[i] * y[i];
    return cum;
  });
  const energies = [];
  for (let s = 0; s + block <= n; s += step) { let e = 0; for (const cum of cums) e += (cum[s + block] - cum[s]) / block; energies.push(e); }
  const lk = (e) => -0.691 + 10 * Math.log10(e);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const abs = energies.filter((e) => e > 0 && lk(e) > -70);
  if (!abs.length) return -Infinity;
  const rel = lk(mean(abs)) - 10;
  const gated = abs.filter((e) => lk(e) > rel);
  return lk(mean(gated.length ? gated : abs));
}

/** Time (s) of the loudest point of a 2 ms-smoothed |x| envelope — where a listener hears a sample "hit". */
export function peakTime(chs, sr = SR) {
  const list = [].concat(chs);
  const n = list[0]?.length ?? 0;
  const a = Math.exp(-1 / (0.002 * sr));
  let e = 0; let best = 0; let at = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const c of list) { const v = Math.abs(c[i]); if (v > m) m = v; }
    e = m > e ? m : a * e + (1 - a) * m;
    if (e > best) { best = e; at = i; }
  }
  return at / sr;
}

// ---------------------------------------------------------------------------------------------------------------
// Space: FDN reverb and ping-pong delay (wet signals only; callers set the send level)

const allpass = (len) => ({ buf: new Float64Array(len), p: 0 });
function allpassStep(ap, x, g) {
  const vd = ap.buf[ap.p];
  const v = x + g * vd;
  ap.buf[ap.p] = v;
  ap.p = ap.p + 1 === ap.buf.length ? 0 : ap.p + 1;
  return vd - g * v;
}

/** 8-line feedback delay network with Hadamard mixing and per-line damping → [wetL, wetR] (same length as input). */
export function reverb(input, { decay = 1.8, damp = 7000, predelay = 0.02, size = 1, diffusion = 0.62, sr = SR } = {}) {
  const inL = input[0];
  const inR = input[1] ?? input[0];
  const n = inL.length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const scale = size * sr / 48000;
  const len = [1931, 2213, 2437, 2663, 2909, 3121, 3343, 3571].map((d) => Math.max(8, Math.round(d * scale)));
  const lines = len.map((d) => new Float64Array(d));
  const pos = new Int32Array(8);
  const fb = len.map((d) => Math.pow(10, -3 * d / (sr * Math.max(0.05, decay))));
  const aD = Math.exp(-TAU * damp / sr);
  const lp = new Float64Array(8);
  const o = new Float64Array(8);
  const apL = [142, 379, 107, 277].map((d) => allpass(Math.max(2, Math.round(d * scale))));
  const apR = [151, 389, 113, 263].map((d) => allpass(Math.max(2, Math.round(d * scale))));
  const pd = Math.max(0, Math.round(predelay * sr));
  const norm = 1 / Math.sqrt(8);
  for (let i = 0; i < n; i++) {
    let xl = i >= pd ? inL[i - pd] : 0;
    let xr = i >= pd ? inR[i - pd] : 0;
    for (const ap of apL) xl = allpassStep(ap, xl, diffusion);
    for (const ap of apR) xr = allpassStep(ap, xr, diffusion);
    for (let k = 0; k < 8; k++) { lp[k] = (1 - aD) * lines[k][pos[k]] + aD * lp[k]; o[k] = lp[k] * fb[k]; }
    outL[i] = 0.35 * (o[0] - o[2] + o[4] - o[6] + 0.5 * (o[1] + o[5]));
    outR[i] = 0.35 * (o[1] - o[3] + o[5] - o[7] + 0.5 * (o[2] + o[6]));
    // fast Walsh-Hadamard transform (orthonormal: energy-preserving, so fb alone sets the decay time)
    for (let h = 1; h < 8; h <<= 1) {
      for (let a = 0; a < 8; a += h << 1) {
        for (let b = a; b < a + h; b++) { const u = o[b]; const v = o[b + h]; o[b] = u + v; o[b + h] = u - v; }
      }
    }
    for (let k = 0; k < 8; k++) {
      lines[k][pos[k]] = o[k] * norm + (k & 1 ? xr : xl) * 0.5;
      pos[k] = pos[k] + 1 === len[k] ? 0 : pos[k] + 1;
    }
  }
  return [outL, outR];
}

/** Cross-feedback stereo delay: echoes alternate L → R → L … with a lowpass in the loop. Returns [wetL, wetR]. */
export function pingPong(input, { time = 0.375, feedback = 0.35, damp = 4500, sr = SR } = {}) {
  const inL = input[0];
  const inR = input[1] ?? input[0];
  const n = inL.length;
  const d = Math.max(1, Math.round(time * sr));
  const bl = new Float64Array(d);
  const br = new Float64Array(d);
  const a = Math.exp(-TAU * damp / sr);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  let p = 0; let fl = 0; let fr = 0;
  for (let i = 0; i < n; i++) {
    const yl = bl[p];
    const yr = br[p];
    fl = (1 - a) * yl + a * fl;
    fr = (1 - a) * yr + a * fr;
    bl[p] = 0.5 * (inL[i] + inR[i]) + feedback * fr;
    br[p] = feedback * fl;
    outL[i] = yl;
    outR[i] = yr;
    p = p + 1 === d ? 0 : p + 1;
  }
  return [outL, outR];
}

// ---------------------------------------------------------------------------------------------------------------
// Sources and small math

/** Seeded white noise in [-1, 1]; seed = number or any parts (hashed with FNV-1a). */
export function noiseGen(...seed) {
  const r = mulberry32(seed.length === 1 && Number.isInteger(seed[0]) ? seed[0] >>> 0 : hash32(...seed));
  return () => r() * 2 - 1;
}

/** ADSR level at t seconds after note-on; `dur` = gate length (release starts there). Curves are click-free. */
export function adsr(t, { a = 0.005, d = 0.1, s = 0.7, r = 0.2, dur = Infinity } = {}) {
  if (!(t >= 0)) return 0;
  const ads = (x) => {
    if (x < a) return Math.sin(0.5 * Math.PI * x / a) ** 2;
    if (d <= 0) return s;
    return s + (1 - s) * Math.exp(-5 * (x - a) / d);
  };
  if (t < dur) return ads(t);
  if (r <= 0 || t >= dur + r) return 0;
  const k = 5;
  const x = (t - dur) / r;
  return ads(dur) * (Math.exp(-k * x) - Math.exp(-k)) / (1 - Math.exp(-k));
}

export const mtof = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
