// tools/instruments.mjs — the synthesized instrument voices that score.mjs arranges (a library; no CLI).
// Every voice is a pure function of its arguments and the seeded noise/rng it is handed (same inputs → same samples).
// Tails fade to exactly 0; attacks ramp from silence, except the noise crack that opens boom() and impact().
// Returns a mono Float32Array, or [L, R] for clap() and impact(); pump() works in place.
import { SR, biquad, svf, onePoleLP, onePoleHP, mtof } from './audio.mjs';
import { normalizeTo } from './sfx.mjs';

const TAU = 2 * Math.PI;
export const N = (sec) => Math.max(1, Math.round(sec * SR));
const att = (t, a) => (t <= 0 ? 0 : t >= a ? 1 : Math.sin(0.5 * Math.PI * t / a) ** 2);
const relCurve = (u) => (u <= 0 ? 1 : u >= 1 ? 0 : (Math.exp(-5 * u) - Math.exp(-5)) / (1 - Math.exp(-5)));
const noiseBuf = (n, noise) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = noise(); return x; };
export const fadeEnd = (x, sec) => {
  for (const c of Array.isArray(x) ? x : [x]) { const m = Math.min(c.length, N(sec)); for (let i = 0; i < m; i++) c[c.length - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / m); }
  return x;
};
const norm = (x) => normalizeTo(x, 0);

// PolyBLEP sawtooth: band-limited enough that 3 detuned voices stay free of audible aliasing in the mid register.
function blepSaw(ph, dt) {
  let v = 2 * ph - 1;
  if (ph < dt) { const t = ph / dt; v -= t + t - t * t - 1; } else if (ph > 1 - dt) { const t = (ph - 1) / dt; v -= t * t + t + t + 1; }
  return v;
}

export function kick({ f0 = 48, f1 = 150, tauP = 0.04, decay = 0.3, len = 0.55, drive = 1.6, click = 0.12, noise }) {
  const n = N(len);
  const x = new Float32Array(n);
  const td = Math.tanh(drive);
  const cl = click > 0 ? onePoleLP(noiseBuf(N(0.015), noise), 3500, SR) : null;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = Math.sin(ph) * att(t, 0.0015) * Math.exp(-t / decay);
    if (cl && i < cl.length) v += click * cl[i] * att(t, 0.0003) * Math.exp(-t / 0.0035);
    x[i] = Math.tanh(drive * v) / td;
    ph += TAU * (f0 + (f1 - f0) * Math.exp(-t / tauP)) / SR;
  }
  return norm(fadeEnd(x, 0.02));
}

export function clap(nl, nr) {
  const n = N(0.42);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 0; k < 3; k++) { const u = t - k * 0.0105; if (u > 0) v += att(u, 0.0004) * Math.exp(-u / 0.0055); }
    const u = t - 0.031;
    if (u > 0) v += 0.55 * att(u, 0.001) * Math.exp(-u / 0.11);
    e[i] = v;
  }
  const out = [nl, nr].map((nz) => {
    const x = noiseBuf(n, nz);
    for (let i = 0; i < n; i++) x[i] *= e[i];
    return biquad(biquad(x, { type: 'bandpass', f: 1150, q: 0.9 }), { type: 'highpass', f: 450 });
  });
  return norm(fadeEnd(out, 0.03));
}

const HAT_F = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0]; // inharmonic square cluster (the classic analog hat recipe)
export function hat({ open = false, tone = 1, noise }) {
  const n = N(open ? 0.5 : 0.09);
  const decay = open ? 0.12 : 0.02;
  const x = new Float32Array(n);
  const ph = new Float64Array(6);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = 0; k < 6; k++) { ph[k] += HAT_F[k] * tone / SR; if (ph[k] >= 1) ph[k] -= 1; m += ph[k] < 0.5 ? 1 : -1; }
    const t = i / SR;
    x[i] = (0.12 * m + 0.35 * noise()) * att(t, 0.0004) * Math.exp(-t / decay);
  }
  const hp = { type: 'highpass', f: 7000, q: 0.7 };
  return norm(fadeEnd(biquad(biquad(biquad(x, hp), hp), { type: 'peaking', f: 10500, q: 1, gainDb: 3 }), 0.01));
}

