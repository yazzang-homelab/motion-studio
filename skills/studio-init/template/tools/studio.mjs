// Shared Node utilities for every motion-studio tool: config, CLI parsing, ffmpeg/python/browser
// resolution, the static server and the page contract driver (openFilm / captureFrame).
// Dependencies: Node built-ins only; playwright and ffmpeg-static are resolved from the project at runtime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import util from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FORMATS, safeProblems } from '../lib/layout.js';

export { FORMATS };
export const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// Config

const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

export const DEFAULTS = deepFreeze({
  title: 'Untitled Film', duration: 12, fps: 60, subframes: 4, shutter: 0.5, bpm: 120, beatsPerBar: 4, loop: false,
  formats: ['9x16', '1x1', '16x9'], primaryFormat: '9x16', capture: 'auto', browser: 'auto',
  encode: { crf: 16, preset: 'slow', tune: 'animation', previewPreset: 'veryfast' },
  poster: null,
  safe: {
    '9x16': { top: 0.10, bottom: 0.16, left: 0.06, right: 0.08 },
    '1x1': { top: 0.07, bottom: 0.07, left: 0.07, right: 0.07 },
    '16x9': { top: 0.08, bottom: 0.08, left: 0.06, right: 0.06 },
    '4x5': { top: 0.07, bottom: 0.09, left: 0.07, right: 0.07 },
  },
  brand: { name: '', url: '', colors: { bg: '#141413', fg: '#F0EEE6', accent: '#D97757', muted: '#6C6B73' },
    fonts: { display: 'Instrument Serif', ui: 'Inter' } },
  fonts: [],
  audio: { music: 'audio/music.wav', sfx: 'audio/sfx.wav', voice: null, master: 'out/score.wav', lufs: -14, lufsTolerance: 0.5,
    truePeak: -1, musicGainDb: -2, sfxGainDb: 0, voiceGainDb: 0, duck: true },
  gate: { enabled: true, minScore: 8, minRounds: 3, axes: ['hook', 'readability', 'motion', 'variety', 'composition', 'brand', 'sound'],
    naAllowed: ['brand'], requireFormats: false },
  critique: { deadSpanSec: 2.0, staticEps: 0.35, cornerPct: 0.08, popRatio: 3.0, stepped: false, popIgnore: [] },
  deliver: { maxBytes: { x: 536870912 } },
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge: objects merge recursively, arrays and scalars (including null) replace, unknown keys are kept. */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over === undefined ? base : over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}

export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  try { if (fs.statSync(dir).isFile()) dir = path.dirname(dir); } catch { /* a not-yet-existing path still walks up */ }
  for (;;) {
    try { if (fs.statSync(path.join(dir, 'studio.json')).isFile()) return dir; } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** findProjectRoot(cwd), else the project this tools/ folder lives in; throws a readable error otherwise. */
export function projectRoot(start = process.cwd()) {
  const root = findProjectRoot(start) ?? findProjectRoot(path.join(TOOLS_DIR, '..'));
  if (!root) throw new Error(`no studio.json found above ${path.resolve(start)}; run this inside a motion-studio film project (see /motion-studio:studio-init)`);
  return root;
}

/** Offset of the first JSON syntax error (Node 20's JSON.parse messages carry no position), or null when valid. */
export function jsonErrorOffset(text) {
  let i = 0;
  const bad = () => { throw i; }; // a number, so it is distinguishable from real errors
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const lit = (w) => { if (text.startsWith(w, i)) i += w.length; else bad(); };
  const str = () => {
    for (i++; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { i++; return; }
      if (c < ' ') bad();
      if (c === '\\') {
        i++;
        if (!'"\\/bfnrtu'.includes(text[i] ?? '')) bad();
        if (text[i] === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) bad(); i += 4; }
      }
    }
    bad();
  };
  const num = () => { const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400)); if (!m) bad(); i += m[0].length; };
  const list = (close, item) => {
    i++; ws();
    if (text[i] === close) { i++; return; }
    for (;;) { item(); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === close) { i++; return; } bad(); }
  };
  const val = () => {
    ws();
    const c = text[i];
    if (c === '{') return list('}', () => { ws(); if (text[i] !== '"') bad(); str(); ws(); if (text[i] !== ':') bad(); i++; val(); });
    if (c === '[') return list(']', val);
    if (c === '"') return str();
    if (c === 't') return lit('true');
    if (c === 'f') return lit('false');
    if (c === 'n') return lit('null');
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    return bad();
  };
  try { val(); ws(); if (i < text.length) bad(); return null; } catch (e) { if (typeof e === 'number') return e; throw e; }
}

