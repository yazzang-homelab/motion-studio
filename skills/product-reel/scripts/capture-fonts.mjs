// Web fonts for capture.mjs: find the @font-face faces a page really used, download them (woff2 first), identify them
// by magic bytes, look for a license and register the files in the project's assets/fonts/fonts.json (array of
// { family, src, weight, style, unicodeRange?, license?, licenseFile? }, the shape tools/fonts.mjs add-file writes).
// Nothing here touches the page. Licenses stay UNVERIFIED unless a URL or a license text turns up.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createGuard, redactUrl } from './capture-guard.mjs';

const MAX_FONT = 10 * 1024 * 1024; // one font file
const MAX_FONT_FILES = 150; // a CJK family in ~100 unicode-range slices still fits
// Decompression budget (the size checks above only see compressed bytes, and a 1 MB WOFF can declare a 1 GiB table):
// nothing is inflated beyond min(32 MiB, 200 x its compressed size); a header that declares more than 200 x, or more than
// 256 MiB, marks the font as a decompression bomb and it is refused.
const MAX_INFLATE = 32 * 1024 * 1024;
const MAX_RATIO = 200;
const BOMB_BYTES = 256 * 1024 * 1024;
const inflateCap = (compressed) => Math.min(MAX_INFLATE, Math.max(compressed, 1) * MAX_RATIO);
class FontLimitError extends Error {}

const FONT_EXT = { woff2: '.woff2', woff: '.woff', ttf: '.ttf', otf: '.otf' };
const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC',
  'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ',
  'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak',
  'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];
const sha6 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 6);
const sameFamily = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Font container from its first bytes (never from the URL or Content-Type): { kind, ext } or { problem }. */
export function sniffFont(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 12) return { problem: `too small to be a font (${b.length} bytes)` };
  const tag = b.toString('latin1', 0, 4);
  if (tag === 'wOF2' || tag === 'wOFF') {
    const kind = tag === 'wOF2' ? 'woff2' : 'woff';
    const declared = b.readUInt32BE(8);
    if (declared !== b.length) return { problem: `truncated ${kind}: the header says ${declared} bytes, got ${b.length}` };
    const bomb = inflateProblem(b);
    return bomb ? { problem: bomb } : { kind, ext: FONT_EXT[kind] };
  }
  const sfnt = (kind) => {
    const tables = b.readUInt16BE(4);
    return tables >= 1 && tables <= 200 && 12 + 16 * tables <= b.length ? { kind, ext: FONT_EXT[kind] } : { problem: `broken ${kind} table directory` };
  };
  if (tag === 'OTTO') return sfnt('otf');
  if (b.readUInt32BE(0) === 0x00010000 || tag === 'true') return sfnt('ttf');
  if (tag === 'ttcf') return { problem: 'a font collection (.ttc) cannot be used by @font-face' };
  if (b.toString('utf8', 0, 256).trimStart().startsWith('<')) return { problem: 'an HTML page, not a font' };
  return { problem: `not a font container (starts with 0x${b.subarray(0, 4).toString('hex')})` };
}

