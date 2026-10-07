#!/usr/bin/env node
// Seeded brief randomizer for the showreel engine test.
// The option tables live in ../assets/variants.md so there is one editable source; the same seed
// always yields the same brief, and different seeds spread runs across the table instead of
// letting every run converge on the same "default" reel. Node built-ins only.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_VARIANTS = path.join(HERE, '..', 'assets', 'variants.md');
const REQUIRED = ['persona', 'genre', 'constraint', 'technique', 'frame'];
const FORMAT_LABEL = { '9x16': 'vertical 9:16', '1x1': 'square 1:1', '16x9': '16:9', '4x5': '4:5 portrait' };

const SPEC = {
  seed: { type: 'string', desc: 'seed text; the same seed gives the same brief (default: <folder>-<YYYY-MM-DD>)' },
  techniques: { type: 'number', default: 3, desc: 'number of distinct techniques to pick (1-6)' },
  seconds: { type: 'number', desc: 'override the rolled duration in seconds' },
  format: { type: 'string', desc: 'override the rolled format: 9x16, 1x1, 16x9 or 4x5' },
  pin: { type: 'list', desc: 'force rows by id, comma-separated (e.g. p03,g11,t04)' },
  variants: { type: 'string', desc: 'variants markdown file (default: this skill\'s assets/variants.md)' },
  list: { type: 'boolean', desc: 'print every option table and exit' },
  json: { type: 'boolean', desc: 'print one JSON result line on stdout' },
  help: { type: 'boolean', alias: 'h', desc: 'show this help' },
};

class UsageError extends Error {}

function usage() {
  const lines = Object.entries(SPEC).map(([k, s]) => {
    const flag = `--${k}${s.type === 'boolean' ? '' : ' <' + s.type + '>'}${s.alias ? ', -' + s.alias : ''}`;
    return `  ${flag.padEnd(26)} ${s.desc}${s.default !== undefined ? ` (default ${s.default})` : ''}`;
  });
  return [
    'Usage: node roll.mjs [seed] [options]',
    '',
    'Rolls persona x genre x constraint x techniques x frame from assets/variants.md and prints',
    'a showreel brief. Record the seed so the brief can be reproduced.',
    '',
    ...lines,
  ].join('\n');
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (const [k, s] of Object.entries(SPEC)) if (s.default !== undefined) flags[k] = s.default;
  const aliases = Object.fromEntries(Object.entries(SPEC).filter(([, s]) => s.alias).map(([k, s]) => [s.alias, k]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (/^-[a-zA-Z]$/.test(a)) {
      const k = aliases[a.slice(1)];
      if (!k) throw new UsageError(`unknown flag ${a}`);
      flags[k] = true;
      continue;
    }
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (k.startsWith('no-') && SPEC[k.slice(3)]?.type === 'boolean') { flags[k.slice(3)] = false; continue; }
    const s = SPEC[k];
    if (!s) throw new UsageError(`unknown flag --${k}`);
    if (s.type === 'boolean') {
      if (v !== undefined) throw new UsageError(`--${k} takes no value`);
      flags[k] = true;
      continue;
    }
    if (v === undefined) {
      v = argv[++i];
      if (v === undefined || (v.startsWith('--') && v.length > 2)) throw new UsageError(`--${k} needs a value`);
    }
    if (s.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new UsageError(`--${k} must be a number, got "${v}"`);
      flags[k] = n;
    } else if (s.type === 'list') {
      flags[k] = [...(flags[k] || []), ...v.split(',').map((x) => x.trim()).filter(Boolean)];
    } else {
      flags[k] = v;
    }
  }
  return { flags, positionals };
}

// FNV-1a over the joined parts, then mulberry32: the same scheme as the film library's rngFor,
// so a seed means the same thing everywhere in the studio.
function hash32(...parts) {
  let h = 0x811c9dc5;
  const s = parts.map(String).join('\u0001');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function splitRow(line) {
  // Tolerates escaped pipes and optional outer pipes.
  const cells = line.trim().replace(/\\\|/g, '\u0000').replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((c) => c.replace(/\u0000/g, '|').trim());
}

export function parseVariants(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const tables = {};
  let heading = null;
  let template = null;
  let inBrief = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      heading = h[2].toLowerCase();
      inBrief = h[1] === '##' && heading.startsWith('composed brief');
      continue;
    }
    if (inBrief && template === null && /^```/.test(line)) {
      const end = lines.indexOf('```', i + 1);
      if (end < 0) throw new Error('variants: unterminated code block under "Composed brief"');
      template = lines.slice(i + 1, end).join('\n');
      i = end;
      continue;
    }
    if (!heading || !line.trim().startsWith('|') || tables[heading]) continue;
    const header = splitRow(line).map((c) => c.toLowerCase());
    if (header[0] !== 'id' || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) continue;
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const cells = splitRow(lines[j]);
      const row = {};
      header.forEach((name, k) => { row[name] = cells[k] ?? ''; });
      if (row.id) rows.push(row);
    }
    tables[heading] = rows;
    i = j - 1;
  }
  return { tables, template };
}

