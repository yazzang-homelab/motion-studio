#!/usr/bin/env node
// Scaffold a motion-studio film project from ../template (Node built-ins only).
//   new / empty dir  → copy every template file
//   existing dir     → add missing files only; list what was skipped
//   --force          → also overwrite template files, except the user's work (studio.json, film/**,
//                      docs/**, assets/fonts/fonts.json); package.json and .gitignore are merged:
//                      template scripts whose command differs are reset, dependency versions never change
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';

const TEMPLATE = fileURLToPath(new URL('../template/', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'out', '.git']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const KNOWN_FORMATS = ['9x16', '1x1', '16x9', '4x5'];

const SPEC = {
  title: { type: 'string', desc: 'film title (studio.json title)' },
  duration: { type: 'number', desc: 'length in seconds' },
  fps: { type: 'number', desc: 'frames per second (integer 1-240)' },
  bpm: { type: 'number', desc: 'tempo of the beat grid' },
  formats: { type: 'list', desc: `comma list of ${KNOWN_FORMATS.join(', ')} (or "all"); first = primary if needed` },
  loop: { type: 'boolean', desc: 'seamless loop film (--no-loop to clear)' },
  'brand-url': { type: 'string', desc: 'product / brand URL (studio.json brand.url); user:password@ and token/key-like parameters are removed' },
  force: { type: 'boolean', desc: 'overwrite template files (keeps studio.json, film/**, docs/**, fonts.json); resets template scripts in package.json, never dependency versions' },
  install: { type: 'boolean', desc: 'run npm install in the new project' },
  json: { type: 'boolean', desc: 'print one JSON result line on stdout' },
  help: { type: 'boolean', alias: 'h', desc: 'show this help' },
};

class UsageError extends Error {}

function usage() {
  const rows = Object.entries(SPEC).map(([k, s]) => {
    const flag = `${s.alias ? `-${s.alias}, ` : ''}--${k}${s.type === 'boolean' ? '' : s.type === 'list' ? ' a,b' : s.type === 'number' ? ' N' : ' VALUE'}`;
    return `  ${flag.padEnd(22)} ${s.desc}`;
  });
  return [
    'Usage: node init.mjs <dir> [options]',
    '',
    'Scaffold a motion-studio film project (seek(t) renderer, tools, house rules) into <dir>.',
    'Existing files are kept unless --force; studio.json and film/** are never overwritten.',
    '',
    'Options:',
    ...rows,
  ].join('\n');
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  const byAlias = Object.fromEntries(Object.entries(SPEC).filter(([, s]) => s.alias).map(([k, s]) => [s.alias, k]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-') { positionals.push(a); continue; }
    let name;
    let value;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      value = eq < 0 ? undefined : a.slice(eq + 1);
      if (!SPEC[name] && name.startsWith('no-') && SPEC[name.slice(3)]?.type === 'boolean' && value === undefined) {
        flags[name.slice(3)] = false;
        continue;
      }
    } else {
      name = byAlias[a.slice(1)];
      if (!name) throw new UsageError(`unknown flag: ${a.split('=')[0]}`);
    }
    const spec = SPEC[name];
    if (!spec) throw new UsageError(`unknown flag: ${a.split('=')[0]}`); // the name only: a value can be a secret
    if (spec.type === 'boolean') {
      if (value !== undefined && !/^(true|false|1|0|yes|no)$/i.test(value)) throw new UsageError(`--${name} takes no value`);
      flags[name] = value === undefined ? true : /^(true|1|yes)$/i.test(value);
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
    }
    if (spec.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || String(value).trim() === '') throw new UsageError(`--${name} must be a number, got "${value}"`);
      flags[name] = n;
    } else if (spec.type === 'list') {
      flags[name] = String(value).split(',').map((x) => x.trim()).filter(Boolean);
    } else {
      flags[name] = String(value);
    }
  }
  return { flags, positionals };
}

// ---------------------------------------------------------------------------------------------

function listTemplate(dir, prefix = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      out.push(...listTemplate(path.join(dir, ent.name), rel));
    } else if (ent.isFile() && !SKIP_FILES.has(ent.name)) {
      out.push(rel);
    }
  }
  return out;
}

