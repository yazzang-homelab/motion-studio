// lib/timeline.js — beat grid, scenes, chapters, cues and the frame compositor.
// Isomorphic: safe to import from Node (no window/document at module scope), so tools can build a film's cues or
// shot list without a browser and tests can drive renderFrame with a mock 2D context.

import { clamp } from './motion.js';
import { rngFor } from './rng.js';
import { layout } from './layout.js';

export const SFX_TYPES = Object.freeze(['click', 'tick', 'pop', 'thump', 'whoosh', 'swoosh', 'riser', 'hit', 'chime', 'type', 'glitch', 'snap']);

// ---------------------------------------------------------------------------------------------------------------
// Beat grid. Uniform (bpm + offset) or measured (beats[] from audio/beats.json). Measured beats interpolate between
// entries and extrapolate with the edge intervals, so grid.beat(n) is defined for any real n.

function sortedTimes(list) {
  if (!Array.isArray(list)) return [];
  const xs = list.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (const x of xs) if (!out.length || x - out[out.length - 1] > 1e-6) out.push(x); // drop duplicates (zero intervals)
  return out;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Piecewise-linear map index -> time over a sorted array, with linear extrapolation at both ends.
function seq(arr, fallbackIv) {
  const last = arr.length - 1;
  const firstIv = arr.length >= 2 ? arr[1] - arr[0] : fallbackIv;
  const lastIv = arr.length >= 2 ? arr[last] - arr[last - 1] : fallbackIv;
  return {
    at(n) {
      if (n <= 0) return arr[0] + n * firstIv;
      if (n >= last) return arr[last] + (n - last) * lastIv;
      const i = Math.floor(n);
      const f = n - i;
      return f === 0 ? arr[i] : arr[i] + (arr[i + 1] - arr[i]) * f;
    },
    pos(t) {
      if (t <= arr[0]) return (t - arr[0]) / firstIv;
      if (t >= arr[last]) return last + (t - arr[last]) / lastIv;
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= t) lo = mid;
        else hi = mid;
      }
      return lo + (t - arr[lo]) / (arr[lo + 1] - arr[lo]);
    },
  };
}

