#!/usr/bin/env node
// Vendor fonts into assets/fonts/ so renders never touch the network (the runtime loads them with FontFace and
// asserts them; fonts.ready alone does not load canvas-only fonts).
//
//   node tools/fonts.mjs add "Family:400,700" [--italic] [--subsets latin,latin-ext] [--yes]   Google Fonts
//   node tools/fonts.mjs add-file <path|https-url> --family NAME [--weight 400] [--style normal] [--license-file <path|url>]
//   node tools/fonts.mjs coverage --text "..." [--text-file f] [--family NAME] [--format 9x16]  glyphs the fonts lack
//   node tools/fonts.mjs list
//   node tools/fonts.mjs remove <family>
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot, loadConfig, parseArgs, usage, main, UsageError, readJSON, writeJSON, writeFileAtomic, ensureDir,
  slug, log, sha256, isMainModule, resolveFormats, FORMATS, even, startServer, launchBrowser } from './studio.mjs';
import { probeWeight } from '../lib/fonts.js';

// A current desktop Chrome UA: the CSS2 API picks the file format by user agent and serves woff2 to this one.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const API = 'https://fonts.googleapis.com/css2';
const LICENSES = [ // where google/fonts keeps each family's license, by license type
  { dir: 'ofl', file: 'OFL.txt', id: 'OFL-1.1', prefix: 'OFL' },
  { dir: 'apache', file: 'LICENSE.txt', id: 'Apache-2.0', prefix: 'LICENSE' },
  { dir: 'ufl', file: 'UFL.txt', id: 'UFL-1.0', prefix: 'UFL' },
];
const REMINDER = 'License: check the family\'s license before commercial use (OFL and Apache allow it) and keep the license file next to the fonts.';
export const MAX_SLICES = 12; // `add` downloads at most this many files without --yes (CJK families come in ~100 slices)
const MAX_FONT_BYTES = 64 * 1024 * 1024;
const COMMANDS = ['add', 'add-file', 'coverage', 'list', 'remove'];

// ---------------------------------------------------------------------------------------------------------------
// Network (injectable: the exported add/addFile take `io` so tests run offline)

async function get(url, what) {
  let r;
  try { r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) }); } catch (err) {
    throw new Error(`cannot reach ${new URL(url).host} (${err.cause?.code ?? err.message}); check the network${process.env.HTTPS_PROXY ? ' (Node fetch ignores HTTPS_PROXY)' : ''}`);
  }
  return { ok: r.ok, status: r.status, body: Buffer.from(await r.arrayBuffer()), what };
}

/** Content-Length of a URL in bytes, or null when the server does not say. */
async function head(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    const n = Number(r.headers.get('content-length'));
    return r.ok && Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

const NET = { get, head };

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ---------------------------------------------------------------------------------------------------------------
// Names, weights, ranges

const FAMILY_RE = /^[\p{L}\p{N} .'-]+$/u;

function validFamily(name) {
  const family = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!family) throw new UsageError('empty family name');
  if (!FAMILY_RE.test(family)) throw new UsageError(`bad family name "${family}" (letters, digits, spaces, . ' - only)`);
  return family;
}

export function parseSpec(spec) {
  const m = String(spec).match(/^\s*([^:]+?)\s*(?::\s*(.+))?$/);
  if (!m || !m[1].trim()) throw new UsageError(`bad font spec "${spec}" (use "Family:400,700" or "Family:100..900")`);
  const family = validFamily(m[1]);
  const w = (m[2] ?? '400').trim();
  const range = w.match(/^(\d{1,4})\s*\.\.\s*(\d{1,4})$/);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    if (!(a >= 1 && b <= 1000 && a < b)) throw new UsageError(`bad weight range ${w} (1..1000, low..high)`);
    return { family, weights: [`${a}..${b}`], range: true };
  }
  const weights = [...new Set(w.split(/[,;\s]+/).filter(Boolean).map((x) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new UsageError(`bad weight "${x}" in "${spec}" (integers 1-1000, e.g. 400,700)`);
    return n;
  }))].sort((a, b) => a - b);
  return { family, weights: weights.map(String), range: false };
}

/** ASCII-only file stem: the slug when it is ASCII, else the ASCII part plus a short hash (Hangul family names). */
function asciiName(family) {
  const s = slug(family);
  if (/^[a-z0-9-]+$/.test(s)) return s;
  return `${s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'font'}-${sha256(family).slice(0, 6)}`;
}
/** "Instrument Serif" -> "InstrumentSerif" (license file names); non-Latin names fall back to asciiName. */
const compactName = (family) => family.replace(/[^A-Za-z0-9]/g, '') || asciiName(family);

/** "400" | "100 900" from 400, "bold", "100..900", "100-900" or "100 900". */
export function normalizeWeight(input) {
  const raw = String(input ?? '400').trim().toLowerCase();
  if (raw === 'normal') return '400';
  if (raw === 'bold') return '700';
  const nums = raw.split(/\s*(?:\.\.|-|\s)\s*/).filter(Boolean);
  const ok = nums.length >= 1 && nums.length <= 2 && nums.every((n) => /^\d{1,4}$/.test(n));
  const [a, b] = nums.map(Number);
  if (!ok || a < 1 || a > 1000 || (nums.length === 2 && (b > 1000 || a >= b))) {
    throw new UsageError(`bad weight "${input}" (an integer 1-1000 such as 400, or a variable range such as "100 900")`);
  }
  return nums.length === 2 ? `${a} ${b}` : String(a);
}

const normalizeWeightSafe = (w) => { try { return normalizeWeight(w); } catch { return String(w); } };

