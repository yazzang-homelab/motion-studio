// lib/fonts.js (browser) — load bundled fonts before the first paint and prove they resolved.
// document.fonts.ready is NOT enough: a face used only by a canvas is never requested by layout, so ready resolves
// while the face is still unloaded and early frames render in a fallback font (research/tech-check §3).
// Undeclared system families "pass" check() while load() returns [], so both must hold for every spec.
//
// Sliced fonts (Google's CJK families: many entries, one family, a unicodeRange each) are loaded eagerly, every slice,
// before frame 0: lazy unicode-range loading would paint the first frames in a fallback. document.fonts.load(spec) with
// no text asks for a space (U+0020), which a Hangul-only slice does not cover, so every entry is probed with a
// character it does cover: its `sample`, else the first printable code point of its unicodeRange, else "A".
// Loaded is not the same as "has the glyph": glyphCoverage() (also used by `node tools/fonts.mjs coverage`) checks that;
// coverage(family, weight, style, chars) is its one-face form, exposed as window.__studio.coverage() by lib/runtime.js.

export const FONT_MANIFEST = 'assets/fonts/fonts.json';

// "100 900" (variable range) -> a representative weight inside the range for the load/check probe.
export function probeWeight(weight) {
  const parts = String(weight).trim().split(/\s+/).map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return String(Math.min(parts[1], Math.max(parts[0], 400)));
  return String(weight).trim() || '400';
}

// Not a control, space, lone surrogate or unassigned code point: a character worth asking the font machinery about.
const PROBEABLE = /^[^\p{White_Space}\p{Cc}\p{Cs}\p{Cn}]$/u;
const RANGE_TOKEN = /^\s*U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i;

/** First probeable character of a CSS unicode-range ("U+AC00-D7A3, U+20"), or null when no token yields one. */
export function firstCodePoint(range) {
  for (const token of String(range ?? '').split(',')) {
    const m = RANGE_TOKEN.exec(token);
    if (!m) continue;
    const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
    const hi = m[2] ? parseInt(m[2], 16) : m[1].includes('?') ? parseInt(m[1].replace(/\?/g, 'F'), 16) : lo;
    for (let cp = lo; cp <= Math.min(hi, lo + 1024, 0x10ffff); cp++) {
      if (PROBEABLE.test(String.fromCodePoint(cp))) return String.fromCodePoint(cp);
    }
  }
  return null;
}

/** The text an entry is probed with: its `sample`, the first printable code point of its unicodeRange, or "A". */
export function sampleFor(entry) {
  if (typeof entry?.sample === 'string' && entry.sample) return entry.sample;
  return (entry?.unicodeRange && firstCodePoint(entry.unicodeRange)) || 'A';
}

const cpLabel = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Validates and normalizes fonts.json-style entries; drops exact duplicates (same family, weight, style, src and
 * unicodeRange). Several entries may share a family: each becomes its own FontFace (one per unicodeRange slice).
 * Returns [{ family, src, weight, style, unicodeRange, stretch, spec, sample }].
 */
export function normalizeFonts(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || typeof it.family !== 'string' || !it.family || typeof it.src !== 'string' || !it.src) {
      throw new Error(`font entry needs "family" and "src": ${JSON.stringify(it)}`);
    }
    if (it.sample != null && typeof it.sample !== 'string') throw new Error(`font entry "sample" must be a string: ${JSON.stringify(it)}`);
    const weight = String(it.weight ?? '400');
    const style = String(it.style ?? 'normal');
    const unicodeRange = it.unicodeRange ? String(it.unicodeRange) : '';
    const key = [it.family, weight, style, it.src, unicodeRange].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      family: it.family, src: it.src, weight, style, unicodeRange, stretch: it.stretch ? String(it.stretch) : '',
      spec: `${style} ${probeWeight(weight)} 64px "${it.family}"`,
      sample: sampleFor({ sample: it.sample, unicodeRange }),
      sampled: (typeof it.sample === 'string' && it.sample !== '') || !!unicodeRange,
    });
  }
  return out;
}

async function readManifest(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new Error(`could not fetch ${url} (${err && err.message ? err.message : err}) — serve the project over http, not file://`);
  }
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`${url} is not valid JSON: ${err.message}`);
  }
  const items = Array.isArray(json) ? json : json && Array.isArray(json.fonts) ? json.fonts : null;
  if (!items) throw new Error(`${url} must be an array of { family, src, weight, style } (or { "fonts": [...] })`);
  return items;
}

// family (lower case, CSS matches names case-insensitively) -> sample characters loadFonts proved loadable.
const LOADED = new Map();

