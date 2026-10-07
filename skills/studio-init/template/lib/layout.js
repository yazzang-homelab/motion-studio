// lib/layout.js — one timeline, every format. Scenes position things against layout(fmt), never literal pixels:
// fractions of the safe rect S, sizes in L.u, and per-format choices via L.pick({...}). Reframe, never crop.
// Isomorphic: no window/document at module scope (tools import it from Node).

import { isTextTracking, recordText, textWidth } from './draw.js';

export const FORMATS = Object.freeze({
  '9x16': Object.freeze({ w: 1080, h: 1920, label: '9:16 · Reels, TikTok, Shorts' }),
  '1x1': Object.freeze({ w: 1080, h: 1080, label: '1:1 · X / feed' }),
  '16x9': Object.freeze({ w: 1920, h: 1080, label: '16:9 · YouTube, site' }),
  '4x5': Object.freeze({ w: 1080, h: 1350, label: '4:5 · feed portrait' }),
});

// Conservative defaults (platform overlays are not standardized); override per project in studio.json "safe".
export const DEFAULT_SAFE = Object.freeze({
  '9x16': Object.freeze({ top: 0.1, bottom: 0.16, left: 0.06, right: 0.08 }),
  '1x1': Object.freeze({ top: 0.07, bottom: 0.07, left: 0.07, right: 0.07 }),
  '16x9': Object.freeze({ top: 0.08, bottom: 0.08, left: 0.06, right: 0.06 }),
  '4x5': Object.freeze({ top: 0.07, bottom: 0.09, left: 0.07, right: 0.07 }),
});

const SIDES = ['top', 'bottom', 'left', 'right'];
const ROW = new Set(['row', 'horizontal', 'h', 'x', 'side']);
const COLUMN = new Set(['column', 'col', 'vertical', 'v', 'y', 'stack', 'stacked']);

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

// The one rule for safe insets, shared with tools/studio.mjs validateConfig so that a studio.json that passes `doctor`
// can never make layout() throw at render time: every side is a fraction in [0, 0.5), and each axis keeps at least 10%
// of the frame (a safe rect under 10% is a typo, not a layout). Sides left out fall back to the format default.
// Returns readable messages (empty = valid); `safe` may be partial.
export function safeProblems(fmt, safe) {
  const base = DEFAULT_SAFE[fmt] || DEFAULT_SAFE['1x1'];
  const out = { ...base };
  const problems = [];
  if (safe && typeof safe === 'object') {
    for (const k of SIDES) {
      if (safe[k] === undefined) continue;
      const v = Number(safe[k]);
      if (typeof safe[k] === 'boolean' || safe[k] === null || safe[k] === '' || !Number.isFinite(v) || v < 0 || v >= 0.5) {
        problems.push(`safe.${fmt}.${k} must be a fraction in [0, 0.5) (got ${JSON.stringify(safe[k])})`);
      } else out[k] = v;
    }
  }
  if (problems.length) return problems;
  for (const [a, b, axis] of [['left', 'right', 'width'], ['top', 'bottom', 'height']]) {
    const left = 1 - out[a] - out[b];
    if (left < 0.1 - 1e-12) problems.push(`safe.${fmt}: ${a} + ${b} = ${Math.round((out[a] + out[b]) * 1e4) / 1e4} leaves no room (only ${pct(Math.max(0, left))} of the ${axis}; keep at least 10%, so ${a} + ${b} <= 0.9)`);
  }
  return problems;
}

function resolveSafe(fmt, safe) {
  const problems = safeProblems(fmt, safe);
  if (problems.length) throw new Error(problems[0]);
  const out = { ...(DEFAULT_SAFE[fmt] || DEFAULT_SAFE['1x1']) };
  if (safe && typeof safe === 'object') for (const k of SIDES) if (safe[k] !== undefined) out[k] = Number(safe[k]);
  return out;
}