/** Every url() of an @font-face `src` value with its format() hint, resolved against `base`; local() sources are dropped. */
export function parseSrc(srcText, base) {
  const out = [];
  for (const m of String(srcText || '').matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)(?:\s*format\(\s*(['"]?)([^'")]*)\3\s*\))?/gi)) {
    let url;
    try { url = m[2].startsWith('data:') ? m[2] : new URL(m[2], base).href; } catch { continue; }
    out.push({ url, format: (m[4] || '').toLowerCase() });
  }
  return out;
}

/** @font-face rules of a CSS text (for stylesheets the page itself is not allowed to read). */
export function parseFontFaces(css, base) {
  const out = [];
  const text = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const prop = (name) => new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`, 'i').exec(m[1])?.[1].trim() ?? null;
    const family = (prop('font-family') || '').replace(/['"]/g, '').trim();
    if (family) out.push({ family, weight: prop('font-weight') || '400', style: prop('font-style') || 'normal', unicodeRange: prop('unicode-range'), srcText: prop('src') || '', base });
  }
  return out;
}

const normWeight = (w) => {
  const t = String(w || '400').trim().toLowerCase();
  return t === 'normal' ? '400' : t === 'bold' ? '700' : t.replace(/\s*(?:\.\.|-)\s*/, ' ').replace(/\s+/g, ' ');
};
// A FontFace without a unicode-range reports the whole code space; the rule has none. Both mean "no slicing".
const normRange = (r) => {
  const text = r ? String(r).split(/[\s,]+/).filter(Boolean).map((x) => x.toUpperCase()).join(', ') : '';
  return text === 'U+0-10FFFF' ? '' : text;
};
// Matching form of a range: Chrome reports a FontFace's range as "U+0-FF, U+131", the stylesheet says "U+0000-00FF, U+0131".
const canonRange = (r) => normRange(r).split(', ').filter(Boolean).map((t) => t.replace(/[0-9A-F?]+/g, (h) => h.replace(/^0+(?=.)/, ''))).join(', ');
const faceKey = (f) => [String(f.family).toLowerCase(), normWeight(f.weight), String(f.style || 'normal').toLowerCase(), canonRange(f.unicodeRange)].join('|');
const weightSpan = (w) => normWeight(w).split(' ').map(Number);

/** True when an fonts.json entry already provides this face: same family, style and unicode-range, weight equal or inside its variable range. */
function coveredBy(list, face) {
  const [lo, hi = lo] = weightSpan(face.weight);
  return list.find((e) => {
    if (!sameFamily(e.family, face.family) || String(e.style || 'normal') !== String(face.style || 'normal') || canonRange(e.unicodeRange) !== canonRange(face.unicodeRange)) return false;
    const [elo, ehi = elo] = weightSpan(e.weight);
    return elo <= lo && hi <= ehi;
  });
}

// Preferred container first: woff2, woff, then raw sfnt. Formats @font-face allows but the runtime cannot use are skipped.
function rankFont(c) {
  const f = c.format || '';
  const ext = c.url.startsWith('data:') ? '' : path.extname(new URL(c.url).pathname).toLowerCase();
  if (f === 'woff2' || ext === '.woff2') return 0;
  if (f === 'woff' || ext === '.woff') return 1;
  if (['truetype', 'opentype', 'ttf', 'otf'].includes(f) || ext === '.ttf' || ext === '.otf') return 2;
  if (['embedded-opentype', 'svg', 'eot'].includes(f) || ext === '.eot' || ext === '.svg') return Infinity;
  return 3; // no hint (a CDN URL without extension): try it last and let the magic bytes decide
}

// WOFF: the `name` entry of the table directory ({ off, comp, orig }), or null.
function woffNameEntry(b) {
  for (let i = 0, n = b.readUInt16BE(12); i < n; i++) {
    const at = 44 + 20 * i;
    if (at + 20 > b.length) throw new Error('truncated WOFF table directory');
    if (b.toString('latin1', at, at + 4) === 'name') return { off: b.readUInt32BE(at + 4), comp: b.readUInt32BE(at + 8), orig: b.readUInt32BE(at + 12) };
  }
  return null;
}

// WOFF2: each table's length in the decompressed stream, the total, and where the brotli stream starts.
function woff2Dir(b) {
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      if (p >= b.length) throw new Error('truncated WOFF2 table directory');
      const c = b[p++];
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Error('bad UIntBase128');
  };
  const tables = [];
  for (let i = 0, n = b.readUInt16BE(12); i < n; i++) {
    if (p >= b.length) throw new Error('truncated WOFF2 table directory');
    const flags = b[p++];
    const idx = flags & 0x3f;
    if (idx === 63 && p + 4 > b.length) throw new Error('truncated WOFF2 table directory');
    const name = idx === 63 ? b.toString('latin1', p, (p += 4)) : WOFF2_TAGS[idx];
    const orig = base128();
    const transformed = idx === 10 || idx === 11 ? flags >> 6 !== 3 : flags >> 6 !== 0; // glyf/loca: version 3 is the null transform
    tables.push({ name, len: transformed ? base128() : orig });
  }
  return { tables, start: p, compressed: b.readUInt32BE(20), total: tables.reduce((a, t) => a + t.len, 0) };
}

/**
 * A reason to refuse a woff/woff2 whose header declares far more decompressed data than its compressed bytes can hold
 * (a decompression bomb), or null. Reads declared lengths only; nothing is inflated.
 */
export function inflateProblem(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  try {
    const tag = b.toString('latin1', 0, 4);
    let declared, compressed, what;
    if (tag === 'wOFF') {
      const e = woffNameEntry(b);
      if (!e || e.comp >= e.orig) return null;
      ({ orig: declared, comp: compressed } = e);
      what = 'name table';
    } else if (tag === 'wOF2') {
      const d = woff2Dir(b);
      ({ total: declared, compressed } = d);
      what = 'table data';
    } else return null;
    if (declared > BOMB_BYTES || (declared > 65536 && declared > MAX_RATIO * Math.max(compressed, 1))) {
      return `decompression bomb: the header declares ${(declared / 1048576).toFixed(1)} MB of ${what} from ${compressed} compressed bytes`;
    }
  } catch { /* an unreadable directory is caught by the callers' own checks */ }
  return null;
}

// The sfnt `name` table of a ttf/otf/woff/woff2 (brotli for woff2: the directory gives each table's length in the
// decompressed stream), or null. Only used to look for a license URL that the font file itself declares.
// Declared lengths are checked against the decompression budget before anything is inflated, and the inflater gets the
// declared size as a hard output limit, so a lying header cannot make it allocate more.
function nameTable(b) {
  const tag = b.toString('latin1', 0, 4);
  if (tag === 'wOFF') {
    const e = woffNameEntry(b);
    if (!e) return null;
    if (e.off + e.comp > b.length) throw new Error('the name table lies outside the file');
    const raw = b.subarray(e.off, e.off + e.comp);
    if (e.comp >= e.orig) return raw;
    if (e.orig > inflateCap(e.comp)) throw new FontLimitError(`name table inflates to ${e.orig} bytes from ${e.comp} (limit ${inflateCap(e.comp)})`);
    return zlib.inflateSync(raw, { maxOutputLength: e.orig });
  }
  if (tag === 'wOF2') {
    const d = woff2Dir(b);
    if (d.total > inflateCap(d.compressed)) throw new FontLimitError(`table data inflates to ${d.total} bytes from ${d.compressed} (limit ${inflateCap(d.compressed)})`);
    const data = zlib.brotliDecompressSync(b.subarray(d.start, d.start + d.compressed), { maxOutputLength: Math.max(d.total, 1) });
    let at = 0;
    for (const t of d.tables) { if (t.name === 'name') return data.subarray(at, at + t.len); at += t.len; }
    return null;
  }
  for (let i = 0, n = b.readUInt16BE(4); i < n; i++) {
    const at = 12 + 16 * i;
    if (b.toString('latin1', at, at + 4) === 'name') return b.subarray(b.readUInt32BE(at + 8), b.readUInt32BE(at + 8) + b.readUInt32BE(at + 12));
  }
  return null;
}

/** Copyright (id 0), license description (13) and license URL (14) that a font file declares; {} when unreadable. */
export function readFontNames(buf) {
  try {
    const t = nameTable(buf);
    if (!t || t.length < 6) return {};
    const count = t.readUInt16BE(2);
    const store = t.readUInt16BE(4);
    const best = {};
    for (let i = 0; i < count && 6 + 12 * i + 12 <= t.length; i++) {
      const r = 6 + 12 * i;
      const [plat, , lang, id, len, off] = [0, 2, 4, 6, 8, 10].map((o) => t.readUInt16BE(r + o));
      if (![0, 13, 14].includes(id)) continue;
      const raw = t.subarray(store + off, store + off + len);
      const str = (plat === 3 || plat === 0 ? Buffer.from(raw.subarray(0, raw.length & ~1)).swap16().toString('utf16le') : raw.toString('latin1')).trim();
      const rank = plat === 3 && lang === 0x409 ? 2 : plat === 3 || plat === 0 ? 1 : 0;
      if (str && (!best[id] || rank > best[id].rank)) best[id] = { rank, str };
    }
    return { copyright: best[0]?.str ?? null, licenseText: best[13]?.str ?? null, licenseUrl: best[14]?.str ?? null };
  } catch {
    return {};
  }
}

const licenseIdOf = (text) => (/SIL\s+OPEN\s+FONT\s+LICENSE|scripts\.sil\.org\/OFL|openfontlicense\.org/i.test(text) ? 'OFL-1.1'
  : /Apache\s+License|apache\.org\/licenses/i.test(text) ? 'Apache-2.0' : /Ubuntu\s+Font\s+Licen[cs]e/i.test(text) ? 'UFL-1.0' : null);

// A license for one family: a URL or text the font file declares, the Google Fonts specimen page for fonts served by
// Google (open-source licenses only), or a LICENSE/OFL text next to a self-hosted file. Otherwise UNVERIFIED.
async function findLicense(context, family, fontUrl, buf, pageUrl, cache, guard) {
  const names = readFontNames(buf);
  const declaredUrl = names.licenseUrl && /^https?:\/\//i.test(names.licenseUrl) ? names.licenseUrl : null;
  const id = licenseIdOf(`${names.licenseText || ''} ${names.licenseUrl || ''}`);
  const lic = { status: 'UNVERIFIED', note: 'no license URL or file found; check the font license before publishing' };
  if (declaredUrl || id) Object.assign(lic, { status: 'FOUND', source: 'font file', url: declaredUrl, id, note: 'declared inside the font file; read it and confirm it covers your use' });
  if (/^https:\/\/fonts\.gstatic\.com\//i.test(fontUrl) && lic.status === 'UNVERIFIED') {
    Object.assign(lic, { status: 'FOUND', source: 'google-fonts', url: `https://fonts.google.com/specimen/${encodeURIComponent(family).replace(/%20/g, '+')}`, note: 'served by Google Fonts (open-source licenses only); the license is on the specimen page' });
  }
  let file = null;
  if (!fontUrl.startsWith('data:') && new URL(fontUrl).origin === new URL(pageUrl).origin) { // self-hosted: a license text may sit next to the font
    const dir = new URL('.', fontUrl).href;
    if (!cache.has(dir)) {
      let found = null;
      for (const name of ['OFL.txt', 'LICENSE.txt', 'LICENSE', 'license.txt', 'LICENCE.txt']) {
        const res = await guard.get(context, dir + name, { timeout: 6000, headers: { Referer: referer(pageUrl) }, maxBytes: 200 * 1024 });
        const body = res.ok ? res.body : null;
        const text = body && body.length >= 100 && !body.subarray(0, 4096).includes(0) ? body.toString('utf8') : '';
        if (text && !/^\s*<(?:!doctype|html)/i.test(text) && /licen[sc]e|copyright|permission/i.test(text)) { found = { body, url: dir + name, id: licenseIdOf(text) }; break; }
      }
      cache.set(dir, found);
    }
    file = cache.get(dir);
    if (file) Object.assign(lic, { status: 'FOUND', source: 'license file next to the font', url: file.url, id: file.id || lic.id || null, note: 'a license text sits next to the font on the site; read it and confirm it covers your use' });
  }
  return { license: lic, file };
}

/**
 * Is a fonts.json entry's license on record? 'verified' = a license id (not "unknown") AND the license text file are both there,
 * as `tools/fonts.mjs add-file --license-file` writes them; anything else is 'unverified' (nobody recorded a license).
 */
export function licenseState(entry) {
  const id = String(entry?.license ?? '').trim();
  return id && id.toLowerCase() !== 'unknown' && entry?.licenseFile ? 'verified' : 'unverified';
}

const reuseLicense = (entry, basis) => ({
  license: { status: 'FOUND', source: 'fonts.json', id: entry.license, file: entry.licenseFile, url: null, reusedFrom: entry.src ?? null,
    note: `license already on record in fonts.json for ${entry.family} (${entry.license}, ${entry.licenseFile}); reused for this face from the entry ${entry.src ?? '(no src)'}: ${basis}` },
  file: null,
  reuse: { id: entry.license, file: entry.licenseFile, from: entry.src ?? null, basis },
});

/** The directory a face was downloaded from, as fonts.json records it in `source` (no query, no fragment, secrets redacted); null for data: URLs. */
export function sourceDirOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return redactUrl(new URL('.', u.href).href);
  } catch { return null; }
}
const originOf = (url) => { try { const o = new URL(url).origin; return o === 'null' ? null : o; } catch { return null; } };

