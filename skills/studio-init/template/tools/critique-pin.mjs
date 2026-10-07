// Film pinning for tools/critique.mjs: a sha256 of the film's sources, written next to every evidence set, and the check
// "does the live film still match this evidence?"; plus the cache of the determinism passes keyed by that hash.
//
// filmHash = sha256 over the sorted list of `<posix path> <sha256 of the file>` for film/**, lib/** and studio.json. Text files
// (.js .mjs .json .css .html .md .txt .svg) are hashed with LF line endings, so a CRLF checkout gives the same hash. Assets
// (images, audio, fonts) are not part of it: they are inputs of a round, not edits made during one (assetsHash() below covers
// them for the determinism cache). Symbolic links and Windows junctions below film/ and lib/ are followed.
//
//   node tools/critique.mjs --check-hash [--format f] [--video]   exit 0 = the live film is the film the evidence shows
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON } from './studio.mjs';

export const HASH_FILE = 'film-hash.json';
export const DET_FILE = 'determinism-cache.json';
const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.css', '.html', '.md', '.txt', '.svg']);
const SKIP_DIR = new Set(['node_modules', '.git']);
const SKIP_FILE = new Set(['.DS_Store', 'Thumbs.db']);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function bytesOf(file) {
  const buf = fs.readFileSync(file);
  return TEXT_EXT.has(path.extname(file).toLowerCase()) ? Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : buf;
}

/**
 * Entries of one folder as { name, dir, file }. A symbolic link or junction is followed (statSync): Dirent.isDirectory()/isFile()
 * are both false for links, so a linked film/ or lib/ folder would silently drop out of the hash. A broken link counts as nothing.
 */
function entriesOf(abs) {
  let ents;
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  return ents.map((e) => {
    if (!e.isSymbolicLink()) return { name: e.name, dir: e.isDirectory(), file: e.isFile() };
    try { const st = fs.statSync(path.join(abs, e.name)); return { name: e.name, dir: st.isDirectory(), file: st.isFile() }; } catch { return { name: e.name, dir: false, file: false }; }
  });
}

/** Every file below `rel` (posix, relative to root) except SKIP_DIR / SKIP_FILE; links are followed, a folder that links back to one of its own ancestors is walked once. */
function walkFiles(root, rel, out) {
  const walk = (r, chain) => {
    let real;
    try { real = fs.realpathSync(path.join(root, ...r.split('/'))); } catch { return; }
    if (chain.has(real)) return; // a link cycle
    const next = new Set(chain).add(real);
    for (const e of entriesOf(path.join(root, ...r.split('/')))) {
      const p = `${r}/${e.name}`;
      if (e.dir) { if (!SKIP_DIR.has(e.name)) walk(p, next); } else if (e.file && !SKIP_FILE.has(e.name)) out.push(p);
    }
  };
  walk(rel, new Set());
}

