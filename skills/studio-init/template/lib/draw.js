// lib/draw.js — canvas helpers. Deterministic (no randomness except seeded grain) and defensive: a non-finite
// coordinate skips that draw with a one-time console warning instead of poisoning the path (a NaN point can throw
// misleading errors deep inside the canvas, ClaudeAnimationBase 58cf4ba). Isomorphic at module scope.
// Units: logical px of the format (see lib/layout.js). tracking is in em (0.02 = 2% of the font size).

import { clamp, resolveSpring, spring as springAt } from './motion.js';
import { hash32, mulberry32 } from './rng.js';
import { GENERIC_FAMILIES as GENERIC, bestWeight, firstFamily, parseFontSpec, registeredFaces, weightRange } from './fonts.js';

const warned = new Set();
function bad(fn, ...vals) {
  if (vals.every((v) => Number.isFinite(v))) return false;
  if (!warned.has(fn)) {
    warned.add(fn);
    console.warn(`[motion-studio] ${fn}(): non-finite input skipped`, vals);
  }
  return true;
}
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------
// Colour (brand tokens are hex strings; these keep mixes deterministic and cheap)

const colorCache = new Map();
export function parseColor(c) {
  const key = String(c);
  let v = colorCache.get(key);
  if (v) return v;
  const s = key.trim();
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/i.exec(s))) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) throw new Error(`bad colour ${c}`);
    v = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
    // Comma or space syntax, alpha after "," or "/"; channels 0-255 or percent, alpha 0-1 or percent (CSS Color 4).
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const num = (tok, unit) => (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i.test(tok) ? (tok.endsWith('%') ? (Number(tok.slice(0, -1)) / 100) * unit : Number(tok)) : NaN);
    v = p.length === 3 || p.length === 4
      ? [clamp(num(p[0], 255), 0, 255), clamp(num(p[1], 255), 0, 255), clamp(num(p[2], 255), 0, 255), p.length > 3 ? clamp(num(p[3], 1)) : 1]
      : [NaN];
    // Anything else ("none", relative colours, a stray token) would give NaN channels, which a canvas silently ignores.
    if (!v.every(Number.isFinite)) throw new Error(`unsupported colour "${c}" (use #rgb, #rrggbb, #rrggbbaa or rgb()/rgba() with numbers or percentages)`);
  } else throw new Error(`unsupported colour "${c}" (use #rgb, #rrggbb, #rrggbbaa or rgb()/rgba())`);
  colorCache.set(key, v);
  return v;
}
const css = ([r, g, b, a]) => (a >= 1 ? `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})` : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${r2(a * 1000) / 1000})`);
export function mixColor(a, b, p) {
  const x = parseColor(a);
  const y = parseColor(b);
  const q = clamp(Number.isFinite(p) ? p : 0);
  return css([x[0] + (y[0] - x[0]) * q, x[1] + (y[1] - x[1]) * q, x[2] + (y[2] - x[2]) * q, x[3] + (y[3] - x[3]) * q]);
}
export function rgba(c, alpha) {
  const x = parseColor(c);
  return css([x[0], x[1], x[2], x[3] * clamp(Number.isFinite(alpha) ? alpha : 1)]);
}

// ---------------------------------------------------------------------------------------------------------------
// State helpers

// Default families. runtime.js boot() sets them from studio.json brand.fonts after the fonts loaded: text() and font()
// use brand.fonts.ui, kinetic() uses brand.fonts.display, so a call without `family` draws the brand face instead of a
// hard-coded one (Hangul without a family used to fall back to whatever system font the machine has). 'Inter' stays
// only for a film that never went through boot (a Node script, a unit test).
const fontDefaults = { text: 'Inter', kinetic: 'Inter' };
/** { text, kinetic }: the families text()/font() and kinetic() use when `family` is left out. */
export const getFontDefaults = () => ({ ...fontDefaults });
export function setFontDefaults({ text, kinetic } = {}) {
  if (typeof text === 'string' && text.trim()) fontDefaults.text = text;
  if (typeof kinetic === 'string' && kinetic.trim()) fontDefaults.kinetic = kinetic;
  return getFontDefaults();
}
/**
 * The weight used when a call leaves `weight` out: 700 when the family has a face for it (or is unknown to lib/fonts.js),
 * else the nearest weight that IS registered. Chrome fakes a missing bold by smearing the strokes, which ruins a 400-only
 * face (Instrument Serif, a bitmap font such as NeoDunggeunmo). `style` picks the faces looked at.
 */
export const defaultWeight = (family = fontDefaults.text, style = 'normal') => bestWeight(family, 700, style);

// A requested weight/style that no registered face backs is synthesized by the browser: say so once per combination.
const faceChecked = new Set();
function checkFace(family, weight, style) {
  const key = `${family}|${weight}|${style}`;
  if (faceChecked.has(key)) return;
  const faces = registeredFaces(family);
  if (!faces.length) return; // not a registered family (a system or generic one): nothing is known, so nothing is said
  faceChecked.add(key);
  const range = weightRange(weight);
  const same = faces.filter((f) => f.style === style);
  const have = (list) => [...new Set(list.map((f) => f.weight))].join(', ');
  if (!same.length) console.warn(`[motion-studio] font ${JSON.stringify(family)} has no ${style} face registered (only ${have(faces)} ${faces[0].style}); the browser fakes a slant. Draw it upright or register the ${style} face.`);
  else if (range && !same.some((f) => f.lo <= range[0] && range[0] <= f.hi)) console.warn(`[motion-studio] font ${JSON.stringify(family)} has no weight ${weight} face registered (has ${have(same)}); the browser fakes it and smears the glyphs. Pass weight: ${bestWeight(family, range[0], style)} or register the weight.`);
}

export function font(size, family = fontDefaults.text, weight, style = 'normal') {
  const w = weight == null ? defaultWeight(family, style) : weight;
  checkFace(family, w, style);
  const fam = /[",]/.test(family) || GENERIC.has(family) ? family : `"${family}"`;
  return `${style} ${w} ${r2(size)}px ${fam}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Text-use registry (opt-in): which characters the film draws with which font. Off by default; window.__TEXT_TRACK__ === true