function validate({ tables, template }, file) {
  const missing = REQUIRED.filter((t) => !tables[t]?.length);
  if (missing.length) throw new Error(`${file}: missing or empty table(s): ${missing.join(', ')}`);
  if (!template) throw new Error(`${file}: no code block under "## Composed brief"`);
  const seen = new Map();
  for (const name of REQUIRED) {
    for (const row of tables[name]) {
      if (seen.has(row.id)) throw new Error(`${file}: duplicate id ${row.id} (${seen.get(row.id)} and ${name})`);
      seen.set(row.id, name);
      if (name === 'frame') {
        if (!(Number(row.seconds) > 0)) throw new Error(`${file}: frame ${row.id} needs a positive seconds value`);
        if (!FORMAT_LABEL[row.format]) throw new Error(`${file}: frame ${row.id} has unknown format "${row.format}"`);
      } else if (!row.option) {
        throw new Error(`${file}: ${name} ${row.id} has no option text`);
      }
    }
  }
  return seen;
}

export function roll(parsed, { seed, techniques = 3, pins = [], seconds, format } = {}) {
  const { tables, template } = parsed;
  const owner = validate(parsed, 'variants');
  const pinned = {};
  for (const id of pins) {
    const table = owner.get(id);
    if (!table) throw new UsageError(`--pin: unknown id "${id}"`);
    (pinned[table] ||= []).push(id);
  }
  for (const t of ['persona', 'genre', 'constraint', 'frame']) {
    if ((pinned[t] || []).length > 1) throw new UsageError(`--pin: more than one ${t} id`);
  }
  const n = Math.trunc(techniques);
  if (!(n >= 1 && n <= 6)) throw new UsageError('--techniques must be between 1 and 6');
  if (n > tables.technique.length) throw new Error(`only ${tables.technique.length} techniques in the table`);
  if ((pinned.technique || []).length > n) throw new UsageError(`--pin lists more techniques than --techniques ${n}`);
  if (format !== undefined && !FORMAT_LABEL[format]) throw new UsageError(`--format must be one of ${Object.keys(FORMAT_LABEL).join(', ')}`);
  if (seconds !== undefined && !(seconds > 0 && seconds <= 600)) throw new UsageError('--seconds must be in (0, 600]');

  // One stream per table: adding rows to one table never reshuffles the others for a given seed.
  const pickOne = (name) => {
    const rows = tables[name];
    const id = pinned[name]?.[0];
    if (id) return rows.find((r) => r.id === id);
    const r = mulberry32(hash32(seed, name));
    return rows[Math.floor(r() * rows.length)];
  };
  const persona = pickOne('persona');
  const genre = pickOne('genre');
  const constraint = pickOne('constraint');
  const frame = { ...pickOne('frame') };
  if (seconds !== undefined) frame.seconds = String(seconds);
  if (format !== undefined) frame.format = format;

  const pinnedTech = (pinned.technique || []).map((id) => tables.technique.find((r) => r.id === id));
  const pool = tables.technique.filter((r) => !pinnedTech.includes(r));
  const r = mulberry32(hash32(seed, 'technique'));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const tech = [...pinnedTech, ...pool.slice(0, n - pinnedTech.length)];

  const values = {
    seconds: String(Number(frame.seconds)),
    format: FORMAT_LABEL[frame.format],
    genre: genre.option,
    persona: persona.option,
    constraint: constraint.option,
    techniques: tech.map((t) => t.option).join('; '),
  };
  const brief = template.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
  return {
    seed,
    brief,
    picks: {
      persona: { id: persona.id, option: persona.option },
      genre: { id: genre.id, option: genre.option },
      constraint: { id: constraint.id, option: constraint.option },
      frame: { id: frame.id, seconds: Number(frame.seconds), format: frame.format },
      techniques: tech.map((t) => ({ id: t.id, option: t.option })),
    },
    loop: /\bloop\b/i.test(genre.option),
  };
}

