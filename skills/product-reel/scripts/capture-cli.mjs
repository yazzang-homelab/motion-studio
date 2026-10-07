// Small CLI helpers shared by states.mjs and canvas-frames.mjs (capture.mjs keeps its own parser): a flag table, one
// parser for `--flag value` and `--flag=value`, a usage printer, the project-root search and the "inside the project" check.
// Node built-ins only; no browser is started here.
import fs from 'node:fs';
import path from 'node:path';

export class UsageError extends Error {}

/**
 * Parses argv against a table { name: { type: 'string' | 'int' | 'number' | 'boolean' | 'list', default?, min?, max?, desc, alias? } }.
 * `--name value`, `--name=value`, `--no-name` (boolean), `-h`. A list flag may repeat and keeps every value as typed (a CSS selector
 * can contain commas). Values that start with `--` are never taken as the value of the previous flag.
 * @returns {{ flags: object, positionals: string[] }}
 */
export function parseFlags(argv, spec) {
  const flags = {};
  const positionals = [];
  for (const [k, s] of Object.entries(spec)) {
    if (s.default !== undefined) flags[k] = Array.isArray(s.default) ? [...s.default] : s.default;
    else if (s.type === 'list') flags[k] = [];
  }
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--') || a === '--') { if (a !== '--') positionals.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    let value = eq === -1 ? undefined : a.slice(eq + 1);
    if (key.startsWith('no-') && spec[key.slice(3)]?.type === 'boolean' && value === undefined) { flags[key.slice(3)] = false; continue; }
    const s = spec[key];
    if (!s) throw new UsageError(`unknown flag --${key}`);
    if (s.type === 'boolean') {
      if (value !== undefined) throw new UsageError(`--${key} takes no value`);
      flags[key] = true;
      continue;
    }
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith('--')) throw new UsageError(`--${key} needs a value`);
      value = String(next);
      i++;
    }
    if (s.type === 'int' || s.type === 'number') {
      const n = Number(value);
      const ok = Number.isFinite(n) && value.trim() !== '' && (s.type === 'number' || Number.isInteger(n));
      if (!ok) throw new UsageError(`--${key} must be ${s.type === 'int' ? 'a whole number' : 'a number'}, got "${value}"`);
      if (s.min !== undefined && n < s.min) throw new UsageError(`--${key} must be at least ${s.min}`);
      if (s.max !== undefined && n > s.max) throw new UsageError(`--${key} must be at most ${s.max}`);
      flags[key] = n;
    } else if (s.type === 'list') {
      if (!seen.has(key)) { flags[key] = []; seen.add(key); }
      flags[key].push(value);
    } else flags[key] = value;
  }
  return { flags, positionals };
}

/** The --help text: a header block, then one row per flag. */
export function usageText(header, spec) {
  const rows = Object.entries(spec).map(([k, s]) => {
    const flag = `--${k}${s.type === 'boolean' ? '' : ` <${s.type === 'list' ? 'value' : s.type}>`}${s.alias ? `, -${s.alias}` : ''}`;
    const def = s.default !== undefined && !Array.isArray(s.default) ? ` (default ${s.default})` : '';
    return `  ${flag.padEnd(26)} ${s.desc}${def}`;
  });
  return [...header, '', ...rows].join('\n');
}

/** The nearest folder at or above `start` that holds a studio.json, or null. */
export function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'studio.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The folder the scripts work in: --root, else the nearest studio.json folder, else the current folder (a skills-only install
 * has no studio.json; Playwright is then resolved from there).
 */
export function resolveRoot(rootFlag, cwd = process.cwd()) {
  if (rootFlag) {
    const root = path.resolve(cwd, rootFlag);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError(`--root ${rootFlag} is not a folder`);
    return root;
  }
  return findProjectRoot(cwd) ?? path.resolve(cwd);
}

/** `p` resolved against `root`; throws when the result is outside `root` (an output folder must stay inside the project). */
export function insideRoot(root, p, what = 'output folder') {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new UsageError(`${what} ${p} is outside the project folder ${root}; use a path inside it`);
  return abs;
}

/** Path relative to `root` with forward slashes (what manifests store). */
export const relTo = (root, p) => path.relative(root, p).split(path.sep).join('/');

/** Writes a file through a temporary name so a crash never leaves a half-written manifest. */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
