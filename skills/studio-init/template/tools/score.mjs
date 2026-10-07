#!/usr/bin/env node
// tools/score.mjs — original music synthesized on the film's beat grid. Deterministic: same flags → same bytes.
// Arrangement: sparse intro bar → build (layers enter, riser) → drop on a downbeat (~40 %) → final hit on the last
// downbeat ≤ dur − 0.5 s → decay tail, exactly `dur` seconds. --loop drops intro/ending and wraps tails to the start.
// Writes audio/beats.json analytically (source "grid"): no analysis needed when we wrote the notes ourselves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, usage, main, loadConfig, projectRoot, readJSON, writeJSON, writeFileAtomic, sha256, log, UsageError } from './studio.mjs';
import { SR, encodeWav, addAt, biquad, noiseGen, limiter, compressor, lufs, peakDb, dbToGain, reverb, pingPong, foldLoop, trimOrPad, fade, mtof } from './audio.mjs';
import { N, fadeEnd, kick, clap, hat, shaker, taiko, boom, impact, pluckNote, pianoNote, bowNote, blip, monoLine, pump } from './instruments.mjs';
import { synthVoice } from './sfx.mjs';
import { hash32, mulberry32 } from '../lib/rng.js';

export const STYLES = ['pulse', 'piano', 'minimal', 'cinematic'];
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------------------------------------------
// Harmony

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SCALE = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] };
const PROG = { minor: [0, 5, 2, 6], major: [0, 4, 5, 3] }; // i–VI–III–VII · I–V–vi–IV (scale degrees)
// Colour tones as scale steps above the root: add9 on tonics, maj7/m7 where they sound warm, plain triads on V/VII.
const COLOR = { minor: { 0: [0, 2, 4, 8], 5: [0, 2, 4, 6], 2: [0, 2, 4, 8], 6: [0, 2, 4] }, major: { 0: [0, 2, 4, 8], 4: [0, 2, 4], 5: [0, 2, 4, 6], 3: [0, 2, 4, 6] } };
const semis = (mode, deg) => SCALE[mode][((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);

export function parseKey(s) {
  const m = /^\s*([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|M|maj|major)?\s*$/.exec(String(s ?? ''));
  if (!m) throw new UsageError(`--key expects a note name like A, F#, Bb or C#m (got "${s}")`);
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  const pc = (PC[m[1].toUpperCase()] + acc + 12) % 12;
  const mode = m[3] ? (/^(m|min|minor)$/.test(m[3]) ? 'minor' : 'major') : null;
  return { pc, name: m[1].toUpperCase() + (acc > 0 ? '#' : acc < 0 ? 'b' : ''), mode };
}

const nearDist = (a, b) => a.reduce((s, x) => s + Math.min(...b.map((y) => Math.abs(x - y))), 0) + b.reduce((s, y) => s + Math.min(...a.map((x) => Math.abs(x - y))), 0);

// Close-position voicing inside [lo, hi] that moves least from the previous chord (smooth voice leading).
function voiceChord(pcs, lo, hi, prev) {
  let best = null;
  let bestScore = Infinity;
  for (let base = lo; base < lo + 12; base++) {
    const r = pcs.indexOf(base % 12);
    if (r < 0) continue;
    const notes = [base];
    for (let k = 1; k < pcs.length; k++) { let m = notes[k - 1] + 1; while (m % 12 !== pcs[(r + k) % pcs.length]) m++; notes.push(m); }
    if (notes[notes.length - 1] > hi) continue;
    const score = prev ? nearDist(notes, prev) : Math.abs(notes.reduce((a, b) => a + b, 0) / notes.length - (lo + hi) / 2);
    if (score < bestScore - 1e-9) { best = notes; bestScore = score; }
  }
  return best;
}

const inRange = (pc, lo) => lo + ((pc - lo) % 12 + 12) % 12;

// ---------------------------------------------------------------------------------------------------------------
// Form

export function planScore({ bpm, dur, beatsPerBar = 4, drop = null, loop = false }) {
  if (!(bpm > 0 && bpm <= 400)) throw new UsageError(`--bpm must be between 1 and 400 (got ${bpm})`);
  if (!(dur > 0 && dur <= 3600)) throw new UsageError(`--dur must be between 0 and 3600 seconds (got ${dur})`);
  const beat = 60 / bpm;
  const bar = beat * beatsPerBar;
  const nBars = Math.max(1, Math.ceil(dur / bar - 1e-9));
  if (loop) return { beat, bar, bpb: beatsPerBar, nBars, dropBar: 0, finalBar: null, loop: true };
  const finalBar = Math.max(0, Math.floor((dur - 0.5) / bar + 1e-9));
  let dropBar;
  if (drop !== null && drop !== undefined) {
    if (!Number.isInteger(drop) || drop < 0 || drop > finalBar) throw new UsageError(`--drop must be a downbeat index 0..${finalBar} for ${dur} s at ${bpm} BPM (got ${drop})`);
    dropBar = drop;
  } else dropBar = finalBar >= 2 ? Math.min(finalBar - 1, Math.max(1, Math.round(0.4 * dur / bar))) : finalBar;
  return { beat, bar, bpb: beatsPerBar, nBars, dropBar, finalBar, loop: false };
}

export function sectionOf(plan, b) {
  if (plan.loop) return 'drop';
  if (b > plan.finalBar) return 'tail';
  if (b === plan.finalBar) return 'final';
  if (b >= plan.dropBar) return 'drop';
  return b === 0 ? 'intro' : 'build';
}

const intensity = (plan, b) => { const s = sectionOf(plan, b); return s === 'intro' ? 0 : s === 'build' ? b / plan.dropBar : 1; };
const isRiserBar = (plan, b) => !plan.loop && plan.dropBar > 0 && b === plan.dropBar - 1 && plan.dropBar < plan.finalBar;

function sectionList(plan, dur) {
  if (plan.loop) return [{ name: 'loop', from: 0, to: r6(dur) }];
  const out = [];
  const push = (name, a, b) => { const e = Math.min(b, dur); if (e > a + 1e-9) out.push({ name, from: r6(a), to: r6(e) }); };
  const d = plan.dropBar * plan.bar;
  const f = plan.finalBar * plan.bar;
  push('intro', 0, Math.min(plan.bar, d));
  push('build', plan.bar, d);
  push('drop', d, f);
  push('outro', f, dur);
  return out;
}

function chordDegree(plan, b, mode) {
  const P = PROG[mode];
  if (plan.loop) return P[b % 4];
  if (b >= plan.finalBar) return P[0];
  if (b === plan.finalBar - 1 && plan.finalBar >= 2) return P[3]; // VII → i / IV → I cadence into the final hit
  return P[(((b - plan.dropBar) % 4) + 4) % 4]; // the drop lands on the tonic
}

// ---------------------------------------------------------------------------------------------------------------
// Styles. Each arranger writes into named stems on S; MIX sets stem level (dB), reverb send and delay send.

// Balance was set by measurement, not by ear: sustained parts by drop-section LUFS relative to the anchor (kick /
// piano / taiko), transients by peak level below the kick (short sounds read low on a 400 ms loudness meter).
export const MIX = {
  pulse: { reverb: { decay: 1.6, damp: 6500, predelay: 0.018, size: 1 }, glue: { thresholdDb: -14, ratio: 2, attackMs: 12, releaseMs: 150, kneeDb: 6 }, maxGR: 3.5,
    stems: { kick: [0, 0.03], clap: [-3, 0.28], hat: [-9, 0.06], open: [-14, 0.1], bass: [-6, 0], arp: [-2, 0.2, 0.26], fx: [-10, 0.3], stab: [-4, 0.4, 0.2] } },
  piano: { reverb: { decay: 2.8, damp: 5200, predelay: 0.025, size: 1.3 }, shelf: { f: 4500, gainDb: 2 }, glue: { thresholdDb: -20, ratio: 1.6, attackMs: 25, releaseMs: 250, kneeDb: 8 }, maxGR: 3,
    stems: { piano: [0, 0.36], kick: [-17, 0.05], shaker: [-16, 0.15], rim: [-3, 0.25], fx: [-12, 0.4], boom: [-9, 0.25] } },
  minimal: { reverb: { decay: 1.3, damp: 7500, predelay: 0.012, size: 0.8 }, glue: { thresholdDb: -16, ratio: 2, attackMs: 8, releaseMs: 120, kneeDb: 6 }, maxGR: 3,
    stems: { tick: [-3, 0.05], click: [-4, 0.08, 0.2], kick: [-3, 0.02], bass: [-7, 0.02], blip: [-7, 0.2, 0.3], snap: [-2, 0.22], fx: [-11, 0.25] } },
  cinematic: { reverb: { decay: 3.2, damp: 6000, predelay: 0.03, size: 1.5 }, shelf: { f: 5000, gainDb: 4 }, glue: { thresholdDb: -16, ratio: 2, attackMs: 20, releaseMs: 200, kneeDb: 6 }, maxGR: 3.5,
    stems: { taiko: [-2, 0.3], drum: [-7, 0.26], boom: [-2, 0.22], low: [-9, 0.16], sub: [-12, 0], ost: [-3.5, 0.22], high: [-9, 0.35], fx: [-10, 0.3] } },
};

const ARP = [
  [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 3, 2, 1, 2, 3],
  [0, 2, 1, 3, 2, 4, 3, 1, 0, 2, 1, 3, 2, 4, 3, 4],
  [0, -1, 2, 1, 3, -1, 2, 4, 0, -1, 2, 1, 3, 2, 4, 3],
  [2, 0, 3, 1, 4, 2, 3, 1, 2, 0, 3, 1, 4, 3, 2, 1],
];
const arpTones = (v) => [...v.slice(0, 4), v[0] + 12, v[1] + 12].slice(0, 5);

function arrangePulse(S) {
  const { plan, beat, bar, bpb } = S;
  const rnd = S.rng('pulse');
  const kickDrop = kick({ noise: S.noise('kick') });
  const kickBuild = kick({ f0: 52, f1: 130, decay: 0.2, drive: 1.3, click: 0.08, noise: S.noise('kick-build') });
  const clapV = clap(S.noise('clap', 0), S.noise('clap', 1));
  const hats = [0, 1, 2, 3].map((k) => hat({ noise: S.noise('hat', k), tone: 0.98 + 0.013 * k }));
  const openHat = hat({ open: true, noise: S.noise('open') });
  const pat = ARP[Math.floor(rnd() * ARP.length)];
  const step = beat / 4;
  const swing = 0.08 * step; // late 16th offbeats on the hats only: groove without moving the beat
  const kicks = [];
  const bass = [];
  for (let b = 0; b < plan.nBars; b++) {
    const sec = sectionOf(plan, b);
    if (sec === 'tail') break;
    const t0 = b * bar;
    const ch = S.chords[b];
    if (sec === 'final') {
      S.put('kick', kickDrop, t0, 1); kicks.push(t0);
      S.put('fx', impact(S.noise('impact', b, 0), S.noise('impact', b, 1)), t0, 0.8);
      bass.push({ t: t0, dur: 0.2, rel: Math.max(0.3, Math.min(1.6, S.dur - t0 - 0.25)), midi: ch.bass, vel: 1 }); // 808-style decay, not a drone
      for (const m of arpTones(ch.voicing)) S.put('stab', pluckNote(mtof(m), 0.25, { bright: 0.8, rel: 1.4, ph0: rnd() }), t0, 0.55, (m % 5 - 2) * 0.1);
      S.hits.push(t0);
      continue;
    }
    const I = intensity(plan, b);
    const riser = isRiserBar(plan, b);
    const drop = sec === 'drop';
    if (sec !== 'intro') {
      for (let k = 0; k < bpb; k++) {
        if (riser && k === bpb - 1) continue; // one beat of air before the drop
        const t = t0 + k * beat;
        S.put('kick', drop ? kickDrop : kickBuild, t, dbToGain(drop ? (k === 0 ? 0 : -1) : -5 + 3 * I - (k === 0 ? 0 : 1)));
        kicks.push(t);
      }
    }
    if (drop || (sec === 'build' && (b >= 2 || plan.dropBar <= 2))) {
      for (let k = 1; k < bpb; k += 2) if (!(riser && k === bpb - 1)) S.put('clap', clapV, t0 + k * beat, drop ? 1 : 0.55 + 0.35 * I);
    }
    for (let s = 0; s < bpb * 4; s++) {
      const pos = s % 4;
      if (riser && s >= (bpb - 1) * 4) continue;
      if (sec === 'intro' && pos !== 2) continue;
      if (sec === 'build' && pos % 2 === 1 && !riser) continue; // 8ths in the build, 16ths in the riser bar
      const t = t0 + s * step + (s % 2 ? swing : 0);
      if (drop && pos === 2) { S.put('open', openHat, t, 0.9, -0.15); continue; }
      const vel = pos === 0 ? 0.55 : pos === 2 ? 1 : 0.42 + 0.1 * rnd();
      S.put('hat', hats[s % 4], t, vel * (sec === 'intro' ? 0.5 : 1), 0.18);
    }
    const tones = arpTones(ch.voicing);
    const bright = sec === 'intro' ? 0.2 : drop ? 1 : 0.3 + 0.55 * I;
    for (let s = 0; s < bpb * 4; s++) {
      const idx = pat[s % 16];
      if (idx < 0 || (riser && s >= (bpb - 1) * 4 + 2)) continue;
      const vel = (s % 4 === 0 ? 1 : s % 2 === 0 ? 0.8 : 0.62) * (0.94 + 0.06 * rnd());
      S.put('arp', pluckNote(mtof(tones[idx]), step * 0.9, { bright, ph0: rnd() }), t0 + s * step, vel * (sec === 'intro' ? 0.75 : 1), idx % 2 ? 0.14 : -0.14);
    }
    if (drop) for (let k = 0; k < bpb; k += 2) bass.push({ t: t0 + k * beat, dur: Math.min(2, bpb - k) * beat - 0.02, midi: ch.bass, vel: k === 0 ? 1 : 0.9 });
    if (riser) riserInto(S, b, 0.9);
    if (drop && b === plan.dropBar && !plan.loop) { S.put('fx', impact(S.noise('impact', b, 0), S.noise('impact', b, 1)), t0, 0.7); S.hits.push(t0); }
    if (drop && (b - plan.dropBar) % 4 === 0) S.hits.push(t0);
  }
  S.stemLine('bass', monoLine(S.total, bass, { wave: 'sub', attack: 0.006, release: 0.05 }));
  pump(S.stem('bass'), kicks, 0.85, 0.13);
  pump(S.stem('arp'), kicks, 0.35, 0.12);
}

const BROKEN = [[0, 1, 2, 3, 2, 1, 2, 3], [0, 2, 1, 3, 2, 3, 1, 2], [0, 1, 2, 1, 3, 2, 1, 2]];
const RHYTHM4 = [[[0, 1], [1, 0.5], [1.5, 0.5], [2, 2]], [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1]], [[0, 0.5], [0.5, 0.5], [1, 1], [2, 1.5], [3.5, 0.5]], [[0, 2], [2, 1], [3, 1]]];

function arrangePiano(S) {
  const { plan, beat, bar, bpb } = S;
  const rnd = S.rng('piano');
  const stepBeats = S.bpm > 110 ? 1 : 0.5;
  const nSteps = Math.max(1, Math.round(bpb / stepBeats));
  const brk = BROKEN[Math.floor(rnd() * BROKEN.length)];
  const felt = kick({ f0: 55, f1: 95, tauP: 0.03, decay: 0.2, drive: 1, click: 0, noise: S.noise('felt') });
  const shakers = [0, 1, 2, 3].map((k) => shaker(S.noise('shaker', k)));
  const rim = synthVoice('snap', { seed: S.seed, i: 0, pitch: 0.8 }).data;
  let noteNo = 0;
  const piano = (midi, t, vel, holdUntil) => {
    const x = pianoNote(midi, Math.min(1, vel), Math.max(0.05, holdUntil - t), rnd, S.noise('piano', noteNo++));
    S.put('piano', x, t, 1, Math.max(-0.35, Math.min(0.35, (midi - 62) / 48)));
  };
  const scaleTones = [];
  for (let m = 64; m <= 88; m++) if (SCALE[S.mode].includes(((m - S.keyPc) % 12 + 12) % 12)) scaleTones.push(m);
  let cur = scaleTones.reduce((a, m) => (Math.abs(m - 74) < Math.abs(a - 74) ? m : a), scaleTones[0]);
  const choose = (cands) => {
    const w = cands.map((m) => { const d = Math.abs(m - cur); return d === 0 ? 0.4 : d <= 2 ? 3 : d <= 4 ? 1.5 : d <= 7 ? 0.5 : 0; });
    const sum = w.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return cands.reduce((a, m) => (Math.abs(m - cur) < Math.abs(a - cur) ? m : a), cands[0]);
    let r = rnd() * sum;
    for (let i = 0; i < cands.length; i++) { r -= w[i]; if (r <= 0) return cands[i]; }
    return cands[cands.length - 1];
  };
  for (let b = 0; b < plan.nBars; b++) {
    const sec = sectionOf(plan, b);
    if (sec === 'tail') break;
    const t0 = b * bar;
    const ch = S.chords[b];
    const lh = ch.bass + 12;
    const chordTones = scaleTones.filter((m) => ch.pcs.includes(m % 12));
    if (sec === 'final') {
      const end = S.dur + 2;
      piano(lh - 12, t0, 0.62, end); piano(lh, t0, 0.55, end);
      for (const m of ch.voicing) piano(m, t0 + 0.012, 0.5, end);
      const top = chordTones.filter((m) => m % 12 === S.keyPc).reduce((a, m) => (Math.abs(m - cur) < Math.abs(a - cur) ? m : a), cur);
      piano(top, t0 + 0.02, 0.6, end);
      S.put('boom', boom(S.noise('boom', b)), t0, 0.45);
      S.hits.push(t0);
      continue;
    }
    const I = intensity(plan, b);
    const drop = sec === 'drop';
    const pedal = t0 + bar + 0.05; // legato pedal: lift just after the next chord sounds
    piano(lh, t0, drop ? 0.55 : 0.45, pedal);
    if (drop) piano(lh - 12, t0, 0.5, pedal);
    if (bpb >= 4 && sec !== 'intro') piano(lh + 7, t0 + 2 * beat, 0.36, pedal);
    for (let s = 0; s < nSteps; s++) {
      const m = ch.voicing[brk[s % brk.length] % ch.voicing.length];
      const vel = (sec === 'intro' ? 0.32 : drop ? 0.27 : 0.33 + 0.12 * I) * (s % 2 ? 0.85 : 1);
      piano(m, t0 + s * stepBeats * beat, vel, pedal);
    }
    if (drop) {
      const phrase = b - plan.dropBar;
      const rhythm = bpb === 4 ? (phrase % 4 === 3 ? [[0, 3], [3, 1]] : RHYTHM4[hash32(S.seed, 'rhythm', phrase >> 1) % RHYTHM4.length]) : Array.from({ length: bpb }, (_, k) => [k, 1]);
      for (const [pos, dur] of rhythm) {
        const strong = pos % 2 === 0;
        cur = choose(strong && chordTones.length ? chordTones : scaleTones);
        piano(cur, t0 + pos * beat, strong ? 0.6 : 0.5, Math.min(pedal, t0 + (pos + dur) * beat + 0.25));
      }
      for (let k = 0; k < bpb; k += 2) S.put('kick', felt, t0 + k * beat, k === 0 ? 1 : 0.8);
      for (let k = 1; k < bpb; k += 2) S.put('rim', rim, t0 + k * beat, 1, 0.1);
    }
    if (drop || (sec === 'build' && I >= 0.5)) for (let s = 0; s < bpb * 2; s++) S.put('shaker', shakers[s % 4], t0 + s * beat / 2, (s % 2 ? 1 : 0.6) * (drop ? 1 : 0.6), 0.3);
    if (isRiserBar(plan, b)) {
      // Reverse-piano swell: the drop chord played backwards, so its decay becomes an inhale that ends on the drop.
      const next = S.chords[b + 1];
      const L = Math.min(bar, 2.5);
      const sw = new Float32Array(N(L));
      for (const m of [next.bass + 12, ...next.voicing]) { const x = pianoNote(m, 0.7, L, rnd, S.noise('swell', m)); for (let i = 0; i < sw.length && i < x.length; i++) sw[i] += x[i]; }
      sw.reverse();
      fadeEnd(sw, 0.004);
      for (let i = 0, m = N(L * 0.3); i < m; i++) sw[i] *= i / m;
      S.put('fx', sw, (b + 1) * bar - L, 1);
    }
    if (drop && b === plan.dropBar && !plan.loop) { S.put('boom', boom(S.noise('boom', b)), t0, 0.35); S.hits.push(t0); }
  }
}

const BASS_PATTERNS = [[0, 1.5, 3], [0, 0.75, 2.5, 3.5], [0, 2, 2.75], [0, 1.5, 2.5]];

function arrangeMinimal(S) {
  const { plan, beat, bar, bpb } = S;
  const rnd = S.rng('minimal');
  const ticks = [0, 1, 2, 3].map((k) => synthVoice('tick', { seed: S.seed, i: k, pitch: k % 2 ? 1.12 : 1 }).data);
  const clicks = [0, 1].map((k) => synthVoice('click', { seed: S.seed, i: k, pitch: 0.8 + 0.1 * k }).data);
  const snapV = synthVoice('snap', { seed: S.seed, i: 7 }).data;
  const softKick = kick({ f0: 50, f1: 120, tauP: 0.03, decay: 0.16, drive: 1.1, click: 0.05, noise: S.noise('kick') });
  const bassPat = BASS_PATTERNS[Math.floor(rnd() * BASS_PATTERNS.length)].filter((p) => p < bpb);
  const step = beat / 4;
  const bass = [];
  let blipNo = 0;
  const hits = [];
  for (let b = 0; b < plan.nBars; b++) {
    const sec = sectionOf(plan, b);
    if (sec === 'tail') break;
    const t0 = b * bar;
    const ch = S.chords[b];
    const hi = ch.voicing.map((m) => m + 12);
    if (sec === 'final') {
      S.put('kick', softKick, t0, 1);
      bass.push({ t: t0, dur: 1.2, midi: ch.bass, vel: 1 });
      for (const m of [...hi, hi[0] + 12]) S.put('blip', blip(mtof(m), 0.8, S.noise('blip', blipNo++)), t0, 1, (m % 7 - 3) * 0.1);
      S.put('snap', snapV, t0, 0.8);
      hits.push(t0);
      continue;
    }
    const I = intensity(plan, b);
    const riser = isRiserBar(plan, b);
    const drop = sec === 'drop';
    for (let s = 0; s < bpb * 4; s++) {
      const pos = s % 4;
      if ((sec === 'intro' || (sec === 'build' && I < 0.5)) && pos % 2 === 1) continue;
      if (riser && s >= (bpb - 1) * 4 + 2) continue;
      const vel = pos === 0 ? 0.9 : pos === 2 ? 0.55 : 0.4;
      S.put('tick', ticks[s % 4], t0 + s * step, vel, 0.25);
    }
    if (sec !== 'intro') for (let k = 0; k < bpb; k++) if (!(riser && k === bpb - 1)) S.put('click', clicks[k % 2], t0 + (k + 0.5) * beat, 0.7, -0.3);
    for (let k = 0; k < bpb; k++) {
      if (sec === 'intro' || (riser && k === bpb - 1)) continue;
      if (!drop && k % 2 === 1) continue;
      S.put('kick', softKick, t0 + k * beat, k === 0 ? 1 : 0.8);
    }
    if (drop) {
      bassPat.forEach((p, i) => bass.push({ t: t0 + p * beat, dur: 0.12, midi: ch.bass + (i === bassPat.length - 1 && (b & 1) ? 12 : 0), vel: i === 0 ? 1 : 0.8 }));
      for (let k = 1; k < bpb; k += 2) S.put('snap', snapV, t0 + k * beat, 0.9, 0.05);
    }
    const density = sec === 'intro' ? 0.25 : drop ? 0.55 : 0.3 + 0.3 * I;
    const pr = mulberry32(hash32(S.seed, 'blips', drop ? (b - plan.dropBar) % 2 : b)); // 2-bar motif repeats in the drop
    for (let s = 0; s < bpb * 2; s++) {
      const on = pr() < (s % 2 === 0 ? density * 1.3 : density * 0.7);
      const idx = Math.floor(pr() * hi.length);
      if (!on || (riser && s >= (bpb - 1) * 2)) continue;
      S.put('blip', blip(mtof(hi[idx]), s % 2 ? 0.7 : 0.9, S.noise('blip', blipNo++)), t0 + s * beat / 2, 1, s % 4 < 2 ? -0.3 : 0.3);
    }
    if (riser) riserInto(S, b, 0.8);
    if (drop && b === plan.dropBar && !plan.loop) { S.put('fx', synthVoice('thump', { seed: S.seed, i: b }).data, t0, 0.8); hits.push(t0); }
  }
  S.hits.push(...hits);
  S.stemLine('bass', monoLine(S.total, bass, { wave: 'sub', attack: 0.003, release: 0.12 }));
}

const GROOVES = [{ big: [0, 2.5], mid: [1, 1.5, 3, 3.5] }, { big: [0, 1.5, 2], mid: [0.75, 2.5, 3, 3.5] }, { big: [0, 2], mid: [1, 1.75, 3, 3.25, 3.5] }];

function arrangeCinematic(S) {
  const { plan, beat, bar, bpb } = S;
  const rnd = S.rng('cinematic');
  const big = [0, 1, 2].map((k) => taiko({ f: 62 + 3 * k, size: 1.3, noise: S.noise('big', k) }));
  const mid = [0, 1, 2, 3].map((k) => taiko({ f: 118 + 9 * k, size: 0.7, noise: S.noise('mid', k) }));
  const boomV = boom(S.noise('boom'));
  const low = [];
  const sub = [];
  let n = 0;
  const bow = (stem, m, t, dur, o) => S.put(stem, bowNote(mtof(m), dur, { ...o, rnd, noise: S.noise('bow', n++) }), t, o.vel ?? 1, o.pan ?? 0);
  const hitBig = (t, vel, flam = false) => {
    S.put('taiko', big[Math.floor(rnd() * 3)], t, vel, -0.05);
    if (flam) S.put('taiko', big[Math.floor(rnd() * 3)], t + 0.018, vel * 0.45, 0.25);
  };
  for (let b = 0; b < plan.nBars; b++) {
    const sec = sectionOf(plan, b);
    if (sec === 'tail') break;
    const t0 = b * bar;
    const ch = S.chords[b];
    const root = ch.bass + 12;
    if (sec === 'final') {
      const hold = S.dur - t0 + 0.5;
      S.put('boom', boomV, t0, 1); hitBig(t0, 1, true);
      S.put('fx', impact(S.noise('impact', b, 0), S.noise('impact', b, 1)), t0, 0.7);
      low.push({ t: t0, dur: hold, midi: root, vel: 1 }); sub.push({ t: t0, dur: hold, midi: ch.bass, vel: 1 });
      ch.voicing.forEach((m, i) => bow('high', m + 12, t0, hold, { attack: 0.08, release: 1.2, bright: 0.55, vel: 0.8, pan: (i - 1.5) * 0.15 }));
      S.hits.push(t0);
      continue;
    }
    const I = intensity(plan, b);
    const drop = sec === 'drop';
    const riser = isRiserBar(plan, b);
    low.push({ t: t0, dur: bar - 0.02, midi: root, vel: sec === 'intro' ? 0.6 : drop ? 0.95 : 0.7 + 0.15 * I });
    if (drop) sub.push({ t: t0, dur: bar - 0.02, midi: ch.bass, vel: 0.9 });
    if (sec !== 'intro') {
      const ost = [root + 12, root + 12, root + 19, root + 12, root + 24, root + 12, root + 19, root + 12];
      const vScale = drop ? 1 : 0.45 + 0.5 * I;
      for (let s = 0; s < bpb * 2; s++) bow('ost', ost[s % ost.length], t0 + s * beat / 2, beat / 2 * 0.9, { attack: 0.03, release: 0.12, bright: 0.45 + 0.35 * vScale, vel: vScale * (s % 4 === 0 ? 1 : 0.75), pan: -0.12 });
    }
    if (drop) ch.voicing.forEach((m, i) => bow('high', m + 12, t0, bar - 0.05, { attack: 0.45, release: 0.8, bright: 0.7, vel: 0.6, pan: (i - 1.5) * 0.18 }));
    if (sec === 'intro') hitBig(t0, 0.55);
    else if (riser) {
      for (let s = 0; s < bpb * 4; s++) {
        if (s < bpb * 2 && s % 2) continue; // 8ths, then 16ths into the drop
        const p = s / (bpb * 4);
        S.put('drum', mid[s % 4], t0 + s * beat / 4, 0.3 + 0.7 * p * p, s % 2 ? 0.3 : -0.3);
      }
      hitBig(t0, 0.8);
    } else if (sec === 'build') {
      for (let k = 0; k < bpb; k += 2) hitBig(t0 + k * beat, 0.6 + 0.3 * I);
      if (I > 0.5) S.put('drum', mid[b % 4], t0 + (bpb - 0.5) * beat, 0.6, 0.3);
    } else {
      const g = GROOVES[hash32(S.seed, 'groove', (b - plan.dropBar) >> 2) % GROOVES.length];
      for (const p of g.big) if (p < bpb) hitBig(t0 + p * beat, p === 0 ? 1 : 0.8, p === 0);
      g.mid.forEach((p, i) => { if (p < bpb) S.put('drum', mid[i % 4], t0 + p * beat, 0.55 + 0.25 * (p % 1 === 0), i % 2 ? 0.3 : -0.3); });
      S.put('boom', boomV, t0, b === plan.dropBar ? 1 : 0.7);
      if (b === plan.dropBar) S.hits.push(t0);
    }
    if (riser) riserInto(S, b, 0.8);
    if (drop && (b - plan.dropBar) % 2 === 0) S.hits.push(t0);
  }
  S.stemLine('low', monoLine(S.total, low, { wave: 'saw', attack: 0.3, release: 0.4, glide: 0.06, legato: true, cutoff: 700 }));
  S.stemLine('sub', monoLine(S.total, sub, { wave: 'sub', attack: 0.2, release: 0.4, glide: 0.06, legato: true }));
}

// The riser bar swells into the drop: at most one bar (and 2.4 s) long, ending exactly on the downbeat.
function riserInto(S, b, gain) {
  const L = Math.min(S.bar, 2.4);
  S.put('fx', synthVoice('riser', { seed: S.seed, i: b, sr: SR, length: L }).data, (b + 1) * S.bar - L, gain);
}

const ARRANGE = { pulse: arrangePulse, piano: arrangePiano, minimal: arrangeMinimal, cinematic: arrangeCinematic };

// ---------------------------------------------------------------------------------------------------------------
// Mix + master

function mixdown(S, m) {
  const total = S.total;
  const bus = () => [new Float32Array(total), new Float32Array(total)];
  const dry = bus(); const rin = bus(); const din = bus();
  let usesDelay = false;
  for (const [name, chs] of S.stems) {
    const [db, send = 0, dly = 0] = m.stems[name] ?? [-6, 0.2, 0];
    const g = dbToGain(db);
    if (dly > 0) usesDelay = true;
    for (let c = 0; c < 2; c++) {
      const src = chs[c]; const d = dry[c]; const r = rin[c]; const e = din[c];
      const gs = g * send; const gd = g * dly;
      for (let i = 0; i < total; i++) d[i] += src[i] * g;
      if (gs > 0) for (let i = 0; i < total; i++) r[i] += src[i] * gs;
      if (gd > 0) for (let i = 0; i < total; i++) e[i] += src[i] * gd;
    }
  }
  if (usesDelay) {
    const echo = pingPong(din, { time: 0.75 * S.beat, feedback: 0.32, damp: 4200 });
    for (let c = 0; c < 2; c++) for (let i = 0; i < total; i++) { dry[c][i] += echo[c][i]; rin[c][i] += 0.3 * echo[c][i]; }
  }
  const wet = reverb(rin, m.reverb);
  for (let c = 0; c < 2; c++) for (let i = 0; i < total; i++) dry[c][i] += wet[c][i];
  return dry;
}

const CEILING_DB = -1.1; // −1 dBFS with room for 16-bit rounding

function master(mix, S, m) {
  let out = mix.map((c) => biquad(c, { type: 'highpass', f: 28, q: 0.707 }));
  if (m.shelf) out = out.map((c) => biquad(c, { type: 'highshelf', f: m.shelf.f, q: 0.707, gainDb: m.shelf.gainDb }));
  compressor(out, { ...m.glue, sr: SR });
  out = S.plan.loop ? foldLoop(out, N(S.dur)) : trimOrPad(out, S.dur);
  if (!S.plan.loop) fade(out, { inSec: 0.002, outSec: Math.min(0.08, S.dur / 4) });
  const L0 = lufs(out);
  const tp0 = peakDb(out, { truePeak: true });
  let g = 0;
  if (Number.isFinite(tp0)) g = Number.isFinite(L0) ? Math.min(S.lufsTarget - L0, CEILING_DB - tp0 + m.maxGR) : CEILING_DB - tp0;
  const k = dbToGain(g);
  for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= k;
  limiter(out, { ceilingDb: CEILING_DB, truePeak: true, releaseMs: 80, sr: SR });
  return out;
}

/** Pure: options → { channels:[L,R], grid (beats.json body), plan, key, mode, stats }. */
export function composeScore({ bpm = 120, dur = 12, style = 'pulse', key = 'A', mode = null, seed = 1, drop = null, loop = false, beatsPerBar = 4, lufsTarget = -14, keepStems = false } = {}) {
  if (!STYLES.includes(style)) throw new UsageError(`--style must be one of ${STYLES.join(', ')} (got "${style}")`);
  const k = parseKey(key);
  const md = mode ?? k.mode ?? 'minor';
  if (!SCALE[md]) throw new UsageError(`--mode must be minor or major (got "${md}")`);
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) throw new UsageError(`beatsPerBar must be a positive integer (got ${beatsPerBar})`);
  const plan = planScore({ bpm, dur, beatsPerBar, drop, loop });
  const total = N(dur + (loop ? 4 : 3)); // tails run past the end, then get folded (loop) or cut with a fade
  const stems = new Map();
  const S = {
    bpm, dur, style, seed, plan, mode: md, keyPc: k.pc, beat: plan.beat, bar: plan.bar, bpb: beatsPerBar, total, stems, lufsTarget, hits: [],
    rng: (...p) => mulberry32(hash32('score', seed, style, ...p)),
    noise: (...p) => noiseGen('score', seed, style, ...p),
    stem(name) { if (!stems.has(name)) stems.set(name, [new Float32Array(total), new Float32Array(total)]); return stems.get(name); },
    put(name, data, t, gain = 1, pan = 0) { addAt(S.stem(name), data, t, { gain, pan, sr: SR }); },
    stemLine(name, mono) { addAt(S.stem(name), mono, 0, { gain: Math.SQRT2, sr: SR }); }, // centred at unity
  };
  S.chords = [];
  let prev = null;
  for (let b = 0; b < plan.nBars + 1; b++) {
    const deg = chordDegree(plan, b, md);
    const pcs = COLOR[md][deg].map((st) => (k.pc + semis(md, deg + st)) % 12);
    const voicing = voiceChord(pcs, 57, 76, prev) ?? voiceChord(pcs, 57, 90, null);
    prev = voicing;
    S.chords.push({ deg, pcs, voicing, bass: inRange(pcs[0], 28) });
  }
  ARRANGE[style](S);
  const channels = master(mixdown(S, MIX[style]), S, MIX[style]);
  const beats = [];
  const downbeats = [];
  for (let i = 0; ; i++) { const t = i * plan.beat; if (t >= dur - 1e-9) break; beats.push(r6(t)); if (i % beatsPerBar === 0) downbeats.push(r6(t)); }
  const grid = {
    version: 1, source: 'grid', bpm, offset: 0, beatsPerBar, duration: dur, beats, downbeats, downbeatPhase: 0,
    hits: [...new Set(S.hits.map(r6))].filter((t) => t < dur).sort((a, b) => a - b), sections: sectionList(plan, dur),
  };
  const stats = { lufs: lufs(channels), truePeakDb: peakDb(channels, { truePeak: true }), peakDb: peakDb(channels) };
  return { channels, grid, plan, key: k.name, mode: md, stats, ...(keepStems ? { stems } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// Parameters, sidecar and staleness

/** The resolved parameters that decide a score's bytes (key and mode after parsing, drop bar after planning). Throws UsageError on invalid values, like composeScore. */
export function scoreParams({ bpm, dur, style, key = 'A', mode = null, seed = 1, drop = null, loop = false, beatsPerBar = 4 }) {
  const k = parseKey(key);
  const plan = planScore({ bpm, dur, beatsPerBar, drop, loop });
  return { bpm, dur, style, key: k.name, mode: mode ?? k.mode ?? 'minor', seed, loop: plan.loop, beatsPerBar, dropBar: plan.dropBar };
}

const PARAM_LABELS = { bpm: 'bpm', dur: 'duration', style: 'style', key: 'key', mode: 'mode', seed: 'seed', loop: 'loop', beatsPerBar: 'beats per bar', dropBar: 'drop bar' };

/** ['duration 6 → 12', …]: how the parameters a file was generated with differ from the wanted ones. */
export function paramDiff(had, want) {
  return Object.keys(PARAM_LABELS).filter((k) => had[k] !== want[k]).map((k) => `${PARAM_LABELS[k]} ${had[k] ?? 'unknown'} → ${want[k]}`);
}

const readJSONQuiet = (p) => { try { return readJSON(p, null); } catch { return null; } };

/** audio/<name>.meta.json next to the WAV: what score.mjs generated it from (and the hash proving the file is still that one). */
export const metaPathFor = (out) => path.join(path.dirname(out), `${path.basename(out, path.extname(out))}.meta.json`);

/**
 * The parameters `out` was generated with, or null when score.mjs did not make this exact file (a supplied track, or
 * a generated one the user replaced). Sidecar first; a file from before the sidecar existed is recognised by its
 * beats.json (generator.tool = score.mjs and the same audioSha256).
 */
export function generatedParams(out, beatsPath) {
  let sha;
  try { sha = sha256(fs.readFileSync(out)); } catch { return null; } // unreadable: not ours to judge, so it is kept
  const meta = readJSONQuiet(metaPathFor(out));
  if (meta?.tool === 'score.mjs' && meta.audioSha256 === sha && meta.params) return meta.params;
  const b = beatsPath ? readJSONQuiet(beatsPath) : null;
  if (b?.generator?.tool === 'score.mjs' && b.audioSha256 === sha) {
    const g = b.generator;
    return { bpm: b.bpm, dur: b.duration, style: g.style, key: g.key, mode: g.mode, seed: g.seed, loop: g.loop, beatsPerBar: b.beatsPerBar, dropBar: g.dropBar };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const SPEC = {
  bpm: { type: 'number', desc: 'tempo (default: studio.json bpm)' },
  dur: { type: 'number', desc: 'length in seconds (default: studio.json duration)' },
  style: { type: 'string', desc: `${STYLES.join(' | ')} (default: studio.json audio.style or pulse)` },
  key: { type: 'string', desc: 'tonic such as A, F#, Bb; a trailing m means minor (default: A)' },
  mode: { type: 'string', desc: 'minor | major (default: minor)' },
  seed: { type: 'number', desc: 'variation seed: arp/melody/groove choices and noise (default: 1)' },
  drop: { type: 'number', arg: '<bar>', desc: 'downbeat index (0-based) where the drop lands (default: ~40% of the length)' },
  loop: { type: 'boolean', desc: 'seamless loop: no intro or ending, tails wrap to the start (default: studio.json loop)' },
  out: { type: 'string', desc: 'output WAV (default: studio.json audio.music or audio/music.wav)' },
  beats: { type: 'string', default: 'audio/beats.json', desc: 'beat-grid JSON to write, or none' },
  'if-missing': { type: 'boolean', desc: 'keep an existing output WAV (a supplied track, or a score whose settings still match audio/music.meta.json) and do nothing; regenerate a score made with other settings' },
  json: { type: 'boolean', desc: 'print one JSON result line on stdout' },
};

const EXTRA = `Styles: pulse (kick 4/4, clap 2&4, hats, sub bass, pluck arp) · piano (felt piano, sparse percussion)
        minimal (ticks, clicks, soft kick, bass hits, mallet blips — UI films) · cinematic (taiko, bowed ostinato, booms)
Progressions: minor i–VI–III–VII, major I–V–vi–IV. 48 kHz stereo 16-bit, true-peak limited below −1 dBFS.`;

async function cli() {
  const title = 'node tools/score.mjs [--bpm N] [--dur S] [--style pulse|piano|minimal|cinematic] [--key A] [--mode minor|major] [--seed N] [--drop BAR] [--out audio/music.wav] [--beats audio/beats.json] [--if-missing] [--json]';
  const { flags, positionals } = parseArgs(process.argv.slice(2), SPEC);
  if (flags.help) { process.stdout.write(usage(title, SPEC, EXTRA)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}"`, usage(title, SPEC, EXTRA));
  const root = projectRoot();
  const cfg = loadConfig(root);
  const a = cfg.audio ?? {};
  const musicOff = !a.music || a.music === 'none';
  const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
  const out = path.resolve(root, flags.out ?? (musicOff ? 'audio/music.wav' : a.music));
  const beatsOut = flags.beats && flags.beats !== 'none' ? path.resolve(root, flags.beats) : null;
  const done = (obj) => { if (flags.json) process.stdout.write(JSON.stringify(obj) + '\n'); return 0; };
  const opts = {
    bpm: flags.bpm ?? cfg.bpm, dur: flags.dur ?? cfg.duration, style: flags.style ?? a.style ?? 'pulse', key: flags.key ?? a.key ?? 'A',
    mode: flags.mode ?? a.mode ?? null, seed: flags.seed ?? a.seed ?? 1, drop: flags.drop ?? null, loop: flags.loop ?? cfg.loop === true,
    beatsPerBar: cfg.beatsPerBar ?? 4, lufsTarget: a.lufs ?? -14,
  };
  const metaOut = metaPathFor(out);
  let regenerated = null;
  if (flags['if-missing']) {
    if (!flags.out && musicOff) { log('score: studio.json audio.music is none — nothing to do'); return done({ skipped: true, reason: 'audio.music is none' }); }
    if (fs.existsSync(out)) {
      // A supplied track is never touched. A file score.mjs generated (sidecar or beats.json proves it, by hash) is kept
      // only while the settings it came from still hold: a stale duration or bpm would make `npm run build` mix a track
      // that ends early or runs off the beat grid.
      const had = generatedParams(out, beatsOut);
      let diff = [];
      if (had) { try { diff = paramDiff(had, scoreParams(opts)); } catch { diff = ['settings']; } } // invalid settings: composeScore below reports them
      if (!diff.length) {
        log(`score: ${rel(out)} exists — kept (--if-missing)`);
        if (beatsOut && !fs.existsSync(beatsOut)) log(`score: hint: measure its beat grid with  node tools/beats.mjs ${rel(out)}`);
        return done({ skipped: true, reason: 'exists', out: rel(out) });
      }
      regenerated = diff.join(', ');
      log(`score: ${rel(out)} was generated with other settings (${regenerated}) — regenerating (--if-missing)`);
    }
  }
  const res = composeScore(opts);
  if (res.plan.loop && Math.abs(opts.dur / res.plan.bar - Math.round(opts.dur / res.plan.bar)) > 1e-6)
    log(`score: warning: ${opts.dur} s is not a whole number of bars at ${opts.bpm} BPM — the loop seam will not land on a downbeat`);
  const wav = encodeWav(res.channels, SR, { bits: 16 });
  writeFileAtomic(out, wav);
  const sha = sha256(wav);
  if (beatsOut) writeJSON(beatsOut, { ...res.grid, audioSha256: sha, generator: { tool: 'score.mjs', style: opts.style, key: res.key, mode: res.mode, seed: opts.seed, dropBar: res.plan.dropBar, finalBar: res.plan.finalBar, loop: res.plan.loop } });
  writeJSON(metaOut, { version: 1, tool: 'score.mjs', audioSha256: sha, samples: res.channels[0].length, params: scoreParams(opts) }); // read by --if-missing
  if (musicOff && !flags.out) log('score: note: studio.json audio.music is none, so mix.mjs will ignore this file');
  const { plan, stats } = res;
  const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-inf');
  const form = plan.loop ? 'loop' : `drop @ downbeat ${plan.dropBar} (${(plan.dropBar * plan.bar).toFixed(2)} s) · final hit ${(plan.finalBar * plan.bar).toFixed(2)} s`;
  log(`score: ${opts.style} · ${res.key} ${res.mode} · ${opts.bpm} BPM · ${opts.dur} s · ${form} · ${f1(stats.lufs)} LUFS · ${f1(stats.truePeakDb)} dBTP → ${rel(out)}${beatsOut ? ` + ${rel(beatsOut)}` : ''}`);
  return done({
    out: rel(out), beats: beatsOut ? rel(beatsOut) : null, meta: rel(metaOut), ...(regenerated ? { regenerated } : {}), style: opts.style, key: res.key, mode: res.mode, bpm: opts.bpm, duration: opts.dur, seed: opts.seed,
    loop: plan.loop, dropBar: plan.dropBar, finalBar: plan.finalBar, samples: res.channels[0].length, sha256: sha,
    lufs: Number.isFinite(stats.lufs) ? +stats.lufs.toFixed(2) : null, truePeakDb: Number.isFinite(stats.truePeakDb) ? +stats.truePeakDb.toFixed(2) : null,
  });
}

const isMain = () => {
  try {
    const x = fs.realpathSync.native(process.argv[1] ?? '');
    const y = fs.realpathSync.native(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch { return false; }
};
if (isMain()) main(cli);