// set before the page loads, or ?texttrack=1, turns it on (lib/runtime.js boot() reads both), and window.__studio.textUse()
// hands the result to the critique, which checks it against the fonts' glyphs (window.__studio.coverage). Recorded: the text
// of text() (when it draws, alpha > 0) and kinetic() (the whole string as soon as it is called, even before its letters spring
// in, so a missing glyph shows on any frame of the scene), the strings textWidth() measures (so wrapText() and fitFontSize()),
// and recordText(str, cssFont) for a film that draws with g.fillText itself. Nothing else touches the canvas: pixels and
// hashes are identical with tracking on or off. Off = one boolean check per call. On = a Set of code points per font,
// plus a bounded memo of the strings already added, so a string that repeats every frame costs one Set lookup.
// A family that is neither registered nor generic is NOT rejected by text()/kinetic(): system fonts are legal per call, and
// boot() asserts only brand.fonts (assertBrandFonts, via hasFont), never the families passed per call. An unregistered
// family or a missing glyph shows up through this registry and window.__studio.coverage() instead.

let trackOn = typeof globalThis !== 'undefined' && globalThis.__TEXT_TRACK__ === true;
const uses = new Map(); // 'style|weight|family (lower case)' -> { family, weight, style, cps: Set<code point>, seen: Set<string> }
const useOf = new Map(); // a request as it came in (bounded) -> its entry in `uses`
const BLANK = /^[\p{White_Space}\p{Cc}]$/u; // never needs a glyph
const blankCp = new Set();
const SEEN_MAX = 256;
const REQUESTS_MAX = 512;

/** Turns the text-use registry on or off (boot() does it for window.__TEXT_TRACK__ and ?texttrack=1). Returns the new state. */
export function setTextTracking(on = true) {
  trackOn = !!on;
  return trackOn;
}
export const isTextTracking = () => trackOn;

/** Forgets everything recorded so far (tracking stays as it is). */
export function resetTextUse() {
  uses.clear();
  useOf.clear();
}

const normWeight = (w) => {
  const s = String(w ?? '400').trim().toLowerCase();
  return s === 'normal' ? '400' : s === 'bold' ? '700' : s;
};

function addChars(entry, str) {
  if (entry.seen.has(str)) return;
  if (entry.seen.size >= SEEN_MAX) entry.seen.clear();
  entry.seen.add(str);
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (entry.cps.has(cp) || blankCp.has(cp)) continue;
    if (BLANK.test(ch)) blankCp.add(cp);
    else entry.cps.add(cp);
  }
}

function entryFor(request, family, weight, style) {
  let e = useOf.get(request);
  if (e) return e;
  const name = firstFamily(family);
  const w = normWeight(weight);
  const st = String(style || 'normal').toLowerCase();
  const key = `${st}|${w}|${name.toLowerCase()}`;
  e = uses.get(key);
  if (!e) uses.set(key, (e = { family: name, weight: w, style: st, cps: new Set(), seen: new Set() }));
  if (useOf.size >= REQUESTS_MAX) useOf.clear();
  useOf.set(request, e);
  return e;
}