/** Every pinned file, as posix paths relative to the project root, in a stable (code unit) order. Links to folders and files are followed. */
export function filmFiles(root) {
  const out = [];
  walkFiles(root, 'film', out);
  walkFiles(root, 'lib', out);
  if (fs.existsSync(path.join(root, 'studio.json'))) out.push('studio.json');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * sha256 over the sorted `<posix path> <size> <sha256>` of every file below assets/ (images, fonts, audio, cue data, links followed).
 * Not part of filmHash (assets are inputs of a round), but the determinism passes render them, so they belong to the determinism cache key.
 * 'none' when the folder is missing or empty.
 */
export function assetsHash(root) {
  const files = [];
  walkFiles(root, 'assets', files);
  if (!files.length) return 'none';
  const all = crypto.createHash('sha256');
  for (const rel of files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    let buf;
    try { buf = fs.readFileSync(path.join(root, ...rel.split('/'))); } catch { continue; }
    all.update(`${rel} ${buf.length} ${sha(buf)}
`);
  }
  return all.digest('hex');
}

/** { hash, files: { path: first 16 hex of the file's sha256 } }: the overall hash plus enough to name what changed. */
export function filmHash(root) {
  const files = {};
  const all = crypto.createHash('sha256');
  for (const rel of filmFiles(root)) {
    const h = sha(bytesOf(path.join(root, ...rel.split('/'))));
    files[rel] = h.slice(0, 16);
    all.update(`${rel} ${h}\n`);
  }
  return { hash: all.digest('hex'), files };
}

/** Writes <dir>/film-hash.json (the hash of the film this evidence set shows). */
export function writeFilmHash(dir, pin, extra = {}) {
  writeJSON(path.join(dir, HASH_FILE), { version: 1, createdBy: 'motion-studio', tool: 'critique', filmHash: pin.hash, fileCount: Object.keys(pin.files).length, files: pin.files, ...extra });
}

/**
 * Does the live film still match the evidence in `dir` (an out/review/<fmt>[/video] folder)?
 * @returns {{ match:boolean|null, live:string, evidence:string|null, dir:string, changed:string[], reason:string }}
 *   match null = the folder holds no hash (older evidence or none): treat as unverified.
 */
export function checkFilmHash(root, dir) {
  const live = filmHash(root);
  const rel = path.relative(root, dir).split(path.sep).join('/') || '.';
  const doc = readJSON(path.join(dir, HASH_FILE), null) ?? readJSON(path.join(dir, 'metrics.json'), null);
  const evidence = typeof doc?.filmHash === 'string' ? doc.filmHash : null;
  if (!evidence) return { match: null, live: live.hash, evidence: null, dir: rel, changed: [], reason: `no film hash in ${rel}/ (evidence from an older critique run, or none): run node tools/critique.mjs again` };
  if (evidence === live.hash) return { match: true, live: live.hash, evidence, dir: rel, changed: [], reason: 'the live film is the film the evidence shows' };
  const was = doc.files && typeof doc.files === 'object' ? doc.files : null;
  const changed = was ? [...new Set([...Object.keys(was), ...Object.keys(live.files)])].filter((f) => was[f] !== live.files[f]).sort() : [];
  return { match: false, live: live.hash, evidence, dir: rel, changed, reason: `the film changed since this evidence was made${changed.length ? ` (${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ` … +${changed.length - 6}` : ''})` : ''}: do not render zoom stills from it; report the mismatch, or run node tools/critique.mjs again first` };
}

// ---------------------------------------------------------------------------------------------------------------
// Determinism cache
//
// Key = sha256 of { filmHash, assets, format, from, to, tool } where `assets` is assetsHash() (every file below assets/: images,
// fonts, audio, cue data) and `tool` is the hash of critique-live.mjs (the code that picks the sample times and compares the
// three passes) plus DET_VERSION. A different film hash, asset, format, range or tool code is a different key, so the passes
// always run again. Only a PASSING result is ever reused. The browser build is not part of the key: after a Chrome upgrade run
// once without --skip-determinism-repeat. Other files under tools/ are not either (only critique-live.mjs is).

export const DET_VERSION = 2;

export function toolHash() {
  try { return sha(bytesOf(fileURLToPath(new URL('./critique-live.mjs', import.meta.url)))).slice(0, 16); } catch { return 'unknown'; }
}

export function detKey({ filmHash: fh, assets = null, format, from = null, to = null, tool = toolHash() }) {
  return sha(JSON.stringify({ v: DET_VERSION, filmHash: fh, assets, format, from, to, tool }));
}

/** The cached passing determinism result for `key` in `dir`, or null. */
export function readDetCache(dir, key) {
  const doc = readJSON(path.join(dir, DET_FILE), null);
  if (!doc || doc.key !== key || doc.result?.pass !== true || doc.result?.skipped) return null;
  return { at: doc.at, result: doc.result };
}

export function writeDetCache(dir, key, parts, result, at = new Date().toISOString()) {
  writeJSON(path.join(dir, DET_FILE), { version: 1, createdBy: 'motion-studio', tool: 'critique', key, parts, at, result });
}