/**
 * Does a verified fonts.json entry's license plausibly cover a face downloaded from `url`? 'same-source' = the entry recorded where it came
 * from (`source`) and the new file comes from the same origin; 'unrecorded' = the entry has no recorded source (registered by hand with
 * tools/fonts.mjs), so only the new file's own license check can contradict it; null = a recorded source on another origin.
 */
export function reuseBasis(entry, url) {
  if (!entry.source) return 'unrecorded';
  const a = originOf(entry.source);
  const b = originOf(url);
  return a && b && a === b ? 'same-source' : null;
}

// Only the origin is sent as Referer, as Chrome does across origins: the page URL may carry a token in its query.
const referer = (pageUrl) => { try { return `${new URL(pageUrl).origin}/`; } catch { return undefined; } };

async function fetchText(context, url, pageUrl, guard) {
  const res = await guard.get(context, url, { timeout: 15000, headers: { Referer: referer(pageUrl) }, maxBytes: 2 * 1024 * 1024 });
  return res.ok ? res.body.toString('utf8') : null;
}

export function readFontsJson(root) {
  const file = path.join(root, 'assets', 'fonts', 'fonts.json');
  if (!fs.existsSync(file)) return { file, list: [], wrap: null };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (err) { throw new Error(`assets/fonts/fonts.json is not valid JSON (${err.message}); fix it or delete it`); }
  if (Array.isArray(raw)) return { file, list: raw, wrap: null };
  if (raw && Array.isArray(raw.fonts)) return { file, list: raw.fonts, wrap: raw };
  throw new Error('assets/fonts/fonts.json must be an array of {family, src, weight, style}');
}