// text() / kinetic(): the family list, weight and style as they were asked for.
function trackText(str, family, weight, style) {
  addChars(entryFor(`${family}\u0000${weight}\u0000${style}`, family, weight, style), str);
}

/**
 * Records that `str` is drawn (or measured) with the CSS font `cssFont` ("italic 700 48px \"Inter\", sans-serif"). text(),
 * kinetic(), textWidth() and fitFontSize() call it themselves; call it for text you draw with g.fillText directly.
 * A no-op while tracking is off and for a font string without size or family.
 */
export function recordText(str, cssFont) {
  if (!trackOn) return;
  const s = String(str ?? '');
  if (!s) return;
  const key = String(cssFont);
  let e = useOf.get(key);
  if (!e) {
    const f = parseFontSpec(key);
    if (!f) return;
    e = entryFor(key, f.family, f.weight, f.style);
  }
  addChars(e, s);
}

/**
 * The text-use registry: [{ family, weight, style, chars }], one per font drawn. family = the first name of the CSS font
 * list, quotes stripped (case as first written); weight = '400' | '700' | ... (normal = 400, bold = 700); style = 'normal' |
 * 'italic' | 'oblique'; chars = the distinct non-whitespace characters, sorted by code point. Sorted by family, style,
 * weight. Empty while tracking is off (or before anything is drawn). window.__studio.textUse() resolves this list.
 */