function jsonError(file, text, err) {
  const m = /position (\d+)/.exec(err.message);
  const at = m ? Number(m[1]) : jsonErrorOffset(text);
  if (at === null || at === undefined) return new Error(`${file} is not valid JSON: ${err.message}`);
  const before = text.slice(0, at).split('\n');
  const near = text.slice(at, at + 24).split('\n')[0];
  return new Error(`${file} is not valid JSON at line ${before.length}, column ${before.at(-1).length + 1}${near ? ` (near "${near}")` : ' (unexpected end)'}`);
}

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'placebo'];
const TUNES = ['film', 'animation', 'grain', 'stillimage', 'fastdecode', 'zerolatency', 'psnr', 'ssim'];
// Read by single tools, so mirrored here (tests keep them in step): score.mjs STYLES and parseKey, its two modes, gate.mjs AXIS_ALIASES.
const SCORE_STYLES = ['pulse', 'piano', 'minimal', 'cinematic'];
const SCORE_MODES = ['minor', 'major'];
const SCORE_KEY = /^\s*[A-Ga-g][#b♯♭]?\s*(?:m|min|minor|M|maj|major)?\s*$/;
const AXIS_ALIASES = {
  'hook-in-first-2s': 'hook', 'first-2s': 'hook', 'readability-at-phone-size': 'readability', 'phone-readability': 'readability', 'legibility': 'readability',
  'motion-quality': 'motion', 'brand-accuracy': 'brand', 'sound-sync': 'sound', 'sync': 'sound', 'audio': 'sound',
};
const axisKey = (name) => { const k = String(name).trim().toLowerCase().replace(/[\s_]+/g, '-'); return AXIS_ALIASES[k] || k; };

export function validateConfig(cfg) {
  const errs = [];
  const show = (v) => JSON.stringify(v);
  // The message names only the bounds that exist: "between 0 and 51", "> 0 and <= 240", ">= 0", never "-Infinity".
  const num = (key, v, { min = -Infinity, max = Infinity, int = false, gt } = {}) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return errs.push(`${key} must be a number (got ${show(v)})`);
    if (int && !Number.isInteger(v)) return errs.push(`${key} must be an integer (got ${v})`);
    if (!((gt === undefined || v > gt) && v >= min && v <= max)) {
      const lo = Number.isFinite(min);
      const hi = Number.isFinite(max);
      const want = gt !== undefined ? `> ${gt}${hi ? ` and <= ${max}` : ''}` : lo && hi ? `between ${min} and ${max}` : lo ? `>= ${min}` : `<= ${max}`;
      errs.push(`${key} must be ${want} (got ${v})`);
    }
  };
  const str = (key, v, { nullable = false } = {}) => {
    if (nullable && v === null) return;
    if (typeof v !== 'string') errs.push(`${key} must be a string${nullable ? ' or null' : ''} (got ${show(v)})`);
  };
  const bool = (key, v) => { if (typeof v !== 'boolean') errs.push(`${key} must be true or false (got ${show(v)})`); };
  const obj = (key, v) => { if (!isPlainObject(v)) { errs.push(`${key} must be an object (got ${show(v)})`); return false; } return true; };
  const oneOf = (key, v, list) => { if (!list.includes(v)) errs.push(`${key} must be one of ${list.join(', ')} (got ${show(v)})`); };

  str('title', cfg.title);
  num('duration', cfg.duration, { gt: 0, max: 36000 });
  num('fps', cfg.fps, { gt: 0, max: 240 });
  num('subframes', cfg.subframes, { min: 1, max: 64, int: true });
  num('shutter', cfg.shutter, { min: 0, max: 1 });
  num('bpm', cfg.bpm, { gt: 0, max: 999 });
  num('beatsPerBar', cfg.beatsPerBar, { min: 1, max: 32, int: true });
  bool('loop', cfg.loop);
  const fmtKeys = Object.keys(FORMATS);
  if (!Array.isArray(cfg.formats) || cfg.formats.length === 0) errs.push(`formats must be a non-empty array of ${fmtKeys.join(', ')}`);
  else {
    for (const f of cfg.formats) if (!fmtKeys.includes(f)) errs.push(`formats: unknown format ${show(f)} (valid: ${fmtKeys.join(', ')})`);
    if (new Set(cfg.formats).size !== cfg.formats.length) errs.push('formats lists a format twice');
    if (!cfg.formats.includes(cfg.primaryFormat)) errs.push(`primaryFormat ${show(cfg.primaryFormat)} must be one of formats [${cfg.formats.join(', ')}]`);
  }
  oneOf('capture', cfg.capture, ['auto', 'canvas', 'page']);
  if (typeof cfg.browser !== 'string' || !(['auto', 'chrome', 'msedge', 'chromium'].includes(cfg.browser) || path.isAbsolute(cfg.browser)))
    errs.push(`browser must be auto, chrome, msedge, chromium or an absolute path to a Chromium-based browser (got ${show(cfg.browser)})`);
  if (obj('encode', cfg.encode)) {
    num('encode.crf', cfg.encode.crf, { min: 0, max: 51 });
    oneOf('encode.preset', cfg.encode.preset, PRESETS);
    oneOf('encode.previewPreset', cfg.encode.previewPreset, PRESETS);
    if (cfg.encode.tune !== null && cfg.encode.tune !== '' && cfg.encode.tune !== undefined) oneOf('encode.tune', cfg.encode.tune, TUNES);
  }
  if (cfg.poster !== null) num('poster', cfg.poster, { min: 0, max: typeof cfg.duration === 'number' ? cfg.duration : Infinity });
  if (obj('safe', cfg.safe)) {
    for (const [f, s] of Object.entries(cfg.safe)) {
      if (!obj(`safe.${f}`, s)) continue;
      const before = errs.length;
      for (const side of ['top', 'bottom', 'left', 'right']) num(`safe.${f}.${side}`, s[side], {});
      // The range and the "at least 10% of the frame per axis" rule are layout.js's own, so a config that passes here can
      // never make layout() throw at render time.
      if (errs.length === before) errs.push(...safeProblems(f, s));
    }
  }
  if (obj('brand', cfg.brand)) {
    str('brand.name', cfg.brand.name); str('brand.url', cfg.brand.url);
    if (obj('brand.colors', cfg.brand.colors)) for (const [k, v] of Object.entries(cfg.brand.colors)) str(`brand.colors.${k}`, v);
    if (obj('brand.fonts', cfg.brand.fonts)) for (const [k, v] of Object.entries(cfg.brand.fonts)) str(`brand.fonts.${k}`, v);
  }
  if (!Array.isArray(cfg.fonts)) errs.push('fonts must be an array of {family, src, weight?, style?}');
  else cfg.fonts.forEach((f, i) => { if (!isPlainObject(f) || typeof f.family !== 'string' || typeof f.src !== 'string') errs.push(`fonts[${i}] needs string "family" and "src"`); });
  if (obj('audio', cfg.audio)) {
    for (const k of ['music', 'sfx', 'voice', 'master']) str(`audio.${k}`, cfg.audio[k], { nullable: true });
    // loudnorm takes I in -70..-5 and mix.mjs rejects anything outside it, so a louder target fails here (before any tool
    // starts) instead of after the stems are decoded.
    num('audio.lufs', cfg.audio.lufs, { min: -70, max: -5 });
    num('audio.lufsTolerance', cfg.audio.lufsTolerance, { gt: 0, max: 10 });
    num('audio.truePeak', cfg.audio.truePeak, { min: -20, max: 0 });
    for (const k of ['musicGainDb', 'sfxGainDb', 'voiceGainDb']) num(`audio.${k}`, cfg.audio[k], { min: -60, max: 24 });
    bool('audio.duck', cfg.audio.duck);
    // Optional keys read by score.mjs and voice.mjs; absent or null = unset (the tools' own defaults).
    const set = (k) => cfg.audio[k] !== undefined && cfg.audio[k] !== null;
    if (set('style')) oneOf('audio.style', cfg.audio.style, SCORE_STYLES);
    if (set('key') && !(typeof cfg.audio.key === 'string' && SCORE_KEY.test(cfg.audio.key)))
      errs.push(`audio.key must be a note name A-G with an optional # or b, like A, F# or Bb (a trailing m or M sets the mode, as in C#m) (got ${show(cfg.audio.key)})`);
    if (set('mode')) oneOf('audio.mode', cfg.audio.mode, SCORE_MODES);
    if (set('seed') && !Number.isInteger(cfg.audio.seed)) errs.push(`audio.seed must be an integer (got ${show(cfg.audio.seed)})`);
    if (set('voiceId')) str('audio.voiceId', cfg.audio.voiceId);
  }
  if (obj('gate', cfg.gate)) {
    bool('gate.enabled', cfg.gate.enabled);
    if (cfg.gate.requireFormats !== undefined && cfg.gate.requireFormats !== null) bool('gate.requireFormats', cfg.gate.requireFormats);
    num('gate.minScore', cfg.gate.minScore, { min: 0, max: 10 });
    num('gate.minRounds', cfg.gate.minRounds, { min: 0, max: 100, int: true });
    if (!Array.isArray(cfg.gate.axes) || cfg.gate.axes.some((a) => typeof a !== 'string')) errs.push('gate.axes must be an array of axis names');
    // naAllowed names axes: the seven defaults (the merged default ["brand"] must stay valid whatever gate.axes says) plus gate.axes.
    const na = cfg.gate.naAllowed;
    if (na !== undefined) {
      const valid = [...new Set([...DEFAULTS.gate.axes, ...(Array.isArray(cfg.gate.axes) ? cfg.gate.axes.filter((a) => typeof a === 'string') : [])].map(axisKey))];
      if (!Array.isArray(na)) errs.push(`gate.naAllowed must be an array of axis names (valid: ${valid.join(', ')}) (got ${show(na)})`);
      else na.forEach((a, i) => {
        if (typeof a !== 'string') errs.push(`gate.naAllowed[${i}] must be an axis name string (got ${show(a)})`);
        else if (!valid.includes(axisKey(a))) errs.push(`gate.naAllowed: unknown axis ${show(a)} (valid: ${valid.join(', ')})`);
      });
    }
  }
  if (obj('critique', cfg.critique)) {
    for (const [k, v] of Object.entries(cfg.critique)) { if (k === 'allowSilence' || k === 'popIgnore' || k === 'stepped') continue; num(`critique.${k}`, v, { min: 0 }); }
    if (cfg.critique.stepped !== undefined && cfg.critique.stepped !== null) bool('critique.stepped', cfg.critique.stepped);
    const pi = cfg.critique.popIgnore; // seconds spans where the pop scan stays silent (a stepped reveal, an intended flash): [[t0, t1], ...]
    if (pi !== undefined && pi !== null) {
      if (!Array.isArray(pi)) errs.push(`critique.popIgnore must be an array of [t0, t1] second pairs (got ${show(pi)})`);
      else pi.forEach((p, i) => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || p[0] < 0 || p[0] >= p[1]) errs.push(`critique.popIgnore[${i}] must be [t0, t1] seconds with 0 <= t0 < t1 (got ${show(p)})`);
      });
    }
    const as = cfg.critique.allowSilence; // intentional silences that critique/deliver must not report: [[from, to], ...] seconds
    if (as !== undefined && as !== null) {
      if (!Array.isArray(as)) errs.push(`critique.allowSilence must be an array of [from, to] second pairs (got ${show(as)})`);
      else as.forEach((p, i) => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || p[0] < 0 || p[0] >= p[1]) errs.push(`critique.allowSilence[${i}] must be [from, to] seconds with 0 <= from < to (got ${show(p)})`);
      });
    }
  }
  if (obj('deliver', cfg.deliver) && cfg.deliver.maxBytes !== undefined && obj('deliver.maxBytes', cfg.deliver.maxBytes))
    for (const [k, v] of Object.entries(cfg.deliver.maxBytes)) num(`deliver.maxBytes.${k}`, v, { gt: 0 });
  return errs;
}

