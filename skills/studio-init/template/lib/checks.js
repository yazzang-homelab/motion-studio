// lib/checks.js — numeric motion checks over probe series. Pure and isomorphic (no window, no document, no imports), so
// lib/timeline.js validates a film's checks with it at build time and tools/probe.mjs / the critique evaluate them in Node.
//
// Probes. A scene records numbers per frame with c.probe(name, value): a finite number, a boolean (0 / 1) or an array of
// up to 4 numbers (recorded as name.x, name.y, name.z, name.w). Names are global to the film (no scene prefix is added):
// two scenes writing one name in the same frame keep the last write. Without a recording sink (preview, render) c.probe
// is a no-op. Nested replays of the film (a contact sheet that paints other times through the scene draws) must guard
// their probes with !c.depth, or they record the replayed time's values.
//
// Checks. The film spec's `checks` (an array, or (grid, ctx) => array) turns those series into assertions. Times are
// seconds; `frame` is an output-frame index at the film fps (frame k shows time k / fps). Every check takes an optional
// `name` and an optional `kind` (inferred when missing):
//   point   { probe, at | frame, eq | near, tol = 1e-3 }        the value at that frame is within tol of eq (near = eq)
//           { probe, at | frame, min?, max? }                   ... or inside [min, max] (eq and min/max may be combined)
//   range   { probe, from, to, min?, max? }                     every recorded frame with time in [from, to) is inside
//                                                               [min, max] (at least one bound)
//   event   { probe, crosses, at | frame, tolFrames = 0, dir = 'any' | 'up' | 'down', from? }
//                                                               the FIRST frame (searching from `from`, default 0) where
//                                                               the value crosses `crosses` (prev < v <= cur going up,
//                                                               prev > v >= cur going down) is the expected frame
//                                                               ± tolFrames: foot contact, a light switching on, a label
//                                                               activating on its beat
//   smooth  { probe, kind: 'smooth' | maxKink, from?, to?, maxKink = 4, allow = [] }
//                                                               no velocity kink and no value jump: |Δv| at a frame
//                                                               (v = Δvalue × fps) is at most maxKink × the larger of its
//                                                               neighbours' |Δv| and the range's median |Δv|; the same
//                                                               test on |Δvalue| finds teleports. Changes under 10% of the
//                                                               range's peak are ignored, and so are frames within 1 frame
//                                                               of a shot boundary or of an `allow` time (seconds)
// Comparing a frame with its neighbours (not with a global median alone) keeps a spring's release legal: a spring starts
// at rest with full acceleration, so its first Δv is as large as the next one, while a linear tween starting or stopping
// changes velocity in ONE frame (a spike next to quiet neighbours).
// Loop films get a seam analysis per probe (seamAnalysis): the value step across frame N−1 → frame 0 and the velocity
// change there, both judged like the smooth check.

export const CHECK_KINDS = Object.freeze(['point', 'range', 'event', 'smooth']);
const KEYS = {
  point: ['name', 'kind', 'probe', 'at', 'frame', 'eq', 'near', 'tol', 'min', 'max'],
  range: ['name', 'kind', 'probe', 'from', 'to', 'min', 'max'],
  event: ['name', 'kind', 'probe', 'crosses', 'at', 'frame', 'tolFrames', 'dir', 'from'],
  smooth: ['name', 'kind', 'probe', 'from', 'to', 'maxKink', 'allow'],
};
const SIGNIFICANT = 0.1; // a change under 10% of the range's peak is never a kink or a jump
export const SEAM_RATIO = 4; // the loop seam step may be this many times the typical step

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const has = (o, k) => o[k] !== undefined && o[k] !== null;

function inferKind(c) {
  if (has(c, 'kind')) return c.kind;
  if (has(c, 'crosses')) return 'event';
  if (has(c, 'at') || has(c, 'frame')) return 'point';
  if (has(c, 'maxKink') || has(c, 'allow')) return 'smooth';
  if (has(c, 'from') || has(c, 'to')) return 'range';
  return null;
}