// Files that hold the user's work once a project exists: --force never replaces them.
function isUserOwned(rel) {
  return rel === 'studio.json' || rel.startsWith('film/') || rel.startsWith('docs/') || rel === 'assets/fonts/fonts.json';
}

function sameBytes(a, b) {
  try {
    const x = fs.readFileSync(a);
    const y = fs.readFileSync(b);
    return x.equals(y);
  } catch {
    return false;
  }
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

// 2-space JSON that keeps short flat arrays/objects on one line, like the template files.
function formatJSON(v, depth = 0) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const arr = Array.isArray(v);
  const entries = arr ? v.map((x) => [null, x]) : Object.entries(v);
  if (!entries.length) return arr ? '[]' : '{}';
  const item = ([k, x], inner) => `${k === null ? '' : `${JSON.stringify(k)}: `}${inner}`;
  if (entries.every(([, x]) => x === null || typeof x !== 'object')) {
    const one = entries.map((e) => item(e, JSON.stringify(e[1]))).join(', ');
    const inline = arr ? `[${one}]` : `{ ${one} }`;
    if (inline.length + depth * 2 <= 96) return inline;
  }
  const pad = '  '.repeat(depth + 1);
  const body = entries.map((e) => `${pad}${item(e, formatJSON(e[1], depth + 1))}`).join(',\n');
  return arr ? `[\n${body}\n${'  '.repeat(depth)}]` : `{\n${body}\n${'  '.repeat(depth)}}`;
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, `${formatJSON(obj)}\n`);
}

// Keep the user's package.json (name, extra deps, own scripts); add what the tools need.
//   scripts                            missing → added. Differing → kept and listed (result.packageKept, with both
//                                      values); under --force reset to the template command (result.packageReset,
//                                      with the old value).
//   devDependencies / optionalDeps     missing → added. An existing version is never touched, --force or not
//                                      (a pinned or newer range is the user's decision); a difference is listed in
//                                      result.packageKept.
function mergePackage(dest, src, force) {
  let user;
  try { user = readJSON(dest); } catch { return { changed: [], kept: [], reset: [], warning: 'package.json is not valid JSON; left untouched' }; }
  const tpl = readJSON(src);
  const out = { ...user };
  const changed = [];
  const kept = [];
  const reset = [];
  const warnings = [];
  if (out.type !== 'module') { out.type = 'module'; changed.push('type=module'); }
  if (out.private === undefined && tpl.private !== undefined) { out.private = tpl.private; changed.push('private'); }
  if (!out.engines && tpl.engines) { out.engines = tpl.engines; changed.push('engines'); }
  for (const key of ['scripts', 'devDependencies', 'optionalDependencies']) {
    if (!tpl[key]) continue;
    const have = out[key];
    if (have !== undefined && (have === null || typeof have !== 'object' || Array.isArray(have))) {
      warnings.push(`package.json "${key}" is not an object; left untouched (tools need: ${Object.keys(tpl[key]).join(', ')})`);
      continue;
    }
    const merged = { ...(have ?? {}) };
    for (const [k, v] of Object.entries(tpl[key])) {
      const field = `${key}.${k}`;
      if (!Object.prototype.hasOwnProperty.call(merged, k)) { merged[k] = v; changed.push(field); continue; }
      if (merged[k] === v) continue;
      if (force && key === 'scripts') { reset.push({ field, was: merged[k], now: v }); merged[k] = v; changed.push(field); } else kept.push({ field, yours: merged[k], template: v });
    }
    out[key] = merged;
  }
  if (changed.length) writeJSON(dest, out);
  return { changed, kept, reset, warnings };
}

function mergeLines(dest, src) {
  const have = fs.readFileSync(dest, 'utf8');
  const lines = new Set(have.split(/\r?\n/).map((l) => l.trim()));
  const missing = fs.readFileSync(src, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !lines.has(l));
  if (!missing.length) return { changed: [] };
  const sep = have.endsWith('\n') || !have ? '' : '\n';
  fs.writeFileSync(dest, `${have}${sep}\n# motion-studio\n${missing.join('\n')}\n`);
  return { changed: missing };
}