// ---------------------------------------------------------------------------------------------------------------
// Registered faces: which weights and styles of a family really exist. Canvas text with a weight or style that no
// registered face has is synthesized by the browser (faux bold smears a pixel font, faux italic is a slant), so draw.js
// asks this registry for its default weight. Filled by loadFonts (and registerFaces, for tests and odd setups).

const FACES = new Map(); // family (lower case) -> [{ style, weight: '400' | '100 900', lo, hi }]

/** CSS generic families: system fonts by design, nothing is bundled for them (draw.js leaves them unquoted). */
export const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace']);

/** First family of a CSS font-family list, quotes stripped, case kept: '"Instrument Serif", serif' -> 'Instrument Serif'. */
export function firstFamily(stack) {
  const s = String(stack ?? '').trim();
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    return (end < 0 ? s.slice(1) : s.slice(1, end)).trim();
  }
  return s.split(',')[0].trim();
}
const familyKey = (family) => firstFamily(family).toLowerCase();

// A CSS font-size token, optionally followed by /line-height (the end of the shorthand's style/weight prefix).
const SIZE_TOKEN = /^((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:[a-z]+|%)|(?:xx?-)?(?:small|large)|xxx-large|medium|larger|smaller)(?:\s*\/\s*[^\s,]+)?(?:\s+|$)/i;

/**
 * Reads a CSS font shorthand ("italic 700 48px \"Instrument Serif\", serif", also what a canvas gives back for ctx.font) into
 * { style: 'normal' | 'italic' | 'oblique', weight: '400', size: '48px', family: 'Instrument Serif' }. weight is the number as
 * a string (normal = 400, bold = 700; bolder and lighter are kept); family is the first name of the list, quotes stripped.
 * Returns null when there is no size or no family.
 */
export function parseFontSpec(css) {
  let rest = String(css ?? '').trim();
  let style = 'normal';
  let weight = '400';
  while (rest) {
    const size = SIZE_TOKEN.exec(rest);
    if (size) {
      const family = firstFamily(rest.slice(size[0].length));
      return family ? { style, weight, size: size[1], family } : null;
    }
    const m = /^(\S+)\s*/.exec(rest);
    const tok = m[1].toLowerCase();
    rest = rest.slice(m[0].length);
    if (tok === 'italic' || tok === 'oblique') {
      style = tok;
      if (tok === 'oblique') rest = rest.replace(/^-?\d*\.?\d+(?:deg|grad|rad|turn)\s*/i, ''); // oblique <angle>
    } else if (tok === 'bold') weight = '700';
    else if (tok === 'bolder' || tok === 'lighter') weight = tok;
    else if (/^\d{1,4}(?:\.\d+)?$/.test(tok)) weight = String(Number(tok));
    // normal, small-caps, stretch keywords and percentages do not pick a face
  }
  return null;
}

/** "400" -> [400, 400]; "100 900" -> [100, 900]; CSS keywords normal/bold; null when unreadable. */
export function weightRange(weight) {
  const parts = String(weight ?? '400').trim().toLowerCase().split(/\s+/).map((w) => (w === 'normal' ? 400 : w === 'bold' ? 700 : Number(w)));
  if (!parts.length || parts.length > 2 || !parts.every(Number.isFinite)) return null;
  return [Math.min(...parts), Math.max(...parts)];
}

/** Records fonts.json-style entries ({ family, weight, style }) as registered faces. Idempotent. */
export function registerFaces(items) {
  for (const it of items) {
    const range = weightRange(it?.weight);
    if (!it || typeof it.family !== 'string' || !range) continue;
    const key = familyKey(it.family);
    const style = String(it.style ?? 'normal');
    const weight = String(it.weight ?? '400');
    const list = FACES.get(key) ?? [];
    if (!list.some((f) => f.style === style && f.weight === weight)) list.push({ style, weight, lo: range[0], hi: range[1] });
    FACES.set(key, list);
  }
}

/** The faces registered for `family` (name or CSS font-family list; first name counts): [{ style, weight, lo, hi }]; [] when unknown. */
export function registeredFaces(family) {
  return (FACES.get(familyKey(family)) ?? []).map((f) => ({ ...f }));
}

/**
 * The weight to ask for so that no bold is synthesized: `want` when a registered face of `family` covers it (a variable
 * range counts), else the nearest registered weight by the CSS font-matching order (above 500: heavier first, then
 * lighter; below 400: lighter first; 400-500: 400/500 first). `style` picks the faces to look at (any style when that
 * one has none). An unknown family returns `want` unchanged: nothing is known about it.
 */