// hits = measured accent peaks (beats.json hits[]): kept as given (sorted, deduplicated), limited to [0, duration).
export function beatGrid({ bpm = 120, offset = 0, beatsPerBar = 4, beats = null, downbeats = null, duration = null, hits = null } = {}) {
  const bpb = Number.isInteger(beatsPerBar) && beatsPerBar > 0 ? beatsPerBar : 4;
  const B = sortedTimes(beats);
  const D = sortedTimes(downbeats);
  const measured = B.length > 0;
  let tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : 0;
  if (!tempo && B.length >= 2) tempo = 60 / median(B.slice(1).map((x, i) => x - B[i]));
  if (!(tempo > 0) || !Number.isFinite(tempo)) tempo = 120; // empty / silent / zero-bpm grids fall back to 120
  const spb = 60 / tempo;
  const off = measured ? B[0] : Number.isFinite(offset) ? offset : 0;
  const dur = Number.isFinite(duration) && duration >= 0 ? duration : null;
  // Frozen: a draw() that sorted or shifted this array would change every later frame (state carried between frames).
  const HITS = Object.freeze(sortedTimes(hits).filter((x) => x >= 0 && (dur == null || x < dur - 1e-9)));

  const beatSeq = measured ? seq(B, spb) : null;
  const barSeq = D.length ? seq(D, spb * bpb) : null;
  const beat = (n) => (beatSeq ? beatSeq.at(n) : off + n * spb);
  const position = (t) => (beatSeq ? beatSeq.pos(t) : (t - off) / spb);
  const bar = (n) => (barSeq ? barSeq.at(n) : beat(n * bpb));
  const barPosition = (t) => (barSeq ? barSeq.pos(t) : position(t) / bpb);

  const between = (at, pos, a, b) => {
    const out = [];
    if (!(b > a)) return out;
    for (let i = Math.ceil(pos(a) - 1e-7); out.length < 100000; i++) {
      const x = at(i);
      if (x >= b - 1e-9) break;
      if (x >= a - 1e-9) out.push(x);
    }
    return out;
  };

  const grid = {
    bpm: tempo,
    beatsPerBar: bpb,
    offset: off,
    spb,
    measured,
    duration: dur,
    beat,
    bar,
    position, // fractional beat index at time t (inverse of beat)
    barPosition,
    index: (t) => Math.floor(position(t) + 1e-9), // index of the beat at or before t
    barIndex: (t) => Math.floor(barPosition(t) + 1e-9),
    nearest(t) {
      const i = Math.floor(position(t));
      const a = beat(i);
      const b = beat(i + 1);
      return t - a <= b - t ? a : b;
    },
    beatsIn: (a, b) => between(beat, position, a, b),
    barsIn: (a, b) => between(bar, barPosition, a, b),
    hits: HITS, // measured peaks in seconds; [] without beats.json hits (a bpm grid has none)
    hitsIn: (a, b) => HITS.filter((x) => x >= a - 1e-9 && x < b - 1e-9), // same [a, b) window as beatsIn
    isOnBeat(t, tol = 0.02) {
      return Math.abs(t - grid.nearest(t)) <= tol;
    },
    count: dur != null ? between(beat, position, 0, dur).length : measured ? B.length : null,
    toJSON() {
      const beatsOut = dur != null ? between(beat, position, 0, dur) : measured ? [...B] : [];
      const barsOut = dur != null ? between(bar, barPosition, 0, dur) : D.length ? [...D] : [];
      const r6 = (x) => Math.round(x * 1e6) / 1e6;
      return {
        source: measured ? 'measured' : 'bpm',
        bpm: tempo,
        beatsPerBar: bpb,
        offset: off,
        duration: dur,
        count: grid.count,
        beats: beatsOut.map(r6),
        downbeats: barsOut.map(r6),
        hits: HITS.map(r6),
      };
    },
  };
  return grid;
}

// ---------------------------------------------------------------------------------------------------------------
// Films, scenes, chapters

export function defineFilm(factory) {
  if (typeof factory !== 'function') throw new TypeError('defineFilm(factory): factory must be a function (ctx) => ({ scenes, cues? })');
  return { __film: true, factory };
}

// scene(from, to, name, draw) | scene(from, to, draw) | scene({ from, to, name, draw, layer?, ...extra })
// layer (number, default 0) orders drawing: scenes paint by (layer, from), so a higher layer sits on top of every
// lower-layer scene whatever its start. Film-wide overlays that must not count as shots go in the factory's overlays.
export function scene(from, to, name, draw) {
  let extra = null;
  if (from && typeof from === 'object') {
    extra = from;
    ({ from, to, name, draw } = from);
  } else if (typeof name === 'function' && draw === undefined) {
    draw = name;
    name = undefined;
  }
  const label = name == null ? `scene@${from}` : String(name);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`scene "${label}": from/to must be finite seconds (got ${from}, ${to})`);
  if (!(to > from)) throw new Error(`scene "${label}": to (${to}) must be greater than from (${from})`);
  if (typeof draw !== 'function') throw new Error(`scene "${label}": draw must be a function (g, lt, c) => void`);
  if (extra && extra.layer != null && !Number.isFinite(extra.layer)) throw new Error(`scene "${label}": layer must be a finite number (got ${JSON.stringify(extra.layer)})`);
  return { ...(extra || {}), from, to, name: label, draw };
}