/** "U+AC00-D7A3,u+20-7e" -> "U+AC00-D7A3, U+20-7E"; throws a UsageError on anything that is not a CSS unicode-range. */
export function normalizeUnicodeRange(input) {
  const tokens = String(input ?? '').split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) throw new UsageError('--unicode-range is empty (example: "U+AC00-D7A3,U+3131-318E")');
  return tokens.map((tok) => {
    const m = /^U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(tok);
    if (!m) throw new UsageError(`bad unicode-range token "${tok}" (use U+AC00, U+AC00-D7A3 or U+4??)`);
    if (m[2] && m[1].includes('?')) throw new UsageError(`bad unicode-range token "${tok}" (a ? wildcard cannot start a range)`);
    const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'F'), 16);
    if (hi > 0x10ffff || lo > hi) throw new UsageError(`bad unicode-range token "${tok}" (code points run 0-10FFFF, low to high)`);
    return tok.toUpperCase().replace(/^U\+/, 'U+');
  }).join(', ');
}

// ---------------------------------------------------------------------------------------------------------------
// Font containers and license texts

const UINT32 = (b, at) => b.readUInt32BE(at);
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * Identifies a font file by its magic bytes, never by its extension. Returns { kind, ext, problem }: `problem` is null for
 * a usable container (woff2, woff, ttf, otf) and a readable reason for anything else (HTML page, Git LFS pointer, font
 * collection, truncated download, garbage).
 */
export function sniffFont(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const bad = (kind, problem) => ({ kind, ext: null, problem });
  if (b.length < 12) return bad('unknown', `too small to be a font (${b.length} bytes)`);
  const tag = b.subarray(0, 4).toString('latin1');
  if (tag === 'wOF2' || tag === 'wOFF') {
    const kind = tag === 'wOF2' ? 'woff2' : 'woff';
    const declared = UINT32(b, 8);
    if (declared !== b.length) return bad(kind, `truncated or padded ${kind}: the header says ${declared} bytes, the file has ${b.length}`);
    return { kind, ext: kind, problem: null };
  }
  const sfnt = (kind, ext) => {
    const tables = b.readUInt16BE(4);
    if (tables < 1 || tables > 200 || 12 + 16 * tables > b.length) return bad(kind, `broken ${ext} table directory (${tables} tables in ${b.length} bytes)`);
    return { kind, ext, problem: null };
  };
  if (tag === 'OTTO') return sfnt('otf', 'otf');
  if (UINT32(b, 0) === 0x00010000 || tag === 'true') return sfnt('ttf', 'ttf');
  if (tag === 'ttcf') return bad('ttc', 'a font collection (.ttc/.otc) cannot be used by @font-face: extract one face first');
  const head = stripBom(b.subarray(0, 256).toString('utf8')).trimStart().toLowerCase();
  if (head.startsWith('<')) return bad('html', 'this is an HTML page, not a font (a 404 or login page saved instead? open the raw file URL)');
  if (head.startsWith('version https://git-lfs')) return bad('lfs', 'this is a Git LFS pointer, not the font (download the real file, not the pointer)');
  return bad('unknown', `not a font container (starts with 0x${b.subarray(0, 4).toString('hex')}; accepted: woff2, woff, ttf, otf)`);
}

/** Rejects binary or HTML text saved in place of a license; returns the decoded text. */
function licenseText(buf, where) {
  const text = buf.toString('utf8');
  if (buf.subarray(0, 4096).includes(0)) throw new Error(`${where} is a binary file, not a license text`);
  if (/^\s*<(?:!doctype|html|\?xml)/i.test(stripBom(text))) throw new Error(`${where} is an HTML page, not a license text (use the raw file URL, e.g. raw.githubusercontent.com/...)`);
  if (text.trim().length < 20) throw new Error(`${where} is nearly empty (${text.trim().length} characters)`);
  return text;
}