export function layout(fmt, safe = DEFAULT_SAFE[fmt]) {
  const F = FORMATS[fmt];
  if (!F) throw new Error(`unknown format "${fmt}" — use one of ${Object.keys(FORMATS).join(', ')}`);
  const W = F.w;
  const H = F.h;
  const sf = resolveSafe(fmt, safe);
  const S = { x: W * sf.left, y: H * sf.top, w: W * (1 - sf.left - sf.right), h: H * (1 - sf.top - sf.bottom) };
  const portrait = H > W;
  const landscape = W > H;
  const square = W === H;
  const orientation = portrait ? 'portrait' : landscape ? 'landscape' : 'square';

  return {
    fmt,
    label: F.label,
    W,
    H,
    u: Math.min(W, H) / 1080, // type & stroke unit: 100·u reads the same size in every format
    cx: W / 2,
    cy: H / 2,
    portrait,
    landscape,
    square,
    orientation,
    safe: sf,
    S,
    // ax, ay in 0..1 of the safe rect (values outside 0..1 are allowed for off-safe placement).
    pos(ax, ay) {
      return [S.x + ax * S.w, S.y + ay * S.h];
    },
    // Exact format key first, then orientation, then 'default'. Falsy values (0, '') are valid picks.
    pick(map) {
      if (!map || typeof map !== 'object') return undefined;
      return map[fmt] ?? map[orientation] ?? map.default;
    },
    // Two regions inside S: side-by-side in landscape, stacked in portrait/square ('auto'); 'row' | 'column' force it.
    split(dir = 'auto', ratio = 0.5, gap = 0) {
      const d = dir === 'auto' ? (landscape ? 'row' : 'column') : ROW.has(dir) ? 'row' : COLUMN.has(dir) ? 'column' : null;
      if (!d) throw new Error(`split: unknown direction "${dir}" (auto, row, column)`);
      const r = Math.min(1, Math.max(0, ratio));
      if (d === 'row') {
        const w = Math.max(0, S.w - gap);
        return { dir: d, a: { x: S.x, y: S.y, w: w * r, h: S.h }, b: { x: S.x + w * r + gap, y: S.y, w: w * (1 - r), h: S.h } };
      }
      const h = Math.max(0, S.h - gap);
      return { dir: d, a: { x: S.x, y: S.y, w: S.w, h: h * r }, b: { x: S.x, y: S.y + h * r + gap, w: S.w, h: h * (1 - r) } };
    },
    cols(n, gap = 0) {
      const count = Math.max(1, Math.floor(n));
      const w = (S.w - gap * (count - 1)) / count;
      return Array.from({ length: count }, (_, i) => ({ x: S.x + i * (w + gap), w }));
    },
    rows(n, gap = 0) {
      const count = Math.max(1, Math.floor(n));
      const h = (S.h - gap * (count - 1)) / count;
      return Array.from({ length: count }, (_, i) => ({ y: S.y + i * (h + gap), h }));
    },
  };
}

// Largest font size whose rendered width fits maxW (binary search on g.measureText).
// text may be an array of lines: the widest line decides. makeFont: size -> CSS font string.
// Options (7th argument, or the 5th/6th when lo/hi are left out):
//   tracking  em, as in text() and kinetic() (0.02 = 2% of the size). The width is measured with that letter spacing at
//             every candidate size, so a fitted headline still fits once it is drawn with the same tracking. Without it
//             the context's own g.letterSpacing applies, as before.
//   step      quantize DOWN to a multiple of step (16 for a bitmap font that is crisp only on its pixel grid). The result
//             is then always a multiple of step, never below it: if even one step is too wide that one step is returned.
//             Without step the result can be fractional (hundredths).
export function fitFontSize(g, text, maxW, makeFont, lo = 8, hi = 1000, opts = {}) {
  if (lo !== null && typeof lo === 'object') { opts = lo; lo = opts.lo ?? 8; hi = opts.hi ?? 1000; } else if (hi !== null && typeof hi === 'object') { opts = hi; hi = opts.hi ?? 1000; }
  const { tracking = 0, step } = opts || {};
  if (step !== undefined && !(step > 0)) throw new RangeError(`fitFontSize: step must be > 0 (got ${step})`);
  const lines = Array.isArray(text) ? text : [text];
  const prev = g.font;
  const width = (size) => {
    const css = makeFont(size);
    let w = 0;
    if (tracking) for (const line of lines) w = Math.max(w, textWidth(g, String(line), css, tracking));
    else {
      g.font = css;
      for (const line of lines) w = Math.max(w, g.measureText(String(line)).width);
    }
    return w;
  };
  let result;
  if (step) {
    // Integer search over multiples of step: exact, no float round-off at the grid (15.99 must not floor to 0).
    let a = Math.max(1, Math.ceil(lo / step - 1e-9));
    let b = Math.max(a, Math.floor(hi / step + 1e-9));
    if (width(a * step) > maxW) b = a;
    else if (width(b * step) <= maxW) a = b;
    else while (b - a > 1) {
      const mid = Math.floor((a + b) / 2);
      if (width(mid * step) <= maxW) a = mid;
      else b = mid;
    }
    result = a * step;
  } else {
    let a = lo;
    let b = hi;
    if (width(a) > maxW) result = a;
    else if (width(b) <= maxW) result = b;
    else {
      for (let i = 0; i < 40 && b - a > 0.01; i++) {
        const mid = (a + b) / 2;
        if (width(mid) <= maxW) a = mid;
        else b = mid;
      }
      result = Math.floor(a * 100) / 100;
    }
  }
  g.font = prev;
  if (isTextTracking()) recordText(lines.join(' '), makeFont(result)); // the text-use registry (lib/draw.js): this text is drawn at this size
  return result;
}