export function bestWeight(family, want = 700, style = 'normal') {
  const all = FACES.get(familyKey(family)) ?? [];
  const faces = all.filter((f) => f.style === style);
  const pool = faces.length ? faces : all;
  if (!pool.length) return want;
  if (pool.some((f) => f.lo <= want && want <= f.hi)) return want;
  const cands = [...new Set(pool.flatMap((f) => [f.lo, f.hi]))];
  const up = cands.filter((w) => w > want).sort((a, b) => a - b);
  const down = cands.filter((w) => w < want).sort((a, b) => b - a);
  if (want < 400) return down[0] ?? up[0];
  if (want > 500) return up[0] ?? down[0];
  const near = up.filter((w) => w <= 500);
  return near[0] ?? down[0] ?? up[0];
}

export async function loadFonts(list = [], { manifest = FONT_MANIFEST } = {}) {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') throw new Error('loadFonts() needs a browser with the FontFace API');
  const entries = normalizeFonts([...(manifest ? await readManifest(manifest) : []), ...(Array.isArray(list) ? list : [])]);
  const pending = [];
  for (const e of entries) {
    const desc = { weight: e.weight, style: e.style, display: 'block' };
    if (e.unicodeRange) desc.unicodeRange = e.unicodeRange;
    if (e.stretch) desc.stretch = e.stretch;
    // Bad descriptors (weight, style, unicodeRange) do not throw here in Chrome: the face gets status "error" and load() rejects.
    const face = new FontFace(e.family, `url("${e.src.replace(/"/g, '%22')}")`, desc);
    // Every entry is loaded now, sliced or not: nothing may wait for the first glyph that needs it.
    pending.push(
      face.load().then(
        (f) => document.fonts.add(f),
        (err) => {
          throw new Error(`font failed to load: ${e.family} ${e.style} ${e.weight} from ${e.src} (${err && err.message ? err.message : err})`);
        },
      ),
    );
  }
  await Promise.all(pending);
  registerFaces(entries);
  const specs = [];
  const probed = new Set();
  for (const e of entries) {
    if (!specs.includes(e.spec)) specs.push(e.spec);
    for (const ch of Array.from(e.sample)) {
      const key = `${e.spec}\n${ch}`;
      if (probed.has(key)) continue;
      probed.add(key);
      const faces = await document.fonts.load(e.spec, ch);
      if (!faces.length || !document.fonts.check(e.spec, ch)) {
        throw new Error(`font missing: ${e.spec}${e.sampled ? ` (no loaded face covers ${cpLabel(ch)} "${ch}"; entry ${e.src})` : ''}`);
      }
      const fam = e.family.toLowerCase();
      if (!LOADED.has(fam)) LOADED.set(fam, new Set());
      LOADED.get(fam).add(ch);
    }
  }
  return specs;
}

/**
 * True only when `family` is registered and loaded for this weight/style (not a silent system fallback).
 * `text` picks the probe character(s); without it a family loadFonts registered is probed with the characters its entries
 * declare (so a Hangul-only slice set passes), any other name with the browser default (a space).
 */
