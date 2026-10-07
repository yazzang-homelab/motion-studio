// Pure metric functions for tools/critique.mjs: per-frame statistics, the streaming Analyzer (dead spans, per-beat
// energy, single-frame pops, strip centre, corner labels, frame borders, loop seam), beat times, cue sync, the loop
// verdict, the font-coverage verdict and the machine-found problem list. No browser, no files, no processes:
// critique.mjs feeds them pixels.
import { fmtTime, UsageError } from './studio.mjs';
import { meanAbsDiff, imageStats, silenceLabel } from './refs.mjs';

export const CRIT_DEFAULTS = { deadSpanSec: 2.0, staticEps: 0.35, cornerPct: 0.08, popRatio: 3.0, stepped: false, popIgnore: [] };
export const LEAD_IN = new Set(['whoosh', 'swoosh', 'riser']); // anticipation cues sit before the beat on purpose
const SYNC_TOL = 0.025;
const TOL = 24; // colour distance (max channel, 0–255) that counts as "not background"
export const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

// ---------------------------------------------------------------------------------------------------------------
// Pixel metrics

/**
 * Page scale of the live pixel pass (the pages then downsample to 160 px). Chrome's CPU canvas snaps glyphs under
 * ~256 device px to whole pixels vertically, so on a 320-px-wide page (scale 0.30 for 9x16, 0.17 for 16x9) slow or
 * settling text moves in isolated 1-px steps that the pop scan reads as hard jumps, while the full-size render is
 * smooth. From half size up the steps fall below a third of a 160-px sample pixel (demo 1x1, frames 10–14:
 * Δ 1.16 0 0.29 at 320 px; 0.56 0.54 0.38 at 540 px; 0.49 0.51 0.40 at full size).
 */
export const PIXEL_SCALE_MIN = 0.5;
export const pixelScale = (logicalWidth) => Math.min(1, Math.max(PIXEL_SCALE_MIN, 320 / logicalWidth));

export function frameStats(buf, w, h, cornerPct) {
  const bins = new Uint32Array(4096);
  for (let i = 0; i < buf.length; i += 4) bins[((buf[i] >> 4) << 8) | ((buf[i + 1] >> 4) << 4) | (buf[i + 2] >> 4)]++;
  let mode = 0;
  for (let b = 1; b < 4096; b++) if (bins[b] > bins[mode]) mode = b;
  let r = 0; let g = 0; let bl = 0; let n = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if ((((buf[i] >> 4) << 8) | ((buf[i + 1] >> 4) << 4) | (buf[i + 2] >> 4)) !== mode) continue;
    r += buf[i]; g += buf[i + 1]; bl += buf[i + 2]; n++;
  }
  const bg = [r / n, g / n, bl / n];
  const far = (i, ref = bg, tol = TOL) => Math.abs(buf[i] - ref[0]) > tol || Math.abs(buf[i + 1] - ref[1]) > tol || Math.abs(buf[i + 2] - ref[2]) > tol;
  let content = 0;
  for (let i = 0; i < buf.length; i += 4) if (far(i)) content++;
  // Border = a thin, near-uniform stroke within 6% of an edge: a line (≥ 92% of its central 80% one colour) that is
  // not background, no thicker than the band, and that ends in an abrupt step to what lies inside it. A smooth ramp
  // (the engine's vignette(), a gradient) is uniform along the line too but has no step; a wide coloured margin
  // around a card is thicker than the band.
  const lineOf = (coords) => {
    let s0 = 0; let s1 = 0; let s2 = 0;
    for (const i of coords) { s0 += buf[i]; s1 += buf[i + 1]; s2 += buf[i + 2]; }
    const m = [s0 / coords.length, s1 / coords.length, s2 / coords.length];
    let same = 0;
    for (const i of coords) if (!far(i, m, 16)) same++;
    return { m, uniform: same / coords.length >= 0.92 };
  };
  const apart = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
  const ruleRows = new Set();
  const ruleCols = new Set();
  const side = (horizontal, fromEnd) => {
    const dim = horizontal ? h : w;
    const span = horizontal ? w : h;
    const band = Math.max(2, Math.round(dim * 0.06));
    const depth = Math.min(dim >> 1, band + 3); // the profile reaches a little past the band to see where a stroke ends
    const posOf = (k) => (fromEnd ? dim - 1 - k : k);
    const profile = [];
    for (let k = 0; k < depth; k++) {
      const coords = [];
      for (let q = Math.round(span * 0.1); q < Math.round(span * 0.9); q++) coords.push((horizontal ? posOf(k) * w + q : q * w + posOf(k)) * 4);
      profile.push(lineOf(coords));
    }
    let hit = false;
    for (let k = 0; k < Math.min(band, depth); k++) {
      const p = profile[k];
      if (!p.uniform || apart(p.m, bg) <= 16) continue;
      let t = 1; // rows the stroke spans: consecutive lines of (nearly) the same colour
      while (k + t < depth && profile[k + t].uniform && apart(profile[k + t].m, p.m) <= 10) t++;
      if (k + t > band || k + t >= depth) continue; // thicker than the band, or never ends: a margin or a ramp
      if (apart(profile[k + t].m, profile[k + t - 1].m) < 12) continue; // no abrupt step inside the stroke: a slow ramp
      hit = true;
      for (const d of [-1, 0, 1]) (horizontal ? ruleRows : ruleCols).add(posOf(k) + d); // antialiased edges of the stroke
    }
    return hit;
  };
  const sides = { top: side(true, false), bottom: side(true, true), left: side(false, false), right: side(false, true) };
  // Corner boxes ignore edge rules, so a frame border is reported once (borders) and not as four corner labels.
  const cw = Math.max(2, Math.round(w * cornerPct));
  const chh = Math.max(2, Math.round(h * cornerPct));
  const box = (x0, y0) => {
    let c = 0; let n2 = 0;
    for (let y = y0; y < y0 + chh; y++) {
      if (ruleRows.has(y)) continue;
      for (let x = x0; x < x0 + cw; x++) { if (ruleCols.has(x)) continue; n2++; if (far((y * w + x) * 4)) c++; }
    }
    return n2 ? c / n2 : 0;
  };
  const corners = { tl: box(0, 0), tr: box(w - cw, 0), bl: box(0, h - chh), br: box(w - cw, h - chh) };
  return { bg: bg.map((v) => Math.round(v)), content: content / (w * h), corners, sides, border: Object.values(sides).filter(Boolean).length >= 3 };
}