// A chapter is a run of shots; shot i spans at_i .. at_{i+1} (the last one runs to `to`). Chapter animators each own
// one film/scenes/chNN_<name>.js that exports chapter({...}); film.js lists the chapters.
export function chapter({ name, from, to, shots = [], cues = [] } = {}) {
  if (!name) throw new Error('chapter: name is required');
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) throw new Error(`chapter "${name}": needs finite from < to (got ${from}, ${to})`);
  const list = (shots || []).map((s, i) => ({ s, i })).sort((a, b) => a.s.at - b.s.at || a.i - b.i);
  if (!list.length) return { name, from, to, scenes: [placeholder(name, from, to)], cues };
  const scenes = list.map(({ s, i }, j) => {
    if (!Number.isFinite(s.at) || s.at < from - 1e-9 || s.at >= to) throw new Error(`chapter "${name}": shot "${s.name ?? i}" at ${s.at} is outside ${from}..${to}`);
    const end = j + 1 < list.length ? list[j + 1].s.at : to;
    if (!(end > s.at)) throw new Error(`chapter "${name}": two shots start at ${s.at}`);
    const { at, name: shotName, draw, ...rest } = s;
    return scene({ ...rest, from: at, to: end, name: `${name}/${shotName ?? j + 1}`, draw, chapter: { name, from, to } });
  });
  return { name, from, to, scenes, cues };
}

const fmtSec = (s) => `${s.toFixed(2)}s`;