/** studio.json deep-merged over DEFAULTS; throws one readable Error listing every problem. */
export function loadConfig(root) {
  if (!root) throw new Error('loadConfig: no project root (no studio.json found)');
  const file = path.join(root, 'studio.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch (err) {
    throw new Error(err.code === 'ENOENT' ? `missing ${file}; run inside a film project (see /motion-studio:studio-init)` : `cannot read ${file}: ${err.message}`);
  }
  let user;
  try { user = JSON.parse(text); } catch (err) { throw jsonError(file, text, err); }
  if (!isPlainObject(user)) throw new Error(`${file} must contain a JSON object`);
  const cfg = deepMerge(DEFAULTS, user);
  const errs = validateConfig(cfg);
  if (errs.length) throw new Error(`invalid ${file}:\n  - ${errs.join('\n  - ')}`);
  return cfg;
}

/** "all" | "a,b" | ['a','b'] | undefined (primary) → validated list of format keys. */
export function resolveFormats(cfg, value) {
  const raw = value === undefined || value === null || value === '' ? [cfg.primaryFormat] : [].concat(value).flatMap((v) => String(v).split(','));
  const list = [...new Set(raw.map((s) => s.trim()).filter(Boolean).flatMap((v) => (v === 'all' ? cfg.formats : [v])))];
  for (const f of list) if (!FORMATS[f]) throw new UsageError(`unknown format "${f}" (valid: ${Object.keys(FORMATS).join(', ')}, all)`);
  return list;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

export class UsageError extends Error {
  constructor(message, usageText) { super(message); this.name = 'UsageError'; if (usageText) this.usage = usageText; }
}

const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const scriptTitle = () => (process.argv[1] ? `node ${path.relative(process.cwd(), process.argv[1]).replace(/\\/g, '/')}` : 'node tool');

/**
 * spec: { name: { type: 'string'|'number'|'boolean'|'list', default, alias, desc, arg, optional, of } }
 * Accepts --k v, --k=v, --no-k (boolean → false, others → null), -a v (one-letter alias), -h/--help → flags.help, `--`.
 * `optional: true` lets a string flag appear bare (value true). `of: 'number'` parses list items as numbers.
 * Kebab names are also exposed camelCased (flags['frames-dir'] === flags.framesDir). Unknown flags throw UsageError
 * (its .usage is built from `title`, default "node tools/<script>").
 */
export function parseArgs(argv, spec = {}, { title } = {}) {
  const flags = { help: false };
  const positionals = [];
  const names = new Map();
  for (const [key, s] of Object.entries(spec)) {
    names.set(key, key); names.set(kebab(key), key);
    for (const a of [].concat(s.alias ?? [])) names.set(a, key);
  }
  const fail = (msg) => { throw new UsageError(msg, usage(title ?? scriptTitle(), spec)); };
  const set = (key, v) => { flags[key] = v; if (key.includes('-')) flags[camel(key)] = v; };
  for (const [key, s] of Object.entries(spec)) set(key, s.default === undefined ? undefined : structuredClone(s.default));
  const seen = new Set();
  const coerce = (key, s, v, shown) => {
    const type = s.type ?? 'string';
    if (type === 'number') {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n)) fail(`${shown} expects a number (got "${v}")`);
      return n;
    }
    if (type === 'boolean') {
      const b = String(v).toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(b)) return true;
      if (['0', 'false', 'no', 'off'].includes(b)) return false;
      fail(`${shown} is a switch (got "${v}")`);
    }
    if (type === 'list') {
      let items = String(v).split(',').map((x) => x.trim()).filter(Boolean);
      if (s.of === 'number') items = items.map((x) => { const n = Number(x); if (!Number.isFinite(n)) fail(`${shown} expects numbers (got "${x}")`); return n; });
      const prev = seen.has(key) && Array.isArray(flags[key]) ? flags[key] : [];
      return [...prev, ...items];
    }
    return String(v);
  };
  const looksLikeValue = (tok) => tok !== undefined && (!tok.startsWith('-') || tok === '-' || /^-\.?\d/.test(tok));
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (tok === '-h' || tok === '--help') { flags.help = true; continue; }
    if (!tok.startsWith('-') || tok === '-' || /^-\.?\d/.test(tok)) { positionals.push(tok); continue; }
    const long = tok.startsWith('--');
    const body = tok.slice(long ? 2 : 1);
    const eq = body.indexOf('=');
    let name = eq >= 0 ? body.slice(0, eq) : body;
    let inline = eq >= 0 ? body.slice(eq + 1) : undefined;
    const shown = (long ? '--' : '-') + name;
    let key = names.get(name);
    let negated = false;
    if (key === undefined && long && name.startsWith('no-') && names.has(name.slice(3))) { key = names.get(name.slice(3)); negated = true; }
    if (key === undefined || (!long && name.length !== 1)) fail(`unknown option ${shown}`);
    const s = spec[key];
    const type = s.type ?? 'string';
    if (negated) {
      if (inline !== undefined) fail(`${shown} takes no value`);
      set(key, type === 'boolean' ? false : null); seen.add(key); continue;
    }
    if (type === 'boolean') { set(key, inline === undefined ? true : coerce(key, s, inline, shown)); seen.add(key); continue; }
    if (inline === undefined) {
      if (looksLikeValue(argv[i + 1])) inline = argv[++i];
      else if (s.optional) { set(key, true); seen.add(key); continue; }
      else fail(`${shown} needs a value${s.arg ? ` (${s.arg})` : ''}`);
    }
    set(key, coerce(key, s, inline, shown)); seen.add(key);
  }
  return { flags, positionals };
}