export async function hasFont(family, weight = '400', style = 'normal', text) {
  const spec = `${style} ${weight} 64px "${family}"`;
  const known = typeof text === 'string' && text ? [text] : [...(LOADED.get(String(family).toLowerCase()) ?? [])];
  if (!known.length) {
    const faces = await document.fonts.load(spec);
    return faces.length > 0 && document.fonts.check(spec);
  }
  for (const probe of known) {
    const faces = await document.fonts.load(spec, probe);
    if (faces.length > 0 && document.fonts.check(spec, probe)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Glyph coverage: which characters would NOT be drawn by the registered face (tofu box or a silent system fallback).

// Code points no font has a glyph for and Chrome draws as the missing-glyph box (U+E0FFF, for one, draws nothing).
const TOFU_CANDIDATES = [0xffff, 0x10ffff, 0x0378, 0x2ffff];
// Not drawn on purpose (spaces, controls, zero-width and other default-ignorable characters, Hangul fillers).
const INVISIBLE = /^[\p{White_Space}\p{Cc}\p{Default_Ignorable_Code_Point}]$/u;
const CANVAS_W = 128;
const CANVAS_H = 96;

/**
 * Per face, the characters of `text` that the face cannot draw. Each character is rasterized on a canvas with the font
 * stack `"Family", <fallback>` and compared with (1) the missing-glyph box in the same stack (reason 'tofu') and (2) the
 * same character in the fallback alone (reason 'fallback': a system font drew it). Identical to either, or blank
 * ('blank'), means the family contributed no glyph. Two fallbacks (serif, monospace) must both agree before a character
 * counts as missing, so a glyph that happens to match one fallback is still found. Spaces, controls and zero-width
 * characters are never reported. Load the fonts first (loadFonts); an unloaded family looks like all-missing.
 *
 * faces: [{ family, style = 'normal', weight = '400' }]. Returns { size, fallbacks, tofu (the reference code point),
 * characters, invisible, faces: [{ family, style, weight, spec, needed, present,
 * missing: [{ ch, cp, reason: 'tofu' | 'fallback' | 'blank' }] }] }.
 */
export function glyphCoverage(faces, text, { size = 48, fallbacks = ['serif', 'monospace'] } = {}) {
  if (typeof document === 'undefined') throw new Error('glyphCoverage() needs a browser canvas');
  const chars = [...new Set(Array.from(String(text ?? '')))];
  const visible = chars.filter((ch) => !INVISIBLE.test(ch));
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('could not create a 2D canvas context');
  const cache = new Map();
  // Raster signature of one character in one font: two FNV-1a hashes over the RGBA words plus the inked pixel count.
  const sig = (font, ch) => {
    const key = `${font}\n${ch}`;
    let s = cache.get(key);
    if (s) return s;
    g.clearRect(0, 0, CANVAS_W, CANVAS_H);
    g.font = font;
    g.fillStyle = '#000';
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillText(ch, 8, Math.round(size * 1.3));
    const px = g.getImageData(0, 0, CANVAS_W, CANVAS_H).data;
    const words = new Uint32Array(px.buffer, px.byteOffset, px.byteLength >> 2);
    let h1 = 0x811c9dc5;
    let h2 = 0x9747b28c;
    let ink = 0;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      h1 = Math.imul(h1 ^ w, 0x01000193);
      h2 = Math.imul(h2 ^ (w + i), 0x85ebca6b);
      if (w >>> 24) ink++;
    }
    s = { key: `${h1 >>> 0}:${h2 >>> 0}:${ink}`, ink };
    cache.set(key, s);
    return s;
  };
  let tofu = null;
  for (const cp of TOFU_CANDIDATES) {
    if (sig(`400 ${size}px ${fallbacks[0]}`, String.fromCodePoint(cp)).ink > 0) { tofu = String.fromCodePoint(cp); break; }
  }
  const out = faces.map((f) => {
    const style = f.style || 'normal';
    const weight = probeWeight(f.weight ?? '400');
    const stacks = fallbacks.map((fb) => ({
      stack: `${style} ${weight} ${size}px ${JSON.stringify(f.family)}, ${fb}`,
      alone: `${style} ${weight} ${size}px ${fb}`,
    }));
    const tofuKeys = stacks.map((s) => (tofu ? sig(s.stack, tofu).key : null));
    const missing = [];
    for (const ch of visible) {
      let reason = null;
      let allMissing = true;
      stacks.forEach((s, i) => {
        const got = sig(s.stack, ch);
        // tofu first: an unsupported character often draws the same box in the fallback stack alone, which is not a real glyph
        const why = got.ink === 0 ? 'blank' : got.key === tofuKeys[i] ? 'tofu' : got.key === sig(s.alone, ch).key ? 'fallback' : null;
        if (!why) allMissing = false;
        else reason ??= why;
      });
      if (allMissing) missing.push({ ch, cp: cpLabel(ch), reason });
    }
    return { family: f.family, style, weight, spec: `${style} ${weight} 64px "${f.family}"`, needed: visible.length, present: visible.length - missing.length, missing };
  });
  return { size, fallbacks, tofu: tofu ? cpLabel(tofu) : null, characters: chars.length, invisible: chars.length - visible.length, faces: out };
}

/**
 * Which characters of `chars` the face `family` / `weight` / `style` cannot draw, for one face and one string: the answer
 * behind window.__studio.coverage() (the same rasterized check as glyphCoverage, so there is one definition of "missing").
 * Resolves { missing, checked }: `missing` = the sorted unique characters with no glyph in that face (tofu box or a silent
 * system fallback; '' when the face covers all of them), `checked` = how many distinct visible characters were looked at
 * (spaces, controls and zero-width characters are not). `family` may be a CSS list (its first name counts); `chars` a string
 * or an array of strings. A name that is not loaded (an unregistered family, a generic one such as sans-serif) has no glyph
 * of its own: every character comes back missing. Load the fonts first: after `await window.__studio.ready` they are.
 */
export async function coverage(family, weight = '400', style = 'normal', chars = '') {
  const text = Array.isArray(chars) ? chars.join('') : String(chars ?? '');
  const name = firstFamily(family);
  if (!name) throw new Error('coverage(): family is required');
  const face = glyphCoverage([{ family: name, weight, style }], text).faces[0];
  const missing = face.missing.map((m) => m.ch.codePointAt(0)).sort((a, b) => a - b);
  return { missing: missing.map((cp) => String.fromCodePoint(cp)).join(''), checked: face.needed };
}