export function getTextUse() {
  const out = [];
  for (const e of uses.values()) {
    if (!e.cps.size) continue;
    let chars = '';
    for (const cp of [...e.cps].sort((a, b) => a - b)) chars += String.fromCodePoint(cp);
    out.push({ family: e.family, weight: e.weight, style: e.style, chars });
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort((a, b) => cmp(a.family, b.family) || cmp(a.style, b.style) || (parseFloat(a.weight) || 0) - (parseFloat(b.weight) || 0) || cmp(a.weight, b.weight));
}

export function withAlpha(g, a, fn) {
  if (!(a > 0)) return; // 0, negative and NaN: nothing visible, skip the work
  g.save();
  g.globalAlpha *= Math.min(1, a);
  fn();
  g.restore();
}

// Translate to (x, y), rotate r, scale s (or sx/sy), then draw content given in coords where (ox, oy) lands on (x, y).
// withTransform(g, { x: cx, y: cy, ox: cx, oy: cy, s: 1.2 }, fn) scales fn's drawing around (cx, cy).
export function withTransform(g, { x = 0, y = 0, s = 1, sx, sy, r = 0, ox = 0, oy = 0 } = {}, fn) {
  const kx = sx ?? s;
  const ky = sy ?? s;
  if (bad('withTransform', x, y, kx, ky, r, ox, oy)) return;
  if (kx === 0 || ky === 0) return; // degenerate matrix: nothing visible
  g.save();
  g.translate(x, y);
  if (r) g.rotate(r);
  if (kx !== 1 || ky !== 1) g.scale(kx, ky);
  if (ox || oy) g.translate(-ox, -oy);
  fn();
  g.restore();
}

const hasSpacing = (g) => 'letterSpacing' in g;
function setTracking(g, px) {
  if (hasSpacing(g)) g.letterSpacing = `${r2(px)}px`;
}
// Chrome applies letterSpacing after every glyph, the last one included; the visual width drops that trailing gap.
function measureRun(g, str, px) {
  const w = g.measureText(str).width;
  if (!px) return w;
  if (hasSpacing(g)) return w - px;
  return w + px * Math.max(0, [...str].length - 1);
}

// Draw one run with tracking and alignment handled here (textAlign stays 'left' so tracking cannot skew centering).
function fillRun(g, str, x, px, y) {
  if (!px || hasSpacing(g)) {
    g.fillText(str, x, y);
    return;
  }
  let cx = x; // manual tracking fallback for contexts without letterSpacing
  for (const ch of str) {
    g.fillText(ch, cx, y);
    cx += g.measureText(ch).width + px;
  }
}

export function text(g, str, x, y, { size = 64, family = fontDefaults.text, weight, style = 'normal', color = '#fff', align = 'left', baseline = 'alphabetic', tracking = 0, alpha = 1 } = {}) {
  if (str == null || str === '' || !(alpha > 0)) return 0;
  if (bad('text', x, y, size, tracking)) return 0;
  const s = String(str);
  const w0 = weight == null ? defaultWeight(family, style) : weight;
  if (trackOn) trackText(s, family, w0, style);
  g.save();
  g.font = font(size, family, w0, style);
  g.fillStyle = color;
  g.globalAlpha *= Math.min(1, alpha);
  g.textBaseline = baseline;
  g.textAlign = 'left';
  const px = tracking * size;
  setTracking(g, px);
  const w = measureRun(g, s, px);
  const x0 = align === 'center' ? x - w / 2 : align === 'right' || align === 'end' ? x - w : x;
  fillRun(g, s, x0, px, y);
  g.restore();
  return w;
}

export function textWidth(g, str, cssFont, tracking = 0) {
  const s = String(str ?? '');
  if (!s) return 0;
  if (trackOn) recordText(s, cssFont);
  const m = /(\d*\.?\d+)px/.exec(cssFont);
  const px = tracking * (m ? Number(m[1]) : 0);
  g.save();
  g.font = cssFont;
  setTracking(g, px);
  const w = measureRun(g, s, px);
  g.restore();
  return w;
}

// ---------------------------------------------------------------------------------------------------------------
// Wrapping. Korean copy is sentences of eojeol (space-separated words) that must not be cut inside a word unless a word
// is wider than the whole line, and never inside a syllable.

// Characters that may not START a line (closing marks, sentence punctuation) and that may not END one (opening brackets).
const NO_START = new Set([...'.,!?;:)]}\'"%°…·', ...'、。，．！？：；）］｝〕〉》」』】〙〗”’»‥']);
const NO_END = new Set([...'([{“‘«（［｛〔〈《「『【〘〖']);
// Characters that attach to the one before them: combining marks, joiners, variation selectors, skin tones and the Hangul
// conjoining jamo (vowels and final consonants), so a syllable written as separate jamo stays whole.
const EXTEND = /^[\p{M}‍︀-️ᅠ-ᇿힰ-퟿\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;

/** Splits into breakable clusters: one code point each, plus whatever attaches to it. A precomposed Hangul syllable is one. */
function clusters(s) {
  const out = [];
  let joined = false;
  for (const ch of s) {
    if (out.length && (joined || EXTEND.test(ch))) out[out.length - 1] += ch;
    else out.push(ch);
    joined = ch === '‍';
  }
  return out;
}

/**
 * Breaks `text` into lines no wider than maxW px (measured with g.measureText in `cssFont`, tracking in em as in text()).
 *   breakWords 'space' (default)  break at spaces only; a word wider than maxW starts on a fresh line and is then cut
 *                                 between characters. 'char': break between any two characters (like CSS break-all).
 *   maxLines                      keep the first N lines. With `ellipsis` (true = "…", or a string) the last kept line
 *                                 is shortened until the mark fits, when text was cut off.
 * A Hangul syllable (or any base character with its marks) is never split. A line never starts with a closing mark
 * (. , ! ? ; : ) ] } " ' % … and their CJK forms) nor ends with an opening bracket: such a mark takes the character before
 * it down to the next line. \n starts a new paragraph line (a blank line stays as ''); runs of spaces count as one.
 * Returns string[] (no leading or trailing spaces); '' gives []. A single character wider than maxW gets its own line.
 * Position the lines yourself: y + i * lineHeight * size with lineHeight >= 1.2, and stagger per line for kinetic().
 */
export function wrapText(g, text, maxW, cssFont, { tracking = 0, maxLines, ellipsis = false, breakWords = 'space' } = {}) {
  if (breakWords !== 'space' && breakWords !== 'char') throw new Error(`wrapText: breakWords must be 'space' or 'char' (got ${JSON.stringify(breakWords)})`);
  if (typeof maxW !== 'number' || Number.isNaN(maxW)) throw new TypeError(`wrapText: maxW must be a number (got ${maxW})`);
  const src = String(text ?? '');
  if (!src) return [];
  const cache = new Map();
  const width = (s) => {
    let w = cache.get(s);
    if (w === undefined) cache.set(s, (w = textWidth(g, s, cssFont, tracking)));
    return w;
  };
  // A break before `u` (which follows `prev` on the line) is legal between words, and between characters unless it would
  // strand a closing mark at the start or an opening bracket at the end.
  const canBreak = (u, prev) => u.sp || (!NO_START.has([...u.s][0]) && !NO_END.has([...prev.s].at(-1)));
  const join = (arr) => arr.map((u, i) => (i && u.sp ? ' ' : '') + u.s).join('');
  const lines = [];
  for (const para of src.replace(/\r\n?/g, '\n').split('\n')) {
    const words = para.split(/[ \t]+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    // Units: whole words, or characters when breakWords is 'char' or the word alone is wider than the line.
    const units = [];
    for (const word of words) {
      if (breakWords === 'space' && width(word) <= maxW) units.push({ s: word, sp: true });
      else clusters(word).forEach((c, i) => units.push({ s: c, sp: i === 0, hard: breakWords === 'space' && i === 0 }));
    }
    let cur = [];
    for (const u of units) {
      if (!cur.length) { cur.push(u); continue; }
      if (u.hard) { lines.push(join(cur)); cur = [u]; continue; } // an over-long word begins on a fresh line
      if (width(join([...cur, u])) <= maxW) { cur.push(u); continue; }
      if (canBreak(u, cur.at(-1))) { lines.push(join(cur)); cur = [u]; continue; }
      let j = cur.length - 1; // the break before u is illegal (u is a closing mark): move the tail of the line down with it
      while (j > 0 && !canBreak(cur[j], cur[j - 1])) j--;
      if (j > 0) { lines.push(join(cur.slice(0, j))); cur = [...cur.slice(j), u]; } else { lines.push(join(cur)); cur = [u]; }
    }
    if (cur.length) lines.push(join(cur));
  }
  while (lines.length && lines.at(-1) === '') lines.pop();
  if (Number.isInteger(maxLines) && maxLines >= 1 && lines.length > maxLines) {
    lines.length = maxLines;
    if (ellipsis) {
      const mark = typeof ellipsis === 'string' ? ellipsis : '…';
      const parts = clusters(lines[maxLines - 1].trimEnd());
      while (parts.length && width(parts.join('').trimEnd() + mark) > maxW) parts.pop();
      lines[maxLines - 1] = parts.join('').trimEnd() + mark;
    }
  }
  return lines;
}

// Kinetic type: each char (or word) springs up from `rise`·size below its slot, staggered. mask: true clips the
// run to its line box so glyphs rise from behind an invisible edge (no fade); otherwise a short alpha ramp.
// Returns { width, left, right } of the laid-out run so accents can be attached to it.
export function kinetic(g, str, x, y, lt, opts = {}) {
  const { size = 64, family = fontDefaults.kinetic, weight, style = 'normal', color = '#fff', tracking = 0, stagger = 0.035, spring = 'snappy', align = 'left', by = 'char', mask = false, alpha = 1, baseline = 'alphabetic', delay = 0 } = opts;
  const rise = opts.rise ?? (mask ? 1.1 : 0.6);
  const s = String(str ?? '');
  if (!s || bad('kinetic', x, y, lt, size, tracking, stagger, rise)) return { width: 0, left: x, right: x };
  const units = by === 'word' ? s.split(/(\s+)/).filter((u) => u.length) : [...s];
  const k = resolveSpring(spring);
  const w0 = weight == null ? defaultWeight(family, style) : weight;
  if (trackOn) trackText(s, family, w0, style); // the whole string, per call: a missing glyph must show before the spring reaches it
  g.save();
  g.font = font(size, family, w0, style);
  g.fillStyle = color;
  g.textBaseline = baseline;
  g.textAlign = 'left';
  const px = tracking * size;
  setTracking(g, px);
  const w = measureRun(g, s, px);
  const x0 = align === 'center' ? x - w / 2 : align === 'right' || align === 'end' ? x - w : x;
  if (mask) {
    // Line box in em relative to y. { top, bottom } overrides it, e.g. { bottom: 0.05 } for caps sitting on a rule.
    const top = baseline === 'top' || baseline === 'hanging' ? -0.1 : baseline === 'middle' ? -0.72 : baseline === 'bottom' || baseline === 'ideographic' ? -1.32 : -1.08;
    const box = typeof mask === 'object' ? mask : {};
    const t0 = Number.isFinite(box.top) ? -box.top : top;
    const t1 = Number.isFinite(box.bottom) ? box.bottom : top + 1.42;
    g.beginPath();
    g.rect(x0 - size * 0.25, y + t0 * size, w + size * 0.5, (t1 - t0) * size);
    g.clip();
  }
  const base = g.globalAlpha * clamp(alpha);
  let prefix = '';
  let idx = 0;
  for (const unit of units) {
    const before = prefix;
    prefix += unit;
    if (!unit.trim()) continue; // spaces take room but do not animate
    const v = springAt(lt - delay - idx * stagger, k.k, k.d, k.m ?? 1);
    idx++;
    if (v <= 0) continue;
    // Slot = width(prefix incl. this unit) − width(unit): keeps the kerning pair with the previous glyph.
    const ux = x0 + (before ? measureRun(g, before + unit, px) - measureRun(g, unit, px) : 0);
    g.globalAlpha = mask ? base : base * clamp(v * 2.5);
    fillRun(g, unit, ux, px, y + (1 - v) * rise * size);
  }
  g.restore();
  return { width: w, left: x0, right: x0 + w };
}

// ---------------------------------------------------------------------------------------------------------------
// Stepped reveals: hard steps, no alpha ramp, no rise, integer-snapped edges. Drive them with a progress p (0..1) the
// caller computes from c.frameLt (never from the subframe time lt: with motion blur the subframes of one output frame would
// sit on different steps and the average is a half-blended edge). See "Which clock" in docs/API.md.

/** p (0..1) quantized UP to `steps` hard steps: 0 only at p <= 0, the first step shows as soon as p > 0, 1 at p >= 1. NaN -> 0. */
export function stepProgress(p, steps = 6) {
  const n = Math.max(1, Math.floor(Number.isFinite(steps) ? steps : 6));
  if (!(p > 0)) return 0;
  return Math.min(n, Math.ceil(p * n - 1e-6)) / n;
}

/**
 * Reveal fn() through a clip rect that grows in `steps` hard steps; same rect and dir conventions as maskReveal() ('up' grows
 * from the bottom edge, 'down' from the top, 'left' from the right edge, 'right' from the left, 'center' from the middle).
 * Every clip edge is rounded to an integer pixel (edges, not widths, so steps never jitter). p <= 0 or NaN draws nothing.
 * Returns the quantized progress (0..1).
 */
export function scanReveal(g, { x, y, w, h }, p, { steps = 6, dir = 'down' } = {}, fn) {
  if (!['up', 'down', 'left', 'right', 'center'].includes(dir)) throw new Error(`scanReveal: unknown dir "${dir}" (up, down, left, right, center)`);
  if (bad('scanReveal', x, y, w, h) || !Number.isFinite(p)) return 0;
  const q = stepProgress(p, steps);
  if (q <= 0) return 0;
  let x0 = x;
  let y0 = y;
  let x1 = x + w;
  let y1 = y + h;
  if (dir === 'up') y0 = y + h * (1 - q);
  else if (dir === 'down') y1 = y + h * q;
  else if (dir === 'left') x0 = x + w * (1 - q);
  else if (dir === 'right') x1 = x + w * q;
  else {
    x0 = x + (w * (1 - q)) / 2;
    x1 = x + (w * (1 + q)) / 2;
    y0 = y + (h * (1 - q)) / 2;
    y1 = y + (h * (1 + q)) / 2;
  }
  const [rx0, ry0, rx1, ry1] = [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
  if (rx1 <= rx0 || ry1 <= ry0) return q;
  clipRect(g, rx0, ry0, rx1 - rx0, ry1 - ry0, fn);
  return q;
}

/**
 * Stepped text: the units (characters, or words with by: 'word') appear whole, left to right, in `steps` hard steps
 * (default one step per unit); nothing fades or rises, and p <= 0 or NaN draws nothing. Same layout, tracking, alignment
 * and family/weight defaults as kinetic() (family defaults to brand.fonts.display), and the whole string is recorded for the
 * font-fallback preflight on every call, even before its first unit shows. snap (default true) rounds each unit's x and y to
 * integer pixels (bitmap fonts). Returns { width, left, right } of the full run, like kinetic().
 */
export function steppedText(g, str, x, y, p, opts = {}) {
  const { size = 64, family = fontDefaults.kinetic, weight, style = 'normal', color = '#fff', tracking = 0, align = 'left', by = 'char', alpha = 1, baseline = 'alphabetic', snap = true } = opts;
  const s = String(str ?? '');
  if (!s || bad('steppedText', x, y, size, tracking)) return { width: 0, left: x, right: x };
  const units = by === 'word' ? s.split(/(\s+)/).filter((u) => u.length) : [...s];
  const w0 = weight == null ? defaultWeight(family, style) : weight;
  if (trackOn) trackText(s, family, w0, style);
  g.save();
  g.font = font(size, family, w0, style);
  g.fillStyle = color;
  g.textBaseline = baseline;
  g.textAlign = 'left';
  const px = tracking * size;
  setTracking(g, px);
  const w = measureRun(g, s, px);
  const x0 = align === 'center' ? x - w / 2 : align === 'right' || align === 'end' ? x - w : x;
  const total = units.filter((u) => u.trim()).length;
  const q = Number.isFinite(p) ? stepProgress(p, opts.steps ?? total) : 0;
  const shown = Math.min(total, Math.ceil(q * total - 1e-6));
  g.globalAlpha = g.globalAlpha * clamp(alpha);
  let prefix = '';
  let idx = 0;
  for (const unit of units) {
    const before = prefix;
    prefix += unit;
    if (!unit.trim()) continue;
    if (idx++ >= shown) break;
    const ux = x0 + (before ? measureRun(g, before + unit, px) - measureRun(g, unit, px) : 0);
    fillRun(g, unit, snap ? Math.round(ux) : ux, px, snap ? Math.round(y) : y);
  }
  g.restore();
  return { width: w, left: x0, right: x0 + w };
}

// ---------------------------------------------------------------------------------------------------------------
// Shapes

export function roundRect(g, x, y, w, h, r = 0) {
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  const rr = clamp(Number.isFinite(r) ? r : 0, 0, Math.min(w, h) / 2);
  g.beginPath();
  if (rr <= 0) {
    g.rect(x, y, w, h);
    return;
  }
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  g.lineTo(x + w, y + h - rr);
  g.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  g.lineTo(x + rr, y + h);
  g.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  g.lineTo(x, y + rr);
  g.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  g.closePath();
}

export function fillRoundRect(g, x, y, w, h, r, color) {
  if (bad('fillRoundRect', x, y, w, h) || w === 0 || h === 0) return;
  roundRect(g, x, y, w, h, r);
  if (color != null) g.fillStyle = color;
  g.fill();
}

export function strokeRoundRect(g, x, y, w, h, r, color, width = 2) {
  if (bad('strokeRoundRect', x, y, w, h, width) || !(width > 0)) return;
  roundRect(g, x, y, w, h, r);
  if (color != null) g.strokeStyle = color;
  g.lineWidth = width;
  g.stroke();
}

export function circle(g, x, y, r, color) {
  if (bad('circle', x, y, r) || !(r > 0)) return;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  if (color != null) g.fillStyle = color;
  g.fill();
}

export function clipRect(g, x, y, w, h, fn) {
  if (bad('clipRect', x, y, w, h)) return;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  fn();
  g.restore();
}

// Reveal fn() through a growing window: 'up' grows from the bottom edge, 'down' from the top, 'left' from the right
// edge, 'right' from the left edge, 'center' from the middle outwards (both axes).
export function maskReveal(g, { x, y, w, h }, p, dir = 'up', fn) {
  if (!(p > 0) || bad('maskReveal', x, y, w, h)) return;
  const q = Math.min(1, p);
  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;
  if (dir === 'up') {
    ry = y + h * (1 - q);
    rh = h * q;
  } else if (dir === 'down') rh = h * q;
  else if (dir === 'left') {
    rx = x + w * (1 - q);
    rw = w * q;
  } else if (dir === 'right') rw = w * q;
  else if (dir === 'center') {
    rx = x + (w * (1 - q)) / 2;
    ry = y + (h * (1 - q)) / 2;
    rw = w * q;
    rh = h * q;
  } else throw new Error(`maskReveal: unknown dir "${dir}" (up, down, left, right, center)`);
  clipRect(g, rx, ry, rw, rh, fn);
}

const pt = (p) => (Array.isArray(p) ? p : [p.x, p.y]);

// Stroke the first p (0..1, by arc length) of a polyline. Returns the tip [x, y] (null when nothing is drawn).
export function lineProgress(g, points, p, { width = 4, color = '#fff', cap = 'round', join = 'round' } = {}) {
  if (!points || points.length < 2 || !(p > 0)) return null;
  const P = points.map(pt);
  if (P.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    bad('lineProgress', NaN);
    return null;
  }
  let total = 0;
  const seg = [];
  for (let i = 1; i < P.length; i++) {
    const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    seg.push(l);
    total += l;
  }
  if (total === 0) return null;
  let left = total * Math.min(1, p);
  g.beginPath();
  g.moveTo(P[0][0], P[0][1]);
  let tip = P[0];
  for (let i = 1; i < P.length; i++) {
    const l = seg[i - 1];
    if (left >= l) {
      g.lineTo(P[i][0], P[i][1]);
      tip = P[i];
      left -= l;
      continue;
    }
    const f = l > 0 ? left / l : 0;
    tip = [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * f, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * f];
    g.lineTo(tip[0], tip[1]);
    break;
  }
  g.lineWidth = width;
  g.strokeStyle = color;
  g.lineCap = cap;
  g.lineJoin = join;
  g.stroke();
  return tip;
}

export function ring(g, x, y, r, p, { width, color = '#fff', start = -Math.PI / 2, cap = 'round' } = {}) {
  if (!(p > 0) || bad('ring', x, y, r, start) || !(r > 0)) return;
  g.beginPath();
  g.arc(x, y, r, start, start + Math.PI * 2 * Math.min(1, p));
  g.lineWidth = width ?? r * 0.14;
  g.strokeStyle = color;
  g.lineCap = cap;
  g.stroke();
}

// Arrow pointer with its hotspot (tip) at (x, y); ~46 px tall at scale 1. pressed 0..1 squashes it slightly.
const ARROW = [[0, 0], [0, 17.2], [4.2, 13.2], [7.1, 20], [10, 18.8], [7.2, 12.2], [12.6, 12.2]];
export function cursor(g, x, y, { scale = 1, pressed = 0, fill = '#FFFFFF', stroke = '#141413' } = {}) {
  if (bad('cursor', x, y, scale, pressed) || !(scale > 0)) return;
  const k = scale * 2.3 * (1 - 0.12 * clamp(pressed));
  g.save();
  g.translate(x, y);
  g.scale(k, k);
  g.beginPath();
  g.moveTo(ARROW[0][0], ARROW[0][1]);
  for (let i = 1; i < ARROW.length; i++) g.lineTo(ARROW[i][0], ARROW[i][1]);
  g.closePath();
  g.lineJoin = 'round';
  g.lineWidth = 1.5;
  g.strokeStyle = stroke;
  g.fillStyle = fill;
  g.fill();
  g.stroke();
  g.restore();
}

// ---------------------------------------------------------------------------------------------------------------
// Texture. Grain is a pure function of (seed, frameIndex). Pass c.frame: it is the OUTPUT frame index, the same for every
// motion-blur subframe of that frame (lib/timeline.js renderFrame), so a still, the preview and a blurred final render show
// the same grain. c.frame * c.subs + c.sub instead gives each subframe its own grain, which the blur then averages (softer).

const TILE = 256;
const grainTiles = new Map();
function grainTile(seed, variant) {
  const key = `${seed}|${variant}`;
  let c = grainTiles.get(key);
  if (c) return c;
  if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(TILE, TILE);
  else if (typeof document !== 'undefined') c = Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  else return null;
  const cg = c.getContext('2d', { willReadFrequently: true }); // CPU raster, like the stage
  const img = cg.createImageData(TILE, TILE);
  const d = img.data;
  const r = mulberry32(hash32('grain', seed, variant));
  for (let i = 0; i < d.length; i += 4) {
    const n = r() + r() - 1; // triangular in [-1, 1]: softer than uniform
    const v = n > 0 ? 255 : 0;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = Math.round(Math.abs(n) * 255);
  }
  cg.putImageData(img, 0, 0);
  if (grainTiles.size > 16) grainTiles.clear();
  grainTiles.set(key, c);
  return c;
}

export function grain(g, W, H, frameIndex, { amount = 0.05, seed = 1, cell = 2 } = {}) {
  if (!(amount > 0) || bad('grain', W, H, frameIndex, cell) || !(cell > 0)) return;
  const f = Math.floor(frameIndex);
  const tile = grainTile(seed, ((f % 4) + 4) % 4);
  if (!tile || typeof g.createPattern !== 'function') return;
  const pat = g.createPattern(tile, 'repeat');
  const r = mulberry32(hash32('grain-offset', seed, f));
  if (pat && typeof pat.setTransform === 'function' && typeof DOMMatrix !== 'undefined') {
    pat.setTransform(new DOMMatrix([cell, 0, 0, cell, Math.floor(r() * TILE) * cell, Math.floor(r() * TILE) * cell]));
  }
  g.save();
  g.globalAlpha *= Math.min(1, amount);
  g.imageSmoothingEnabled = false;
  g.fillStyle = pat;
  g.fillRect(0, 0, W, H);
  g.restore();
}

export function vignette(g, W, H, { strength = 0.35, color = '#000000' } = {}) {
  if (!(strength > 0) || bad('vignette', W, H)) return;
  const rad = Math.hypot(W, H) / 2;
  const grad = g.createRadialGradient(W / 2, H / 2, rad * 0.35, W / 2, H / 2, rad);
  grad.addColorStop(0, rgba(color, 0));
  grad.addColorStop(1, rgba(color, clamp(strength)));
  g.save();
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.restore();
}