export function shaker(noise) {
  const n = N(0.12);
  const x = noiseBuf(n, noise);
  for (let i = 0; i < n; i++) { const t = i / SR; x[i] *= att(t, 0.006) * Math.exp(-t / 0.035); }
  return norm(fadeEnd(biquad(biquad(x, { type: 'bandpass', f: 6500, q: 0.9 }), { type: 'highpass', f: 3000 }), 0.01));
}

// Circular-membrane modes (Bessel ratios) with tension pitch-drop: a big struck drum, not a sine thump.
const MODES = [[1, 1, 0.55], [1.59, 0.55, 0.22], [2.14, 0.38, 0.16], [2.3, 0.3, 0.14], [2.65, 0.22, 0.11], [2.92, 0.18, 0.09], [3.16, 0.12, 0.08]];
export function taiko({ f = 64, size = 1, noise }) {
  const n = N(1.1 * size + 0.2);
  const x = new Float32Array(n);
  for (const [r, a, tau] of MODES) {
    const tt = tau * size;
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      if (t > 9 * tt) break;
      x[i] += a * Math.sin(ph) * Math.exp(-t / tt);
      ph += TAU * f * r * (1 + 0.32 * Math.exp(-t / 0.02)) / SR;
    }
  }
  const stick = biquad(noiseBuf(N(0.05), noise), { type: 'bandpass', f: 1700, q: 0.8 });
  for (let i = 0; i < stick.length; i++) { const t = i / SR; x[i] += 0.5 * stick[i] * att(t, 0.0003) * Math.exp(-t / 0.006); }
  for (let i = 0; i < n; i++) x[i] = Math.tanh(1.5 * x[i] * att(i / SR, 0.0008));
  return norm(fadeEnd(x, 0.05));
}

export function boom(noise) {
  const n = N(2.4);
  const x = new Float32Array(n);
  const low = norm(onePoleLP(onePoleLP(noiseBuf(n, noise), 280, SR), 280, SR));
  const crack = onePoleHP(noiseBuf(N(0.05), noise), 2500, SR);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = Math.sin(ph) * att(t, 0.002) * Math.exp(-t / 0.85) + 0.45 * low[i] * att(t, 0.003) * Math.exp(-t / 0.3);
    if (i < crack.length) v += 0.12 * crack[i] * Math.exp(-t / 0.008);
    x[i] = Math.tanh(1.6 * v);
    ph += TAU * (36 + 64 * Math.exp(-t / 0.07)) / SR;
  }
  return norm(fadeEnd(x, 0.2));
}

export function impact(nl, nr) {
  const n = N(2);
  const out = [nl, nr].map((nz) => svf(noiseBuf(n, nz), { type: 'lowpass', f: (i) => 250 + 7500 * Math.exp(-i / SR / 0.25), q: 0.7 }));
  const crack = onePoleHP(noiseBuf(N(0.06), nl), 3000, SR);
  for (const c of out) for (let i = 0; i < n; i++) { const t = i / SR; c[i] = c[i] * att(t, 0.001) * Math.exp(-t / 0.55) + (i < crack.length ? 0.5 * crack[i] * Math.exp(-t / 0.01) : 0); }
  return norm(fadeEnd(out, 0.1));
}

// Pluck: two detuned saws + sub sine through a resonant lowpass whose cutoff snaps shut (the "pluck" is the filter).
export function pluckNote(f, dur, { bright = 1, rel = 0.26, ph0 = 0 } = {}) {
  const n = N(dur + rel);
  const x = new Float32Array(n);
  const fc = new Float32Array(n);
  const d1 = f * 0.997 / SR; const d2 = f * 1.003 / SR; const d3 = f / 2 / SR;
  const fMax = Math.min(15000, (900 + 6000 * bright) * Math.pow(f / 440, 0.35));
  const fMin = 220 + 700 * bright;
  let p1 = ph0; let p2 = (ph0 + 0.37) % 1; let p3 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const a = att(t, 0.0015) * Math.exp(-t / 0.2) * relCurve((t - dur) / rel);
    x[i] = a * (0.5 * blepSaw(p1, d1) + 0.5 * blepSaw(p2, d2) + 0.2 * Math.sin(TAU * p3));
    fc[i] = fMin + (fMax - fMin) * Math.exp(-t / 0.085);
    p1 += d1; if (p1 >= 1) p1 -= 1;
    p2 += d2; if (p2 >= 1) p2 -= 1;
    p3 += d3; if (p3 >= 1) p3 -= 1;
  }
  return fadeEnd(svf(x, { type: 'lowpass', f: fc, q: 1.1 }), 0.005);
}