/** Validate and normalize a film's checks. Throws an Error naming the check (#index or name) on any problem. */
export function normalizeChecks(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new TypeError('checks must be an array or (grid, ctx) => array');
  return list.map((raw, i) => {
    const label = raw && typeof raw === 'object' && typeof raw.name === 'string' && raw.name ? `check "${raw.name}"` : `check #${i}`;
    const fail = (msg) => { throw new Error(`${label}: ${msg}`); };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('must be an object { probe, ... }');
    const kind = inferKind(raw);
    if (!CHECK_KINDS.includes(kind)) fail(kind == null ? 'cannot tell the kind: give at/frame (point), from/to with min/max (range), crosses (event) or kind: "smooth"' : `unknown kind "${kind}" (use ${CHECK_KINDS.join(', ')})`);
    const unknown = Object.keys(raw).filter((k) => !KEYS[kind].includes(k));
    if (unknown.length) fail(`unknown key(s) ${unknown.join(', ')} for a ${kind} check (allowed: ${KEYS[kind].join(', ')})`);
    if (typeof raw.probe !== 'string' || !raw.probe) fail('probe (the name passed to c.probe) is required');
    const c = { name: typeof raw.name === 'string' && raw.name ? raw.name : `${kind} ${raw.probe}${i ? ` #${i}` : ''}`, kind, probe: raw.probe };
    const num = (k, { min, int } = {}) => {
      if (!has(raw, k)) return undefined;
      const v = raw[k];
      if (!isNum(v)) fail(`${k} must be a finite number (got ${JSON.stringify(v)})`);
      if (min != null && v < min) fail(`${k} must be ≥ ${min} (got ${v})`);
      if (int && !Number.isInteger(v)) fail(`${k} must be an integer (got ${v})`);
      return v;
    };
    const when = () => {
      if (has(raw, 'at') && has(raw, 'frame')) fail('give at (seconds) or frame (index), not both');
      if (!has(raw, 'at') && !has(raw, 'frame')) fail('needs at (seconds) or frame (output-frame index)');
      if (has(raw, 'at')) c.at = num('at', { min: 0 });
      else c.frame = num('frame', { min: 0, int: true });
    };
    const bounds = () => {
      const lo = num('min');
      const hi = num('max');
      if (lo !== undefined) c.min = lo;
      if (hi !== undefined) c.max = hi;
      if (lo !== undefined && hi !== undefined && lo > hi) fail(`min (${lo}) is greater than max (${hi})`);
    };
    const span = () => {
      const from = num('from', { min: 0 });
      const to = num('to', { min: 0 });
      if (from !== undefined) c.from = from;
      if (to !== undefined) c.to = to;
      if (from !== undefined && to !== undefined && !(to > from)) fail(`to (${to}) must be greater than from (${from})`);
    };
    if (kind === 'point') {
      when();
      if (has(raw, 'eq') && has(raw, 'near')) fail('eq and near are the same; give one');
      const target = has(raw, 'eq') ? num('eq') : num('near');
      if (target !== undefined) c.eq = target;
      c.tol = num('tol', { min: 0 }) ?? 1e-3;
      bounds();
      if (c.eq === undefined && c.min === undefined && c.max === undefined) fail('a point check needs eq (or near) and/or min / max');
    } else if (kind === 'range') {
      span();
      if (c.from === undefined || c.to === undefined) fail('a range check needs from and to (seconds)');
      bounds();
      if (c.min === undefined && c.max === undefined) fail('a range check needs min and/or max (for velocity, use kind: "smooth")');
    } else if (kind === 'event') {
      when();
      c.crosses = num('crosses');
      if (c.crosses === undefined) fail('an event check needs crosses (the threshold)');
      c.tolFrames = num('tolFrames', { min: 0, int: true }) ?? 0;
      c.dir = raw.dir ?? 'any';
      if (!['any', 'up', 'down'].includes(c.dir)) fail(`dir must be "any", "up" or "down" (got ${JSON.stringify(raw.dir)})`);
      const from = num('from', { min: 0 });
      if (from !== undefined) c.from = from;
    } else {
      span();
      c.maxKink = num('maxKink', { min: 1 }) ?? 4;
      const allow = raw.allow ?? [];
      if (!Array.isArray(allow) || !allow.every(isNum)) fail('allow must be an array of times in seconds');
      c.allow = [...allow];
    }
    return c;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Series helpers. A series is an array indexed by sampled frame (index 0 = frame k0), NaN (or null) where not recorded.

const val = (s, i) => (i >= 0 && i < s.length && s[i] != null && Number.isFinite(s[i]) ? s[i] : NaN);

export function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** { min, max, peakSpeed (units/s), recorded } of a series sampled at fps. */
export function seriesStats(series, fps) {
  let min = Infinity;
  let max = -Infinity;
  let recorded = 0;
  let peak = 0;
  for (let i = 0; i < series.length; i++) {
    const v = val(series, i);
    if (!Number.isFinite(v)) continue;
    recorded++;
    if (v < min) min = v;
    if (v > max) max = v;
    const p = val(series, i - 1);
    if (Number.isFinite(p)) peak = Math.max(peak, Math.abs(v - p) * fps);
  }
  return recorded ? { min, max, peakSpeed: peak, recorded } : { min: NaN, max: NaN, peakSpeed: 0, recorded: 0 };
}

/** Frame-to-frame differences: d[i] = s[i] − s[i−1] (NaN at i = 0 or where either side is missing). */
export function diffs(series) {
  const d = new Array(series.length).fill(NaN);
  for (let i = 1; i < series.length; i++) d[i] = val(series, i) - val(series, i - 1);
  return d;
}

/**
 * Spikes of |x| against its neighbours: index i is a spike when |x[i]| ≥ SIGNIFICANT × peak and |x[i]| > ratio × max(|x[i−1]|,
 * |x[i+1]|, median |x|). Indices in `skip` are never reported. Returns [{ i, value, ref }].
 */
export function spikes(xs, ratio, skip = new Set()) {
  const abs = xs.map((x) => (Number.isFinite(x) ? Math.abs(x) : NaN));
  const peak = Math.max(0, ...abs.filter(Number.isFinite));
  if (!(peak > 0)) return [];
  const med = median(abs);
  const out = [];
  for (let i = 0; i < abs.length; i++) {
    const a = abs[i];
    if (!Number.isFinite(a) || skip.has(i) || a < SIGNIFICANT * peak) continue;
    const nb = Math.max(Number.isFinite(abs[i - 1]) ? abs[i - 1] : 0, Number.isFinite(abs[i + 1]) ? abs[i + 1] : 0, Number.isFinite(med) ? med : 0);
    if (a > ratio * nb + 1e-12 * peak) out.push({ i, value: xs[i], ref: nb });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);

/**
 * Evaluate normalized checks against probe series.
 *   series   { [probe]: number[] } indexed by sampled frame; index 0 is frame k0
 *   opts     { fps (sampling fps), filmFps = fps (the fps `frame` and tolFrames refer to), k0 = 0, frames = the longest
 *            series (how many frames were sampled from k0 on), shots = [{ from, to }] (boundaries for smooth checks) }
 * Returns [{ name, kind, probe, pass, detail, frame?, t?, value?, expected? }]; pass is null for a check outside the sampled
 * range (skipped).
 */
export function evaluateChecks(checks, series, { fps, filmFps = fps, k0 = 0, frames = null, shots = [] } = {}) {
  if (!(fps > 0)) throw new Error('evaluateChecks: fps must be > 0');
  if (frames == null) frames = Math.max(0, ...Object.values(series).map((x) => x.length));
  const toK = (c) => Math.round(Number.isFinite(c.at) ? c.at * fps : (c.frame * fps) / filmFps);
  const kOfT = (t) => Math.ceil(t * fps - 1e-6);
  const fmtF = (k) => `frame ${k} (${r4(k / fps)} s)`;
  const fmtV = (v) => (Number.isFinite(v) ? String(r4(v)) : 'not recorded');
  const boundaryK = new Set();
  for (const s of shots) for (const t of [s.from, s.to]) if (Number.isFinite(t) && t > 0) { const k = Math.round(t * fps); for (const d of [-1, 0, 1]) boundaryK.add(k + d); }
  return checks.map((c) => {
    const base = { name: c.name, kind: c.kind, probe: c.probe };
    const s = series[c.probe];
    const n = s ? s.length : 0;
    const at = (k) => (s ? val(s, k - k0) : NaN);
    const inside = (k) => k >= k0 && k < k0 + n;
    // A check whose frames lie outside the sampled range is skipped before anything else (a --from/--to run). With no
    // series at all the range is unknown: the check fails below as never recorded.
    if (frames > 0) {
      const end = k0 + frames;
      const outside = c.kind === 'point' || c.kind === 'event' ? (c.kind === 'point' || !s) && (toK(c) < k0 || toK(c) >= end)
        : c.kind === 'range' ? kOfT(c.to) <= k0 || kOfT(c.from) >= end
          : (Number.isFinite(c.to) && kOfT(c.to) <= k0) || (Number.isFinite(c.from) && kOfT(c.from) >= end);
      if (outside) return { ...base, pass: null, detail: 'outside the sampled range' };
    }
    if (!s || !s.some((x) => x != null && Number.isFinite(x))) {
      const known = Object.keys(series);
      return { ...base, pass: false, detail: `probe "${c.probe}" was never recorded${known.length ? ` (recorded: ${known.slice(0, 8).join(', ')}${known.length > 8 ? ' …' : ''})` : ' (no probes at all: call c.probe(name, value) in a scene)'}` };
    }
    if (c.kind === 'point') {
      const k = toK(c);
      if (!inside(k)) return { ...base, pass: null, frame: k, t: r4(k / fps), detail: `${fmtF(k)} is outside the sampled range` };
      const v = at(k);
      const why = [];
      if (!Number.isFinite(v)) why.push('not recorded at this frame');
      else {
        if (c.eq !== undefined && Math.abs(v - c.eq) > c.tol) why.push(`${fmtV(v)} ≠ ${c.eq} ±${c.tol}`);
        if (c.min !== undefined && v < c.min) why.push(`${fmtV(v)} < min ${c.min}`);
        if (c.max !== undefined && v > c.max) why.push(`${fmtV(v)} > max ${c.max}`);
      }
      const expected = [c.eq !== undefined ? `${c.eq} ±${c.tol}` : null, c.min !== undefined ? `≥ ${c.min}` : null, c.max !== undefined ? `≤ ${c.max}` : null].filter(Boolean).join(', ');
      return { ...base, pass: !why.length, frame: k, t: r4(k / fps), value: r4(v), expected, detail: why.length ? `${fmtF(k)}: ${why.join('; ')}` : `${fmtF(k)}: ${fmtV(v)} (${expected})` };
    }
    if (c.kind === 'range') {
      const a = Math.max(kOfT(c.from), k0);
      const b = Math.min(kOfT(c.to), k0 + n);
      const expected = `in [${c.min ?? '-∞'}, ${c.max ?? '∞'}]`;
      if (b <= a) return { ...base, pass: null, detail: `${r4(c.from)}–${r4(c.to)} s is outside the sampled range`, expected };
      let worst = null;
      let seen = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = a; k < b; k++) {
        const v = at(k);
        if (!Number.isFinite(v)) continue;
        seen++;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        const over = Math.max(c.min !== undefined ? c.min - v : -Infinity, c.max !== undefined ? v - c.max : -Infinity);
        if (over > 0 && (!worst || over > worst.over)) worst = { k, v, over };
      }
      if (!seen) return { ...base, pass: false, expected, detail: `not recorded between ${r4(c.from)} and ${r4(c.to)} s` };
      if (worst) return { ...base, pass: false, frame: worst.k, t: r4(worst.k / fps), value: r4(worst.v), expected, detail: `${fmtF(worst.k)}: ${fmtV(worst.v)} outside ${expected} (frames ${a}–${b - 1} span ${fmtV(lo)}..${fmtV(hi)})` };
      return { ...base, pass: true, expected, detail: `frames ${a}–${b - 1}: ${fmtV(lo)}..${fmtV(hi)} ${expected}` };
    }
    if (c.kind === 'event') {
      const kExp = toK(c);
      const tol = Math.round((c.tolFrames * fps) / filmFps);
      const expected = `frame ${kExp}${tol ? ` ±${tol}` : ''}`;
      const start = Math.max(k0 + 1, Number.isFinite(c.from) ? kOfT(c.from) : 0);
      let hit = null;
      for (let k = start; k < k0 + n; k++) {
        const p = at(k - 1);
        const v = at(k);
        if (!Number.isFinite(p) || !Number.isFinite(v)) continue;
        const up = p < c.crosses && v >= c.crosses;
        const down = p > c.crosses && v <= c.crosses;
        if ((c.dir !== 'down' && up) || (c.dir !== 'up' && down)) { hit = { k, v, dir: up ? 'up' : 'down' }; break; }
      }
      if (!hit) {
        if (!inside(kExp)) return { ...base, pass: null, frame: kExp, expected, detail: `${fmtF(kExp)} is outside the sampled range` };
        return { ...base, pass: false, frame: kExp, t: r4(kExp / fps), expected, detail: `never crosses ${c.crosses}${c.dir !== 'any' ? ` going ${c.dir}` : ''} (expected at ${fmtF(kExp)})` };
      }
      const off = hit.k - kExp;
      const pass = Math.abs(off) <= tol;
      return { ...base, pass, frame: hit.k, t: r4(hit.k / fps), value: r4(hit.v), expected, detail: `crosses ${c.crosses} going ${hit.dir} at ${fmtF(hit.k)}${pass ? '' : `, expected ${expected}: ${Math.abs(off)} frame(s) ${off > 0 ? 'late' : 'early'}`}` };
    }
    // smooth
    const a = Math.max(Number.isFinite(c.from) ? kOfT(c.from) : k0, k0);
    const b = Math.min(Number.isFinite(c.to) ? kOfT(c.to) : k0 + n, k0 + n);
    if (b - a < 3) return { ...base, pass: null, detail: 'fewer than 3 sampled frames in the range' };
    const seg = [];
    for (let k = a; k < b; k++) seg.push(at(k));
    const skip = new Set();
    for (const k of boundaryK) if (k >= a && k < b) skip.add(k - a);
    for (const t of c.allow) { const k = Math.round(t * fps); for (const d of [-1, 0, 1]) skip.add(k + d - a); }
    const step = diffs(seg); // value step per frame
    const vel = step.map((x) => x * fps);
    const dv = diffs(vel);
    const jumps = spikes(step, c.maxKink, skip).map((x) => ({ k: a + x.i, what: `value jumps ${r4(x.value)} in one frame (neighbouring steps ≤ ${r4(x.ref)})` }));
    const jumpK = new Set(jumps.flatMap((j) => [j.k, j.k + 1])); // a jump also kinks the velocity on both sides
    const kinks = spikes(dv, c.maxKink, skip).filter((x) => !jumpK.has(a + x.i)).map((x) => ({ k: a + x.i, what: `velocity changes by ${r4(x.value)}/s in one frame (neighbours ≤ ${r4(x.ref)}/s)` }));
    const bad = [...jumps, ...kinks].sort((p, q) => p.k - q.k);
    const range = `frames ${a}–${b - 1}`;
    if (!bad.length) return { ...base, pass: true, detail: `${range}: no velocity kink or jump (max ratio ${c.maxKink})` };
    return { ...base, pass: false, frame: bad[0].k, t: r4(bad[0].k / fps), value: r4(at(bad[0].k)), detail: `${range}: ${bad.slice(0, 3).map((x) => `${fmtF(x.k)} ${x.what}`).join('; ')}${bad.length > 3 ? ` … +${bad.length - 3} more` : ''}`, frames: bad.map((x) => x.k) };
  });
}

/**
 * Loop seam per probe (series over the WHOLE film, frames 0..N−1 at fps). The seam step is s[0] − s[N−1]; it must look
 * like a normal step (≤ SEAM_RATIO × the larger of the steps on both sides of the seam and the median step), and the
 * velocity change across the seam must not spike either (same rule, maxKink). Constant or unrecorded probes pass.
 * Returns [{ probe, pass, valueJump, typicalStep, velJump, typicalDv, detail }].
 */
export function seamAnalysis(series, { fps, maxKink = 4, ratio = SEAM_RATIO } = {}) {
  const out = [];
  for (const [probe, s] of Object.entries(series)) {
    const N = s.length;
    const v0 = val(s, 0);
    const vN = val(s, N - 1);
    if (N < 4 || !Number.isFinite(v0) || !Number.isFinite(vN)) continue;
    const step = diffs(s);
    const absSteps = step.map(Math.abs).filter(Number.isFinite);
    const peak = Math.max(0, ...absSteps);
    const seam = v0 - vN;
    const before = val(s, N - 1) - val(s, N - 2);
    const afterS = val(s, 1) - v0;
    const typical = Math.max(Math.abs(before) || 0, Math.abs(afterS) || 0, median(absSteps) || 0);
    const scale = Math.max(peak, Math.abs(v0), Math.abs(vN), 1e-12);
    const valueOk = Math.abs(seam) <= ratio * typical + 1e-9 * scale || Math.abs(seam) < SIGNIFICANT * peak * 0.1;
    // velocities around the seam: …, v(N−2→N−1), v(N−1→0), v(0→1), …
    const vb = before * fps;
    const vs = seam * fps;
    const va = afterS * fps;
    const dvIn = vs - vb;
    const dvOut = va - vs;
    const dvs = diffs(step.map((x) => x * fps)).map(Math.abs).filter(Number.isFinite);
    const typDv = Math.max(Math.abs(val(step, N - 1) * fps - val(step, N - 2) * fps) || 0, Math.abs(val(step, 2) * fps - va) || 0, median(dvs) || 0);
    const peakDv = Math.max(0, ...dvs, Math.abs(dvIn), Math.abs(dvOut));
    const velJump = Math.max(Math.abs(dvIn), Math.abs(dvOut));
    const velOk = velJump < SIGNIFICANT * peakDv || velJump <= maxKink * typDv + 1e-9 * Math.max(peakDv, 1e-12);
    const pass = valueOk && velOk;
    out.push({ probe, pass, valueJump: r4(seam), typicalStep: r4(typical), velJump: r4(velJump), typicalDv: r4(typDv),
      detail: pass ? `seam step ${r4(seam)} vs typical ${r4(typical)}; velocity change ${r4(velJump)}/s` : [!valueOk ? `value jumps ${r4(seam)} across the seam (typical step ${r4(typical)}): it does not return to its frame-0 value` : null, !velOk ? `velocity changes by ${r4(velJump)}/s across the seam (typical ${r4(typDv)}/s): it arrives moving and leaves at rest, or the reverse (loopTrack keeps velocity continuous)` : null].filter(Boolean).join('; ') });
  }
  return out;
}