/** SPDX-style id from a license text: OFL-1.1, Apache-2.0, UFL-1.0 or null; `reservedName` when it declares an RFN. */
export function inferLicense(text) {
  const t = String(text);
  let id = null;
  if (/SIL\s+OPEN\s+FONT\s+LICENSE/i.test(t) && /Version\s+1\.1/i.test(t)) id = 'OFL-1.1';
  else if (/Apache\s+License/i.test(t) && /Version\s+2\.0/i.test(t)) id = 'Apache-2.0';
  else if (/Ubuntu\s+Font\s+Licen[cs]e/i.test(t)) id = 'UFL-1.0';
  return { id, reservedName: /with\s+Reserved\s+Font\s+Names?\s+["“‘']/i.test(t) };
}

/** "SIL OFL 1.1" / "OFL" / "Apache 2.0" -> SPDX-style id used in fonts.json; anything else is kept as typed. */
export function normalizeLicenseId(input) {
  const raw = String(input ?? '').trim();
  const k = raw.toLowerCase().replace(/[\s_]+/g, '-');
  if (/^(sil-)?ofl(-1\.1)?$/.test(k) || /^sil-open-font-licen[cs]e(-(v|version-)?1\.1)?$/.test(k)) return 'OFL-1.1';
  if (/^apache(-licen[cs]e)?(-(v|version-)?2(\.0)?)?$/.test(k)) return 'Apache-2.0';
  if (/^ufl(-1\.0)?$/.test(k) || /^ubuntu-font-licen[cs]e(-1\.0)?$/.test(k)) return 'UFL-1.0';
  return raw;
}
const licensePrefix = (id) => (id === 'OFL-1.1' ? 'OFL' : id === 'UFL-1.0' ? 'UFL' : 'LICENSE');

// ---------------------------------------------------------------------------------------------------------------
// Google Fonts CSS

function cssUrl({ family, weights }, italic) {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  const axis = italic ? `ital,wght@${[0, 1].flatMap((i) => weights.map((w) => `${i},${w}`)).join(';')}` : `wght@${weights.join(';')}`;
  return `${API}?family=${fam}:${axis}&display=swap`;
}

/**
 * @font-face blocks with their subset. The API writes a label comment before the named subsets (latin, latin-ext,
 * cyrillic, ...); the numbered unicode-range slices of CJK families come without one (or as `[n]`) and are named
 * `slice-<n>` from the number in the file URL (`....118.woff2`).
 */
export function parseCss(css) {
  const out = [];
  const re = /(?:\/\*\s*([^*]*?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  let m;
  let unlabeled = 0;
  while ((m = re.exec(css))) {
    const body = m[2];
    const prop = (k) => (body.match(new RegExp(`${k}\\s*:\\s*([^;]+);`)) || [])[1]?.trim() ?? null;
    const src = (prop('src') || '').match(/url\(([^)]+)\)\s*format\(['"]?woff2['"]?\)/);
    if (!src) continue;
    const url = src[1].replace(/^['"]|['"]$/g, '');
    const label = m[1]?.trim();
    let subset;
    if (label && /^[\w-]+$/.test(label)) subset = label;
    else {
      const n = label?.match(/^\[(\d+)\]$/)?.[1] ?? url.match(/\.(\d+)\.woff2(?:$|[?#])/)?.[1] ?? String(unlabeled);
      unlabeled++;
      subset = `slice-${n}`;
    }
    out.push({ subset, family: (prop('font-family') || '').replace(/^['"]|['"]$/g, ''), style: prop('font-style') || 'normal', weight: (prop('font-weight') || '400').replace(/\s+/g, ' '), url, unicodeRange: prop('unicode-range') });
  }
  return out;
}

const CJK_ALIASES = ['korean', 'cjk', 'slices'];

/** Blocks for the wanted subsets. `korean` (aliases cjk, slices) selects the numbered slices of a CJK family. */
export function selectBlocks(blocks, subsets) {
  const want = new Set(subsets.map((s) => String(s).toLowerCase()));
  const slices = CJK_ALIASES.some((a) => want.has(a));
  return blocks.filter((b) => want.has(b.subset) || (slices && b.subset.startsWith('slice-')));
}

/** "latin, latin-ext, korean (119 slices)" — what a family offers, with the numbered slices folded. */
export function describeSubsets(blocks) {
  const named = [...new Set(blocks.filter((b) => !b.subset.startsWith('slice-')).map((b) => b.subset))];
  const slices = new Set(blocks.filter((b) => b.subset.startsWith('slice-')).map((b) => b.subset)).size;
  return [...named, ...(slices ? [`korean (${slices} numbered slices)`] : [])].join(', ') || 'none';
}

/** Bytes of the given URLs: measured (HEAD Content-Length) where the server answers, extrapolated for the rest. */
async function estimateBytes(urls, io) {
  const sizes = await mapLimit(urls, 8, (u) => io.head(u));
  const known = sizes.filter((n) => Number.isFinite(n) && n > 0);
  if (!known.length) return { bytes: null, exact: false, measured: 0 };
  const sum = known.reduce((a, n) => a + n, 0);
  return { bytes: Math.round(sum + (sum / known.length) * (urls.length - known.length)), exact: known.length === urls.length, measured: known.length };
}

// ---------------------------------------------------------------------------------------------------------------
// assets/fonts/fonts.json

const fontsFile = (root) => path.join(root, 'assets', 'fonts', 'fonts.json');
function readFonts(root) {
  const raw = readJSON(fontsFile(root), []);
  if (Array.isArray(raw)) return { list: raw, wrap: null };
  if (raw && Array.isArray(raw.fonts)) return { list: raw.fonts, wrap: raw };
  throw new Error('assets/fonts/fonts.json must be an array of {family, src, weight, style}');
}
const saveFonts = (root, list, wrap) => writeJSON(fontsFile(root), wrap ? { ...wrap, fonts: list } : list);
const sameFamily = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * True when a fonts.json path names a place inside assets/fonts/ of this project: relative, no drive letter, no UNC share,
 * no `..` climbing out. path.relative() alone is not enough on Windows: between two drives (or onto a share) it returns the
 * absolute target, which never starts with "..". Drive and UNC forms are refused on every platform, so a fonts.json that
 * travelled from Windows to a POSIX machine is judged the same way.
 */
export function insideFontsDir(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return false;
  if (/^(?:[a-z]:|[\\/])/i.test(rel) || path.isAbsolute(rel)) return false;
  const fontsDir = path.resolve(root, 'assets', 'fonts');
  const r = path.relative(fontsDir, path.resolve(root, rel));
  return !!r && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
}

/**
 * Deletes the given project-relative files that no remaining entry uses. Never leaves assets/fonts/, never OFL.txt.
 * A path outside assets/fonts/ (an absolute, drive, UNC or `..` src in a hand-edited or foreign fonts.json) is never
 * touched: it is returned in `skipped`, so the caller can say the file was left alone.
 */
function deleteUnused(root, rels, remaining) {
  const used = new Set(remaining.flatMap((f) => [f.src, f.licenseFile]).filter(Boolean));
  const deleted = [];
  const skipped = [];
  for (const rel of new Set(rels.filter(Boolean))) {
    if (used.has(rel)) continue;
    if (!insideFontsDir(root, rel)) { skipped.push(String(rel)); continue; }
    const abs = path.resolve(root, rel);
    if (path.basename(abs) === 'OFL.txt') continue;
    if (fs.existsSync(abs)) { fs.rmSync(abs); deleted.push(rel); }
  }
  return { deleted, skipped };
}

async function fetchLicense(root, family, io) {
  const key = family.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const L of LICENSES) {
    const r = await io.get(`https://raw.githubusercontent.com/google/fonts/main/${L.dir}/${key}/${L.file}`, 'license').catch(() => null);
    if (!r?.ok || r.body.length < 200) continue;
    const name = `${L.prefix}-${compactName(family)}.txt`;
    writeFileAtomic(path.join(root, 'assets', 'fonts', name), r.body);
    return { license: L.id, licenseFile: `assets/fonts/${name}` };
  }
  return { license: null, licenseFile: null };
}

// ---------------------------------------------------------------------------------------------------------------
// add (Google Fonts)

export async function add(root, cfg, spec, { italic = false, subsets = ['latin', 'latin-ext'], yes = false } = {}, io = NET) {
  const want = parseSpec(spec);
  const url = cssUrl(want, italic);
  const css = await io.get(url, 'css');
  if (!css.ok) throw new Error(`Google Fonts has no "${want.family}" with weights ${want.weights.join(',')}${italic ? ' + italic' : ''} (HTTP ${css.status}); check the name and weights at https://fonts.google.com/?query=${encodeURIComponent(want.family)}`);
  const blocks = parseCss(css.body.toString('utf8'));
  const available = describeSubsets(blocks);
  const picked = selectBlocks(blocks, subsets);
  if (!picked.length) throw new Error(`no woff2 for subsets ${subsets.join(',')} (available: ${available}); pass --subsets`);
  const urls = [...new Set(picked.map((b) => b.url))];
  let estimate = null;
  if (picked.length > MAX_SLICES) {
    // A CJK family is ~100 slices: say so before fetching hundreds of files, and ask.
    estimate = await estimateBytes(urls, io);
    const size = estimate.bytes == null ? 'size unknown' : `${estimate.exact ? '' : 'about '}${fmtBytes(estimate.bytes)}${estimate.exact ? '' : ' (extrapolated from ' + estimate.measured + ' measured files)'}`;
    const plan = `${want.family}: ${picked.length} files${urls.length === picked.length ? '' : ` (${urls.length} distinct downloads)`}, ${size}, for --subsets ${subsets.join(',')}`;
    if (!yes) {
      throw new UsageError(`${plan}: more than ${MAX_SLICES} slices, so nothing was downloaded.\n` +
        '  - to download them all: repeat the command with --yes (every slice is loaded at boot, and each is one entry in fonts.json)\n' +
        '  - for one file instead: add-file with a full Hangul woff2, e.g.\n' +
        `    node tools/fonts.mjs add-file <path-or-https-url-of-a-full-Hangul.woff2> --family "${want.family}" --license-file <license path or url>`);
    }
    log(`${plan}; downloading (--yes)`);
  }
  const dir = ensureDir(path.join(root, 'assets', 'fonts'));
  const lic = await fetchLicense(root, want.family, io);
  const cache = new Map();
  await mapLimit(urls, 6, async (u) => {
    const r = await io.get(u, 'font');
    if (!r.ok || sniffFont(r.body).kind !== 'woff2') throw new Error(`download failed for ${u} (HTTP ${r.status})`);
    cache.set(u, r.body);
  });
  const entries = [];
  for (const b of picked) {
    const file = `${asciiName(want.family)}-${b.weight.replace(' ', '-')}${b.style === 'italic' ? '-italic' : ''}-${b.subset}.woff2`;
    writeFileAtomic(path.join(dir, file), cache.get(b.url));
    entries.push({ family: want.family, src: `assets/fonts/${file}`, weight: b.weight, style: b.style, unicodeRange: b.unicodeRange ?? undefined, license: lic.license ?? 'unknown', licenseFile: lic.licenseFile ?? undefined, bytes: cache.get(b.url).length, subset: b.subset });
  }
  const { list, wrap } = readFonts(root);
  const srcs = new Set(entries.map((e) => e.src));
  const keep = list.filter((f) => !srcs.has(f.src));
  saveFonts(root, [...keep, ...entries.map(({ bytes, subset, ...e }) => e)], wrap);
  const brandUses = Object.values(cfg?.brand?.fonts ?? {}).includes(want.family);
  return { family: want.family, files: entries.map((e) => ({ src: e.src, weight: e.weight, style: e.style, subset: e.subset, bytes: e.bytes })), license: lic.license, licenseFile: lic.licenseFile, availableSubsets: available, brandUses, sliced: entries.length, estimate };
}

// ---------------------------------------------------------------------------------------------------------------
// add-file (a font you already have: a local file or an https URL)

async function readSource(src, io, what) {
  const s = String(src ?? '').trim();
  if (/^https?:\/\//i.test(s)) {
    if (!/^https:/i.test(s)) throw new UsageError(`${what} URL must be https (got ${s})`);
    const r = await io.get(s, what);
    if (!r.ok) throw new Error(`${what}: HTTP ${r.status} from ${s}`);
    if (r.body.length > MAX_FONT_BYTES) throw new Error(`${what} from ${s} is ${fmtBytes(r.body.length)}, more than the ${fmtBytes(MAX_FONT_BYTES)} limit`);
    return { buf: r.body, from: s };
  }
  const abs = path.resolve(s);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`${what} file not found: ${abs}`); }
  if (!st.isFile()) throw new Error(`${what} path is not a file: ${abs}`);
  if (st.size > MAX_FONT_BYTES) throw new Error(`${what} ${abs} is ${fmtBytes(st.size)}, more than the ${fmtBytes(MAX_FONT_BYTES)} limit`);
  return { buf: fs.readFileSync(abs), from: abs };
}

/** rel unchanged unless another family's entry already uses that file name; then a short hash of the family is added. */
function ownName(list, rel, family) {
  const other = list.some((f) => (f.src === rel || f.licenseFile === rel) && !sameFamily(f.family, family));
  if (!other) return rel;
  const ext = path.posix.extname(rel);
  return `${rel.slice(0, rel.length - ext.length)}-${sha256(family.toLowerCase()).slice(0, 6)}${ext}`;
}

export async function addFile(root, cfg, src, opts = {}, io = NET) {
  const family = validFamily(opts.family);
  const weight = normalizeWeight(opts.weight ?? '400');
  const style = String(opts.style ?? 'normal').toLowerCase();
  if (!['normal', 'italic'].includes(style)) throw new UsageError(`bad --style "${opts.style}" (normal | italic)`);
  const unicodeRange = opts.unicodeRange ? normalizeUnicodeRange(opts.unicodeRange) : null;
  if (!src) throw new UsageError('add-file needs a font file path or https URL');

  const font = await readSource(src, io, 'font');
  const sniff = sniffFont(font.buf);
  if (sniff.problem) throw new Error(`${font.from}: ${sniff.problem}`);
  const warnings = [];
  const notes = [];
  const declaredExt = path.extname(font.from.split(/[?#]/)[0]).slice(1).toLowerCase();
  if (declaredExt && declaredExt !== sniff.ext && ['woff2', 'woff', 'ttf', 'otf'].includes(declaredExt)) notes.push(`the file is named .${declaredExt} but is a ${sniff.kind}: saved as .${sniff.ext}`);

  const { list, wrap } = readFonts(root);
  // A second weight/style of a family that already ships a license reuses it instead of warning again.
  const sibling = list.find((f) => sameFamily(f.family, family) && f.licenseFile);
  let license = opts.license ? normalizeLicenseId(opts.license) : null;
  let licenseBuf = null;
  if (opts.licenseFile) {
    const lic = await readSource(opts.licenseFile, io, 'license');
    const text = licenseText(lic.buf, lic.from);
    licenseBuf = lic.buf;
    const seen = inferLicense(text);
    if (seen.id && license && seen.id !== license) warnings.push(`--license says ${license} but ${lic.from} reads as ${seen.id}`);
    license ??= seen.id;
    if (!license) warnings.push(`could not tell which license ${lic.from} is: pass --license "<id>" so fonts.json records it`);
    if (seen.reservedName) notes.push('the license declares a Reserved Font Name: use the font unmodified, under its own name');
  } else if (sibling) {
    license ??= sibling.license ?? null;
    notes.push(`no license given: reusing ${sibling.licenseFile} from the ${family} entry already registered`);
  } else if (license) {
    warnings.push(`no license file for ${family}: pass --license-file <path|url> so the license text ships next to the font`);
  } else {
    warnings.push(`no license given for ${family}: check the font's license before commercial use, then re-run with --license-file <path|url> (and --license "<id>")`);
  }

  ensureDir(path.join(root, 'assets', 'fonts'));
  const stem = `${asciiName(family)}-${weight.replace(' ', '-')}${style === 'italic' ? '-italic' : ''}${unicodeRange ? `-u${sha256(unicodeRange).slice(0, 6)}` : ''}`;
  const rel = ownName(list, `assets/fonts/${stem}.${sniff.ext}`, family);
  let licenseRel = null;
  if (licenseBuf) licenseRel = ownName(list, `assets/fonts/${licensePrefix(license)}-${compactName(family)}.txt`, family);

  const isSame = (f) => sameFamily(f.family, family) && normalizeWeightSafe(f.weight) === weight && String(f.style ?? 'normal') === style && (f.unicodeRange ? String(f.unicodeRange) : '') === (unicodeRange ?? '');
  const replaced = list.filter(isSame);
  const entry = { family, src: rel, weight, style };
  if (unicodeRange) entry.unicodeRange = unicodeRange;
  if (license) entry.license = license;
  if (licenseRel) entry.licenseFile = licenseRel;
  else if (sibling && !opts.licenseFile) entry.licenseFile = sibling.licenseFile;

  writeFileAtomic(path.join(root, rel), font.buf);
  if (licenseBuf) writeFileAtomic(path.join(root, licenseRel), licenseBuf);
  const rest = list.filter((f) => !isSame(f));
  saveFonts(root, [...rest, entry], wrap);
  const { deleted, skipped } = deleteUnused(root, replaced.flatMap((f) => [f.src, f.licenseFile]), [...rest, entry]);
  if (skipped.length) warnings.push(`left alone (not inside assets/fonts/): ${skipped.join(', ')}`);
  const brandRoles = Object.entries(cfg?.brand?.fonts ?? {}).filter(([, v]) => sameFamily(v, family)).map(([k]) => k);
  return { family, src: rel, weight, style, unicodeRange, format: sniff.kind, bytes: font.buf.length, license: entry.license ?? null, licenseFile: entry.licenseFile ?? null, replaced: replaced.map((f) => f.src), deleted, warnings, notes, brandUses: brandRoles.length > 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// list / remove

export function list(root) {
  const { list: items } = readFonts(root);
  const fams = new Map();
  for (const f of items) {
    const g = fams.get(f.family) ?? { family: f.family, weights: new Set(), styles: new Set(), files: 0, bytes: 0, missing: [], license: new Set() };
    g.weights.add(String(f.weight ?? '400')); g.styles.add(f.style ?? 'normal'); g.files++;
    const p = path.join(root, f.src ?? '');
    if (f.src && fs.existsSync(p)) g.bytes += fs.statSync(p).size; else g.missing.push(f.src);
    if (f.license) g.license.add(f.license);
    fams.set(f.family, g);
  }
  return [...fams.values()].map((g) => ({ ...g, weights: [...g.weights], styles: [...g.styles], license: [...g.license] }));
}

export function remove(root, cfg, family) {
  const { list: items, wrap } = readFonts(root);
  const gone = items.filter((f) => sameFamily(f.family, family));
  if (!gone.length) throw new Error(`no "${family}" in assets/fonts/fonts.json (have: ${[...new Set(items.map((f) => f.family))].join(', ') || 'none'})`);
  const rest = items.filter((f) => !sameFamily(f.family, family));
  const { deleted, skipped } = deleteUnused(root, gone.flatMap((f) => [f.src, f.licenseFile]), rest);
  saveFonts(root, rest, wrap);
  const roles = Object.entries(cfg?.brand?.fonts ?? {}).filter(([, v]) => sameFamily(v, family)).map(([k]) => k);
  return { family: gone[0].family, entries: gone.length, deleted, skipped, brandRoles: roles };
}

// ---------------------------------------------------------------------------------------------------------------
// coverage: which characters would render as tofu or a system fallback

/** Text from --text and --text-file (UTF-8, BOM stripped); a UsageError when neither yields any. */
export function readTextInput({ text, textFile } = {}) {
  const parts = [];
  if (typeof text === 'string' && text) parts.push(text);
  if (typeof textFile === 'string' && textFile) {
    let raw;
    try { raw = fs.readFileSync(path.resolve(textFile), 'utf8'); } catch (err) { throw new UsageError(`cannot read --text-file ${textFile}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`); }
    parts.push(stripBom(raw));
  }
  const all = parts.join('\n');
  if (!all.trim()) throw new UsageError('coverage needs the text to check: --text "..." and/or --text-file <file>');
  return all;
}

/** Character classes of a text, for the report header (proves the shell passed the Korean intact). */
export function describeText(text) {
  const chars = [...new Set(Array.from(text))].filter((c) => !/^[\s\p{Cc}]$/u.test(c));
  const count = (re) => chars.filter((c) => re.test(c)).length;
  const hangul = count(/\p{Script=Hangul}/u);
  const latin = count(/\p{Script=Latin}/u);
  const digits = count(/\p{N}/u);
  return { unique: chars.length, hangul, latin, digits, other: chars.length - hangul - latin - digits };
}

/** The faces (family, style, probe weight) to check, from fonts.json plus studio.json `fonts`; --family narrows them. */
export function coverageFaces(root, cfg, families) {
  const items = [...readFonts(root).list, ...(Array.isArray(cfg?.fonts) ? cfg.fonts : [])].filter((f) => f && typeof f.family === 'string');
  if (!items.length) throw new Error('no fonts registered (assets/fonts/fonts.json is empty): add one with `add` or `add-file`');
  const registered = [...new Map(items.map((f) => [f.family.toLowerCase(), f.family])).values()];
  const typed = families?.length ? families.map((f) => String(f).trim()) : null;
  const wanted = typed?.map((f) => f.toLowerCase()) ?? null;
  if (typed) {
    const unknown = typed.filter((f) => !registered.some((r) => r.toLowerCase() === f.toLowerCase()));
    if (unknown.length) throw new Error(`no "${unknown.join('", "')}" in the registered fonts (have: ${registered.join(', ')})`);
  }
  const faces = new Map();
  for (const f of items) {
    if (wanted && !wanted.includes(f.family.toLowerCase())) continue;
    const style = String(f.style ?? 'normal');
    const weight = probeWeight(f.weight ?? '400');
    faces.set([f.family.toLowerCase(), style, weight].join('|'), { family: f.family, style, weight });
  }
  return [...faces.values()];
}

/** Opens a blank page on the project's static server, loads the registered fonts with lib/fonts.js and measures the text. */
export async function runCoverage(root, cfg, { text, families, format }) {
  const faces = coverageFaces(root, cfg, families);
  const fmt = FORMATS[format] ?? FORMATS[cfg?.primaryFormat] ?? { w: 1080, h: 1080 };
  const srv = await startServer(root);
  let browser = null;
  let context = null;
  try {
    ({ browser } = await launchBrowser(root, cfg));
    context = await browser.newContext({ viewport: { width: even(fmt.w), height: even(fmt.h) }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
    // The page only needs the server's origin (for /lib/fonts.js and assets/fonts/): answer it without a file on disk.
    await page.route('**/__fonts_coverage.html', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>font coverage</title>' }));
    await page.goto(`${srv.url}/__fonts_coverage.html`, { waitUntil: 'load' });
    let result;
    try {
      result = await page.evaluate(async ({ extra, faces: fc, text: t }) => {
        const F = await import('/lib/fonts.js');
        await F.loadFonts(extra);
        return F.glyphCoverage(fc, t);
      }, { extra: Array.isArray(cfg?.fonts) ? cfg.fonts : [], faces, text });
    } catch (err) {
      throw new Error(`the registered fonts did not load, so coverage cannot be measured: ${String(err.message ?? err).split('\n')[0]}${pageErrors.length ? `\n  page: ${pageErrors[0]}` : ''}`);
    }
    return { ...result, browser: browser.version(), format };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
}

const SHOWN_MISSING = 40;

/** Report lines and the machine result for a runCoverage result. */
export function summarizeCoverage(result) {
  const rows = result.faces.map((f) => ({ family: f.family, face: `${f.style} ${f.weight}`, needed: f.needed, missing: f.missing.length, ok: f.missing.length === 0 }));
  const w = Math.max(6, ...rows.map((r) => r.family.length));
  const head = `${'family'.padEnd(w)}  ${'face'.padEnd(14)}  needed  missing  result`;
  const lines = [head, ...rows.map((r) => `${r.family.padEnd(w)}  ${r.face.padEnd(14)}  ${String(r.needed).padStart(6)}  ${String(r.missing).padStart(7)}  ${r.ok ? 'OK' : 'MISSING'}`)];
  for (const f of result.faces) {
    if (!f.missing.length) continue;
    const shown = f.missing.slice(0, SHOWN_MISSING).map((m) => `${m.ch} ${m.cp}`).join('  ');
    const why = [...new Set(f.missing.map((m) => m.reason))].map((r) => ({ fallback: 'a system font would draw it', tofu: 'draws the missing-glyph box', blank: 'draws nothing' }[r])).join('; ');
    lines.push('', `${f.family} ${f.style} ${f.weight}: ${f.missing.length} of ${f.needed} characters have no glyph (${why}):`, `  ${shown}${f.missing.length > SHOWN_MISSING ? `  ... +${f.missing.length - SHOWN_MISSING} more (--json lists all)` : ''}`);
  }
  const missingTotal = result.faces.reduce((a, f) => a + f.missing.length, 0);
  return { rows, lines, missingTotal, ok: missingTotal === 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const SPEC = {
  italic: { type: 'boolean', desc: 'add: also download the italic styles' },
  subsets: { type: 'list', default: ['latin', 'latin-ext'], arg: '<a,b>', desc: 'add: subsets to keep; "korean" = the numbered Hangul slices (aliases cjk, slices)' },
  yes: { type: 'boolean', desc: `add: confirm a download of more than ${MAX_SLICES} files (CJK families come in ~100 slices)` },
  family: { type: 'list', arg: '<name>', desc: 'add-file: the family name to register (required); coverage: only these families (default: all)' },
  weight: { type: 'string', arg: '<w>', desc: 'add-file: 400 (default), or a variable range such as "100 900"' },
  style: { type: 'string', arg: '<s>', desc: 'add-file: normal (default) | italic' },
  license: { type: 'string', arg: '<id>', desc: 'add-file: license id, e.g. "SIL OFL 1.1" (stored as OFL-1.1; inferred from --license-file when omitted)' },
  licenseFile: { type: 'string', arg: '<path|url>', desc: 'add-file: license text to copy next to the font (a path or an https URL)' },
  unicodeRange: { type: 'string', arg: '<ranges>', desc: 'add-file: CSS unicode-range this file covers, e.g. "U+AC00-D7A3,U+3131-318E" (for sliced fonts)' },
  text: { type: 'string', arg: '<chars>', desc: 'coverage: the characters the film draws' },
  textFile: { type: 'string', arg: '<file>', desc: 'coverage: read the characters from a UTF-8 file (e.g. film/film.js)' },
  format: { type: 'string', arg: '<fmt>', desc: 'coverage: viewport of the probe page (default: studio.json primaryFormat); the result does not depend on it' },
  json: { type: 'boolean', desc: 'Print one JSON result line on stdout' },
};
const TITLE = `Usage: node tools/fonts.mjs add "Family:400,700" [--italic] [--subsets latin,latin-ext] [--yes]
       node tools/fonts.mjs add-file <path-or-https-url> --family NAME [--weight 400] [--style normal] [--license-file <path|url>] [--license "SIL OFL 1.1"] [--unicode-range "U+..."]
       node tools/fonts.mjs coverage --text "..." [--text-file f] [--family NAME] [--format 9x16]
       node tools/fonts.mjs list
       node tools/fonts.mjs remove <family>

add        Downloads woff2 files from the Google Fonts CSS2 API into assets/fonts/<slug>-<weight>[-italic]-<subset>.woff2,
           records them in assets/fonts/fonts.json (unicode-range kept) and saves the family's license file.
           Weights: "400,700" (static) or "100..900" (variable range).
add-file   Registers a font you already have (a local file or an https URL) as assets/fonts/<slug>-<weight>[-italic].<ext>.
           The format is read from the file's magic bytes (woff2, woff, ttf, otf); anything else is refused. The license text is
           copied to assets/fonts/OFL-<Family>.txt (LICENSE-<Family>.txt for other licenses); without one you get a warning.
remove     Drops every entry of the family from fonts.json and deletes its font and license files under assets/fonts/ (a
           license another family still uses stays). A path outside assets/fonts/ (drive, UNC share, absolute or ..) is never
           deleted: it is listed as "left alone" and the entry is dropped.
coverage   Draws each character of the text with every registered family in Chrome and lists the ones with no glyph (tofu or
           a silent system-font fallback). Exit 1 when any is missing. Check the result before you write Korean into a film.
Korean     The bundled Instrument Serif and Inter have no Hangul. Prefer ONE full Hangul woff2 via add-file. Google's CJK
           families are ~100 slices: \`add "Noto Sans KR:400" --subsets korean,latin\` prints the count and size first and needs --yes
           above ${MAX_SLICES} files. Every slice is loaded at boot (fonts.json entries with unicodeRange; optional "sample" to assert).`;

async function cli(argv, io = NET) {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (flags.help) { process.stdout.write(usage(TITLE, SPEC)); return 0; }
  const [cmd, ...args] = positionals;
  if (!COMMANDS.includes(cmd)) throw new UsageError(cmd ? `unknown command "${cmd}"` : `missing command (${COMMANDS.join(' | ')})`, usage(TITLE, SPEC));
  const root = findProjectRoot();
  if (!root) throw new Error('no studio.json here or above: run inside a film project');
  let cfg = null;
  try { cfg = loadConfig(root); } catch (err) { if (cmd === 'coverage') throw err; } // coverage launches a browser with it
  const out = (obj, text) => { if (flags.json) process.stdout.write(JSON.stringify({ ok: true, ...obj }) + '\n'); else process.stdout.write(text + '\n'); };

  if (cmd === 'list') {
    if (args.length) throw new UsageError('list takes no arguments', usage(TITLE, SPEC));
    const fams = list(root);
    out({ families: fams }, fams.length ? fams.map((g) => `${g.family.padEnd(22)} weights ${g.weights.join(', ')} · ${g.styles.join('/')} · ${g.files} file(s) ${(g.bytes / 1024).toFixed(0)} KB · ${g.license.join(', ') || 'license unknown'}${g.missing.length ? ` · MISSING ${g.missing.join(', ')}` : ''}`).join('\n') : 'no fonts in assets/fonts/fonts.json');
    return fams.some((g) => g.missing.length) ? 1 : 0;
  }

  if (cmd === 'coverage') {
    if (args.length) throw new UsageError('coverage takes no arguments: pass the characters with --text "..." or --text-file <file>', usage(TITLE, SPEC));
    const text = readTextInput(flags);
    const format = resolveFormats(cfg, flags.format)[0];
    const result = await runCoverage(root, cfg, { text, families: flags.family, format });
    const s = summarizeCoverage(result);
    const d = describeText(text);
    const header = `coverage of ${d.unique} distinct characters (Hangul ${d.hangul}, Latin ${d.latin}, digits ${d.digits}, other ${d.other}) in ${result.browser ? `Chrome ${result.browser}` : 'Chrome'}, missing-glyph reference ${result.tofu ?? 'none'}`;
    const bad = s.rows.filter((r) => !r.ok).length;
    const tail = s.ok ? 'all needed characters have a glyph in every checked face'
      : `${bad} of ${s.rows.length} face(s) lack characters the text needs. Draw that text only with a family that covers it, or add one (\`add-file\` / \`add\`); --family NAME checks just the fonts a text is drawn with.`;
    if (flags.json) process.stdout.write(JSON.stringify({ ok: s.ok, text: d, tofu: result.tofu, faces: result.faces }) + '\n');
    else process.stdout.write([header, '', ...s.lines, '', tail].join('\n') + '\n');
    return s.ok ? 0 : 1;
  }

  if (cmd === 'add-file') {
    if (args.length !== 1) throw new UsageError('add-file takes exactly one font: a file path or an https URL', usage(TITLE, SPEC));
    if (!flags.family?.length) throw new UsageError('add-file needs --family NAME (the CSS family the film will use, e.g. --family NeoDunggeunmo)', usage(TITLE, SPEC));
    if (flags.family.length !== 1) throw new UsageError(`add-file registers one family at a time (got ${flags.family.join(', ')})`);
    const r = await addFile(root, cfg, args[0], { family: flags.family[0], weight: flags.weight, style: flags.style, license: flags.license, licenseFile: flags.licenseFile, unicodeRange: flags.unicodeRange }, io);
    const lines = [`added ${r.family} ${r.weight} ${r.style}${r.unicodeRange ? ` (unicode-range ${r.unicodeRange})` : ''}: ${r.src}  ${fmtBytes(r.bytes)} ${r.format}`];
    if (r.replaced.length) lines.push(`replaced the earlier entry: ${r.replaced.join(', ')}${r.deleted.length ? ` (deleted ${r.deleted.join(', ')})` : ''}`);
    lines.push(r.licenseFile ? `license ${r.license ?? 'unknown'} in ${r.licenseFile}` : 'no license file saved');
    for (const n of r.notes) lines.push(`note: ${n}`);
    if (!r.brandUses) lines.push(`use it: set studio.json brand.fonts.display or brand.fonts.ui to "${r.family}"`);
    lines.push(`check glyphs: node tools/fonts.mjs coverage --family "${r.family}" --text "<the text your film draws>"`);
    lines.push(REMINDER);
    out({ ...r, reminder: REMINDER }, lines.join('\n'));
    for (const w of r.warnings) log(`warning: ${w}`);
    return 0;
  }

  if (args.length !== 1) throw new UsageError(`${cmd} takes exactly one ${cmd === 'add' ? '"Family:weights" spec (quote it)' : 'family name (quote names with spaces)'}`, usage(TITLE, SPEC));
  if (cmd === 'add') {
    const subsets = flags.subsets.map((s) => s.toLowerCase());
    const r = await add(root, cfg, args[0], { italic: flags.italic, subsets, yes: flags.yes }, io);
    const lines = r.files.length > 12
      ? [`added ${r.family}: ${r.files.length} file(s), ${fmtBytes(r.files.reduce((a, f) => a + f.bytes, 0))} in total`, `  first: ${r.files[0].src} ... last: ${r.files.at(-1).src}`]
      : [`added ${r.family}: ${r.files.length} file(s)`, ...r.files.map((f) => `  ${f.src}  ${f.weight} ${f.style} ${f.subset}  ${(f.bytes / 1024).toFixed(0)} KB`)];
    lines.push(r.license ? `license ${r.license} saved to ${r.licenseFile}` : 'license file not found in google/fonts: look it up on fonts.google.com before use');
    if (!r.brandUses) lines.push(`use it: set studio.json brand.fonts.display or brand.fonts.ui to "${r.family}"`);
    lines.push(REMINDER);
    out({ ...r, reminder: REMINDER }, lines.join('\n'));
    if (!flags.json) log(`other subsets available: ${r.availableSubsets}`);
    return 0;
  }
  const r = remove(root, cfg, args[0]);
  const warn = r.brandRoles.length ? `\nwarning: studio.json brand.fonts.${r.brandRoles.join(', brand.fonts.')} still names "${r.family}"; loadFonts will fail until you change it` : '';
  const left = r.skipped.length ? `\nwarning: left alone, not inside assets/fonts/: ${r.skipped.join(', ')}` : '';
  out(r, `removed ${r.family}: ${r.entries} entr${r.entries === 1 ? 'y' : 'ies'}, deleted ${r.deleted.length} file(s)${r.deleted.length ? `: ${r.deleted.join(', ')}` : ''}${left}${warn}`);
  return 0;
}

if (isMainModule(import.meta.url)) main(() => cli(process.argv.slice(2)));