export function usage(title, spec = {}, extra = '') {
  const rows = Object.entries(spec).map(([key, s]) => {
    const type = s.type ?? 'string';
    const aliases = [].concat(s.alias ?? []).map((a) => (a.length === 1 ? `-${a}` : `--${a}`));
    const placeholder = s.arg ?? (type === 'number' ? '<n>' : type === 'list' ? '<a,b>' : '<value>');
    const name = type === 'boolean' ? (s.default === true ? `--no-${kebab(key)}` : `--${kebab(key)}`)
      : `--${kebab(key)} ${s.optional ? `[${placeholder.replace(/^<|>$/g, '')}]` : placeholder}`;
    const def = s.default !== undefined && type !== 'boolean' ? ` (default: ${[].concat(s.default).join(',')})` : '';
    return [[...aliases, name].join(', '), `${s.desc ?? ''}${def}`];
  });
  rows.push(['-h, --help', 'Show this help']);
  const w = Math.min(34, Math.max(...rows.map((r) => r[0].length)) + 2);
  const lines = rows.map(([a, b]) => (a.length + 2 > w ? `  ${a}\n  ${' '.repeat(w)}${b}` : `  ${a.padEnd(w)}${b}`));
  return `${title}\n\nOptions:\n${lines.join('\n')}\n${extra ? `\n${extra.trimEnd()}\n` : ''}`;
}