// Solve the n×n system A x = b in place (Gaussian elimination, partial pivoting); a singular system returns zeros.
function solve(A, b, n) {
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
    if (Math.abs(A[p * n + c]) < 1e-12) return new Float64Array(n);
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let acc = b[r];
    for (let k = r + 1; k < n; k++) acc -= A[r * n + k] * x[k];
    x[r] = acc / A[r * n + r];
  }
  return x;
}

/**
 * Share of pixels that are NOT explained by a smooth background: the "how much is on screen" measure behind the
 * frame-0 check. The background is a quadratic surface a + bx + cy + dx² + exy + fy² per channel, fitted robustly, so a
 * plain gradient, a diagonal wash or a vignette over a flat colour counts as empty (the modal-colour measure read 30–90%
 * "content" on them and never raised the P0 for the gradient openers the house rules warn about). Three deterministic
 * starting sets compete (all pixels, the pixels near the most common colour, the outer 15% of the frame); each is
 * refined on its own inliers and the surface that explains the most pixels wins, so a large low-contrast shape on a
 * flat background is still content.
 * @param {Uint8Array|Buffer} buf RGBA; @param {number[]} bg modal background colour (starting set 2)
 * @returns {number} 0–1, pixels farther than TOL (max channel) from the winning surface
 */
export function surfaceContent(buf, w, h, bg, tol = TOL) {
  const n = w * h;
  if (n < 64 || w < 4 || h < 4) return null;
  const phi = new Float32Array(n * 6);
  for (let y = 0, p = 0; y < h; y++) {
    const ny = (2 * y) / (h - 1) - 1;
    for (let x = 0; x < w; x++, p++) {
      const nx = (2 * x) / (w - 1) - 1;
      phi.set([1, nx, ny, nx * nx, nx * ny, ny * ny], p * 6);
    }
  }
  const fit = (mask) => {
    const A = new Float64Array(36);
    const B = [new Float64Array(6), new Float64Array(6), new Float64Array(6)];
    // Every second pixel of every second row is plenty for six coefficients.
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const p = y * w + x;
        if (mask && !mask[p]) continue;
        const o = p * 6;
        for (let i = 0; i < 6; i++) {
          const fi = phi[o + i];
          for (let j = i; j < 6; j++) A[i * 6 + j] += fi * phi[o + j];
          for (let c = 0; c < 3; c++) B[c][i] += fi * buf[p * 4 + c];
        }
      }
    }
    for (let i = 0; i < 6; i++) { A[i * 6 + i] += 1e-6; for (let j = 0; j < i; j++) A[i * 6 + j] = A[j * 6 + i]; }
    return B.map((b) => solve(A.slice(), b.slice(), 6));
  };
  const residuals = (coef) => {
    const res = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const o = p * 6;
      let m = 0;
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let i = 0; i < 6; i++) v += coef[c][i] * phi[o + i];
        const d = Math.abs(buf[p * 4 + c] - v);
        if (d > m) m = d;
      }
      res[p] = m;
    }
    return res;
  };
  const starts = [null];
  const near = new Uint8Array(n);
  const edge = new Uint8Array(n);
  const bx = Math.max(1, Math.round(w * 0.15));
  const by = Math.max(1, Math.round(h * 0.15));
  for (let p = 0, y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      const i = p * 4;
      near[p] = Math.abs(buf[i] - bg[0]) <= tol && Math.abs(buf[i + 1] - bg[1]) <= tol && Math.abs(buf[i + 2] - bg[2]) <= tol ? 1 : 0;
      edge[p] = x < bx || x >= w - bx || y < by || y >= h - by ? 1 : 0;
    }
  }
  starts.push(near, edge);
  let best = 1;
  for (const start of starts) {
    let mask = start;
    let coef = fit(mask);
    let res = residuals(coef);
    for (let it = 0; it < 3; it++) {
      const next = new Uint8Array(n);
      let count = 0;
      for (let p = 0; p < n; p++) if (res[p] <= 12) { next[p] = 1; count++; }
      if (count < Math.max(24, n * 0.05)) break;
      mask = next;
      coef = fit(mask);
      res = residuals(coef);
    }
    let far = 0;
    for (let p = 0; p < n; p++) if (res[p] > tol) far++;
    best = Math.min(best, far / n);
  }
  return best;
}