/**
 * The fonts the page really used: @font-face rules (readable sheets from the page, the others fetched here) that
 * match a face whose status is "loaded", deduplicated, downloaded as woff2 (else woff, ttf, otf) and identified by
 * magic bytes. Faces fonts.json already provides are not fetched. Returns files in memory; nothing is written yet.
 */
export async function collectFonts(context, fonts, pageUrl, existing, notes, guard = createGuard({ target: pageUrl })) {
  const rules = [...(fonts.rules || [])];
  for (const href of new Set(fonts.unreadableSheets || [])) {
    const css = await fetchText(context, href, pageUrl, guard);
    if (css == null) { notes.push(`font stylesheet could not be fetched: ${redactUrl(href).slice(0, 120)}`); continue; }
    rules.push(...parseFontFaces(css, href));
  }
  const loaded = new Set((fonts.allLoaded || []).filter((l) => l.status === 'loaded').map(faceKey));
  const seen = new Set();
  const used = [];
  let unused = 0;
  for (const r of rules) {
    const k = faceKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    if (loaded.has(k)) used.push(r); else unused++;
  }
  const files = [];
  const skipped = [];
  const licenses = new Map();
  const dirCache = new Map();
  for (const r of used.slice(0, MAX_FONT_FILES)) {
    const face = { family: r.family, weight: normWeight(r.weight), style: String(r.style || 'normal').toLowerCase(), unicodeRange: normRange(r.unicodeRange) || null };
    const have = coveredBy(existing, face);
    if (have) { skipped.push({ ...face, reason: `already registered in fonts.json (${have.src}); left as it is` }); continue; }
    const options = parseSrc(r.srcText, r.base).filter((c) => rankFont(c) < Infinity).sort((a, b) => rankFont(a) - rankFont(b));
    let got = null;
    const problems = [];
    try {
      for (const c of options) {
        const shown = redactUrl(c.url).slice(0, 80);
        let buf;
        if (c.url.startsWith('data:')) {
          const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(c.url);
          buf = m ? (m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]), 'latin1')) : null;
        } else {
          const res = await guard.get(context, c.url, { timeout: 20000, headers: { Referer: referer(pageUrl) }, maxBytes: MAX_FONT });
          if (!res.ok) { problems.push(`${shown}: ${res.reason}`); continue; }
          buf = res.body;
        }
        if (!buf) { problems.push(`${shown}: download failed`); continue; }
        if (buf.length > MAX_FONT) { problems.push(`${shown}: ${(buf.length / 1048576).toFixed(1)} MB is over the ${MAX_FONT / 1048576} MB limit`); continue; }
        const kind = sniffFont(buf);
        if (kind.problem) { problems.push(`${shown}: ${kind.problem}`); continue; }
        got = { buf, kind, url: c.url };
        break;
      }
      const key = got ? `${face.family.toLowerCase()}|${originOf(got.url) ?? 'data'}` : '';
      if (got && !licenses.has(key)) {
        // A family whose license is already on record in fonts.json (id and license text) keeps it for the faces added now, so the entry
        // that arrives next to a verified one does not turn into a second, UNVERIFIED entry. Only when the new file plausibly belongs to
        // that distribution (see reuseBasis): another origin, or a file whose own license check names a different license, is checked on its own.
        const on = existing.find((e) => sameFamily(e.family, face.family) && licenseState(e) === 'verified');
        const basis = on ? reuseBasis(on, got.url) : null;
        let found;
        if (on && basis === 'same-source') found = reuseLicense(on, 'same source origin as the entry');
        else {
          found = await findLicense(context, face.family, got.url, got.buf, pageUrl, dirCache, guard);
          const own = found.license.status === 'FOUND' ? found.license.id : null;
          if (on && basis === 'unrecorded' && !(own && own !== on.license)) found = reuseLicense(on, "the entry records no source; the new file's own license check found nothing that contradicts it");
          else if (on && own && own === on.license) found = reuseLicense(on, "the new file's own license check names the same license");
          else if (on) found.license.note += `; fonts.json has a verified ${face.family} entry (${on.license}) but this file comes from another source, so that license was not reused`;
        }
        licenses.set(key, found);
      }
    } catch (err) { // one broken face is skipped, the capture goes on
      got = null;
      problems.push(String(err.message).split('\n')[0]);
    }
    if (!got) { skipped.push({ ...face, reason: problems.length ? problems.join('; ') : 'no woff2, woff, ttf or otf source' }); continue; }
    const found = licenses.get(`${face.family.toLowerCase()}|${originOf(got.url) ?? 'data'}`);
    files.push({ ...face, source: sourceDirOf(got.url), url: got.url.startsWith('data:') ? 'data:' : got.url, buf: got.buf, kind: got.kind.kind, ext: got.kind.ext, license: found.license, licenseFile: found.file, reuse: found.reuse ?? null });
  }
  if (used.length > MAX_FONT_FILES) notes.push(`${used.length} font faces are in use; only the first ${MAX_FONT_FILES} were downloaded`);
  if (unused) notes.push(`${unused} @font-face rule(s) were declared but not used by this page and were not downloaded`);
  return { files, skipped, unused };
}