// A finished CLI must not be kept alive by a leaked handle (a browser still shutting down, a socket, a child): after ms
// it exits once stdout/stderr are flushed. The timers are unref'd, so an idle process still exits at once.
function exitWhenIdle(ms) {
  setTimeout(() => {
    const busy = [process.stdout, process.stderr].filter((s) => s.writableLength > 0);
    if (!busy.length) process.exit();
    let left = busy.length;
    for (const s of busy) s.once('drain', () => { if (--left === 0) process.exit(); });
    setTimeout(() => process.exit(), 2000).unref();
  }, ms).unref();
}

/** True when argv turns --json on (the last of --json / --json=<bool> / --no-json wins; nothing after a bare `--` counts). */
export function wantsJson(argv = process.argv.slice(2)) {
  let on = false;
  for (const tok of argv) {
    if (tok === '--') break;
    if (tok === '--json') on = true;
    else if (tok === '--no-json') on = false;
    else if (tok.startsWith('--json=')) on = !['0', 'false', 'no', 'off'].includes(tok.slice(7).toLowerCase());
  }
  return on;
}

/** Runs an async CLI body: UsageError → exit 2 (+usage), Error → exit 1 (stack with DEBUG). A returned number is the exit
 *  code and ends the process within ~1 s even if a handle leaked; returning undefined keeps it running (serve.mjs).
 *  With --json a failure also prints ONE line on stdout, {"ok":false,"error":"<message>"} (the human message stays on
 *  stderr, the exit code is unchanged), so a script parsing stdout never gets an empty string for a failed run. */