// Felt piano: stretched (inharmonic) partials, two slightly detuned strings per low partial (beating), two-stage
// decay (prompt + aftersound), felt-muted highs that open with velocity, hammer noise, dampers at note-off.
export function pianoNote(midi, vel, hold, rnd, noise) {
  const f0 = mtof(midi);
  const B = 1.2e-4 * Math.pow(2, (midi - 60) / 20);
  const roll = 1200 + 2800 * vel;
  const tf = 0.5 * Math.pow(262 / f0, 0.45);
  const ts = 3.2 * Math.pow(262 / f0, 0.5);
  const len = Math.max(0.3, Math.min(hold + 0.6, ts * 2.5 + 0.1));
  const n = N(len);
  const x = new Float64Array(n);
  const off = Math.round(hold * SR);
  const rd = Math.exp(-1 / (0.11 * SR));
  const nP = Math.max(1, Math.min(14, Math.floor(7000 / f0)));
  for (let k = 1; k <= nP; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k);
    if (fk >= 0.45 * SR) break;
    const amp = Math.pow(k, -1.3) * Math.exp(-(fk - f0) / roll);
    const strings = k <= 6 ? 2 : 1;
    const tfk = tf / (1 + 0.3 * (k - 1));
    const tsk = ts / (1 + 0.4 * (k - 1));
    for (let s = 0; s < strings; s++) {
      const cents = strings === 2 ? (s ? 1 : -1) * (0.4 + 0.5 * rnd()) : 0;
      const w = TAU * fk * Math.pow(2, cents / 1200) / SR;
      const cw = Math.cos(w); const sw = Math.sin(w);
      let c = 1; let sn = 0;
      let e1 = 0.6 * amp / strings; let e2 = 0.4 * amp / strings;
      const r1 = Math.exp(-1 / (tfk * SR)); const r2 = Math.exp(-1 / (tsk * SR));
      const floor = amp * 3e-5;
      for (let i = 0; i < n; i++) {
        x[i] += sn * (e1 + e2);
        const nc = c * cw - sn * sw; sn = sn * cw + c * sw; c = nc;
        e1 *= r1; e2 *= r2;
        if (i >= off) { e1 *= rd; e2 *= rd; }
        if (e1 + e2 < floor) break;
      }
    }
  }
  const hn = Math.min(n, N(0.03));
  const hammer = onePoleLP(noiseBuf(hn, noise), 900 + 2200 * vel, SR);
  for (let i = 0; i < hn; i++) { const t = i / SR; x[i] += 0.05 * vel * hammer[i] * Math.exp(-t / 0.004) + 0.04 * Math.sin(TAU * 72 * t) * Math.exp(-t / 0.018); }
  const a = 0.0025 + 0.004 * (1 - vel);
  const lvl = 0.3 * Math.pow(vel, 1.5);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] * att(i / SR, a) * lvl;
  return fadeEnd(out, 0.01);
}

// Bowed ensemble voice: three detuned band-limited saws, delayed vibrato, bow noise, brightness following the bow.
export function bowNote(f, dur, { attack = 0.06, release = 0.2, bright = 0.6, vib = 0.004, rnd, noise }) {
  const n = N(dur + release);
  const x = new Float32Array(n);
  const fc = new Float32Array(n);
  const det = [-0.0045, 0, 0.004];
  const ph = det.map(() => rnd());
  const lfo = rnd() * TAU;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const a = att(t, attack) * relCurve((t - dur) / release);
    const depth = vib * Math.min(1, Math.max(0, (t - 0.15) / 0.3));
    const fm = f * (1 + depth * Math.sin(TAU * 5.1 * t + lfo));
    let v = 0;
    for (let k = 0; k < 3; k++) { const dt = fm * (1 + det[k]) / SR; v += blepSaw(ph[k], dt); ph[k] += dt; if (ph[k] >= 1) ph[k] -= 1; }
    x[i] = a * (v / 3 + 0.03 * noise());
    fc[i] = (500 + 2800 * bright) * (0.55 + 0.45 * a);
  }
  return fadeEnd(svf(x, { type: 'lowpass', f: fc, q: 0.6 }), 0.01);
}