/**
 * Splits the raw pop candidates by the film's own grammar (studio.json critique.stepped / critique.popIgnore):
 *   list    = candidates that stay findings (flicker always; jumps unless the film is stepped)
 *   info    = jump candidates of a stepped film (hard steps are its grammar): listed, never findings
 *   ignored = candidates inside a popIgnore span (both kinds), listed with the span that took them
 * `suppressed` says what was held back and why, for metrics.md. Pure; candidates keep their own fields.
 */
export function popSplit(pops, crit, fps) {
  const spans = Array.isArray(crit.popIgnore) ? crit.popIgnore.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) : [];
  const eps = 0.5 / fps;
  const list = []; const info = []; const ignored = [];
  for (const p of pops) {
    const span = spans.find(([a, b]) => p.t >= a - eps && p.t <= b + eps);
    if (span) ignored.push({ ...p, span: [span[0], span[1]] });
    else if (crit.stepped === true && p.kind === 'jump') info.push(p);
    else list.push(p);
  }
  const suppressed = { stepped: crit.stepped === true, steppedJumps: info.length, popIgnore: spans, ignored: ignored.length,
    why: [
      ...(crit.stepped === true ? [`critique.stepped = true: ${info.length} hard-jump candidate(s) are the film's own stepped grammar, listed as info; a one-frame flicker is still a P1`] : []),
      ...(spans.length ? [`critique.popIgnore ${JSON.stringify(spans)}: ${ignored.length} candidate(s) inside the span(s) suppressed (jumps and flickers alike)`] : []),
    ] };
  return { list, info, ignored, suppressed };
}

