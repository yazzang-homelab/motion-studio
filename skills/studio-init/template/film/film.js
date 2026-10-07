// film/film.js — the demo film. 12 s at 120 BPM = 6 bars; one idea per downbeat, one accent shape that never cuts:
// hook type -> the accent rule becomes a button -> loader -> check -> the camera pulls back onto a contact sheet
// (one still per beat) -> the sheet folds into a spring curve -> every format at once -> lockup.
// Everything is a pure function of time and of L (the format layout): no literal pixels, no carried state.
// Replace it with your film and keep the pattern: shots on the beat grid, springs from lib/motion.js, per-element
// seeds from rngFor, cues taken from the same grid.

import { defineFilm, scene } from '../lib/timeline.js';
import { clamp, lerp, remap, track, sp, spring, swapAlpha, indicator, springFromFeel, settleTime, SPRINGS } from '../lib/motion.js';
import { rngFor } from '../lib/rng.js';
import { layout, fitFontSize } from '../lib/layout.js';
import { font, text, textWidth, kinetic, roundRect, fillRoundRect, strokeRoundRect, clipRect, maskReveal, lineProgress, ring, cursor, circle, grain, withAlpha, withTransform, mixColor } from '../lib/draw.js';

const COPY = {
  hook: { portrait: ['MAKE', 'IT', 'MOVE.'], landscape: ['MAKE IT', 'MOVE.'] },
  hookCaption: 'a film is a function of time',
  button: 'Render',
  determinism: 'same frame, every run',
  sheet: 'one still per beat',
  counterLabel: 'frames, one function of time',
  curveNote: 'spring(t) · k 220 · d 14',
  formats: 'one timeline, every format',
  word: { stacked: ['motion-', 'studio'], row: ['motion-studio'] },
  tagline: 'motion design, rendered from code',
  chip: 'edit film/film.js',
};
const FMTS = ['9x16', '1x1', '16x9'];
const FMT_LABEL = { '9x16': '9:16', '1x1': '1:1', '16x9': '16:9' };
const CURVE = SPRINGS.playful; // the curve the stills fold into
const TAU = 1.1; // seconds of spring shown on the chart
const VMAX = 1.3;
const NOTE_SIZE = 44; // chart note, in su: 15 px at phone width in 9:16 and 1:1, 11 px in 16:9
const LINE_SPRING = springFromFeel({ duration: 1.0, bounce: 0 });
const CHECK_SPRING = springFromFeel({ duration: 0.4, bounce: 0 });
const POP = { k: 200, d: 20 }; // frames landing next to each other: ~4% overshoot, so neighbours never touch
const CAPS_MASK = { top: 1.0, bottom: 0.06 }; // caps sit on the accent rule: the mask closes at the baseline

const TN_END = 1.98; // how far the hook has replayed inside the format frames when the lockup takes over
const lerpRect = (a, b, p) => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p) });
const scaleRect = (r, s) => ({ x: r.x + (r.w * (1 - s)) / 2, y: r.y + (r.h * (1 - s)) / 2, w: r.w * s, h: r.h * s });

// Largest size in [lo, hi] (steps of 2 px) at which the string fits maxW on one line, or on two balanced lines (the
// split with the narrowest widest line). A bigger two-line caption beats a smaller one-line one.
function wrapFit(g, str, family, weight, maxW, hi, lo) {
  const words = str.split(' ');
  for (let s = hi; s >= lo; s -= 2) {
    const cf = font(s, family, weight);
    const w = (x) => textWidth(g, x, cf);
    if (w(str) <= maxW) return { lines: [str], size: s };
    let best = null;
    let bw = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      const m = Math.max(w(a), w(b));
      if (m < bw) {
        bw = m;
        best = [a, b];
      }
    }
    if (best && bw <= maxW) return { lines: best, size: s };
  }
  return { lines: [str], size: lo };
}