// Keeps a film renderable while chapters are still being written in parallel.
export function placeholder(name, from, to) {
  return scene(from, to, `${name}/placeholder`, (g, lt, c) => {
    const col = (c.brand && c.brand.colors) || {};
    const fam = (c.brand && c.brand.fonts && c.brand.fonts.ui) || 'sans-serif';
    const u = c.u || 1;
    const S = (c.L && c.L.S) || { x: c.W * 0.08, y: c.H * 0.08, w: c.W * 0.84, h: c.H * 0.84 };
    const x = S.x + 40 * u;
    const y = S.y + S.h * 0.42;
    g.strokeStyle = col.muted || '#6C6B73';
    g.lineWidth = 3 * u;
    if (g.setLineDash) g.setLineDash([16 * u, 12 * u]);
    g.strokeRect(S.x + 8 * u, S.y + 8 * u, S.w - 16 * u, S.h - 16 * u);
    if (g.setLineDash) g.setLineDash([]);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = col.fg || '#F0EEE6';
    g.font = `600 ${56 * u}px "${fam}", sans-serif`;
    g.fillText(`chapter ${name}`, x, y);
    g.fillStyle = col.muted || '#6C6B73';
    g.font = `400 ${34 * u}px "${fam}", sans-serif`;
    g.fillText(`not painted yet · ${fmtSec(from)}–${fmtSec(to)}`, x, y + 56 * u);
    g.fillStyle = col.accent || '#D97757';
    g.fillRect(x, y + 96 * u, Math.max(0, (S.w - 80 * u) * c.p), 8 * u); // progress, so the span is never static
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Context + build

// ctx handed to the film factory. beats = parsed audio/beats.json (or null) — measured beats win over cfg.bpm;
// its hits[] become grid.hits even when no beats were tracked (peaks do not need a tempo).
export function filmContext(cfg, fmt, beats = null) {
  const c = cfg || {};
  const f = fmt || c.primaryFormat || '9x16';
  const dur = Number(c.duration) > 0 ? Number(c.duration) : 12;
  const fps = Number(c.fps) > 0 ? Number(c.fps) : 60;
  const hasBeats = beats && Array.isArray(beats.beats) && beats.beats.length > 0;
  const grid = beatGrid({
    bpm: hasBeats && beats.bpm > 0 ? beats.bpm : c.bpm,
    offset: hasBeats ? beats.offset : 0,
    beatsPerBar: (hasBeats && beats.beatsPerBar) || c.beatsPerBar || 4,
    beats: hasBeats ? beats.beats : null,
    downbeats: hasBeats ? beats.downbeats : null,
    duration: dur,
    hits: beats && Array.isArray(beats.hits) ? beats.hits : null,
  });
  const L = layout(f, c.safe && c.safe[f]);
  return {
    dur,
    fps,
    bpm: grid.bpm,
    loop: c.loop === true,
    grid,
    L,
    W: L.W,
    H: L.H,
    u: L.u,
    brand: c.brand || {},
    fmt: f,
    title: c.title || '',
    rngFor,
    cfg: c,
  };
}

export function buildFilm(film, ctx) {
  let spec;
  if (film && film.__film) spec = film.factory(ctx);
  else if (typeof film === 'function') spec = film(ctx);
  else spec = film;
  if (!spec || typeof spec !== 'object') throw new Error('the film factory must return an object { scenes: [...], cues? }');

  const cueSources = spec.cues ? [spec.cues] : [];
  const collect = (root) => {
    const out = [];
    const visit = (x) => {
      if (x == null || x === false) return;
      if (Array.isArray(x)) return x.forEach(visit);
      if (typeof x === 'object' && typeof x.draw !== 'function' && Array.isArray(x.scenes)) {
        visit(x.scenes); // a chapter() result: its scenes and cues join the film
        if (x.cues) cueSources.push(x.cues);
        return;
      }
      out.push(scene(x));
    };
    visit(root);
    return out;
  };
  const scenes = collect(spec.scenes);
  if (!scenes.length) throw new Error('the film has no scenes');
  // Overlays paint after every scene in array order (captions, seam transitions) and are never shots.
  const overlays = collect(spec.overlays);
  const indexed = scenes.map((s, i) => ({ s, i }));
  const layerOf = (s) => s.layer ?? 0;
  const sorted = [...indexed].sort((a, b) => layerOf(a.s) - layerOf(b.s) || a.s.from - b.s.from || a.i - b.i).map((x) => x.s);
  // Shots stay in time order whatever their layer (stills labels, critique boundaries, preview strip).
  const shots = indexed.sort((a, b) => a.s.from - b.s.from || a.i - b.i).map(({ s }) => ({ name: s.name, from: s.from, to: s.to }));

  const raw = [];
  for (const src of cueSources) {
    const v = typeof src === 'function' ? src(ctx && ctx.grid, ctx) : src;
    if (v == null) continue;
    if (!Array.isArray(v)) throw new Error('cues must be an array or (grid) => array');
    raw.push(...v);
  }
  const capture = spec.capture == null ? 'canvas' : spec.capture;
  if (capture !== 'canvas' && capture !== 'page') throw new Error(`capture must be 'canvas' or 'page' (got ${capture})`);
  const colors = (ctx && ctx.brand && ctx.brand.colors) || {};
  return {
    background: spec.background == null ? colors.bg || '#141413' : spec.background,
    capture,
    scenes: sorted,
    overlays,
    shots,
    cues: normalizeCues(raw),
    setup: typeof spec.setup === 'function' ? spec.setup : null,
  };
}

function resetState(g) {
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000';
  g.strokeStyle = '#000';
  g.lineWidth = 1;
  g.lineCap = 'butt';
  g.lineJoin = 'miter';
  g.miterLimit = 10;
  if (g.setLineDash) g.setLineDash([]);
  g.lineDashOffset = 0;
  g.shadowBlur = 0;
  g.shadowColor = 'rgba(0,0,0,0)';
  g.shadowOffsetX = 0;
  g.shadowOffsetY = 0;
  g.font = '10px sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  if ('filter' in g) g.filter = 'none';
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  if ('wordSpacing' in g) g.wordSpacing = '0px';
  g.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
}

// Paint frame t: background, then every scene with from <= t < to in array order (built.scenes is sorted by layer,
// then from; overlaps allowed), then every overlay by the same rule in its own array order, on top of all scenes.
// At the film's very end (t == dur) scenes and overlays that end exactly there still draw, so seek(dur) shows the
// final state, not an empty bg. frameCtx = { W, H, u, fmt, L, grid, brand, fps, dur, film, frameT, sub, subs }. The
// caller owns the transform (logical px).
//
// Time seen by scene code. Motion blur averages `subs` subframes of one output frame, so the physical model is:
//   t        the time being painted: the SUBFRAME time when blur is on (it differs between the subframes of one output frame),
//            so motion (springs, tracks, camera) blurs by itself. lt = t - scene.from.
//   frameT   the output frame's own (centre) time, the same for every subframe of that frame (= t when there is no blur).
//            The caller passes it as frameCtx.frameT; it defaults to t.
//   frameLt  frameT - scene.from: scene-local time of the output frame (lt of the frame's centre).
//   frame    the OUTPUT frame index = floor(frameT * fps + 1e-6), at the film's fps: every subframe of a frame shares it.
//   sub      subframe index 0..subs-1 (0 with no blur), subs = the number of subframes (1 with no blur).
// Frame-indexed things use frame (grain(g, W, H, c.frame) looks identical in a still, a preview and a blurred final
// render; c.frame * c.subs + c.sub gives every subframe its own grain, which the blur then averages down) and stepped
// time ("on twos") uses frameT / frameLt so a step is a hard cut, not a 50/50 blend of two steps:
// stepTime(c.frameLt, 12).
export function renderFrame(built, g, t, frameCtx = {}) {
  const film = frameCtx.film || {};
  const W = frameCtx.W ?? film.W;
  const H = frameCtx.H ?? film.H;
  const fps = frameCtx.fps ?? film.fps ?? 60;
  const dur = frameCtx.dur ?? film.dur ?? Infinity;
  const frameT = Number.isFinite(frameCtx.frameT) ? frameCtx.frameT : t;
  const subs = Number.isInteger(frameCtx.subs) && frameCtx.subs >= 1 ? frameCtx.subs : 1;
  const sub = Number.isInteger(frameCtx.sub) && frameCtx.sub >= 0 && frameCtx.sub < subs ? frameCtx.sub : 0;
  const base = { W, H, u: frameCtx.u ?? film.u ?? 1, fmt: frameCtx.fmt ?? film.fmt, L: frameCtx.L ?? film.L, grid: frameCtx.grid ?? film.grid, brand: frameCtx.brand ?? film.brand, fps, film, frameT, sub, subs };
  const frame = Math.floor(frameT * fps + 1e-6);
  const atEnd = t >= dur - 1e-9;
  g.save();
  resetState(g);
  const bg = built.background;
  if (typeof bg === 'function') {
    g.save();
    bg(g, t, { ...base, t, frame, frameLt: frameT });
    g.restore();
  } else if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
  }
  // No early exit on from > t: a higher layer restarts the time order.
  const paint = (list) => {
    for (const s of list) {
      if (t < s.from || !(t < s.to || (atEnd && t <= s.to + 1e-9))) continue;
      const lt = t - s.from;
      const sd = s.to - s.from;
      g.save();
      s.draw(g, lt, { ...base, t, lt, frameLt: frameT - s.from, dur: sd, p: clamp(lt / sd), frame, scene: s.name, chapter: s.chapter || null });
      g.restore();
    }
  };
  paint(built.scenes);
  if (built.overlays) paint(built.overlays);
  g.restore();
}

// [{ t, type, gain = 1, pan = 0, pitch = 1 }] sorted by t (stable). Accepts { sfx } for type and { vol } for gain
// (claude-animation cue format). Drops cues with t < 0 or a non-finite t; a cue without a type is an error.
export function normalizeCues(cues) {
  if (cues == null) return [];
  if (!Array.isArray(cues)) throw new TypeError('cues must be an array');
  const out = [];
  cues.forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    const t = Number(c.t ?? c.time);
    if (!Number.isFinite(t) || t < 0) return;
    const type = c.type ?? c.sfx;
    if (typeof type !== 'string' || !type) throw new Error(`cue #${i} at t=${t}: missing type (one of ${SFX_TYPES.join(', ')})`);
    const gain = Number(c.gain ?? c.vol ?? 1);
    const pan = Number(c.pan ?? 0);
    const pitch = Number(c.pitch ?? 1);
    out.push({
      t,
      type,
      gain: Number.isFinite(gain) && gain >= 0 ? gain : 1,
      pan: Number.isFinite(pan) ? clamp(pan, -1, 1) : 0,
      pitch: Number.isFinite(pitch) && pitch > 0 ? pitch : 1,
      i,
    });
  });
  out.sort((a, b) => a.t - b.t || a.i - b.i);
  return out.map(({ i, ...c }) => c);
}