// File-name stem: the family in lower-case ASCII; other names (Hangul, accents) keep their ASCII part plus a short hash.
function asciiName(family) {
  const low = family.toLowerCase();
  const s = low.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s && s === low.replace(/[ .'_-]+/g, '-') ? s : `${s || 'font'}-${sha6(family)}`;
}

/** Writes the downloaded files to assets/fonts/ and adds one entry each to fonts.json (same shape and names as tools/fonts.mjs add-file). */
export function registerFonts(root, files) {
  const { file, list, wrap } = readFontsJson(root);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const licenseFiles = new Map();
  for (const f of files) {
    const stem = `${asciiName(f.family)}-${f.weight.replace(' ', '-')}${f.style === 'italic' ? '-italic' : ''}${f.unicodeRange ? `-u${sha6(f.unicodeRange)}` : ''}`;
    let rel = `assets/fonts/${stem}${f.ext}`;
    if (list.some((e) => e.src === rel && !sameFamily(e.family, f.family))) rel = `assets/fonts/${stem}-${sha6(f.family.toLowerCase())}${f.ext}`; // never overwrite another family's file
    fs.writeFileSync(path.join(root, rel), f.buf);
    const entry = { family: f.family, src: rel, weight: f.weight, style: f.style };
    if (f.unicodeRange) entry.unicodeRange = f.unicodeRange;
    if (f.source) entry.source = f.source;
    if (f.reuse) {
      entry.license = f.reuse.id;
      entry.licenseFile = f.reuse.file;
    } else if (f.licenseFile) {
      const key = `${f.family.toLowerCase()}|${sha6(f.licenseFile.body)}`;
      if (!licenseFiles.has(key)) {
        const id = f.licenseFile.id;
        let name = `assets/fonts/${id === 'OFL-1.1' ? 'OFL' : id === 'UFL-1.0' ? 'UFL' : 'LICENSE'}-${f.family.replace(/[^A-Za-z0-9]/g, '') || asciiName(f.family)}.txt`;
        const onDisk = fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name)) : null;
        const taken = (onDisk && !onDisk.equals(Buffer.from(f.licenseFile.body))) || [...licenseFiles.values()].includes(name);
        if (taken) name = name.replace(/\.txt$/, `-${sha6(f.licenseFile.body)}.txt`); // a different license text never replaces one already on disk
        fs.writeFileSync(path.join(root, name), f.licenseFile.body);
        licenseFiles.set(key, name);
      }
      entry.licenseFile = licenseFiles.get(key);
      if (f.licenseFile.id) entry.license = f.licenseFile.id;
    }
    list.push(entry);
    written.push({ family: f.family, weight: f.weight, style: f.style, unicodeRange: f.unicodeRange, file: rel, format: f.kind, bytes: f.buf.length, from: f.url, licenseFile: entry.licenseFile ?? null,
      license: { ...f.license, ...(entry.licenseFile ? { file: entry.licenseFile } : {}) } });
  }
  if (written.length) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(wrap ? { ...wrap, fonts: list } : list, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }
  return written;
}
