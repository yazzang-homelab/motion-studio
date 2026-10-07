// Silent spans of a soundtrack (tools/refs.mjs re-exports these; critique.mjs and deliver.mjs use them): ffmpeg silencedetect
// (n = -50 dB, d = 1.0 s) on the audio stream, the rule for which spans are problems and the studio.json critique.allowSilence list.
import { ffmpeg } from './studio.mjs';

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// A soundtrack that drops out for seconds (a short stem padded with zeros, a cue-less sfx bed under a silent music track)
// still measures -14 LUFS after the mix, so loudness alone cannot see it.

/** ffmpeg silencedetect threshold and the spans that are not gaps: a span starting before startSec (a silent intro), a span that starts in the last endSec. */
export const SILENCE = { noiseDb: -50, minSec: 1.0, startSec: 0.3, endSec: 1.0 };
const SILENCE_SLACK = 0.05; // s: silencedetect reports the start of a run a few samples off the true edge
const ALLOW_PAD = 0.15; // s: an allowed interval also covers the ramp in and out of the silence

/** ffmpeg silencedetect output → [{ from, to, sec }]; a span still open at the end of the stream ends at `duration`. */
export function parseSilence(stderr, duration = null) {
  const spans = [];
  let open = null;
  const push = (from, to) => { if (Number.isFinite(from) && Number.isFinite(to) && to > from) spans.push({ from: round(Math.max(0, from), 3), to: round(to, 3), sec: round(to - Math.max(0, from), 3) }); };
  for (const line of String(stderr ?? '').split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+(?:e[+-]?\d+)?)/i.exec(line);
    if (s) { open = Number(s[1]); continue; }
    const e = /silence_end:\s*(-?[\d.]+(?:e[+-]?\d+)?)\s*\|\s*silence_duration:\s*([\d.]+(?:e[+-]?\d+)?)/i.exec(line);
    if (e) {
      const to = Number(e[1]);
      push(open ?? to - Number(e[2]), to);
      open = null;
    }
  }
  if (open !== null && Number.isFinite(duration)) push(open, duration);
  return spans;
}

/** Silent runs of at least minSec below noiseDb (dBFS) in the first audio stream of `file`: [{ from, to, sec }]. */
export async function detectSilence(root, file, { noiseDb = SILENCE.noiseDb, minSec = SILENCE.minSec, duration = null } = {}) {
  const { stderr } = await ffmpeg(root, ['-nostats', '-i', file, '-map', '0:a:0', '-af', `silencedetect=n=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-'], { timeoutMs: 600000 });
  return parseSilence(stderr, duration);
}

/** studio.json critique.allowSilence read defensively: [[from, to], ...] (or [{ from, to }]), only finite from < to pairs, sorted. */
export function allowedSilence(cfg) {
  const raw = cfg?.critique?.allowSilence;
  const list = Array.isArray(raw) && raw.length === 2 && raw.every((x) => typeof x === 'number') ? [raw] : Array.isArray(raw) ? raw : [];
  return list.map((x) => (Array.isArray(x) ? [Number(x[0]), Number(x[1])] : x && typeof x === 'object' ? [Number(x.from), Number(x.to)] : [NaN, NaN]))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((p, q) => p[0] - q[0]);
}

/**
 * Which silent spans are problems. Not a gap: a span that starts before startSec (a silent intro), one that starts in the
 * last endSec of the audio (a fade-out that ends on silence), and whatever studio.json critique.allowSilence covers (each
 * interval padded 0.15 s; a span half inside one keeps the part outside it). A tail of several seconds IS a gap: that is
 * the half-silent film. Returns { gaps: [{ from, to, sec }], ignored: [{ from, to, sec, why: 'start'|'end'|'allowed' }] }.
 */
export function judgeSilence(spans, { duration = null, allow = [], minSec = SILENCE.minSec, startSec = SILENCE.startSec, endSec = SILENCE.endSec } = {}) {
  const gaps = [];
  const ignored = [];
  const seg = (from, to) => ({ from: round(from, 3), to: round(to, 3), sec: round(to - from, 3) });
  for (const s of spans ?? []) {
    if (!(s.to - s.from >= minSec - 1e-6)) continue;
    if (s.from < startSec) { ignored.push({ ...seg(s.from, s.to), why: 'start' }); continue; }
    if (Number.isFinite(duration) && s.from >= duration - endSec - SILENCE_SLACK) { ignored.push({ ...seg(s.from, s.to), why: 'end' }); continue; }
    let pieces = [[s.from, s.to]];
    for (const [a0, b0] of allow) {
      const a = a0 - ALLOW_PAD;
      const b = b0 + ALLOW_PAD;
      pieces = pieces.flatMap(([x, y]) => (b <= x || a >= y ? [[x, y]] : [[x, a], [b, y]].filter(([p, q]) => q - p > 1e-6)));
    }
    const left = pieces.filter(([x, y]) => y - x >= minSec - 1e-6);
    if (left.length) for (const [x, y] of left) gaps.push(seg(x, y));
    else ignored.push({ ...seg(s.from, s.to), why: 'allowed' });
  }
  return { gaps, ignored };
}

/** "3.2 s at 00:08.1": one decimal, the way deliver and critique name a silent span. */
export function silenceLabel(g) {
  const t = Math.round(g.from * 10) / 10;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${g.sec != null ? (Math.round(g.sec * 10) / 10).toFixed(1) : (Math.round((g.to - g.from) * 10) / 10).toFixed(1)} s at ${String(m).padStart(2, '0')}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/** detectSilence + judgeSilence + the studio.json allow list: { noiseDb, minSec, spans, gaps, ignored, allow }. */
export async function audioGaps(root, file, cfg, { duration = null } = {}) {
  const spans = await detectSilence(root, file, { duration });
  const allow = allowedSilence(cfg);
  return { noiseDb: SILENCE.noiseDb, minSec: SILENCE.minSec, spans, ...judgeSilence(spans, { duration, allow }), allow };
}