export function main(fn) {
  Promise.resolve().then(fn).then((code) => {
    if (typeof code !== 'number') return;
    process.exitCode = code;
    exitWhenIdle(1000);
  }, (err) => {
    const isUsage = err instanceof UsageError || err?.name === 'UsageError';
    if (wantsJson()) process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }) + '\n');
    process.stderr.write(`error: ${err?.message ?? err}\n`);
    if (isUsage && err.usage) process.stderr.write(`\n${err.usage}`);
    if (process.env.DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
    process.exitCode = isUsage ? 2 : 1;
    exitWhenIdle(3000);
  });
}

/** True when the module at metaUrl is the script node was started with (so importing a tool never runs its CLI). */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  const norm = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* keep the resolved path */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  try { return norm(process.argv[1]) === norm(fileURLToPath(metaUrl)); } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------------------
// Processes

const osHint = () => ({
  win32: 'winget install Gyan.FFmpeg   (or: npm install ffmpeg-static, or set FFMPEG_PATH=C:\\path\\to\\ffmpeg.exe)',
  darwin: 'brew install ffmpeg   (or: npm install ffmpeg-static, or set FFMPEG_PATH)',
}[process.platform] ?? 'sudo apt-get install ffmpeg  (or dnf/pacman; or npm install ffmpeg-static, or set FFMPEG_PATH)');

const probeOk = (cmd, args) => {
  try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 15000, windowsHide: true }).status === 0; } catch { return false; }
};
const requireFrom = (root) => [path.join(root, 'package.json'), path.join(TOOLS_DIR, '..', 'package.json')].map((p) => createRequire(p));

