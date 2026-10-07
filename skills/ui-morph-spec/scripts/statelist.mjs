#!/usr/bin/env node
// State list on the beat grid for a one-shape UI morph (ui-morph-spec skill).
// Puts each state on a downbeat (bar grid from studio.json, or measured downbeats from audio/beats.json),
// prints the table the user approves before any code, and checks that the loop length matches the film.
// Node built-ins only; the same bar arithmetic as the film's grid.bar(n).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEC = {
  states: { type: 'string', desc: 'comma-separated states; "name:2" holds a state for 2 bars' },
  file: { type: 'string', desc: 'read states from a text file, one per line (same "name:bars" syntax)' },
  bars: { type: 'number', default: 1, desc: 'default bars per state' },
  bpm: { type: 'number', desc: 'tempo (default: studio.json bpm, else 120)' },
  'beats-per-bar': { type: 'number', desc: 'beats per bar (default: studio.json beatsPerBar, else 4)' },
  beats: { type: 'string', desc: 'measured beat grid JSON (default: audio/beats.json when present; "none" to ignore)' },
  'start-bar': { type: 'number', default: 0, desc: 'bar index of the first state' },
  loop: { type: 'boolean', desc: 'last state morphs back into the first (default: studio.json loop, else true)' },
  root: { type: 'string', desc: 'film project root (default: nearest folder with studio.json, else cwd)' },
  out: { type: 'string', desc: 'also write the markdown table to this file' },
  json: { type: 'boolean', desc: 'print one JSON result line on stdout instead of markdown' },
  help: { type: 'boolean', alias: 'h', desc: 'show this help' },
};

class UsageError extends Error {}

function usage() {
  const rows = Object.entries(SPEC).map(([k, s]) => {
    const flag = `--${k}${s.type === 'boolean' ? '' : ` <${s.type}>`}${s.alias ? `, -${s.alias}` : ''}`;
    return `  ${flag.padEnd(26)} ${s.desc}${s.default !== undefined ? ` (default ${s.default})` : ''}`;
  });
  return ['Usage: node statelist.mjs --states "logo,cta,email,loader,check,card,chart,palette" [options]', '',
    'Prints the state list on the beat grid (states on downbeats) for approval before any code.', '', ...rows].join('\n');
}

function parseArgs(argv) {
  const flags = {};
  for (const [k, s] of Object.entries(SPEC)) if (s.default !== undefined) flags[k] = s.default;
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (k.startsWith('no-') && SPEC[k.slice(3)]?.type === 'boolean') { flags[k.slice(3)] = false; continue; }
    const s = SPEC[k];
    if (!s) throw new UsageError(`unknown flag --${k}`);
    if (s.type === 'boolean') { if (v !== undefined) throw new UsageError(`--${k} takes no value`); flags[k] = true; continue; }
    if (v === undefined) { v = argv[++i]; if (v === undefined) throw new UsageError(`--${k} needs a value`); }
    if (s.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new UsageError(`--${k} must be a number`);
      flags[k] = n;
    } else flags[k] = v;
  }
  if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}" (use --states)`);
  return flags;
}