function defaultSeed() {
  const day = new Date().toISOString().slice(0, 10);
  return `${path.basename(process.cwd()) || 'studio'}-${day}`;
}

function main(argv) {
  const { flags, positionals } = parseArgs(argv);
  if (flags.help) { process.stdout.write(usage() + '\n'); return 0; }
  if (positionals.length > 1) throw new UsageError(`expected at most one positional seed, got ${positionals.length}`);
  if (positionals.length && flags.seed !== undefined) throw new UsageError('give the seed either positionally or with --seed, not both');
  const file = path.resolve(flags.variants || DEFAULT_VARIANTS);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read variants file ${file}: ${err.code || err.message}`);
  }
  const parsed = parseVariants(text);
  if (flags.list) {
    validate(parsed, file);
    const out = REQUIRED.map((name) => {
      const rows = parsed.tables[name].map((r) => `  ${r.id}  ${name === 'frame' ? `${r.seconds} s ${r.format}` : r.option}`);
      return `${name} (${rows.length})\n${rows.join('\n')}`;
    }).join('\n\n');
    if (flags.json) process.stdout.write(JSON.stringify({ file, tables: parsed.tables }) + '\n');
    else process.stdout.write(out + '\n');
    return 0;
  }
  const seed = String(flags.seed ?? positionals[0] ?? defaultSeed());
  const result = roll(parsed, {
    seed, techniques: flags.techniques, pins: flags.pin || [], seconds: flags.seconds, format: flags.format,
  });
  const p = result.picks;
  process.stderr.write(`seed "${seed}": ${[p.persona.id, p.genre.id, p.constraint.id, p.frame.id, ...p.techniques.map((t) => t.id)].join(' ')}\n`);
  if (result.loop) process.stderr.write('genre is a loop: scaffold with --loop and make the last frame equal the first\n');
  if (flags.json) process.stdout.write(JSON.stringify({ ok: true, file, ...result }) + '\n');
  else process.stdout.write(result.brief + '\n');
  return 0;
}

/**
 * True when the module at `metaUrl` is the script node was started with. Node realpath()s the main module for
 * import.meta.url but leaves process.argv[1] as typed, so a path through a symlink or junction (a symlinked skills
 * install, a symlinked $HOME, macOS /tmp) has to be compared by real path, or main() never runs and the CLI exits 0 with
 * no output. Falls back to the resolved path when a real path cannot be read.
 */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (p) => {
    let r = path.resolve(p);
    try { r = realpathSync.native(r); } catch { /* keep the resolved path */ }
    return process.platform === 'win32' ? r.toLowerCase() : r; // drive-letter case differs between shells
  };
  try { return real(argv1) === real(fileURLToPath(metaUrl)); } catch { return false; }
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`roll: ${err.message}\n\n${usage()}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`roll: ${err.message}\n`);
      if (process.env.DEBUG) process.stderr.write(`${err.stack}\n`);
      process.exitCode = 1;
    }
  }
}