// Mallet blip (marimba-like bar partials 1 : 3.93 : 9.2) for the minimal style.
export function blip(f, vel, noise) {
  const tau = 0.3 * Math.pow(440 / f, 0.35);
  const n = N(Math.min(1.2, tau * 5));
  const x = new Float32Array(n);
  for (const [r, a, tr] of [[1, 1, 1], [3.93, 0.28, 0.25], [9.2, 0.07, 0.1]]) {
    const w = TAU * f * r / SR;
    if (w >= 0.95 * Math.PI) continue;
    const cw = Math.cos(w); const sw = Math.sin(w); const rd = Math.exp(-1 / (SR * tau * tr));
    let c = 1; let s = 0; let e = a; // rotating phasor × multiplicative decay: no sin/exp per sample
    for (let i = 0; i < n && e > 1e-6; i++) { x[i] += s * e; const nc = c * cw - s * sw; s = s * cw + c * sw; c = nc; e *= rd; }
  }
  const mallet = onePoleLP(noiseBuf(Math.min(n, N(0.01)), noise), 3000, SR);
  for (let i = 0; i < mallet.length; i++) x[i] += 0.08 * mallet[i] * Math.exp(-i / SR / 0.0015);
  for (let i = 0; i < n; i++) x[i] *= att(i / SR, 0.0008) * vel;
  return fadeEnd(x, 0.02);
}

// One continuous oscillator for a monophonic line (sub bass, low strings): phase never resets, so note changes
// cannot click; legato keeps the previous note's envelope under the new attack.
export function monoLine(total, notes, { wave = 'sub', attack = 0.006, release = 0.06, glide = 0.003, legato = false, drive = 1.25, cutoff = 900 } = {}) {
  const x = new Float32Array(total);
  if (!notes.length) return x;
  const gA = Math.exp(-1 / (glide * SR));
  const aS = Math.exp(-1 / (0.002 * SR));
  const envOf = (nt, t) => (nt && t >= nt.t ? nt.vel * att(t - nt.t, attack) * relCurve((t - nt.t - nt.dur) / (nt.rel ?? release)) : 0);
  const hz = notes.map((nt) => mtof(nt.midi));
  let f = hz[0];
  let ph = 0; let amp = 0; let j = -1;
  for (let i = 0; i < total; i++) {
    const t = i / SR;
    while (j + 1 < notes.length && t >= notes[j + 1].t) j++;
    const cur = notes[j];
    let target = envOf(cur, t);
    if (legato && j > 0) target = Math.max(target, envOf(notes[j - 1], t));
    const ft = cur ? hz[j] : f;
    f = ft + (f - ft) * gA;
    amp = target + (amp - target) * aS;
    const dt = f / SR;
    x[i] = amp * (wave === 'sub' ? Math.sin(TAU * ph) + 0.22 * Math.sin(2 * TAU * ph) + 0.06 * Math.sin(3 * TAU * ph) : blepSaw(ph, dt));
    ph += dt;
    if (ph >= 1) ph -= 1;
  }
  if (wave === 'sub') { const td = Math.tanh(drive); for (let i = 0; i < total; i++) x[i] = Math.tanh(drive * x[i]) / td; return x; }
  return svf(x, { type: 'lowpass', f: cutoff, q: 0.6 });
}

// Sidechain "pump": gain dips under every kick and recovers; the max over the two latest kicks keeps it continuous.
export function pump(chs, kicks, depth, rel) {
  if (!kicks.length) return;
  const n = chs[0].length;
  const shape = (u) => (u < 0 ? 0 : u < 0.005 ? u / 0.005 : Math.exp(-(u - 0.005) / rel));
  let j = -1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    while (j + 1 < kicks.length && kicks[j + 1] <= t) j++;
    if (j < 0) continue;
    const s = Math.max(shape(t - kicks[j]), j > 0 ? shape(t - kicks[j - 1]) : 0);
    const g = 1 - depth * s;
    for (const c of chs) c[i] *= g;
  }
}