function findRoot(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'studio.json'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export function parseStates(text, defaultBars) {
  const items = text.split(/\r?\n|,/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
  return items.map((item) => {
    const m = /^(.*?)(?::\s*(\d+(?:\.\d+)?))?$/.exec(item);
    const bars = m[2] !== undefined ? Number(m[2]) : defaultBars;
    if (!m[1]) throw new UsageError(`empty state name in "${item}"`);
    if (!(bars > 0) || !Number.isInteger(bars)) throw new UsageError(`state "${m[1]}": bars must be a positive whole number`);
    return { name: m[1], bars };
  });
}

// Downbeat n in seconds, ported from lib/timeline.js beatGrid(): measured downbeats when present,
// else beat(n * beatsPerBar) over measured beats, else offset + n * bar length. Piecewise-linear with
// linear extrapolation at both ends, so the table matches grid.bar(n) in the film exactly.
function seq(arr, fallbackIv) {
  const last = arr.length - 1;
  const firstIv = arr.length >= 2 ? arr[1] - arr[0] : fallbackIv;
  const lastIv = arr.length >= 2 ? arr[last] - arr[last - 1] : fallbackIv;
  return (n) => {
    if (n <= 0) return arr[0] + n * firstIv;
    if (n >= last) return arr[last] + (n - last) * lastIv;
    const i = Math.floor(n);
    const f = n - i;
    return f === 0 ? arr[i] : arr[i] + (arr[i + 1] - arr[i]) * f;
  };
}
const sortedTimes = (a) => (Array.isArray(a) ? a.filter((x) => Number.isFinite(x) && x >= 0).sort((x, y) => x - y) : []);

export function makeBar({ bpm, beatsPerBar, offset = 0, downbeats = null, beats = null }) {
  const spb = 60 / bpm;
  const B = sortedTimes(beats);
  const D = sortedTimes(downbeats);
  const off = B.length ? B[0] : offset;
  const beatAt = B.length ? seq(B, spb) : (n) => off + n * spb;
  const barAt = D.length ? seq(D, spb * beatsPerBar) : null;
  return (n) => (barAt ? barAt(n) : beatAt(n * beatsPerBar));
}

export function buildStateList({ states, bar, startBar = 0, loop = true, beatsPerBar = 4 }) {
  const rows = [];
  let b = startBar;
  for (const [i, s] of states.entries()) {
    const start = bar(b);
    const end = bar(b + s.bars);
    rows.push({ i, name: s.name, bar: b, barBeat: `${b + 1}.1`, start, end, hold: end - start,
      contentIn: start + 0.08, contentFullyIn: start + 0.2, contentOut: end - 0.1 });
    b += s.bars;
  }
  const endTime = bar(b);
  return { rows, endBar: b, end: endTime, loop, beatsPerBar };
}

const f3 = (x) => x.toFixed(3).replace(/\.?0+$/, '') || '0';

export function toMarkdown(list, { source, bpm }) {
  const lines = [
    `State list on the beat grid · ${source} grid · ${f3(bpm)} BPM · ${list.beatsPerBar}/4 · states on downbeats`,
    '',
    '| # | State | Bar.beat | Start (s) | Hold (s) | Content in / out (s) | Cursor action | Data shown | Sounds |',
    '|---|---|---|---|---|---|---|---|---|',
    ...list.rows.map((r) => `| ${r.i + 1} | ${r.name} | ${r.barBeat} | ${f3(r.start)} | ${f3(r.hold)} | ${f3(r.contentIn)} / ${f3(r.contentOut)} | click @ ${f3(r.start)} | | click @ ${f3(r.start)} |`),
  ];
  if (list.loop) lines.push(`| ${list.rows.length + 1} | back to ${list.rows[0].name} (loop seam) | ${list.endBar + 1}.1 | ${f3(list.end)} = 0 | | | same position and speed as frame 0 | | |`);
  lines.push('', `Film length: ${f3(list.end)} s${list.loop ? ' (loop: set studio.json "loop": true)' : ''}. In film code use grid.bar(<bar>) for each start, never typed seconds.`);
  return lines.join('\n');
}

function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) { process.stdout.write(usage() + '\n'); return 0; }
  if (!flags.states && !flags.file) throw new UsageError('give --states or --file');
  const text = flags.file ? fs.readFileSync(path.resolve(flags.file), 'utf8') : flags.states;
  const states = parseStates(text, flags.bars);
  if (!states.length) throw new UsageError('no states given');

  const root = flags.root ? path.resolve(flags.root) : findRoot(process.cwd()) ?? process.cwd();
  const cfgPath = path.join(root, 'studio.json');
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  const warnings = [];
  let measured = null;
  const beatsArg = flags.beats ?? (fs.existsSync(path.join(root, 'audio', 'beats.json')) ? path.join(root, 'audio', 'beats.json') : null);
  if (beatsArg && beatsArg !== 'none') {
    const p = path.resolve(root, beatsArg);
    if (!fs.existsSync(p)) throw new Error(`beat grid not found: ${p}`);
    measured = readJson(p);
    if (!Array.isArray(measured.beats) || !measured.beats.length) { warnings.push(`${path.basename(p)} has no beats; using the bpm grid`); measured = null; }
  }
  const bpm = flags.bpm ?? (measured?.bpm > 0 ? measured.bpm : cfg.bpm) ?? 120;
  const beatsPerBar = flags['beats-per-bar'] ?? measured?.beatsPerBar ?? cfg.beatsPerBar ?? 4;
  if (!(bpm > 0)) throw new UsageError('--bpm must be positive');
  if (!(beatsPerBar >= 1) || !Number.isInteger(beatsPerBar)) throw new UsageError('--beats-per-bar must be a positive whole number');
  const source = measured && flags.bpm === undefined ? (measured.source === 'grid' ? 'analytic' : 'measured') : 'bpm';
  const bar = makeBar({ bpm, beatsPerBar, offset: source === 'bpm' ? 0 : (measured.offset ?? 0),
    downbeats: source === 'bpm' ? null : measured.downbeats, beats: source === 'bpm' ? null : measured.beats });
  const loop = flags.loop ?? cfg.loop ?? true;
  const list = buildStateList({ states, bar, startBar: flags['start-bar'], loop, beatsPerBar });

  if (states.length < 8 || states.length > 12) warnings.push(`${states.length} states; the pattern works best with 8 to 12`);
  for (const r of list.rows) if (r.hold < 1) warnings.push(`state "${r.name}" holds only ${f3(r.hold)} s; content will not read`);
  if (cfg.duration !== undefined && Math.abs(cfg.duration - list.end) > 0.001) {
    warnings.push(`studio.json duration is ${cfg.duration} s but the states end at ${f3(list.end)} s; set "duration": ${f3(list.end)}`);
  }
  if (loop && cfg.loop === false) warnings.push('studio.json has "loop": false; set it to true for a seamless loop');
  if (loop && Math.abs(list.rows[0].start) > 0.001) {
    warnings.push(`the first state starts at ${f3(list.rows[0].start)} s, not 0: a loop must start on a downbeat; trim the track so its first downbeat is at 0 (or use --start-bar)`);
  }
  if (measured?.duration && list.end > measured.duration + 0.001) warnings.push(`the states run past the end of the track (${f3(measured.duration)} s)`);

  const md = toMarkdown(list, { source, bpm });
  if (flags.out) fs.writeFileSync(path.resolve(flags.out), md + '\n');
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: true, source, bpm, beatsPerBar, loop, duration: list.end, states: list.rows, warnings }) + '\n');
  } else process.stdout.write(md + '\n');
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
    try { r = fs.realpathSync.native(r); } catch { /* keep the resolved path */ }
    return process.platform === 'win32' ? r.toLowerCase() : r; // drive-letter case differs between shells
  };
  try { return real(argv1) === real(fileURLToPath(metaUrl)); } catch { return false; }
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`statelist: ${err.message}\n${err instanceof UsageError ? `\n${usage()}\n` : ''}`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  }
}
