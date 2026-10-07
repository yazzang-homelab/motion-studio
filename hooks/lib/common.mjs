// Shared plumbing for the motion-studio plugin hooks. Node built-ins only.
// Contract: read stdin fully, never throw, stay silent on internal errors (exit 0),
// respect MOTION_STUDIO_HOOKS=off, finish well under a second.
import fs from 'node:fs';
import os from 'node:os';

export const IS_WIN = process.platform === 'win32';
// Case-insensitive file systems are the default on Windows and macOS.
const FOLD_CASE = IS_WIN || process.platform === 'darwin';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const TEMPLATE_URL = new URL('../../skills/studio-init/template/', import.meta.url);

// ---------------------------------------------------------------------------------------------
// Environment switches

export function hooksDisabled(env = process.env) {
  const v = String(env.MOTION_STUDIO_HOOKS ?? '').trim().toLowerCase();
  return ['off', '0', 'false', 'no', 'disable', 'disabled'].includes(v);
}

export function debug(...parts) {
  if (!process.env.MOTION_STUDIO_HOOKS_DEBUG) return;
  const text = parts.map((p) => (p instanceof Error ? p.stack || p.message : String(p))).join(' ');
  try { process.stderr.write(`[motion-studio hook] ${text}\n`); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------
// stdin

// Resolves to the parsed JSON object, or null for empty / malformed / non-object input.
// The timeout only matters when a caller forgets to close stdin; Claude Code always does.
export function readInput({ stream = process.stdin, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY) { resolve(null); return; }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (overflow = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners('data');
      try { stream.pause(); stream.destroy(); } catch { /* ignore */ }
      if (overflow) { resolve(null); return; }
      resolve(parseInput(Buffer.concat(chunks).toString('utf8')));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    stream.on('data', (c) => {
      size += c.length;
      if (size > MAX_INPUT_BYTES) { finish(true); return; }
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    });
    stream.on('end', () => finish(false));
    stream.on('error', () => { chunks.length = 0; finish(false); });
  });
}

export function parseInput(text) {
  const s = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Paths. Everything is normalized to forward slashes; drive letters upper-case; no trailing
// slash except on a root ("/", "C:/"). The normalized form is directly usable with node:fs.

export function normPath(p) {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  if (!s) return null;
  if (s.startsWith('file://')) {
    try { s = decodeURIComponent(new URL(s).pathname); if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1); } catch { return null; }
  }
  s = s.replace(/\\/g, '/');
  if (s.startsWith('//?/')) s = s.slice(4); // Win32 long-path prefix
  if (IS_WIN) {
    // Git Bash / Cygwin spellings of a drive path.
    let m = /^\/cygdrive\/([A-Za-z])(?=\/|$)/.exec(s);
    if (m) s = `${m[1]}:${s.slice(m[0].length)}`;
    m = /^\/([A-Za-z])(?=\/|$)/.exec(s);
    if (m) s = `${m[1]}:${s.slice(2)}`;
  }
  if (/^[A-Za-z]:(\/|$)/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (/^[A-Za-z]:$/.test(s)) s += '/';
  const unc = s.startsWith('//') && !s.startsWith('///');
  const lead = unc ? '//' : s.startsWith('/') ? '/' : '';
  const drive = /^[A-Za-z]:\//.test(s) ? s.slice(0, 3) : '';
  const body = s.slice(unc ? 2 : drive ? 3 : lead.length);
  const out = [];
  for (const seg of body.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!drive && !lead) out.push('..'); // relative path keeps leading ..
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  if (drive) return drive + joined;
  if (lead) return lead + joined || '/';
  return joined || '.';
}

export function isAbs(p) {
  return typeof p === 'string' && (/^[A-Za-z]:\//.test(p) || p.startsWith('/'));
}

// Resolve p against base (both any spelling). Returns null when p is relative and base unknown.
export function resolvePath(base, p) {
  const n = normPath(p);
  if (!n) return null;
  if (isAbs(n)) return n;
  const b = normPath(base);
  if (!b || !isAbs(b)) return null;
  return normPath(`${b}/${n}`);
}

export function parentDir(p) {
  const i = p.lastIndexOf('/');
  if (i < 0) return null;
  if (i === 0) return p === '/' ? null : '/';
  const head = p.slice(0, i);
  if (/^[A-Za-z]:$/.test(head)) return p.length > i + 1 ? `${head}/` : null;
  if (/^\/\/[^/]+$/.test(head)) return null; // never climb above //server/share
  return head;
}

function fold(p) { return FOLD_CASE ? p.toLowerCase() : p; }

// Posix-style path of p relative to root ('' when equal), or null when p is outside root.
export function relInside(root, p) {
  const r = normPath(root);
  const q = normPath(p);
  if (!r || !q) return null;
  if (fold(q) === fold(r)) return '';
  const prefix = r.endsWith('/') ? r : `${r}/`;
  if (!fold(q).startsWith(fold(prefix))) return null;
  return q.slice(prefix.length);
}

// Resolve symlinks on the deepest existing ancestor so a link inside an allowed folder cannot
// smuggle a write elsewhere. Non-existing tails (a file about to be created) are appended as-is.
export function realish(p) {
  const n = normPath(p);
  if (!n || !isAbs(n)) return n;
  const tail = [];
  let cur = n;
  for (let guard = 0; cur && guard < 256; guard++) {
    try {
      const real = normPath(fs.realpathSync.native(cur));
      return tail.length ? normPath(`${real}/${tail.reverse().join('/')}`) : real;
    } catch {
      const up = parentDir(cur);
      if (!up) break;
      tail.push(cur.slice(up.length).replace(/^\//, ''));
      cur = up;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Project discovery. A studio project = a directory holding studio.json plus film/, tools/ or
// index.html (the scaffold from skills/studio-init/template). Plain studio.json is not enough:
// other tools use that file name too.

export function isStudioRoot(dir) {
  try {
    if (!fs.statSync(`${dir.replace(/\/$/, '')}/studio.json`).isFile()) return false;
  } catch {
    return false;
  }
  const base = dir.replace(/\/$/, '');
  for (const marker of ['film', 'tools']) {
    try { if (fs.statSync(`${base}/${marker}`).isDirectory()) return true; } catch { /* next */ }
  }
  try { return fs.statSync(`${base}/index.html`).isFile(); } catch { return false; }
}

export function findProjectRoot(start) {
  let dir = normPath(start);
  if (!dir || !isAbs(dir)) return null;
  try {
    if (!fs.statSync(dir).isDirectory()) dir = parentDir(dir);
  } catch {
    dir = parentDir(dir); // path does not exist yet (file about to be written)
  }
  for (let guard = 0; dir && guard < 128; guard++) {
    if (isStudioRoot(dir)) return dir;
    dir = parentDir(dir);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Files

export function readJSONFile(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

export function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Template modules (lint.mjs, gate.mjs, studio.mjs). Always the PLUGIN's copy, never the
// project's tools/: the agent can edit the project, and hooks run outside any sandbox.

export async function importTemplate(rel) {
  try {
    return await import(new URL(rel, TEMPLATE_URL).href);
  } catch (err) {
    debug(`cannot import template/${rel}:`, err);
    return null;
  }
}

const FALLBACK_CONFIG = {
  title: 'Untitled Film',
  duration: 12,
  fps: 60,
  bpm: 120,
  beatsPerBar: 4,
  loop: false,
  formats: ['9x16', '1x1', '16x9'],
  primaryFormat: '9x16',
  gate: { enabled: true, minScore: 8, minRounds: 3, axes: ['hook', 'readability', 'motion', 'variety', 'composition', 'brand', 'sound'] },
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && v && typeof v === 'object' && !Array.isArray(v)
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

// { cfg, error } — cfg is always usable; error explains why the fallback merge was used.
export async function loadStudioConfig(root) {
  const studio = await importTemplate('tools/studio.mjs');
  let error = null;
  if (studio && typeof studio.loadConfig === 'function') {
    try {
      const cfg = await studio.loadConfig(root);
      if (cfg && typeof cfg === 'object') return { cfg, error: null };
    } catch (err) {
      error = String(err && err.message ? err.message : err);
    }
  }
  const raw = readJSONFile(`${root}/studio.json`, undefined);
  if (raw === undefined && !error) error = 'studio.json is not valid JSON';
  const cfg = deepMerge(FALLBACK_CONFIG, raw && typeof raw === 'object' ? raw : {});
  return { cfg, error };
}

// Normalized gate result, or null when gate.mjs is unavailable or crashed (fail open).
export async function gateStatus(root, cfg) {
  const gate = await importTemplate('tools/gate.mjs');
  if (!gate || typeof gate.checkGate !== 'function') return null;
  try {
    const r = await gate.checkGate(root, cfg);
    if (!r || typeof r !== 'object') return null;
    return {
      pass: r.pass === true,
      reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [],
      rounds: Number.isFinite(r.rounds) ? r.rounds : Array.isArray(r.rounds) ? r.rounds.length : 0,
      last: r.last && typeof r.last === 'object' ? r.last : null,
    };
  } catch (err) {
    debug('checkGate failed:', err);
    return null;
  }
}

export function formatScores(last) {
  const scores = last && last.scores && typeof last.scores === 'object' ? last.scores : null;
  if (!scores) return '';
  return Object.entries(scores).map(([k, v]) => `${k}=${v}`).join(' ');
}

export function countP0(last) {
  const probs = last && Array.isArray(last.problems) ? last.problems : [];
  return probs.filter((p) => p && p.severity === 'P0').length;
}

export function clip(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}\u2026`;
}

// ---------------------------------------------------------------------------------------------
// Output + lifecycle

function write(stream, text) {
  return new Promise((resolve) => {
    if (!text) { resolve(); return; }
    try { stream.write(text, () => resolve()); } catch { resolve(); }
  });
}

// handler(input) → null | { json?: object, stderr?: string, code?: 0 | 2 }
// Any throw inside the handler is swallowed: the hook exits 0 with no output (fail open).
export async function runHook(handler) {
  // Unref'd: only fires if something (a never-closed stdin) keeps the process alive.
  const watchdog = setTimeout(() => process.exit(0), 9000);
  watchdog.unref();
  let result = null;
  try {
    // Drain stdin even when disabled so the caller never sees EPIPE on its write.
    const input = await readInput();
    if (input && !hooksDisabled()) result = await handler(input);
  } catch (err) {
    debug(err);
    result = null;
  }
  let code = 0;
  try {
    if (result && result.json) await write(process.stdout, `${JSON.stringify(result.json)}\n`);
    if (result && result.stderr) await write(process.stderr, result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    code = result && result.code === 2 ? 2 : 0;
  } catch (err) {
    debug(err);
  }
  process.exit(code);
}

// Aliases matching DESIGN.md §8 names.
export const emit = (json) => ({ json });
export const homeDir = () => normPath(os.homedir());