/** Streams frames (in order, index k at t = k/fps) and keeps only what the metrics need. */
export class Analyzer {
  /**
   * `frames` = index one past the last frame (absolute). `k0` = the first frame analysed (a chapter review with
   * --from): frame indices stay absolute (a pop at k is reported at k / fps), the series just starts at k0, and the
   * film's frame-0 check is skipped when k0 > 0 (that frame is not the film's first).
   */
  constructor({ fps, frames, crit, sampleFps = 10, noise = 0, k0 = 0 }) {
    Object.assign(this, { fps, frames, crit, sampleFps, noise, k0 });
    this.d = new Float64Array(frames + 1).fill(NaN); // d[k] = |f[k-1] − f[k]|
    this.bridge = new Float64Array(frames + 1).fill(NaN); // bridge[k] = |f[k-1] − f[k+1]|
    this.samples = []; // 10 fps: { t, k, diff, stats }
    this.nextSample = k0;
    this.sampleNo = 0;
  }
  /** Frame indices of the 10 fps series from k0 up to (excluding) N (the same schedule push() follows). */
  sampleFrames(N) {
    const out = [];
    for (let j = 0; ; j++) { const k = this.k0 + Math.round((j * this.fps) / this.sampleFps); if (k >= N) break; if (!out.length || k > out.at(-1)) out.push(k); }
    return out;
  }
  sample(buf, k, w, h) {
    this.w = w; this.h = h;
    if (k === this.k0) {
      this.f0 = buf;
      if (this.k0 === 0) {
        this.frame0 = { ...frameStats(buf, w, h, this.crit.cornerPct), ...imageStats(buf, w, h) };
        // "Empty" is judged against a smooth background model, not one colour (a gradient is not content).
        const smooth = surfaceContent(buf, w, h, this.frame0.bg);
        if (smooth !== null) this.frame0.content = Math.min(this.frame0.content, smooth);
      }
    }
    this.samples.push({ t: k / this.fps, k, diff: this.lastSample ? meanAbsDiff(this.lastSample, buf, this.noise) : null, stats: frameStats(buf, w, h, this.crit.cornerPct) });
    this.lastSample = buf;
  }
  /** Streaming path (video mode): every frame in order. */
  push(buf, k, w, h) {
    if (this.prev) this.d[k] = meanAbsDiff(this.prev, buf, this.noise);
    if (this.prev2) this.bridge[k - 1] = meanAbsDiff(this.prev2, buf, this.noise);
    if (k >= this.nextSample) {
      this.sample(buf, k, w, h);
      this.sampleNo++;
      this.nextSample = this.k0 + Math.round((this.sampleNo * this.fps) / this.sampleFps);
    }
    this.prev2 = this.prev;
    this.prev = buf;
    this.count = k + 1;
  }
  /** Precomputed path (live mode): per-frame diffs from the page plus the 10 fps sample frames, in order. */
  ingest({ d, bridge, samples, last, count, w, h }) {
    for (const [k, v] of Object.entries(d)) this.d[Number(k)] = v;
    for (const [k, v] of Object.entries(bridge)) this.bridge[Number(k)] = v;
    for (const s of samples) this.sample(s.buf, s.k, w, h);
    this.prev = last;
    this.count = count;
  }
  finish({ shots, cues, beats }) {
    const { fps, crit, k0 } = this;
    const N = this.count;
    const nearBoundary = (k) => shots.some((s) => Math.abs(s.from * fps - k) <= 1.5 || Math.abs(s.to * fps - k) <= 1.5);
    const nearCue = (k) => cues.some((c) => Math.abs(c.t * fps - k) <= 2.5);
    // dead spans on the 10 fps series
    const spans = [];
    let run = null;
    for (const s of this.samples.slice(1)) {
      if (s.diff < crit.staticEps) { run ??= { from: Math.max(s.t - 1 / this.sampleFps, k0 / fps), to: s.t }; run.to = s.t; } else { if (run) spans.push(run); run = null; }
    }
    if (run) spans.push(run);
    const dead = spans.map((s) => ({ from: round(s.from), to: round(s.to), sec: round(s.to - s.from, 2) })).filter((s) => s.sec >= crit.deadSpanSec - 1e-6);
    // Per-beat energy on the same 0.1 s series as staticEps (per-frame diffs are ~fps/10 times smaller). A range review
    // (k0 > 0, or a range that ends early) scores only the beats that start inside it; beat numbers stay the film's.
    const beatEnergy = [];
    beats.forEach((t, i) => {
      if (t < k0 / fps - 1e-6 || t >= N / fps - 1e-6) return;
      const end = beats[i + 1] ?? N / fps;
      const inBeat = this.samples.filter((x) => x.diff != null && x.t > t + 1e-6 && x.t <= end + 1e-6);
      beatEnergy.push({ beat: i, t: round(t), energy: round(inBeat.length ? inBeat.reduce((acc, x) => acc + x.diff, 0) / inBeat.length : 0, 3) });
    });
    // pops: flicker (one frame unlike both neighbours) and jumps (a diff spike vs its neighbours)
    const pops = [];
    const cuts = [];
    const minPop = 1.0;
    const flick = new Set();
    for (let k = 1; k < N - 1; k++) {
      const din = this.d[k]; const dout = this.d[k + 1]; const br = this.bridge[k];
      if (!Number.isFinite(din) || !Number.isFinite(dout) || !Number.isFinite(br)) continue;
      const lo = Math.min(din, dout);
      if (lo > minPop && lo > crit.popRatio * Math.max(br, 0.3)) {
        flick.add(k);
        pops.push({ kind: 'flicker', frame: k, t: round(k / fps), diff: round(lo, 2), neighbours: round(br, 2), ratio: round(lo / Math.max(br, 0.3), 1), atShotBoundary: nearBoundary(k), nearCue: nearCue(k) });
      }
    }
    for (let k = 1; k < N; k++) {
      const v = this.d[k];
      if (!Number.isFinite(v) || v <= minPop || flick.has(k) || flick.has(k - 1)) continue;
      const nb = [this.d[k - 2], this.d[k - 1], this.d[k + 1], this.d[k + 2]].filter(Number.isFinite);
      if (!nb.length) continue;
      const mean = nb.reduce((a, b) => a + b, 0) / nb.length;
      if (v > crit.popRatio * Math.max(mean, 0.1)) {
        const item = { kind: 'jump', frame: k, t: round(k / fps), diff: round(v, 2), neighbours: round(mean, 2), ratio: round(v / Math.max(mean, 0.1), 1), atShotBoundary: nearBoundary(k), nearCue: nearCue(k) };
        (item.atShotBoundary ? cuts : pops).push(item);
      }
    }
    pops.sort((a, b) => a.frame - b.frame);
    const sorted = popSplit(pops, crit, fps);
    // strip centre: most motion (5-frame mean) away from cuts
    let best = -1; let bestK = Math.round((k0 + N) / 2);
    for (let k = 3; k < N - 3; k++) {
      if (nearBoundary(k)) continue;
      let s = 0; let n = 0;
      for (let j = k - 2; j <= k + 2; j++) if (Number.isFinite(this.d[j])) { s += this.d[j]; n++; }
      if (n && s / n > best) { best = s / n; bestK = k; }
    }
    const S = this.samples;
    const cornerShare = {};
    for (const c of ['tl', 'tr', 'bl', 'br']) cornerShare[c] = round(S.filter((s) => s.stats.corners[c] > 0.004 && s.stats.corners[c] < 0.45).length / (S.length || 1), 3);
    const borderShare = round(S.filter((s) => s.stats.border).length / (S.length || 1), 3);
    const sideShare = {};
    for (const k of ['top', 'bottom', 'left', 'right']) sideShare[k] = round(S.filter((s) => s.stats.sides[k]).length / (S.length || 1), 3);
    return {
      frames: N - k0, sampled: { fps: this.sampleFps, count: S.length, width: this.w, height: this.h },
      deadSpans: { staticEps: crit.staticEps, minSec: crit.deadSpanSec, spans: dead, beatEnergy, staticBeats: beatEnergy.filter((b) => b.energy < crit.staticEps).map((b) => b.beat) },
      pops: { ratio: crit.popRatio, list: sorted.list, info: sorted.info, ignored: sorted.ignored, suppressed: sorted.suppressed, cuts: cuts.map(({ frame, t, diff }) => ({ frame, t, diff })) },
      frame0: k0 > 0 ? { skipped: true, reason: `the range starts at frame ${k0}, not at the film's first frame`, content: null, edgeShare: null, background: null, pass: true }
        : { content: round(this.frame0?.content ?? 0, 4), edgeShare: round(this.frame0?.edgeShare ?? 0, 4), background: this.frame0?.bg ?? null, pass: (this.frame0?.content ?? 0) >= 0.005 },
      corners: { pct: crit.cornerPct, share: cornerShare, pass: Object.values(cornerShare).every((v) => v < 0.3) },
      borders: { share: borderShare, sides: sideShare, pass: borderShare < 0.25 },
      seam: N >= 3 ? { seamDiff: round(meanAbsDiff(this.prev, this.f0, this.noise), 3), prevDiff: round(this.d[N - 1], 3) } : null,
      stripCenter: bestK,
    };
  }
}