const ffCache = new Map();
export function resolveFfmpeg(root = process.cwd()) {
  const key = path.resolve(root);
  if (ffCache.has(key)) return ffCache.get(key);
  const tried = [];
  const found = (p) => { ffCache.set(key, p); return p; };
  for (const name of ['FFMPEG_PATH', 'FFMPEG']) {
    const v = process.env[name];
    if (!v) continue;
    if (fs.existsSync(v) || probeOk(v, ['-version'])) return found(v);
    tried.push(`${name}=${v} (not found)`);
  }
  for (const req of requireFrom(key)) {
    try { const p = req('ffmpeg-static'); if (typeof p === 'string' && fs.existsSync(p)) return found(p); if (p) tried.push(`ffmpeg-static (binary missing at ${p}; re-run npm install)`); } catch { /* not installed */ }
  }
  if (probeOk('ffmpeg', ['-version'])) return found('ffmpeg');
  tried.push('ffmpeg on PATH');
  let py = null;
  try { py = resolvePython(key); } catch (err) { tried.push(err.message); } // a broken MOTION_PYTHON pin is one more thing tried, not the error
  if (py) {
    const r = spawnSync(py, ['-c', 'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.status === 0 && r.stdout && fs.existsSync(r.stdout.trim())) return found(r.stdout.trim());
    tried.push('python imageio_ffmpeg');
  }
  throw new Error(`ffmpeg not found (tried: ${tried.join('; ')}).\nInstall one: ${osHint()}`);
}

const pyCache = new Map();
const PY_PROBE_MS = 20000; // per auto-discovered candidate: a hanging stub (Microsoft Store alias) must not stall the search
const PY_PINNED_PROBE_MS = 60000; // MOTION_PYTHON is the user's own choice: a slow disk, antivirus scan or network drive gets time

/** One candidate through `import sys` only (numba and librosa start-up are not part of it): { python } or { why }. */
function probePython([cmd, ...pre], timeout, spawn) {
  let r;
  try { r = spawn(cmd, [...pre, '-c', 'import sys; sys.stdout.write(sys.executable)'], { encoding: 'utf8', timeout, windowsHide: true }); } catch (err) { return { why: String(err?.message ?? err).split('\n')[0] }; }
  if (r.error) {
    const code = r.error.code;
    return { why: code === 'ETIMEDOUT' ? `no answer within ${timeout / 1000} s` : code === 'ENOENT' ? 'no such file or command' : String(r.error.message).split('\n')[0] };
  }
  if (r.status !== 0) {
    const tail = String(r.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1);
    return { why: `exited with ${r.status ?? r.signal}${tail ? `: ${tail.slice(0, 200)}` : ''}` };
  }
  const python = String(r.stdout ?? '').trim();
  return python ? { python } : { why: 'it printed no interpreter path (is it a Python?)' };
}

/**
 * The Python to use: MOTION_PYTHON when set, else `<root>/.venv`, `python3`, `python`, `py -3` (the first that answers);
 * null when none does. MOTION_PYTHON is a pin, never a hint: when that interpreter does not answer this throws
 * `MOTION_PYTHON=<path> is not usable: <reason>` instead of quietly using another Python (a wrong librosa would give a
 * different beat grid). Callers that can live without Python catch it and show the message. The answer, failure included, is
 * cached per project root and MOTION_PYTHON value. `opts.spawn` replaces spawnSync (tests).
 */
export function resolvePython(root = process.cwd(), { spawn = spawnSync } = {}) {
  const dir = path.resolve(root);
  const pinned = process.env.MOTION_PYTHON || null;
  const key = `${dir}\0${pinned ?? ''}`;
  if (!pyCache.has(key)) {
    let found;
    if (pinned) {
      const r = probePython([pinned], PY_PINNED_PROBE_MS, spawn);
      found = r.python ? { python: r.python } : { error: `MOTION_PYTHON=${pinned} is not usable: ${r.why}` };
    } else {
      const venv = process.platform === 'win32' ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');
      const candidates = [];
      if (fs.existsSync(venv)) candidates.push([venv]);
      candidates.push(['python3'], ['python'], ['py', '-3']);
      found = { python: null };
      for (const candidate of candidates) {
        const r = probePython(candidate, PY_PROBE_MS, spawn);
        if (r.python) { found = { python: r.python }; break; }
      }
    }
    pyCache.set(key, found);
  }
  const hit = pyCache.get(key);
  if (hit.error) throw new Error(hit.error);
  return hit.python;
}

/** spawn without a shell; resolves { code, signal, stdout, stderr, timedOut, error } and never rejects. */
export function run(cmd, args = [], { cwd, input, env, timeoutMs, onStderr, encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    const out = [];
    let stderr = '';
    let timedOut = false;
    const finish = (extra) => {
      const buf = Buffer.concat(out);
      resolve({ stdout: encoding === 'buffer' ? buf : buf.toString('utf8'), stderr, timedOut, ...extra });
    };
    let child;
    try {
      const fullEnv = env ? Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined)) : process.env;
      child = spawn(cmd, args, { cwd, env: fullEnv, shell: false, windowsHide: true, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (error) { finish({ code: null, signal: null, error, stderr: error.message }); return; }
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; onStderr?.(d); });
    let spawnError = null;
    child.on('error', (e) => { spawnError = e; });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      finish({ code: spawnError ? null : code, signal, error: spawnError ?? undefined, stderr: spawnError ? `${stderr}${spawnError.message}` : stderr });
    });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

const lastLines = (text, n) => text.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join('\n');
const isPipeOut = (args) => ['-', 'pipe:', 'pipe:1'].includes(args.at(-1));

/**
 * ffmpeg with -hide_banner. stdout is a Buffer when the last arg is '-'/'pipe:1' (media on stdout) or encoding:'buffer',
 * otherwise a string. Throws with the last 20 stderr lines on a non-zero exit.
 */
export async function ffmpeg(root, args, opts = {}) {
  const bin = resolveFfmpeg(root);
  const encoding = opts.encoding ?? (isPipeOut(args) ? 'buffer' : 'utf8');
  const r = await run(bin, ['-hide_banner', ...args], { ...opts, encoding });
  if (r.code !== 0) {
    const cmd = `ffmpeg ${args.join(' ')}`;
    throw new Error(`${cmd.length > 300 ? cmd.slice(0, 300) + '…' : cmd}\nffmpeg ${r.timedOut ? 'timed out' : `exited with ${r.code ?? r.signal}`}:\n${lastLines(r.stderr, 20)}`);
  }
  return { stdout: r.stdout, stderr: r.stderr, code: 0 };
}

/** Streaming ffmpeg stdin writer with backpressure; a dead ffmpeg surfaces as a rejection with its stderr, never an EOF crash. */
export function ffmpegSink(root, args, { onStderr } = {}) {
  const bin = resolveFfmpeg(root);
  const pre = ['-hide_banner', '-nostats'];
  if (!args.includes('-loglevel') && !args.includes('-v')) pre.push('-loglevel', 'error');
  const ff = spawn(bin, [...pre, ...args], { stdio: ['pipe', 'ignore', 'pipe'], shell: false, windowsHide: true });
  let tail = '';
  ff.stderr.setEncoding('utf8');
  ff.stderr.on('data', (d) => { tail = (tail + d).slice(-8000); onStderr?.(d); });
  ff.stdin.on('error', () => {}); // EPIPE/EOF: the real cause arrives via 'close'
  let killed = false;
  const closed = new Promise((resolve, reject) => {
    ff.once('error', (e) => reject(new Error(`cannot start ffmpeg (${bin}): ${e.message}`)));
    ff.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(killed ? 'ffmpeg was stopped' : `ffmpeg exited with ${code ?? signal}${tail.trim() ? `:\n${lastLines(tail, 20)}` : ' without an error message (killed, crashed or out of disk space?)'}`));
    });
  });
  closed.catch(() => {});
  const exited = () => ff.exitCode !== null || ff.signalCode !== null;
  return {
    proc: ff,
    closed,
    async write(buf) {
      if (exited()) { await closed; throw new Error('ffmpeg exited before all input was written'); }
      if (!ff.stdin.write(buf)) await Promise.race([once(ff.stdin, 'drain').catch(() => closed), closed]);
    },
    async end() { ff.stdin.end(); await closed; },
    kill() { killed = true; try { ff.stdin.destroy(); } catch { /* already gone */ } try { ff.kill('SIGKILL'); } catch { /* already gone */ } },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Static server + browser/page driver live in studio-web.mjs (kept separate for size); every tool imports them from here.
// The list is explicit (a star export would hide a clash with a local name) and complete: a test compares it with every
// export of studio-web.mjs, so a new helper there cannot be forgotten here. The second line is the browser policy: which
// browser launchBrowser may start, and the Windows failed-logon guard around an installed Chrome/Edge.

export { BROWSER_ARGS, OPTIONAL_RESOURCES, boundClose, captureFrame, closeTimeoutMs, dataUrlToBuffer, even, importPlaywright,
  isBenignConsoleError, isChromeUnsafePort, launchBrowser, mimeType, openFilm, settleWithin, startServer, waitReady,
  LAUNCH_WINDOW_MS, browserAttempts, classifyBrowser, guardSystemLaunch, launchFailureMessage, launchGuard, launchLogPath,
  lockoutRefusal, readLaunchLog, recordLaunch, systemBrowserMax, systemBrowserWarning } from './studio-web.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Files and small helpers

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

export function readJSON(p, ...fallback) {
  let text;
  try { text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch (err) {
    if (err.code === 'ENOENT' && fallback.length) return fallback[0];
    throw err.code === 'ENOENT' ? new Error(`missing ${p}`) : err;
  }
  try { return JSON.parse(text); } catch (err) { throw jsonError(p, text, err); }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Write to a sibling temp file, then rename; retries briefly when Windows holds the target open (EPERM/EBUSY). */
export function writeFileAtomic(p, data) {
  ensureDir(path.dirname(p));
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, p); return p; } catch (err) {
      if (i >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) { fs.rmSync(tmp, { force: true }); throw err; }
      pause(50 * (i + 1));
    }
  }
}