function copyTemplate(target, force) {
  const res = { created: [], overwritten: [], merged: [], skipped: [], kept: [], unchanged: 0, warnings: [], packageKept: [], packageReset: [] };
  for (const rel of listTemplate(TEMPLATE)) {
    const src = path.join(TEMPLATE, ...rel.split('/'));
    const dest = path.join(target, ...rel.split('/'));
    let st = null;
    try { st = fs.statSync(dest); } catch { /* missing */ }
    if (!st) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      res.created.push(rel);
      continue;
    }
    if (!st.isFile()) { res.warnings.push(`${rel}: exists and is not a file; left alone`); continue; }
    if (sameBytes(src, dest)) { res.unchanged++; continue; }
    if (rel === 'package.json') {
      const m = mergePackage(dest, src, force);
      if (m.warning) res.warnings.push(m.warning);
      res.warnings.push(...(m.warnings ?? []));
      res.packageKept.push(...m.kept);
      res.packageReset.push(...m.reset);
      if (m.changed.length) res.merged.push(`package.json (${m.changed.join(', ')})`); else res.unchanged++;
      continue;
    }
    if (rel === '.gitignore') {
      const m = mergeLines(dest, src);
      if (m.changed.length) res.merged.push(`.gitignore (+${m.changed.length} lines)`); else res.unchanged++;
      continue;
    }
    if (force && !isUserOwned(rel)) {
      fs.copyFileSync(src, dest);
      res.overwritten.push(rel);
      continue;
    }
    (force ? res.kept : res.skipped).push(rel);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Credentials in --brand-url. studio.json is committed, pasted into reports and read by every tool, so brand.url must
// never carry a login: user:password@ userinfo and secret-looking parameters (query, fragment, ;matrix) are dropped
// before anything is written or printed. Self-contained on purpose (the skill can be installed alone); the word list
// mirrors the product-reel capture guard, so both skills agree on what looks secret ("keyword" and "author" do not).

const SECRET_WORDS = new Set(['token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'pass', 'pwd', 'passphrase', 'auth', 'authorization', 'authkey', 'sig', 'signature',
  'session', 'sessionid', 'sessid', 'sid', 'jwt', 'credential', 'credentials', 'bearer', 'otp', 'key', 'apikey', 'code', 'cookie', 'ticket', 'sas']);
const SECRET_TAIL = /(token|secret|password|passwd|passphrase|signature|apikey|sessionid|sessid|accesskey|secretkey|privatekey|credential)s?$/;

function isSecretName(raw) {
  let name = raw;
  try { name = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { /* keep the raw spelling */ }
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => SECRET_WORDS.has(w)) || SECRET_TAIL.test(words.join(''));
}

// `a=1&token=x&b=2` without its secret pairs, or null when none is secret. Pairs are split at & and at the older ; separator
// and rejoined with the separators as typed. `label` names where the text came from.
function dropSecretPairs(text, label, removed) {
  const parts = text.split(/([&;])/); // pair, separator, pair, ...
  const kept = []; // [separator in front of the pair, pair]
  let dropped = false;
  for (let i = 0; i < parts.length; i += 2) {
    const pair = parts[i];
    const eq = pair.indexOf('=');
    if (pair && isSecretName(eq < 0 ? pair : pair.slice(0, eq))) {
      dropped = true;
      removed.push(`${label}:${eq < 0 ? '(no value)' : pair.slice(0, eq)}`); // the name only, never the value
    } else kept.push([parts[i - 1] ?? '', pair]);
  }
  return dropped ? kept.map(([sep, pair], i) => (i ? sep : '') + pair).join('') : null;
}

// The fragment without secret parameters, or null when it has none. It is a parameter list when it holds "=" (an OAuth
// implicit-flow #access_token=...) and a plain anchor otherwise ("#pricing" stays); a single-page-app route keeps its path
// and loses only the secrets of its own query (#/reset?token=... -> #/reset).
function dropSecretFragment(hash, removed) {
  const frag = hash.slice(1);
  const q = frag.indexOf('?');
  const eq = frag.indexOf('=');
  if (q >= 0 && (eq < 0 || q < eq)) { // a route first ("?" before any "="); a "?" inside a token value does not make one
    const kept = dropSecretPairs(frag.slice(q + 1), 'fragment', removed);
    return kept === null ? null : frag.slice(0, q) + (kept ? `?${kept}` : '');
  }
  return eq >= 0 ? dropSecretPairs(frag, 'fragment', removed) : null;
}

/**
 * The URL without credentials, and what was taken out: { url, removed: ['userinfo', 'query:token', 'fragment:access_token',
 * 'path:jsessionid'] } (names only, never a value). A URL that had nothing to remove comes back exactly as given.
 * Only what is named as a credential goes (userinfo, and parameters whose name looks secret); a secret that is just a path
 * segment or an unnamed value cannot be recognized, which is why the docs say to pass a plain public URL.
 * Throws the URL constructor's TypeError for a string that is not an absolute URL.
 */
export function redactUrl(input) {
  const raw = String(input).trim();
  const u = new URL(raw);
  const removed = [];
  if (u.username || u.password) { removed.push('userinfo'); u.username = ''; u.password = ''; }
  const pathname = u.pathname.replace(/;([^/;=?#]+)(=[^/;?#]*)?/g, (m, name) => (isSecretName(name) ? (removed.push(`path:${name}`), '') : m));
  if (pathname !== u.pathname) u.pathname = pathname;
  const query = dropSecretPairs(u.search.slice(1), 'query', removed);
  if (query !== null) u.search = query;
  const fragment = dropSecretFragment(u.hash, removed);
  if (fragment !== null) u.hash = fragment;
  return { url: removed.length ? u.href : raw, removed };
}

// Validates the flags (mutating: formats and brand-url are normalized) and returns the credentials taken out of --brand-url.
function validateFlags(flags) {
  if (flags.title !== undefined && !flags.title.trim()) throw new UsageError('--title must not be empty');
  if (flags.duration !== undefined && !(flags.duration > 0 && flags.duration <= 7200)) throw new UsageError('--duration must be > 0 and <= 7200 seconds');
  if (flags.fps !== undefined && !(Number.isInteger(flags.fps) && flags.fps >= 1 && flags.fps <= 240)) throw new UsageError('--fps must be an integer 1-240');
  if (flags.bpm !== undefined && !(flags.bpm >= 20 && flags.bpm <= 400)) throw new UsageError('--bpm must be between 20 and 400');
  if (flags.formats !== undefined) {
    if (flags.formats.length === 1 && flags.formats[0].toLowerCase() === 'all') flags.formats = KNOWN_FORMATS.slice();
    const bad = flags.formats.filter((f) => !KNOWN_FORMATS.includes(f));
    if (!flags.formats.length || bad.length) throw new UsageError(`--formats: unknown format(s) ${bad.join(', ') || '(none given)'}; use ${KNOWN_FORMATS.join(', ')}`);
    flags.formats = [...new Set(flags.formats)];
  }
  let redacted = [];
  if (flags['brand-url'] !== undefined) {
    // Neither message quotes the value: a rejected URL can still carry a password or token.
    let u;
    try { u = new URL(flags['brand-url']); } catch { throw new UsageError('--brand-url is not a URL (expected http(s)://host/path)'); }
    if (!/^https?:$/.test(u.protocol)) throw new UsageError('--brand-url must be http(s)');
    ({ url: flags['brand-url'], removed: redacted } = redactUrl(flags['brand-url']));
  }
  return { redacted };
}

function patchStudio(target, flags) {
  const file = path.join(target, 'studio.json');
  const patch = {};
  if (flags.title !== undefined) patch.title = flags.title.trim();
  if (flags.duration !== undefined) patch.duration = flags.duration;
  if (flags.fps !== undefined) patch.fps = flags.fps;
  if (flags.bpm !== undefined) patch.bpm = flags.bpm;
  if (flags.loop !== undefined) patch.loop = flags.loop;
  if (flags.formats !== undefined) patch.formats = flags.formats;
  if (!Object.keys(patch).length && flags['brand-url'] === undefined) return {};
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = readJSON(file); } catch (err) { throw new Error(`studio.json is not valid JSON (${err.message}); fix it or delete it and re-run`); }
  }
  Object.assign(cfg, patch);
  if (patch.formats && !patch.formats.includes(cfg.primaryFormat)) { cfg.primaryFormat = patch.formats[0]; patch.primaryFormat = cfg.primaryFormat; }
  if (flags['brand-url'] !== undefined) {
    cfg.brand = { ...(cfg.brand && typeof cfg.brand === 'object' ? cfg.brand : {}), url: flags['brand-url'] };
    patch['brand.url'] = flags['brand-url'];
  }
  writeJSON(file, cfg);
  return patch;
}

function npmInstall(cwd, io) {
  return new Promise((resolve) => {
    // npm is a .cmd shim on Windows: it needs a shell (Node refuses .cmd without one since CVE-2024-27980).
    const win = process.platform === 'win32';
    const child = spawn(win ? 'npm.cmd' : 'npm', ['install'], { cwd, stdio: ['ignore', 2, 2], shell: win });
    child.on('error', (err) => { io.err.write(`npm install could not start: ${err.message}\n`); resolve(false); });
    child.on('close', (code) => resolve(code === 0));
  });
}

function nextSteps(target, installed) {
  const cd = `cd "${target}"`;
  return [
    cd,
    ...(installed ? [] : ['npm install']),
    process.platform === 'win32'
      ? 'npx playwright install chromium-headless-shell   (Windows: required unless you opt in to the installed Chrome with studio.json "browser": "chrome", which counts one failed logon per launch and can lock the account)'
      : 'npx playwright install chromium-headless-shell   (macOS/Linux: optional when Chrome is installed)',
    'npm run doctor',
    'npm run preview',
  ];
}

// A one-time GitHub star suggestion: printed after the first new project on this machine, never again (a marker file in
// ~/.motion-studio). Off under node --test, in CI and with MOTION_STUDIO_STAR_HINT=off. Init never stars anything itself.
const REPO_URL = 'https://github.com/yazzang-homelab/motion-studio';
function starHintOnce(mode) {
  const env = process.env;
  if (mode !== 'new' || env.NODE_TEST_CONTEXT || env.CI || /^(0|off|false|no)$/i.test(env.MOTION_STUDIO_STAR_HINT ?? '')) return null;
  try {
    const dir = path.join(os.homedir(), '.motion-studio');
    const marker = path.join(dir, 'star-hint-shown');
    if (fs.existsSync(marker)) return null;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch { return null; }
  return `If motion-studio is useful to you, a GitHub star helps others find it: ${REPO_URL}`;
}

// One-line JSON rendering of a package.json value for the report.
function show(v) {
  const t = JSON.stringify(v);
  return t.length > 100 ? `${t.slice(0, 99)}…` : t;
}

// The package.json entries init did not change on purpose (or did reset), with both values.
function packageNotes(res) {
  const out = [];
  if (res.packageReset.length) {
    out.push(`  reset by --force to the template command (${res.packageReset.length}):`);
    for (const r of res.packageReset) out.push(`    ${r.field}: was ${show(r.was)}, now ${show(r.now)}`);
  }
  if (res.packageKept.length) {
    out.push(`  kept your package.json values, which differ from the template (${res.packageKept.length}):`);
    for (const k of res.packageKept) out.push(`    ${k.field}: yours ${show(k.yours)}, template ${show(k.template)}`);
    if (res.packageKept.some((k) => k.field.startsWith('scripts.'))) {
      out.push('    The docs run the template commands (npm run render, lint, build ...); those names run YOUR command. --force resets template scripts to the template command.');
    }
  }
  return out;
}

function list(label, items, max = 12) {
  if (!items.length) return [];
  const shown = items.slice(0, max).join(', ');
  return [`  ${label} (${items.length}): ${shown}${items.length > max ? ', ...' : ''}`];
}

async function main(argv, io) {
  const { flags, positionals } = parseArgs(argv);
  if (flags.help) { io.out.write(`${usage()}\n`); return 0; }
  if (positionals.length !== 1) throw new UsageError(positionals.length ? `expected one <dir>, got ${positionals.length}` : 'missing <dir>');
  const { redacted } = validateFlags(flags);
  if (!fs.existsSync(path.join(TEMPLATE, 'studio.json'))) throw new Error(`template not found or incomplete: ${TEMPLATE}`);

  const target = path.resolve(positionals[0]);
  const rel = path.relative(TEMPLATE, target);
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('refusing to scaffold into the plugin template itself');
  if (fs.existsSync(path.join(target, '.claude-plugin', 'plugin.json'))) throw new Error(`${target} is a Claude Code plugin root, not a film project directory`);
  let existed = false;
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new Error(`${target} exists and is not a directory`);
    existed = fs.readdirSync(target).length > 0;
  }
  const wantsPatch = ['title', 'duration', 'fps', 'bpm', 'loop', 'formats', 'brand-url'].some((k) => flags[k] !== undefined);
  const existingStudio = path.join(target, 'studio.json');
  if (wantsPatch && fs.existsSync(existingStudio)) {
    // Fail before copying anything when the flags cannot be applied.
    try { readJSON(existingStudio); } catch (err) { throw new Error(`studio.json is not valid JSON (${err.message}); fix it or delete it and re-run`); }
  }
  fs.mkdirSync(target, { recursive: true });

  const force = flags.force === true;
  const res = copyTemplate(target, force);
  const patched = patchStudio(target, flags);
  let installed = null;
  if (flags.install) installed = await npmInstall(target, io);

  const mode = !existed ? 'new' : force ? 'force' : 'merge';
  const next = nextSteps(target, installed === true);
  const starHint = starHintOnce(mode);
  const log = [
    `motion-studio: ${mode === 'new' ? 'scaffolded' : 'updated'} ${target} (${mode})`,
    ...list('created', res.created, 8),
    ...list('overwritten', res.overwritten),
    ...list('merged', res.merged),
    ...packageNotes(res),
    ...list('skipped, already present (yours kept)', res.skipped),
    ...list('kept (your work, not overwritten by --force)', res.kept),
    ...(res.unchanged ? [`  unchanged: ${res.unchanged}`] : []),
    ...res.warnings.map((w) => `  warning: ${w}`),
    ...(Object.keys(patched).length ? [`  studio.json: ${Object.entries(patched).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`] : []),
    ...(redacted.length ? [`  note: --brand-url carried credentials; removed before writing studio.json: ${redacted.join(', ')}. Keep keys and passwords in .env, not in a URL.`] : []),
    ...(installed === false ? ['  npm install FAILED (see output above)'] : installed ? ['  npm install: ok'] : []),
    'Next:',
    ...next.map((s, i) => `  ${i + 1}. ${s}`),
    ...(starHint ? ['', `★ ${starHint}`] : []),
  ];
  io.err.write(`${log.join('\n')}\n`);
  if (flags.json) {
    io.out.write(`${JSON.stringify({ ok: installed !== false, dir: target, template: TEMPLATE, mode, ...res, studio: patched, redacted, installed, next, ...(starHint ? { starHint } : {}) })}\n`);
  }
  return installed === false ? 1 : 0;
}

// One CLI invocation → exit code (0 ok, 1 failure, 2 usage error). Output goes to io.out / io.err, which are the
// process streams by default; the tests pass their own to run init in process instead of spawning node per case.
export async function runInit(argv, io = { out: process.stdout, err: process.stderr }) {
  try {
    return await main(argv, io);
  } catch (err) {
    const usageErr = err instanceof UsageError;
    io.err.write(`init: ${err.message}\n${usageErr ? `\n${usage()}\n` : ''}`);
    if (process.env.DEBUG && !usageErr) io.err.write(`${err.stack}\n`);
    if (wantsJson(argv)) io.out.write(`${JSON.stringify({ ok: false, error: err.message, usage: usageErr })}\n`);
    return usageErr ? 2 : 1;
  }
}

// --json for the failure line, which can be needed before the flags parsed: the last of --json / --json=<bool> / --no-json
// wins and nothing after a bare `--` counts (the same rule as every other tool's wantsJson).
function wantsJson(argv) {
  let on = false;
  for (const tok of argv) {
    if (tok === '--') break;
    if (tok === '--json') on = true;
    else if (tok === '--no-json') on = false;
    else if (tok.startsWith('--json=')) on = !['0', 'false', 'no', 'off'].includes(tok.slice(7).toLowerCase());
  }
  return on;
}

// Runs as a CLI unless a test sets MOTION_STUDIO_INIT_AS_LIBRARY before importing this file. It is an opt-out on
// purpose: a plain `node init.mjs` can never end up doing nothing.
if (!process.env.MOTION_STUDIO_INIT_AS_LIBRARY) runInit(process.argv.slice(2)).then((code) => { process.exitCode = code; });