export default defineFilm((ctx) => {
  const { grid, dur } = ctx;
  const colors = (ctx.brand && ctx.brand.colors) || {};
  const fonts = (ctx.brand && ctx.brand.fonts) || {};
  const DISPLAY = fonts.display || 'Instrument Serif';
  const UI = fonts.ui || 'Inter';
  const BG = colors.bg || '#141413';
  const FG = colors.fg || '#F0EEE6';
  const ACCENT = colors.accent || '#D97757';
  const SURFACE = mixColor(BG, FG, 0.07);
  const LINE = mixColor(BG, FG, 0.26);
  const DIM = mixColor(FG, BG, 0.3);
  const B = (n) => grid.beat(n); // beat n in seconds: a measured beats.json moves every key with the music
  const safeOf = (f) => ctx.cfg && ctx.cfg.safe && ctx.cfg.safe[f];
  const LAYOUTS = Object.fromEntries(FMTS.map((f) => [f, layout(f, safeOf(f))]));
  const scenes = [];

  // Paint the whole film at time tn (optionally in another format) into rect, clipped to a rounded card.
  // Used by the contact sheet and the format frames; c.depth stops the recursion.
  function paintAt(g, tn, c, L2, rect, radius) {
    const k = rect.w / L2.W;
    if (!(k > 0.002) || rect.h <= 0) return;
    g.save();
    roundRect(g, rect.x, rect.y, rect.w, rect.h, radius);
    g.clip();
    g.translate(rect.x, rect.y);
    g.scale(k, k);
    g.fillStyle = BG;
    g.fillRect(0, 0, L2.W, L2.H);
    const depth = (c.depth || 0) + 1;
    for (const s of scenes) {
      if (tn < s.from || tn >= s.to) continue;
      const lt = tn - s.from;
      const sd = s.to - s.from;
      g.save();
      s.draw(g, lt, { ...c, t: tn, lt, dur: sd, p: clamp(lt / sd), W: L2.W, H: L2.H, u: L2.u, fmt: L2.fmt, L: L2, frame: Math.floor(tn * c.fps + 1e-6), scene: s.name, depth });
      g.restore();
    }
    g.restore();
  }

  const ui = (size, color = DIM, weight = 500) => ({ size, family: UI, weight, color, by: 'word', mask: true, spring: 'default', stagger: 0.07 });
  // Small type unit: 16:9 is shown at 360 px wide as 1/5.3 of its pixels (9:16 and 1:1: 1/3), so its small type gets a 1.32x unit.
  const su = (L) => L.u * (L.landscape ? 1.32 : 1);
  const capSize = (L) => (L.landscape ? 64 : 48) * L.u;
  // A block of height h sits on the optical centre (49% of the frame height) and never leaves the safe rect S. The
  // safe rect is lopsided in 9:16 (10% top, 16% bottom), so centring on S alone leaves the lower third empty.
  const midTop = (L, h) => Math.max(L.S.y, Math.min(L.S.y + L.S.h - h, L.H * 0.49 - h / 2));

  // ---------------------------------------------------------------------------------------------------------
  // Geometry: pure functions of the layout (and of font metrics via g.measureText).

  function hookGeom(g, L) {
    const { S, u } = L;
    const lines = L.portrait ? COPY.hook.portrait : COPY.hook.landscape; // 9:16 stacks three lines, wider frames two
    const n = lines.length;
    const LH = 0.84;
    const mk = (s) => font(s, DISPLAY, 400);
    const stackH = 0.72 + (n - 1) * LH + 0.17; // cap top of line 1 down to the rule, in em
    let size;
    let cs;
    if (L.landscape) size = Math.min(fitFontSize(g, lines, S.w * 0.86, mk, 40, 1200), (S.h * 0.9) / stackH);
    else {
      cs = Math.min(60 * u, fitFontSize(g, COPY.hookCaption, S.w, (v) => font(v, UI, 500), 20, 60 * u));
      size = Math.min(fitFontSize(g, lines, S.w * (L.square ? 0.94 : 1), mk, 40, 1200), (S.h * 0.96 - cs * 2.4) / stackH);
    }
    const top = midTop(L, size * stackH + (L.landscape ? 0 : cs * 2.4));
    const base = lines.map((_, i) => top + size * (0.72 + i * LH));
    const barH = Math.max(12 * u, size * 0.07);
    const bar = { x: S.x, y: base[n - 1] + size * 0.1, w: textWidth(g, lines[n - 1], mk(size)), h: barH };
    let cap;
    if (L.landscape) {
      // The caption sits right of "MOVE.", two balanced lines, the last one on the last baseline.
      const x = S.x + bar.w + size * 0.3;
      const fit = wrapFit(g, COPY.hookCaption, UI, 500, S.x + S.w - x, clamp(size * 0.15, 56 * u, 76 * u), 44 * u);
      const lh = fit.size * 1.28;
      cap = { x, y: base[n - 1] - (fit.lines.length - 1) * lh, size: fit.size, lines: fit.lines, lh };
    } else cap = { x: S.x, y: bar.y + barH + cs * 1.9, size: cs, lines: [COPY.hookCaption], lh: cs * 1.3 };
    return { lines, size, base, x: S.x, bar, cap };
  }

  function pillGeom(L) {
    const k = L.portrait ? 1.2 : L.square ? 1.05 : 1; // a bigger event in the taller frames
    const d = 300 * L.u * k;
    const top = midTop(L, d + 150 * L.u); // the circle plus the caption under it
    return { cx: L.S.x + L.S.w / 2, cy: top + d / 2, w: Math.min(L.S.w * 0.82, 760 * L.u * k), h: 190 * L.u * k, d };
  }

  function sheetGeom(L) {
    const { S, u } = L;
    const cols = 6;
    const rows = 4;
    const gap = 16 * u;
    const pad = 30 * u; // paper margin around the stills
    const capH = 150 * u;
    const tw = Math.min((S.w - 2 * pad - gap * (cols - 1)) / cols, ((S.h - capH - 2 * pad - gap * (rows - 1)) / rows) * (L.W / L.H));
    const th = (tw * L.H) / L.W;
    const gw = cols * tw + (cols - 1) * gap;
    const gh = rows * th + (rows - 1) * gap;
    const x0 = S.x + (S.w - gw) / 2;
    const y0 = midTop(L, gh + 2 * pad + 112 * u) + pad; // paper plus the caption under it
    const tiles = Array.from({ length: cols * rows }, (_, k) => ({ k, col: k % cols, row: Math.floor(k / cols), x: x0 + (k % cols) * (tw + gap), y: y0 + Math.floor(k / cols) * (th + gap), w: tw, h: th }));
    const panel = { x: x0 - pad, y: y0 - pad, w: gw + 2 * pad, h: gh + 2 * pad };
    return { tiles, tw, th, x0, y0, gw, gh, panel, panelR: 22 * u, r: Math.min(tw, th) * 0.07, capX: panel.x, capY: panel.y + panel.h + 92 * u };
  }

  function chartGeom(g, L) {
    const { u } = L;
    const { a, b } = L.split('auto', L.landscape ? 0.38 : L.portrait ? 0.35 : 0.34, L.landscape ? 80 * u : 24 * u);
    const noteH = (L.landscape ? 100 : 112) * u;
    const ph = Math.min(b.h - noteH, b.w * (L.landscape ? 0.8 : L.portrait ? 0.86 : 0.72));
    const plot = { x: b.x, y: b.y + (b.h - noteH - ph) / 2, w: b.w, h: ph };
    const X = (tau) => plot.x + (tau / TAU) * plot.w;
    const Y = (v) => plot.y + plot.h - (v / VMAX) * plot.h;
    const at = (tau) => [X(tau), Y(spring(tau, CURVE.k, CURVE.d))];
    const pts = Array.from({ length: 24 }, (_, k) => at((TAU * k) / 23));
    const curve = Array.from({ length: 161 }, (_, i) => at((TAU * i) / 160));
    let peak = pts[0];
    for (const p of pts) if (p[1] < peak[1]) peak = p;
    const size = Math.min(a.h * (L.landscape ? 0.42 : 0.64), (a.w * 0.9) / 1.75);
    // The label wraps to two balanced lines where the column is narrow: it must end inside `a`, clear of the plot.
    const lab = wrapFit(g, COPY.counterLabel, UI, 500, a.w, (L.landscape ? 68 : 52) * u, 44 * u);
    const lh = lab.size * 1.28;
    const gapL = clamp(size * 0.28, 56 * u, 90 * u);
    const relTop = -0.82 * size;
    const relBot = gapL + (lab.lines.length - 1) * lh + 0.25 * lab.size;
    const base = a.y + (a.h - (relBot - relTop)) / 2 - relTop; // digits and label centred in their column
    const axis = { x: plot.x, y: Y(0) - u, w: plot.w, h: 2 * u };
    return { plot, X, Y, pts, curve, peak, axis, noteY: plot.y + plot.h + (L.landscape ? 72 : 64) * u, su: su(L), cnt: { x: a.x, base, size, labelY: base + gapL, labelSize: lab.size, labelLines: lab.lines, labelLH: lh } };
  }

  function formatsGeom(L) {
    const { S, u } = L;
    const gapX = 52 * u;
    const gapY = 96 * u; // rows leave room for the label of the row above
    const cs = Math.min(96 * u, S.w * 0.08);
    const capH = 72 * su(L) + cs * 1.3; // labels and the caption under the last row
    const rects = {};
    let bottom;
    if (L.landscape) {
      // One row: 9:16 | 1:1 | 16:9, all the same height.
      const h = Math.min((S.w - 2 * gapX) / (9 / 16 + 1 + 16 / 9), S.h - capH - 40 * u);
      const ws = [(h * 9) / 16, h, (h * 16) / 9];
      const top = midTop(L, h + capH);
      let x = S.x + (S.w - (ws[0] + ws[1] + ws[2] + 2 * gapX)) / 2;
      FMTS.forEach((f, i) => {
        rects[f] = { x, y: top, w: ws[i], h };
        x += ws[i] + gapX;
      });
      bottom = top + h;
    } else if (L.portrait) {
      // Stacked: 16:9 across the top, 9:16 and 1:1 side by side under it. Fills the tall frame.
      const h2 = Math.min((S.w - gapX) / 1.5625, (S.h - capH - gapY - 0.5625 * gapX) / 1.8789);
      const w2 = h2 * 1.5625 + gapX;
      const h169 = 0.5625 * w2;
      const top = midTop(L, h169 + gapY + h2 + capH);
      const x = S.x + (S.w - w2) / 2;
      rects['16x9'] = { x, y: top, w: w2, h: h169 };
      rects['9x16'] = { x, y: top + h169 + gapY, w: 0.5625 * h2, h: h2 };
      rects['1x1'] = { x: x + 0.5625 * h2 + gapX, y: top + h169 + gapY, w: h2, h: h2 };
      bottom = top + h169 + gapY + h2;
    } else {
      // Bento: 9:16 on the left, 16:9 over 1:1 on the right. H1 solves w1 + gapX + rw = S.w with rw·(1 + 9/16) + gapY = H1.
      const H1 = Math.min((S.w + 0.64 * gapY - gapX) / 1.2025, S.h - capH - 40 * u);
      const w1 = (H1 * 9) / 16;
      const rw = (H1 - gapY) / 1.5625;
      const x = S.x + (S.w - (w1 + gapX + rw)) / 2;
      const y = midTop(L, H1 + capH);
      rects['9x16'] = { x, y, w: w1, h: H1 };
      rects['16x9'] = { x: x + w1 + gapX, y, w: rw, h: (rw * 9) / 16 };
      rects['1x1'] = { x: x + w1 + gapX, y: y + (rw * 9) / 16 + gapY, w: rw, h: rw };
      bottom = y + H1;
    }
    // The frames arrive one per beat, the current format first. While only some are on screen the group is centred on
    // what is there (a camera offset per arrival, springs in the shot), so the first frame never sits alone in a corner.
    const band = 70 * su(L); // a frame's label counts as part of it
    const boxOf = (f) => ({ x0: rects[f].x, y0: rects[f].y, x1: rects[f].x + rects[f].w, y1: rects[f].y + rects[f].h + band });
    const uni = (fs) => fs.map(boxOf).reduce((p, q) => ({ x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1) }));
    const cen = (f) => [rects[f].x + rects[f].w / 2, rects[f].y + rects[f].h / 2];
    const dist = (a, b) => Math.hypot(cen(a)[0] - cen(b)[0], cen(a)[1] - cen(b)[1]);
    const mid = (b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
    const arrival = (fmt) => {
      const hero = FMTS.includes(fmt) ? fmt : FMTS[0];
      const [p, q] = FMTS.filter((f) => f !== hero);
      return dist(hero, q) < dist(hero, p) ? [hero, q, p] : [hero, p, q]; // the neighbour next to the first frame lands 2nd: no frame crosses another
    };
    const full = mid(uni(FMTS));
    // The caption lands last, under the frames: until then the frames alone sit that much lower, on the optical centre.
    const drop = Math.max(0, L.H * 0.49 - full[1]);
    const offs = (fmt) => {
      const arr = arrival(fmt);
      return arr.map((_, j) => {
        const m = mid(uni(arr.slice(0, j + 1)));
        return [full[0] - m[0], full[1] - m[1] + (drop * (2 - j)) / 2];
      });
    };
    // The first frame arrives large (a close-up on the current format) and pulls back into its slot as the next one lands.
    const zoom = (fmt) => {
      const r = rects[FMTS.includes(fmt) ? fmt : FMTS[0]];
      return clamp(Math.min((S.w * 0.84) / r.w, (S.h * 0.62) / r.h), 1, 1.6);
    };
    return { rects, r: 16 * u, arrival, offs, zoom, label: { dy: 52 * su(L), size: 44 * su(L) }, cap: { x: rects['9x16'].x, y: bottom + 72 * su(L) + cs * 1.05, size: cs } };
  }

  function lockupGeom(g, L) {
    const { S, u } = L;
    const stacked = !L.landscape;
    const lines = stacked ? COPY.word.stacked : COPY.word.row;
    const mk = (s) => font(s, DISPLAY, 400);
    const tag = Math.min((stacked ? 52 : 68) * u, fitFontSize(g, COPY.tagline, S.w * 0.98, (v) => font(v, UI, 500), 20, 80));
    const chipH = (stacked ? 76 : 96) * u;
    const MARK = stacked ? 0.95 : 0.88;
    let wm;
    if (stacked) wm = Math.min(fitFontSize(g, lines, S.w * 0.95, mk, 40, 600), (S.h * 0.94 - tag * 4.2 - chipH - 40 * u) / (MARK + 1.0 + 0.9), 330 * u);
    else wm = Math.min((S.w * 0.94) / (textWidth(g, lines[0], mk(100)) / 100 + MARK + 0.32), 300 * u);
    const wordW = Math.max(...lines.map((l) => textWidth(g, l, mk(wm))));
    let markRect;
    let word;
    let x0;
    let blockH;
    let top;
    if (stacked) {
      const mark = wm * MARK;
      blockH = mark + wm * (1.0 + 0.9) + tag * 4.2 + chipH;
      x0 = S.x;
      top = midTop(L, blockH);
      markRect = { x: x0, y: top, w: mark, h: mark };
      word = { x: x0 - wm * 0.02, y: top + mark + wm * 1.0, lh: wm * 0.9 };
    } else {
      const mark = wm * MARK;
      const blockW = mark + wm * 0.32 + wordW;
      blockH = mark + tag * 3.25 + chipH;
      x0 = S.x + (S.w - blockW) / 2;
      top = midTop(L, blockH);
      markRect = { x: x0, y: top, w: mark, h: mark };
      word = { x: x0 + mark + wm * 0.32, y: top + mark * 0.78, lh: wm * 0.86 };
    }
    const lastBase = word.y + word.lh * (lines.length - 1);
    const tagY = Math.max(lastBase, markRect.y + markRect.h) + tag * (stacked ? 2.9 : 2.1);
    const m = markRect.w;
    const glyph = Array.from({ length: 49 }, (_, i) => {
      const tau = (0.9 * i) / 48;
      return [markRect.x + m * (0.2 + 0.6 * (tau / 0.9)), markRect.y + m * (0.74 - 0.42 * spring(tau, CURVE.k, CURVE.d))];
    });
    const right = Math.max(markRect.x + m, word.x + wordW);
    return { lines, wm, tag, markRect, word, glyph, tag0: { x: x0, y: tagY }, chip: { x: x0, y: tagY + tag * (stacked ? 1.3 : 1.15), h: chipH }, cx: (x0 + right) / 2, cy: top + blockH / 2 };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Reused pieces

  const tnAt = (t) => remap(t, B(16) + 0.2, B(20), 0.25, TN_END); // the hook replaying inside the format frames
  const tileTime = (k) => B(k + 0.98); // one still per beat, taken at the end of the beat (settled states)
  const HOOK_START = (n) => (n === 2 ? [-0.32, B(1)] : [-0.32, 0.16, B(1)]);
  const order = (fmt) => (FMTS.includes(fmt) ? [fmt, ...FMTS.filter((f) => f !== fmt)] : FMTS);

  // Odometer: fixed digit cells (no width jitter), each digit rolls up through its cell as the value grows, and a
  // higher place only moves while the place below carries (value mod p in the last unit). A continuous value means
  // no single-frame digit flips, so the settle into 720 reads as motion, not as a pop.
  const COUNT_TO = 720;
  // Normalize the spring to reach exactly 1 at its 0.1% settle time: the count lands in finite time (no half-rolled
  // digit creeping through the exponential tail) and stops at ~0.14 digit/frame instead of snapping from a spin.
  const COUNT_T = settleTime('default', 1e-3);
  const countAt = (lt) => COUNT_TO * Math.min(1, sp(lt, 'default') / sp(COUNT_T, 'default'));
  function counter(g, value, K) {
    const { x, base, size } = K.cnt;
    const n = String(COUNT_TO).length;
    g.font = font(size, DISPLAY, 400);
    const pitch = g.measureText('0').width * 1.02;
    const step = size * 0.95;
    const v = Math.max(0, value);
    for (let i = 0; i < n; i++) {
      const p = 10 ** (n - 1 - i);
      const whole = Math.floor(v / p);
      const roll = p === 1 ? v - Math.floor(v) : clamp((v % p) - (p - 1));
      if (whole === 0 && roll === 0 && p > 1) continue; // leading zero
      const cx = x + pitch * (i + 0.5);
      clipRect(g, x + pitch * i, base - size * 0.82, pitch, size * 1.02, () => {
        const d = { size, family: DISPLAY, weight: 400, color: FG, align: 'center' };
        if (whole > 0 || p === 1) text(g, String(whole % 10), cx, base - roll * step, d);
        if (roll > 0) text(g, String((whole + 1) % 10), cx, base + (1 - roll) * step, d);
      });
    }
  }
  const counterBox = (K) => ({ x: K.cnt.x - 20 * K.u, y: K.cnt.base - K.cnt.size * 0.86, w: K.cnt.size * 3, h: K.cnt.size * 1.0 });

  function target(g, K, u) {
    g.save();
    g.setLineDash([12 * u, 10 * u]);
    g.strokeStyle = LINE;
    g.lineWidth = 2 * u;
    g.beginPath();
    g.moveTo(K.plot.x, K.Y(1));
    g.lineTo(K.plot.x + K.plot.w, K.Y(1));
    g.stroke();
    g.restore();
    text(g, '1.0', K.plot.x + K.plot.w - 18 * u, K.Y(1) - 22 * u, { size: 44 * K.su, family: UI, weight: 500, color: DIM, align: 'right' });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Shots

  function hook(g, lt, c) {
    const { t, L } = c;
    const h = hookGeom(g, L);
    const starts = HOOK_START(h.lines.length);
    // No slow camera drift on type: Chrome snaps glyphs under ~256 device px to whole pixels vertically, so a
    // sub-pixel drift steps in 1 px jumps (visible at small render scales). Motion comes from the springs instead.
    h.lines.forEach((line, i) => kinetic(g, line, h.x, h.base[i], t - starts[i], { size: h.size, family: DISPLAY, weight: 400, color: FG, mask: CAPS_MASK, spring: 'default', stagger: 0.05 }));
    fillRoundRect(g, h.bar.x, h.bar.y, h.bar.w * sp(t + 0.16, 'snappy'), h.bar.h, h.bar.h / 2, ACCENT);
    h.cap.lines.forEach((line, i) => kinetic(g, line, h.cap.x, h.cap.y + i * h.cap.lh, t - B(2) - i * 0.1, { ...ui(h.cap.size), stagger: 0.05 }));
  }

  function morph(g, lt, c) {
    const { t, L } = c;
    const u = L.u;
    const h = hookGeom(g, L);
    const P = pillGeom(L);
    const [T4, T5, T6] = [B(4), B(5), B(6)];

    // The hook leaves upward inside its own line masks (no fade), bottom line first: the rule rises through it.
    const n = h.lines.length;
    h.lines.forEach((line, i) => {
      const e = sp(t - T4 - (n - 1 - i) * 0.045, 'snappy');
      if (e > 0.999) return;
      clipRect(g, 0, h.base[i] - h.size * 0.8, L.W, h.size * 0.86, () => text(g, line, h.x, h.base[i] - e * h.size * 0.9, { size: h.size, family: DISPLAY, weight: 400, color: FG }));
    });
    const ce = sp(t - T4 - 0.08, 'snappy');
    if (ce < 0.999) {
      h.cap.lines.forEach((line, i) => {
        const y = h.cap.y + i * h.cap.lh;
        clipRect(g, 0, y - h.cap.size * 1.1, L.W, h.cap.size * 1.45, () => text(g, line, h.cap.x, y - ce * h.cap.size * 1.2, { size: h.cap.size, family: UI, weight: 500, color: DIM }));
      });
    }

    // One shape: accent rule -> button -> loader -> check. Every property is a track() of springs.
    const b = h.bar;
    const press = clamp(track(t, [[0, 0], [T5 - 0.07, 1, 'snappy'], [T5 + 0.06, 0, 'snappy']]));
    const cx = track(t, [[0, b.x + b.w / 2], [T4, P.cx]]);
    const cy = track(t, [[0, b.y + b.h / 2], [T4, P.cy]]);
    const size = (v0, v1) => track(t, [[0, v0], [T4, v1], [T5 + 0.04, P.d, 'snappy'], [T6, P.d * 1.1, 'snappy'], [T6 + 0.1, P.d, 'snappy']]) * (1 - 0.05 * press);
    const w = size(b.w, P.w);
    const hh = size(b.h, P.h);
    const R = Math.min(w, hh) / 2;
    // Loading = the accent irises closed onto a dark well, done = it irises open again (crisp, no muddy blend).
    const TL = T5 + 0.04;
    const iris = t < TL ? 1 : t < T6 - 0.02 ? 1 - sp(t - TL, 'snappy') : sp(t - T6 + 0.02, 'snappy');
    if (iris < 0.999) fillRoundRect(g, cx - w / 2, cy - hh / 2, w, hh, R, SURFACE);
    if (iris > 0.001) fillRoundRect(g, cx - (w * iris) / 2, cy - (hh * iris) / 2, w * iris, hh * iris, R * iris, ACCENT);
    text(g, COPY.button, cx, cy + 3 * u, { size: 64 * u, family: UI, weight: 600, color: BG, align: 'center', baseline: 'middle', alpha: swapAlpha(t, T4 + 0.12, T5 + 0.06) });
    withAlpha(g, swapAlpha(t, TL, T6 + 0.1, { inDelay: 0.06 }), () => {
      ring(g, cx, cy, P.d * 0.3, 0.2 + 0.55 * sp(t - T5 - 0.1), { width: 12 * u, color: ACCENT, start: -Math.PI / 2 + (t - T5) * Math.PI * 3.2 });
    });
    if (t > T6) lineProgress(g, [[cx - 0.36 * R, cy + 0.02 * R], [cx - 0.1 * R, cy + 0.28 * R], [cx + 0.38 * R, cy - 0.26 * R]], sp(t - T6 - 0.1, CHECK_SPRING), { width: 0.13 * R, color: BG });
    kinetic(g, COPY.determinism, P.cx, P.cy + P.d / 2 + 130 * u, t - T6 - 0.1, { ...ui(capSize(L) * 1.1), align: 'center', stagger: 0.05 });

    // The cursor drives the change: in from below, click on the beat, out again. Position and press are tracks.
    if (t < T6 + 0.6) {
      const [x0, y0] = L.pos(0.9, 1.25);
      const [x2, y2] = L.pos(0.74, 1.3);
      const tx = P.cx + P.w * 0.22;
      const ty = P.cy + P.h * 0.2;
      const x = track(t, [[0, x0], [T4 + 0.06, tx], [T6 - 0.12, x2]]);
      const y = track(t, [[0, y0], [T4 + 0.06, ty], [T6 - 0.12, y2]]);
      cursor(g, x, y, { scale: 1.5 * u, pressed: press, fill: FG, stroke: BG });
    }
  }

  // The stills pop in around the hero still (the end of the morph shot), rippling out from it.
  function stills(g, t, c, G) {
    const hero = 7;
    const T = B(8);
    const H = G.tiles[hero];
    for (const r of G.tiles) {
      if (r.k === hero) continue;
      const rnd = rngFor('still', r.k)();
      const dist = Math.abs(r.col - H.col) + Math.abs(r.row - H.row);
      const s = sp(t - T - 0.02 - dist * 0.04 - rnd * 0.05, 'playful');
      if (s <= 0.002) continue;
      const rr = scaleRect(r, s);
      if (c.depth) fillRoundRect(g, rr.x, rr.y, rr.w, rr.h, G.r * s, BG);
      else paintAt(g, tileTime(r.k), c, c.L, rr, G.r * s);
    }
    const z = sp(t - T, 'default'); // camera pull-back: the full frame shrinks into its own still
    const hr = lerpRect({ x: 0, y: 0, w: c.L.W, h: c.L.H }, H, z);
    if (c.depth) fillRoundRect(g, hr.x, hr.y, hr.w, hr.h, G.r * z, BG);
    else paintAt(g, tileTime(hero), c, c.L, hr, G.r * z);
  }

  function sheet(g, lt, c) {
    const { t, L } = c;
    const u = L.u;
    const G = sheetGeom(L);
    const P = G.panel;
    fillRoundRect(g, P.x, P.y, P.w, P.h, G.panelR, FG); // the paper the stills sit on, revealed by the pull-back
    stills(g, t, c, G);
    // "You are here": a stretchy indicator walks the stills of this very shot, one per beat.
    const [T9, T10, T11] = [B(9), B(10), B(11)];
    const ts = G.tiles;
    const ind = indicator(t, [[T9, ts[9].x], [T10, ts[10].x], [T11, ts[11].x]], { width: G.tw });
    const hs = sp(t - T9 + 0.06, 'snappy');
    if (hs > 0.002) {
      const pad = 7 * u;
      const w = ind.right - ind.left + 2 * pad;
      const hh = G.th + 2 * pad;
      strokeRoundRect(g, ind.left - pad + (w * (1 - hs)) / 2, ts[9].y - pad + (hh * (1 - hs)) / 2, w * hs, hh * hs, G.r + pad, ACCENT, 6 * u);
    }
    kinetic(g, COPY.sheet, G.capX, G.capY, t - T10, ui(capSize(L) * 1.15, FG));
  }

  function chart(g, lt, c) {
    const { t, L } = c;
    const u = L.u;
    const G = sheetGeom(L);
    const K = { ...chartGeom(g, L), u };
    const [T12, T13, T14, T15] = [B(12), B(13), B(14), B(15)];

    // The paper folds into the chart's baseline; the indicator snaps shut; the caption drops out of its mask.
    // Height folds fast (snappy), width follows (default), so the paper reads as a sheet flattening into a line.
    const fy = sp(t - T12, 'snappy');
    const fx = sp(t - T12 - 0.04, 'default');
    const P = G.panel;
    const A = K.axis;
    const py = lerp(P.y, A.y, fy);
    const ph = lerp(P.h, A.h, fy);
    const px = lerp(P.x, A.x, fx);
    const pw = lerp(P.w, A.w, fx);
    fillRoundRect(g, px, py, pw, ph, lerp(G.panelR, u, fy), mixColor(FG, LINE, clamp(fy * 1.3)));
    const e = sp(t - T12, 'snappy');
    if (e < 0.999) {
      const r = G.tiles[11];
      const pad = 7 * u;
      const k = 1 - e;
      strokeRoundRect(g, r.x - pad + ((r.w + 2 * pad) * e) / 2, r.y - pad + ((r.h + 2 * pad) * e) / 2, (r.w + 2 * pad) * k, (r.h + 2 * pad) * k, G.r + pad, ACCENT, 6 * u);
      const cs = capSize(L) * 1.15;
      clipRect(g, 0, G.capY - cs * 1.1, L.W, cs * 1.4, () => text(g, COPY.sheet, G.capX, G.capY + e * cs * 1.4, { size: cs, family: UI, weight: 500, color: FG }));
    }

    maskReveal(g, { x: K.plot.x - 20 * u, y: K.plot.y - 60 * u, w: K.plot.w + 40 * u, h: K.plot.h + 80 * u }, sp(t - T12 - 0.3), 'right', () => target(g, K, u));
    lineProgress(g, K.curve, sp(t - T12 - 0.3, LINE_SPRING), { width: 8 * u, color: ACCENT });

    // Every still collapses into one sample of the spring curve.
    const d = 22 * u;
    for (const r of G.tiles) {
      const z = sp(t - T12 - 0.012 * r.k, 'default');
      const [px, py] = K.pts[r.k];
      if (z > 0.995) {
        circle(g, px, py, d / 2, FG);
        continue;
      }
      const rr = lerpRect(r, { x: px - d / 2, y: py - d / 2, w: d, h: d }, z);
      const rad = lerp(G.r, d / 2, z);
      fillRoundRect(g, rr.x, rr.y, rr.w, rr.h, rad, mixColor(BG, FG, clamp((z - 0.45) / 0.5)));
      if (!c.depth) withAlpha(g, clamp(1 - (z - 0.3) / 0.4), () => paintAt(g, tileTime(r.k), c, L, rr, rad));
    }

    const pk = sp(t - T15, 'playful');
    if (pk > 0.002) ring(g, K.peak[0], K.peak[1], 34 * u * pk, 1, { width: 5 * u, color: ACCENT });

    // The counter rises into its mask while it counts (fixed digit cells, no jitter).
    const rise = sp(t - T13, 'default');
    const cb = counterBox(K);
    if (rise > 0.002) clipRect(g, cb.x, cb.y, cb.w, cb.h, () => withTransform(g, { y: (1 - rise) * K.cnt.size }, () => counter(g, countAt(t - T13 - 0.04), K)));
    K.cnt.labelLines.forEach((line, i) => kinetic(g, line, K.cnt.x, K.cnt.labelY + i * K.cnt.labelLH, t - T14 - i * 0.1, ui(K.cnt.labelSize)));
    kinetic(g, COPY.curveNote, K.plot.x, K.noteY, t - T14, { ...ui(NOTE_SIZE * K.su), stagger: 0.03 });
  }

  function formats(g, lt, c) {
    const { t, L } = c;
    const u = L.u;
    const K = { ...chartGeom(g, L), u };
    const F = formatsGeom(L);
    const [T16, T17, T18] = [B(16), B(17), B(18)];

    // The chart clears: the curve un-draws, samples shrink, the counter and notes drop out of their masks.
    const e = sp(t - T16, 'snappy');
    if (e < 0.999) {
      lineProgress(g, K.curve, 1 - e, { width: 8 * u, color: ACCENT });
      K.pts.forEach(([px, py], k) => circle(g, px, py, 11 * u * (1 - sp(t - T16 - 0.006 * k, 'snappy')), FG));
      maskReveal(g, { x: K.plot.x - 20 * u, y: K.plot.y - 60 * u, w: K.plot.w + 40 * u, h: K.plot.h + 80 * u }, 1 - e, 'right', () => {
        target(g, K, u);
        g.fillStyle = LINE;
        g.fillRect(K.axis.x, K.axis.y, K.axis.w, K.axis.h);
      });
      const cb = counterBox(K);
      clipRect(g, cb.x, cb.y, cb.w, cb.h, () => withTransform(g, { y: -e * K.cnt.size }, () => counter(g, COUNT_TO, K)));
      const ls = K.cnt.labelSize;
      K.cnt.labelLines.forEach((line, i) => {
        const y = K.cnt.labelY + i * K.cnt.labelLH;
        clipRect(g, 0, y - ls * 1.1, L.W, ls * 1.45, () => text(g, line, K.cnt.x, y - e * ls * 1.3, { size: ls, family: UI, weight: 500, color: DIM }));
      });
      clipRect(g, 0, K.noteY - 44 * K.su, L.W, 60 * K.su, () => text(g, COPY.curveNote, K.plot.x, K.noteY - e * 56 * K.su, { size: NOTE_SIZE * K.su, family: UI, weight: 500, color: DIM }));
    }

    // The plot becomes this format's frame; the other two pop in on the next beats. Inside every frame the hook
    // replays in that format, all in sync: one timeline, reframed (never cropped) per format. The group is centred on
    // the frames that are on screen: offsets per arrival, sprung on the beat that adds the next frame.
    const tn = tnAt(t);
    const offs = F.offs(c.fmt);
    const [A17, A18] = [T17 - 0.08, T18 - 0.08]; // the group moves just ahead of the frame that lands next
    const ox = track(t, [[0, offs[0][0]], [A17, offs[1][0]], [A18, offs[2][0]]]);
    const oy = track(t, [[0, offs[0][1]], [A17, offs[1][1]], [A18, offs[2][1]]]);
    const hs = track(t, [[0, F.zoom(c.fmt)], [A17, 1]]);
    F.arrival(c.fmt).forEach((f, i) => {
      const r = { ...F.rects[f], x: F.rects[f].x + ox, y: F.rects[f].y + oy };
      const at = [T16, T17, T18][i];
      let rect;
      let s = 1;
      // The frame outline starts moving a beat-fraction after the chart's text has left, so it never cuts through it.
      if (i === 0) rect = lerpRect(K.plot, scaleRect(r, hs), sp(t - T16 - 0.06));
      else {
        s = sp(t - at, POP);
        if (s <= 0.002) return;
        rect = scaleRect(r, s);
      }
      const cur = f === c.fmt;
      if (c.depth) fillRoundRect(g, rect.x, rect.y, rect.w, rect.h, F.r * s, SURFACE);
      else withAlpha(g, i === 0 ? swapAlpha(t, T16 + 0.14, null) : 1, () => paintAt(g, tn, c, LAYOUTS[f], rect, F.r * s));
      // The plot's outline eases in on the downbeat (a spring on its alpha) instead of appearing whole.
      withAlpha(g, i === 0 ? clamp(sp(t - T16 + 0.02, 'snappy')) : 1, () => strokeRoundRect(g, rect.x, rect.y, rect.w, rect.h, F.r * s, cur ? ACCENT : LINE, (cur ? 6 : 3) * u));
      // The label rides the frame (the moving rect for the first one), never the slot it is heading for.
      const lb = i === 0 ? rect : r;
      kinetic(g, FMT_LABEL[f], lb.x, lb.y + lb.h + F.label.dy, t - at - 0.12, ui(F.label.size, cur ? FG : DIM, 600));
    });
    kinetic(g, COPY.formats, F.cap.x, F.cap.y, t - T18, { size: F.cap.size, family: DISPLAY, style: 'italic', weight: 400, color: FG, mask: true, spring: 'default', stagger: 0.01 });
  }

  function lockup(g, lt, c) {
    const { t, L } = c;
    const u = L.u;
    const K = lockupGeom(g, L);
    const F = formatsGeom(L);
    const [T20, T21, T22] = [B(20), B(21), B(22)];
    const M = K.markRect;
    // The bar line does not hard-cut: the formats shot's furniture keeps its place for the first frame and leaves on a
    // spring (caption out of its mask, labels down with their frames), and the frames still show the replay.
    const ex = sp(t - T20, 'snappy');
    if (ex < 0.999) {
      const cap = F.cap;
      clipRect(g, 0, cap.y - cap.size * 1.08, L.W, cap.size * 1.42, () => text(g, COPY.formats, cap.x, cap.y - ex * cap.size * 1.3, { size: cap.size, family: DISPLAY, style: 'italic', weight: 400, color: FG }));
      FMTS.forEach((f) => {
        const r = F.rects[f];
        text(g, FMT_LABEL[f], r.x, r.y + r.h + F.label.dy, { size: F.label.size, family: UI, weight: 600, color: f === c.fmt ? FG : DIM, alpha: 1 - clamp(ex * 2.5) });
      });
    }
    // On the hit the frames fold into the mark: this format becomes the mark, the other two fly into it.
    const [first, ...rest] = order(c.fmt);
    rest.forEach((f, i) => {
      const k = sp(t - T20 - 0.03 * i, 'default');
      if (k > 0.995) return;
      const rr = lerpRect(F.rects[f], scaleRect(M, 0.3), k);
      const rad = lerp(F.r, M.w * 0.1, k);
      withAlpha(g, clamp(1 - k * 2.5), () => (c.depth ? fillRoundRect(g, rr.x, rr.y, rr.w, rr.h, rad, SURFACE) : paintAt(g, TN_END, c, LAYOUTS[f], rr, rad)));
      strokeRoundRect(g, rr.x, rr.y, rr.w, rr.h, rad, LINE, 3 * u);
    });
    const z = sp(t - T20, 'snappy');
    const m = lerpRect(F.rects[first], M, z);
    const mr = lerp(F.r, M.w * 0.22, z);
    if (z < 0.4) withAlpha(g, 1 - z * 2.5, () => (c.depth ? fillRoundRect(g, m.x, m.y, m.w, m.h, mr, SURFACE) : paintAt(g, TN_END, c, LAYOUTS[first] || L, m, mr)));
    maskReveal(g, { x: m.x - u, y: m.y - u, w: m.w + 2 * u, h: m.h + 2 * u }, sp(t - T20 + 0.02, 'snappy') * 1.02, 'up', () => fillRoundRect(g, m.x, m.y, m.w, m.h, mr, ACCENT));
    if (z < 0.999) strokeRoundRect(g, m.x, m.y, m.w, m.h, mr, ACCENT, 6 * u);
    lineProgress(g, K.glyph, sp(t - T20 - 0.16, LINE_SPRING), { width: M.w * 0.075, color: BG });

    // The hyphen is drawn in the accent: at the end of the first line (9:16, 1:1) it reads as the joiner of one name,
    // not as an accidental break, and in one line (16:9) it ties the two words to the mark.
    const wf = font(K.wm, DISPLAY, 400);
    K.lines.forEach((line, i) => {
      let done = '';
      line.split(/(-)/).filter(Boolean).forEach((run) => {
        const rx = K.word.x + textWidth(g, done + run, wf) - textWidth(g, run, wf);
        kinetic(g, run, rx, K.word.y + i * K.word.lh, t - T20 - 0.16 - i * 0.12 - done.length * 0.03, { size: K.wm, family: DISPLAY, weight: 400, color: run === '-' ? ACCENT : FG, mask: true, spring: 'default', stagger: 0.03 });
        done += run;
      });
    });
    kinetic(g, COPY.tagline, K.tag0.x, K.tag0.y, t - T21, ui(K.tag));

    const cs = sp(t - T22, 'snappy');
    if (cs > 0.002) {
      const size = 44 * su(L);
      const ch = { x: K.chip.x, y: K.chip.y, w: textWidth(g, COPY.chip, font(size, UI, 600)) + 56 * su(L), h: K.chip.h };
      withTransform(g, { x: ch.x, y: ch.y + ch.h / 2, ox: ch.x, oy: ch.y + ch.h / 2, s: cs }, () => {
        strokeRoundRect(g, ch.x, ch.y, ch.w, ch.h, ch.h / 2, LINE, 2.5 * u);
        text(g, COPY.chip, ch.x + 28 * su(L), ch.y + ch.h / 2 + u, { size, family: UI, weight: 600, color: FG, baseline: 'middle' });
      });
    }
    // The grain comes up with the lockup instead of switching on at the cut.
    if (!c.depth) grain(g, L.W, L.H, c.frame, { amount: 0.045 * sp(t - T20 - 0.1), seed: 7 });
  }

  // Shots on downbeats: bar i starts shot i; the last shot runs to the end of the film.
  const plan = [['hook', hook], ['morph', morph], ['sheet', sheet], ['chart', chart], ['formats', formats], ['lockup', lockup]];
  plan.forEach(([name, draw], i) => {
    const from = i === 0 ? 0 : grid.bar(i);
    const to = i === plan.length - 1 ? dur : Math.min(dur, grid.bar(i + 1));
    if (from < dur && to > from) scenes.push(scene(from, to, name, draw));
  });

  // Sound on the same grid: thumps and whooshes on downbeats, UI sounds on the beats where things happen.
  const cues = (gr) => {
    const b = (n) => gr.beat(n);
    return [
      { t: b(0), type: 'thump' },
      { t: b(2), type: 'pop', gain: 0.55 },
      { t: b(4), type: 'whoosh' },
      { t: b(5), type: 'click', pan: 0.25 },
      { t: b(6), type: 'chime', gain: 0.7 },
      { t: b(8), type: 'thump' },
      { t: b(9), type: 'pop', gain: 0.6, pan: 0.1 },
      { t: b(10), type: 'tick', gain: 0.45, pan: 0.25 },
      { t: b(11), type: 'tick', gain: 0.45, pan: 0.4 },
      { t: b(12), type: 'whoosh' },
      { t: b(13), type: 'tick', gain: 0.45 },
      { t: b(14), type: 'tick', gain: 0.45 },
      { t: b(15), type: 'pop', gain: 0.6, pan: -0.2 },
      { t: b(16), type: 'thump' },
      { t: b(17), type: 'pop', gain: 0.6, pan: 0.3 },
      { t: b(17), type: 'riser', gain: 0.8 },
      { t: b(18), type: 'pop', gain: 0.6, pan: -0.3 },
      { t: b(20), type: 'hit' },
      { t: b(21), type: 'type', gain: 0.5 },
      { t: b(22), type: 'snap', gain: 0.5 },
    ].filter((cue) => cue.t < dur);
  };

  return { background: BG, scenes, cues };
});