export const writeJSON = (p, obj) => writeFileAtomic(p, JSON.stringify(obj, null, 2) + '\n');

/**
 * Rename that tolerates Windows sharing violations (a player or indexer holding the target): retried with growing pauses
 * (50 ms up to 400 ms) until `waitMs` have passed (default 1.8 s). `onWait(err)` runs once, at the first failed attempt.
 * `rename` replaces fs.renameSync (tests).
 */
export function renameWithRetry(from, to, { waitMs = 1800, onWait, rename = fs.renameSync } = {}) {
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    try { rename(from, to); return to; } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || Date.now() - t0 >= waitMs) throw err;
      if (i === 0) onWait?.(err);
      pause(Math.min(400, 50 * (i + 1), Math.max(1, waitMs - (Date.now() - t0))));
    }
  }
}

/** .env → object. Supports export, quotes, inline # comments, CRLF, BOM. Never logs, never touches process.env. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^export\s/.test(line)) line = line.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    const q = val[0];
    let close = -1;
    if (q === "'") close = val.indexOf("'", 1);
    else if (q === '"') for (let k = 1; k < val.length; k++) { if (val[k] === '\\') k++; else if (val[k] === '"') { close = k; break; } }
    if (close > 0) {
      val = val.slice(1, close);
      if (q === '"') val = val.replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
    } else {
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash).trimEnd();
    }
    out[key] = val;
  }
  return out;
}

export function loadEnv(root) {
  try { return parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')); } catch { return {}; }
}

export function fmtTime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '--:--.--';
  const neg = sec < 0;
  const cs = Math.round(Math.abs(sec) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const pad = (n) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${h ? `${h}:` : ''}${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

export function slug(str) {
  const s = String(str ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  return s || 'film';
}

export function log(...a) { process.stderr.write(util.format(...a) + '\n'); }

export const outDir = (root, fmt, ...sub) => path.join(root, 'out', fmt, ...sub);