export function beatTimes(grid, duration, cfg) {
  const measured = Array.isArray(grid?.beats) ? grid.beats.filter(Number.isFinite) : [];
  if (measured.length) return measured.filter((b) => b >= 0 && b < duration - 1e-9).sort((a, b) => a - b);
  const bpm = grid?.bpm > 0 ? grid.bpm : cfg.bpm > 0 ? cfg.bpm : 120;
  const off = Number.isFinite(grid?.offset) ? grid.offset : 0;
  const out = [];
  for (let n = Math.ceil(-off / (60 / bpm) - 1e-9); ; n++) { const t = off + (n * 60) / bpm; if (t >= duration - 1e-9) break; if (t >= -1e-9) out.push(Math.max(0, t)); }
  return out;
}

export function syncMetrics(cues, beats, downbeats, shots) {
  const near = (t, list) => list.reduce((m, b) => Math.min(m, Math.abs(b - t)), Infinity);
  const rows = cues.map((c) => ({ t: round(c.t), type: c.type, offMs: Math.round(near(c.t, beats) * 1000) }));
  const on = rows.filter((r) => r.offMs <= SYNC_TOL * 1000);
  const impact = rows.filter((r) => !LEAD_IN.has(r.type));
  const bounds = [...new Set(shots.map((s) => s.from).filter((t) => t > 1e-6))];
  const bars = downbeats.length ? downbeats : beats.filter((_, i) => i % 4 === 0);
  return {
    tolMs: SYNC_TOL * 1000, cues: rows.length, onBeat: on.length, share: rows.length ? round(on.length / rows.length) : null,
    impactShare: impact.length ? round(impact.filter((r) => r.offMs <= SYNC_TOL * 1000).length / impact.length) : null,
    offGrid: rows.filter((r) => r.offMs > SYNC_TOL * 1000), shotChanges: bounds.length,
    shotChangesOnDownbeat: bounds.filter((t) => near(t, bars) <= SYNC_TOL).length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Loop seam

export const LOOP_RATIO = 1.5; // last→first step vs the step between the last two frames
export const LOOP_END_EPS = 0.1; // mean |end − frame 0| (0–255, 270-px panes) below which a hash mismatch is invisible rounding

/**
 * The live half of the loop check. Loop films wrap every time (seek(dur) paints frame 0), so hash(0) === hash(dur) is
 * always true; a runtime that honours hash(t, { wrap: false }) paints the raw end state instead, clamped to
 * [0, dur]. Feature test without a version bump: honoured, t = 1.5·dur clamps to the same frame as t = dur; ignored,
 * both wrap (to 0.5·dur and 0), which differ unless the film is static there. A wrong "honoured" in that static case
 * compares two wrapped frames and passes, which is the old behaviour, never a false failure.
 * @returns {{ unwrapped:boolean, hashEqual:boolean|null }}
 */
export function loopClosure({ h0, hEnd, hBeyond }) {
  const unwrapped = typeof hEnd === 'string' && hEnd === hBeyond;
  return { unwrapped, hashEqual: unwrapped ? h0 === hEnd : null };
}

/**
 * Loop verdict. seam = { seamDiff: |f[N−1] − f0|, prevDiff: |f[N−2] − f[N−1]| } | null; probe = null (video mode) or
 * { unwrapped, hashEqual, endDiff }. Continuity: ratio ≤ LOOP_RATIO or a seam step under staticEps. Closure (only
 * when the runtime can paint t = dur unwrapped): equal hashes, or a mean end-vs-start difference under LOOP_END_EPS.
 */
export function loopVerdict(seam, probe, crit) {
  const ratio = seam && seam.prevDiff > 0 ? seam.seamDiff / seam.prevDiff : null;
  const continuity = ratio === null ? (seam?.seamDiff ?? 0) < crit.staticEps : ratio <= LOOP_RATIO || seam.seamDiff < crit.staticEps;
  const unwrapped = !!probe?.unwrapped;
  const hashEqual = unwrapped ? probe.hashEqual : null;
  const endDiff = unwrapped && Number.isFinite(probe.endDiff) ? round(probe.endDiff, 3) : null;
  const closes = hashEqual !== false || (endDiff != null && endDiff < LOOP_END_EPS);
  return { enabled: true, unwrapped, invariant: unwrapped ? 'hash(0) === hash(dur, { wrap: false })' : null, hashEqual, endDiff,
    ...(seam ?? {}), ratio: round(ratio, 2), continuity, closes, pass: continuity && closes };
}

/** |a − b| × amp per RGB channel of two same-size RGBA frames (opaque result), for the loop panel. */
export function diffImage(a, b, amp = 4) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.abs(a[i + c] - b[i + c]) * amp);
    out[i + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Review range (--from / --to: one chapter of a long film)

/**
 * The frames a review covers. `from`/`to` are the flag values (seconds, undefined = the film's start / end); the range is
 * snapped to the fps grid and clamped to [0, frames]. Returns { from, to, fromFrame, toFrame, frames, full }; `full` is
 * true for the whole film (then the frame-0 and loop-seam checks apply). Bad values throw a UsageError.
 */
export function resolveRange({ from, to } = {}, { duration, fps, frames, minFrames = 3 }) {
  const has = (v) => v !== undefined && v !== null;
  if (has(from) && !(Number(from) >= 0)) throw new UsageError(`--from must be >= 0 (got ${from})`);
  if (has(to) && !(Number(to) > (has(from) ? Number(from) : 0))) throw new UsageError(`--to must be greater than ${has(from) ? '--from' : '0'} (got ${to})`);
  const k0 = has(from) ? Math.round(Number(from) * fps) : 0;
  const k1 = has(to) ? Math.min(frames, Math.round(Number(to) * fps)) : frames;
  if (k0 >= frames) throw new UsageError(`--from ${from} is past the end of the film (${round(duration, 3)} s)`);
  if (k1 - k0 < Math.min(minFrames, frames)) throw new UsageError(`the range ${has(from) ? from : 0}-${has(to) ? to : round(duration, 3)} s holds ${Math.max(0, k1 - k0)} frame(s) at ${fps} fps; a review needs at least ${minFrames}`);
  return { from: round(k0 / fps, 4), to: round(k1 / fps, 4), fromFrame: k0, toFrame: k1, frames: k1 - k0, full: k0 === 0 && k1 === frames };
}

// ---------------------------------------------------------------------------------------------------------------
// Glyph-fallback preflight (Korean / CJK safety)

const MAX_MISSING_LISTED = 40;

/**
 * textUse() answers of one or more pages → [{ family, weight, style, chars }]: one row per (family, weight, style), chars =
 * the sorted string of unique non-whitespace characters drawn with it (the union over the pages).
 */
export function mergeTextUse(lists) {
  const map = new Map();
  for (const uses of lists) {
    for (const u of Array.isArray(uses) ? uses : []) {
      if (!u || typeof u.family !== 'string' || !u.family) continue;
      const weight = String(u.weight ?? '400');
      const style = String(u.style ?? 'normal');
      const key = [u.family.toLowerCase(), weight, style].join('|');
      const row = map.get(key) ?? { family: u.family, weight, style, set: new Set() };
      for (const ch of Array.from(String(u.chars ?? ''))) if (!/^\s$/u.test(ch)) row.set.add(ch);
      map.set(key, row);
    }
  }
  return [...map.values()].map(({ set, ...r }) => ({ ...r, chars: [...set].sort().join('') }))
    .sort((a, b) => a.family.localeCompare(b.family) || a.weight.localeCompare(b.weight) || a.style.localeCompare(b.style));
}

/**
 * Coverage rows → the metrics.json `fonts` object. A row is { family, weight, style, needed, registered, reason?,
 * missing: [{ ch, cp, reason }] } as measured next to the page's fonts (critique.mjs#pageGlyphCoverage). A character with
 * no glyph in its family is drawn by a system font (a different one on every machine) or as a tofu box: P0 font-fallback.
 * At most 40 missing characters are listed per row; missingCount is the total.
 */
export function fontVerdict(rows, { source = 'draw.js text tracking (window.__studio.textUse)' } = {}) {
  const entries = rows.map((r) => {
    const missing = Array.isArray(r.missing) ? r.missing : [];
    return { family: r.family, weight: String(r.weight ?? '400'), style: r.style ?? 'normal', chars: r.needed ?? 0, registered: r.registered !== false, reason: r.reason ?? null,
      missingCount: missing.length, missing: missing.slice(0, MAX_MISSING_LISTED), pass: missing.length === 0 };
  });
  return { available: true, skipped: false, source, faces: entries.length, characters: entries.reduce((n, e) => n + e.chars, 0), entries, pass: entries.every((e) => e.pass) };
}

/** The fonts object when the check cannot run: a note, never a failure. */
export const fontsUnavailable = (reason) => ({ available: false, skipped: true, reason: `preflight: unavailable (${reason})`, entries: [], pass: true });

// ---------------------------------------------------------------------------------------------------------------
// Findings

export function findings(r, crit) {
  const out = [];
  // `fresh` = isNew flag of a candidate against the previous run's baseline (undefined = no baseline to compare with).
  const add = (severity, t, text, metric, fresh) => out.push({ severity, t: t == null ? null : round(t, 2), text: fresh === false ? `${text} [same as the previous run]` : text, metric, ...(fresh === true ? { new: true } : {}) });
  const px = r.px;
  if (r.determinism && !r.determinism.skipped && r.determinism.mismatches.length) {
    const m = r.determinism.mismatches;
    add('P0', m[0].t, `frames differ between renders at ${m.length} sample time(s) (${m.slice(0, 4).map((x) => fmtTime(x.t)).join(', ')}): state carried between frames or an unseeded source; run node tools/lint.mjs`, 'determinism');
  }
  if (r.fonts && !r.fonts.skipped) {
    for (const e of r.fonts.entries.filter((x) => x.missingCount)) {
      const list = e.missing.map((m) => m.ch).join(' ');
      const why = e.reason === 'unregistered' ? `"${e.family}" is not a registered font, so every character comes from a system font`
        : e.reason === 'system' ? `"${e.family}" is a generic system family, not a font bundled with the film`
          : `"${e.family}" ${e.weight}${e.style !== 'normal' ? ` ${e.style}` : ''} has no glyph for ${e.missingCount} of ${e.chars} character(s) the film draws`;
      add('P0', null, `font-fallback: ${why}: ${list}${e.missingCount > e.missing.length ? ` … +${e.missingCount - e.missing.length} more` : ''}. The machine draws a system font (different on every computer) or a tofu box. Register a font that covers them (node tools/fonts.mjs add-file <file> --family "Name", check with node tools/fonts.mjs coverage --text "…" --family "Name") or change the family`, 'font-fallback');
    }
  }
  if (!px.frame0.pass) add('P0', 0, `frame 0 is nearly empty (${(px.frame0.content * 100).toFixed(2)}% of pixels differ from the background); open mid-action`, 'frame0');
  if (r.loop.enabled && !r.loop.pass) {
    const why = [];
    if (!r.loop.continuity) why.push(`loop seam jumps: last→first diff ${r.loop.seamDiff} vs ${r.loop.prevDiff} between the last two frames (ratio ${r.loop.ratio ?? 'n/a'}, needs ≤ ${LOOP_RATIO})`);
    if (!r.loop.closes) why.push(`loop does not close: frame t=dur (unwrapped) ≠ frame 0 (hash differs, mean diff ${r.loop.endDiff ?? 'n/a'}; loop.png): something does not return to its start value (loopTrack, last key = first)`);
    add('P0', r.film.duration, why.join('; '), 'loop');
  }
  for (const s of px.deadSpans.spans) add('P1', s.from, `dead span ${s.sec} s until ${fmtTime(s.to)}: nothing moves (mean diff < ${crit.staticEps})`, 'deadSpans', s.isNew);
  for (const p of px.pops.list.filter((x) => !x.atShotBoundary).sort((x, y) => (y.isNew === true) - (x.isNew === true)).slice(0, 6)) {
    if (p.kind === 'flicker') add('P1', p.t, `single-frame pop at frame ${p.frame}: it differs from both neighbours ${p.ratio}× more than they differ from each other${p.nearCue ? ' (next to a cue: an intended flash?)' : ''} (strip around it: --strip-at ${p.t})`, 'pops', p.isNew);
    else add('P2', p.t, `hard jump at frame ${p.frame} (${p.ratio}× the neighbouring motion): something popped in, teleported or flipped (text/digits) instead of easing${p.nearCue ? ' (on a cue)' : ''}`, 'pops', p.isNew);
  }
  const cornerNames = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' };
  for (const [c, v] of Object.entries(px.corners.share)) if (v >= 0.3) add('P1', null, `small content in the ${cornerNames[c]} corner box (${Math.round(crit.cornerPct * 100)}%) in ${Math.round(v * 100)}% of sampled frames: a corner label? (banned default; P0 if confirmed)`, 'corners');
  if (!px.borders.pass) add('P1', null, `uniform lines along ≥ 3 edges in ${Math.round(px.borders.share * 100)}% of sampled frames: a frame border? (banned default; P0 if confirmed)`, 'borders');
  if (r.sync.impactShare != null && r.sync.impactShare < 0.8 && r.sync.cues >= 4) add('P2', r.sync.offGrid.find((c) => !LEAD_IN.has(c.type))?.t ?? null, `${Math.round((1 - r.sync.impactShare) * 100)}% of hit cues sit > 25 ms off the beat grid (${r.sync.offGrid.filter((c) => !LEAD_IN.has(c.type)).slice(0, 4).map((c) => `${c.type}@${c.t}`).join(', ')})`, 'sync');
  if (r.sync.shotChanges && r.sync.shotChangesOnDownbeat < r.sync.shotChanges) add('P2', null, `${r.sync.shotChanges - r.sync.shotChangesOnDownbeat} of ${r.sync.shotChanges} shot changes miss a downbeat`, 'sync');
  const beatsN = px.deadSpans.beatEnergy.length;
  if (beatsN && px.deadSpans.staticBeats.length / beatsN > 0.25 && !px.deadSpans.spans.length) add('P2', null, `${px.deadSpans.staticBeats.length} of ${beatsN} beats are static (beats ${px.deadSpans.staticBeats.slice(0, 8).join(', ')})`, 'deadSpans');
  if (r.audio && !r.audio.skipped) {
    if (!r.audio.present) add('P0', null, 'no audio stream: run npm run mix', 'audio');
    else {
      if (!(Math.abs(r.audio.I - r.audio.target) <= r.audio.tol)) add('P1', null, `integrated loudness ${r.audio.I} LUFS, target ${r.audio.target} ±${r.audio.tol}`, 'audio');
      if (r.audio.TP > 0) add('P0', null, `true peak ${r.audio.TP} dBTP clips (> 0)`, 'audio');
      else if (r.audio.TP > r.audio.truePeak + 0.05) add('P1', null, `true peak ${r.audio.TP} dBTP above ${r.audio.truePeak}`, 'audio');
      if (r.audio.duration != null && Math.abs(r.audio.duration - r.audio.videoDuration) > 1 / r.film.fps + 0.001) add('P1', null, `audio ${r.audio.duration} s vs video ${r.audio.videoDuration} s`, 'audio');
      const sil = r.audio.silence;
      for (const g of (sil?.gaps ?? []).slice(0, 6)) {
        add('P1', g.from, `audio gap: silence ${silenceLabel(g)} (until ${fmtTime(g.to)}, below ${sil.noiseDb} dB): a stem ends early or a bed plays under nothing. Fix the stem (npm run score / sfx / voice) and re-mix, or list an intended silence in studio.json critique.allowSilence ([[${g.from}, ${g.to}]])`, 'audio-gap');
      }
      if ((sil?.gaps?.length ?? 0) > 6) add('P1', null, `audio gap: ${sil.gaps.length - 6} more silent span(s) after the first 6 (metrics.json audio.silence.gaps)`, 'audio-gap');
    }
  }
  const rank = { P0: 0, P1: 1, P2: 2 };
  // Worst first; inside a severity the findings that are new since the previous run come first (the critic reviews the delta).
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.new ? 1 : 0) - (a.new ? 1 : 0) || (a.t ?? 1e9) - (b.t ?? 1e9));
}
