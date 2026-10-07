#!/usr/bin/env node
// Render gate: reads docs/review_log.md and decides whether the critique loop has earned a final render.
// Imported by the plugin's PreToolUse hook and by deliver.mjs, so it stays dependency-free and side-effect-free
// on import (the CLI runs only when this file is executed directly).
//
// Review-log block (append one per round):
//   ## Round 2 — 9x16 — <free text>
//   SCORES: hook=8 readability=9 motion=8 variety=8 composition=8 brand=na sound=7
//   PROBLEMS:
//   1. [P1] [00:04.20] text overlaps during the swap into the chart state
//   FIXES: ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// naAllowed: the axes whose `na` passes in the last round (brand=na for a pure showreel). Any other na fails, so a
// film that ships with audio cannot pass on sound=na.
// requireFormats: false = only the LAST round is judged (the default and the documented contract); true = additionally every
// format in studio.json "formats" needs at least one logged round (heading format token) whose own scores pass.
const GATE_DEFAULTS = { enabled: true, minScore: 8, minRounds: 3, axes: ['hook', 'readability', 'motion', 'variety', 'composition', 'brand', 'sound'], naAllowed: ['brand'], requireFormats: false };

// Common spellings of the seven axes, so "sound sync=8" or "brand_accuracy=9" still count.
const AXIS_ALIASES = {
  'hook-in-first-2s': 'hook', 'first-2s': 'hook',
  'readability-at-phone-size': 'readability', 'phone-readability': 'readability', 'legibility': 'readability',
  'motion-quality': 'motion',
  'brand-accuracy': 'brand',
  'sound-sync': 'sound', 'sync': 'sound', 'audio': 'sound',
};

const normAxis = (name) => {
  const k = String(name).trim().toLowerCase().replace(/[\s_]+/g, '-');
  return AXIS_ALIASES[k] || k;
};

const SEP = /\s+[—–\-·|:]\s+|\s*[—–·|]\s*/;
const FORMAT_RE = /^\d+x\d+$/i;

function parseTime(s) {
  if (s == null) return null;
  const str = String(s).trim().replace(',', '.');
  let m = str.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = str.match(/^(\d+):(\d{2}):(\d{1,2}(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = str.match(/^(\d+(?:\.\d+)?)\s*s?$/i);
  if (m) return Number(m[1]);
  return null;
}

const TIME_TOKEN = String.raw`\d{1,2}:\d{1,2}(?:[.,]\d+)?|\d+(?:\.\d+)?\s*s`;

// Severity detection is strict by default: a P0/P1/P2 token ANYWHERE in a problem line sets the severity, however the
// critic decorated it ("[P0]", "**P0**", "(P0)", "Severity: P0", "... (P0)", a table cell). Only a template
// placeholder ("[P0|P1|P2]"), and a mention that says there is none ("no P0", "P0: 0"), are no severity. P0 wins when a
// line carries several tokens. "[BLOCKER]", "[CRITICAL]", "[SHOWSTOPPER]" and "SEV0" are P0.
const P_LIST = /P[0-2](?:\s*[|/]\s*P[0-2])+/gi;
const P_TOKEN = /(?<![\w|])P([0-2])(?![\w|])/gi;
const P0_WORDS = /(?:[[(*_]\s*(?:blocker|critical|showstopper|sev(?:erity)?[-\s]?0)\s*[\])*_])|(?:^\s*(?:blocker|showstopper|critical)\s*[:\-–—])|(?<![\w-])sev(?:erity)?[-\s]?0(?![\w])/i;

function negated(text, index, length) {
  const before = text.slice(Math.max(0, index - 24), index);
  const after = text.slice(index + length, index + length + 24);
  return /\b(?:no|zero|without|non)[-\s]+(?:open\s+|remaining\s+|more\s+)?$/i.test(before)
    || /(?<![\w:.])0[-\s]+(?:open\s+|remaining\s+)?$/.test(before)
    || /^s?\s*(?:count\s*)?[:=]\s*(?:0(?![\d:.,])|(?:none|nil)\b)/i.test(after)
    || /^s?\s+(?:remaining|left|open)\s*[:=]?\s*(?:0(?![\d:.,])|none\b)/i.test(after);
}

/** { severity, index, length } of the deciding severity token in `text`, or null. Placeholders and "no P0" are skipped. */
function findSeverity(text) {
  const src = String(text).replace(P_LIST, (m) => ' '.repeat(m.length));
  const hits = [];
  for (const m of src.matchAll(P_TOKEN)) {
    if (!negated(src, m.index, m[0].length)) hits.push({ severity: `P${m[1]}`, index: m.index, length: m[0].length });
  }
  const p0 = hits.find((h) => h.severity === 'P0');
  if (p0) return p0;
  const word = P0_WORDS.exec(src);
  if (word && !negated(src, word.index, word[0].length)) return { severity: 'P0', index: word.index, length: word[0].length };
  return hits[0] ?? null;
}

function parseProblem(body) {
  let text = body.trim();
  let severity = null;
  let stamp = null;
  let time = null;
  let timeEnd = null;
  const sev = findSeverity(text);
  if (sev) {
    severity = sev.severity;
    // Drop the tag and what decorates it ("**[P0]**", "(P0)", "Severity: P0 —") so the text reads clean.
    const left = text.slice(0, sev.index).replace(/(?:\b(?:severity|sev|priority|prio)\s*[:=]\s*)?(?:\*\*|__|[*_])?[[(]?\s*$/i, '');
    const right = text.slice(sev.index + sev.length).replace(/^\s*[\])]?(?:\*\*|__|[*_])?\s*[:\-–—]?\s*/, '');
    text = `${left} ${right}`.trim();
  }
  const tre = new RegExp(String.raw`^\[?\s*(${TIME_TOKEN})(?:\s*(?:–|—|-|to)\s*(${TIME_TOKEN}))?\s*\]?\s*[:\-–—]?\s*`, 'i');
  let tm = text.match(tre);
  if (!tm) {
    const inner = new RegExp(String.raw`\[\s*(${TIME_TOKEN})(?:\s*(?:–|—|-|to)\s*(${TIME_TOKEN}))?\s*\]`, 'i');
    tm = text.match(inner);
  }
  if (tm) {
    stamp = tm[2] ? `${tm[1]}–${tm[2]}` : tm[1];
    time = parseTime(tm[1]);
    timeEnd = tm[2] ? parseTime(tm[2]) : null;
    text = (text.slice(0, tm.index) + ' ' + text.slice(tm.index + tm[0].length)).trim();
  }
  return { severity, time, timeEnd, stamp, text: text.replace(/ {2,}/g, ' ') };
}

function parseScores(str, round) {
  const re = /([A-Za-z][\w\- ]*?)\s*[=:]\s*([^\s,;]+)/g;
  let m;
  let found = 0;
  while ((m = re.exec(str))) {
    const axis = normAxis(m[1]);
    if (!axis || axis === 'scores') continue;
    found++;
    const raw = m[2].replace(/\*+/g, '');
    const v = raw.toLowerCase();
    if (v === 'na' || v === 'n/a' || v === 'n.a.') { round.scores[axis] = 'na'; continue; }
    const num = raw.match(/^(-?\d+(?:\.\d+)?)(?:\/10)?$/);
    if (num && Number(num[1]) >= 0 && Number(num[1]) <= 10) round.scores[axis] = Number(num[1]);
    else if (!round.unscored.includes(axis)) round.unscored.push(axis);
  }
  return found;
}

// Section labels: "SCORES: ...", "**PROBLEMS:**", "Open problems:", "ISSUES:", "FIXES:", or the bare word alone on its
// line; a markdown heading with the same name ("### Problems") opens the section too.
const LABEL_RE = /^\s*(?:[-*]\s*)?\**\s*(SCORES?|(?:OPEN\s+)?PROBLEMS?|(?:OPEN\s+)?ISSUES?|FIXES|FIXED|NOTES?)\s*\**\s*(?::\s*\**\s*(.*)|$)/i;
const HEADING_RE = /^\s{0,3}#{1,6}(?:\s+(.*?))?\s*#*\s*$/;
const sectionOf = (word) => {
  const w = word.toUpperCase();
  if (w.startsWith('SCORE')) return 'SCORES';
  if (/PROBLEM|ISSUE/.test(w)) return 'PROBLEMS';
  return w.startsWith('FIX') ? 'FIXES' : 'NOTES';
};
const NONE_RE = /^(?:none|n\/?a|nil|-|no (?:open )?(?:problems?|issues?))\.?$/i;
const TABLE_HEAD = /^(?:#|no\.?|n|id|severity|sev|priority|prio|time|when|timestamp|at|problem|issue|description|text|where|what|evidence)$/i;

/** One PROBLEMS line -> { id, body } (a list item or a table row), 'skip' (table rule/header), or null (plain text). */
function problemItem(line) {
  const li = line.match(/^\s*(?:(\d+)[.)]\s*|[-*+]\s+)(.*)$/);
  if (li) return { id: li[1] ? Number(li[1]) : null, body: li[2] };
  if (!/^\s*\|/.test(line)) return null;
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  if (cells.every((c) => !c || /^:?-{2,}:?$/.test(c) || TABLE_HEAD.test(c))) return 'skip';
  let id = null;
  if (/^#?\d+$/.test(cells[0])) { id = Number(cells[0].replace('#', '')); cells.shift(); }
  return { id, body: cells.filter(Boolean).join(' ') };
}

function addProblem(round, body, id) {
  const p = parseProblem(body);
  // Not enumerable: the parsed shape stays { severity, time, timeEnd, stamp, text }; gate.mjs needs both to match a
  // problem to a "3. fixed" line and to re-read a continuation line.
  Object.defineProperty(p, 'id', { value: id ?? round.problems.length + 1, enumerable: false });
  Object.defineProperty(p, 'raw', { value: body, enumerable: false, writable: true });
  round.problems.push(p);
}

/**
 * Parse a review log into rounds. Fenced code blocks and HTML comments are ignored, so a template that shows the
 * block format inside ``` fences never counts as a round. Fail-closed: a P0 anywhere in a problem line counts, and
 * a P0 mentioned outside PROBLEMS (notes, an unrecognised label, loose text under the round heading) is kept in
 * round.stray so checkGate can refuse it instead of silently passing.
 * @returns {{ n:number, title:string, format:string|null, line:number, scores:Object, unscored:string[],
 *             problems:{severity:'P0'|'P1'|'P2'|null, time:number|null, timeEnd:number|null, stamp:string|null, text:string}[],
 *             fixes:string, stray:{line:number, text:string}[] }[]}
 */
export function parseReviewLog(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, '')).split(/\r?\n/);
  const rounds = [];
  let cur = null;
  let section = null;
  let fence = null;
  const stray = (line, idx) => {
    const sev = findSeverity(line);
    if (sev?.severity === 'P0') cur.stray.push({ line: idx + 1, text: line.trim().slice(0, 160) });
  };
  lines.forEach((raw, idx) => {
    const line = raw.replace(/\s+$/, '');
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const h = line.match(/^\s{0,3}#{1,4}\s*Round\s+(\d+)\b\s*(.*)$/i);
    if (h) {
      const title = h[2].replace(/^\s*[—–\-:·|]+\s*/, '').trim();
      const first = title.split(SEP)[0]?.trim() || '';
      cur = { n: Number(h[1]), title, format: FORMAT_RE.test(first) ? first.toLowerCase() : null, line: idx + 1, scores: {}, unscored: [], problems: [], fixes: '', stray: [] };
      rounds.push(cur);
      section = null;
      return;
    }
    if (!cur) return;
    const head = line.match(HEADING_RE);
    if (head) { // another heading ends the round's sections; "### Problems" starts one
      const name = (head[1] ?? '').replace(/[*_:]/g, '').trim();
      section = /^(?:scores?|(?:open\s+)?problems?|(?:open\s+)?issues?|fix(?:es|ed)|notes?)$/i.test(name) ? sectionOf(name) : null;
      return;
    }
    const lab = line.match(LABEL_RE);
    if (lab) {
      section = sectionOf(lab[1]);
      const rest = (lab[2] || '').trim();
      if (section === 'SCORES' && rest) parseScores(rest, cur);
      else if (section === 'PROBLEMS' && rest && !NONE_RE.test(rest)) {
        const item = problemItem(rest);
        if (item && item !== 'skip') addProblem(cur, item.body, item.id);
        else if (!item) addProblem(cur, rest, null);
      } else if (section === 'FIXES' && rest) cur.fixes = rest;
      else if (section === 'NOTES' && rest) stray(rest, idx);
      return;
    }
    if (!line.trim()) return;
    if (section === 'PROBLEMS') {
      const item = problemItem(line);
      if (item === 'skip' || NONE_RE.test(line.trim())) return;
      if (item) addProblem(cur, item.body, item.id);
      else if (cur.problems.length) { // continuation: the severity may sit on the second line
        const last = cur.problems[cur.problems.length - 1];
        last.raw += ' ' + line.trim();
        Object.assign(last, parseProblem(last.raw));
      } else addProblem(cur, line.trim(), null);
    } else if (section === 'FIXES') cur.fixes = (cur.fixes ? cur.fixes + '\n' : '') + line.trim();
    else {
      if (section === 'SCORES') parseScores(line, cur);
      stray(line, idx);
    }
  });
  return rounds;
}

/**
 * Problem numbers a round's FIXES block closes. The only accepted form is one statement per problem, number first and
 * the status word right after it: "1. fixed ...", "#2 resolved ...", "problem 3: wontfix ...", "- 4) won't fix ...",
 * also several on one line separated by ";" or ",". "not fixed", "fix planned" and free prose close nothing.
 */
export function closedProblemIds(fixes) {
  const done = new Set();
  const re = /^\s*(?:[-*+]\s*)?(?:(?:problem|issue|item|p0)\s*)?#?(\d+)\s*[.):,\-–—]?\s*[[(]?\s*(?:fixed|resolved|wont[\s-]?fix|won['’]t[\s-]?fix)\b/i;
  for (const seg of String(fixes ?? '').split(/\n|;|,\s*(?=(?:problem|issue|item|p0)?\s*#?\d+\s*[.):,\-–—]?\s*[[(]?\s*(?:fixed|resolved|wont|won['’]t))/i)) {
    const m = seg.match(re);
    if (m) done.add(Number(m[1]));
  }
  return done;
}

function readGateConfig(root, cfg) {
  let gate = cfg && typeof cfg === 'object' ? cfg.gate : undefined;
  if (gate === undefined && root) {
    try { gate = JSON.parse(fs.readFileSync(path.join(root, 'studio.json'), 'utf8')).gate; } catch { gate = undefined; }
  }
  const g = { ...GATE_DEFAULTS, ...(gate && typeof gate === 'object' ? gate : {}) };
  if (!Array.isArray(g.axes) || !g.axes.length) g.axes = GATE_DEFAULTS.axes;
  g.axes = g.axes.map(normAxis);
  // A malformed list falls back to the default, never to "any axis may be na".
  g.naAllowed = Array.isArray(g.naAllowed) && g.naAllowed.every((a) => typeof a === 'string') ? [...new Set(g.naAllowed.map(normAxis))] : GATE_DEFAULTS.naAllowed;
  g.minScore = Number.isFinite(Number(g.minScore)) ? Number(g.minScore) : GATE_DEFAULTS.minScore;
  g.minRounds = Number.isFinite(Number(g.minRounds)) ? Number(g.minRounds) : GATE_DEFAULTS.minRounds;
  g.requireFormats = g.requireFormats === true;
  return g;
}

/** The studio.json formats the gate asks for under requireFormats: cfg.formats, else the file's, else none. */
function formatsOf(root, cfg) {
  let f = cfg && Array.isArray(cfg.formats) ? cfg.formats : undefined;
  if (f === undefined && root) { try { f = JSON.parse(fs.readFileSync(path.join(root, 'studio.json'), 'utf8')).formats; } catch { f = undefined; } }
  return Array.isArray(f) ? f.filter((x) => typeof x === 'string' && FORMAT_RE.test(x)) : [];
}

/** Why one round does not pass on its own (scores for every axis, minScore, na only where allowed, no open P0); [] = it passes. */
function judgeRound(round, g) {
  const reasons = [];
  const tag = `round ${round.n}`;
  const missing = g.axes.filter((a) => !(a in round.scores));
  if (missing.length) reasons.push(`${tag}: no score for ${missing.join(', ')}${round.unscored.length ? ` (unfilled: ${round.unscored.join(', ')})` : ''}`);
  const low = Object.entries(round.scores).filter(([, v]) => typeof v === 'number' && v < g.minScore);
  if (low.length) reasons.push(`${tag}: below ${g.minScore}: ${low.map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const naBad = Object.keys(round.scores).filter((k) => round.scores[k] === 'na' && !g.naAllowed.includes(k));
  if (naBad.length) {
    reasons.push(`${tag}: na not allowed for ${naBad.join(', ')} (gate.naAllowed: ${g.naAllowed.length ? g.naAllowed.join(', ') : 'none'}); score 1-10` +
      (naBad.includes('sound') ? ' (a film that ships with audio needs a sound score: review the mixed render with critique --video)' : ''));
  }
  // Fail closed: every P0 in the round is open unless its FIXES line says "<n>. fixed|resolved|wontfix ...".
  const closed = closedProblemIds(round.fixes);
  const open = round.problems.filter((p) => p.severity === 'P0' && !closed.has(p.id));
  if (open.length) reasons.push(`${tag}: ${open.length} open P0: ${open.map((p) => `${p.id}. ${p.stamp ? `[${p.stamp}] ` : ''}${p.text}`).join(' | ').slice(0, 300)} (close one only with a FIXES line "${open[0].id}. fixed: ..." or "wontfix")`);
  const loose = round.stray ?? [];
  if (loose.length) reasons.push(`${tag}: P0 mentioned outside PROBLEMS (line ${loose[0].line}: "${loose[0].text.slice(0, 80)}"${loose.length > 1 ? ` and ${loose.length - 1} more` : ''}); list it under PROBLEMS: as "N. [P0] [mm:ss.cc] ..." and close it in FIXES, or reword the line`);
  return reasons;
}

/**
 * Gate status for a project. `cfg` is the loaded studio config (studio.json is read when it is omitted).
 * Pass = gate disabled, or ≥ minRounds scored rounds, the last round scores every gate axis, every numeric score
 * ≥ minScore, every `na` sits on an axis in gate.naAllowed (default: brand), and the last round lists no P0.
 * Only the LAST round is judged, unless gate.requireFormats is true: then every format in studio.json formats also needs a
 * logged round (heading format token) and the LATEST round of that format must pass the same per-round checks (an earlier pass does not cover a later regression). `formats` in the result says which rounds cover which format.
 * @returns {{ pass:boolean, reasons:string[], rounds:number, last:object|null, enabled:boolean, minScore:number,
 *             minRounds:number, axes:string[], naAllowed:string[], log:string|null }}
 */
export function checkGate(root, cfg) {
  const g = readGateConfig(root, cfg);
  const base = { enabled: g.enabled !== false, minScore: g.minScore, minRounds: g.minRounds, axes: g.axes, naAllowed: g.naAllowed, requireFormats: g.requireFormats, formats: { required: g.requireFormats } };
  const logPath = root ? path.join(root, 'docs', 'review_log.md') : null;
  let text = null;
  if (logPath) { try { text = fs.readFileSync(logPath, 'utf8'); } catch { text = null; } }
  const all = text == null ? [] : parseReviewLog(text);
  const scored = all.filter((r) => Object.keys(r.scores).length > 0);
  const last = all.length ? all[all.length - 1] : null;
  const out = { pass: false, reasons: [], rounds: scored.length, last, ...base, log: logPath && text != null ? 'docs/review_log.md' : null };
  if (g.enabled === false) {
    out.pass = true;
    out.reasons.push('gate disabled in studio.json (gate.enabled=false)');
    return out;
  }
  if (!root) { out.reasons.push('not inside a motion-studio project (no studio.json found)'); return out; }
  if (text == null) {
    out.reasons.push('docs/review_log.md not found: run the critique loop (node tools/critique.mjs) and log each round');
    return out;
  }
  if (scored.length < g.minRounds) out.reasons.push(`${scored.length} scored critique round(s) logged; at least ${g.minRounds} required`);
  if (!last) return out;
  out.reasons.push(...judgeRound(last, g));
  const closed = closedProblemIds(last.fixes);
  const p0 = last.problems.filter((p) => p.severity === 'P0');
  out.p0 = { open: p0.filter((p) => !closed.has(p.id)).length, closed: p0.filter((p) => closed.has(p.id)).length };
  if (g.requireFormats) {
    const formats = formatsOf(root, cfg);
    const covered = {};
    for (const f of formats) {
      const rounds = scored.filter((r) => r.format === f.toLowerCase());
      const ok = rounds.filter((r) => judgeRound(r, g).length === 0);
      const latest = rounds.length ? rounds[rounds.length - 1] : null;
      covered[f] = { rounds: rounds.map((r) => r.n), passing: ok.map((r) => r.n), latest: latest ? latest.n : null };
      if (!latest) out.reasons.push(`format ${f}: no logged round (gate.requireFormats=true needs a round headed "## Round <n> — ${f} — ..." for every format in studio.json formats: ${formats.join(', ')})`);
      // The LATEST round of a format decides: an earlier pass does not cover a later regression. The film's last round is already judged above.
      else if (latest !== last && !ok.includes(latest)) out.reasons.push(`format ${f}: latest round ${latest.n} does not pass (${judgeRound(latest, g)[0]}); an earlier passing round does not cover a later one`);
    }
    out.formats = { required: true, list: formats, covered };
  }
  out.pass = out.reasons.length === 0;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const USAGE = `Usage: node tools/gate.mjs [--json]

Checks docs/review_log.md against studio.json "gate" (minRounds, minScore, axes, naAllowed, requireFormats).
By default only the LAST round is judged (scores, na, open P0); the format in its heading is not looked at.
With gate.requireFormats=true every format in studio.json "formats" also needs a logged round (heading
"## Round <n> — <format> — ...") and the LATEST round of that format must pass on its own scores: turn it on when the brief ships several formats.
Exit 0 when the final render is allowed, 1 when it is not.

Open P0 rule (strict by default): any occurrence of the token P0 (case-insensitive, word boundary) in a problem
line of the LAST round counts as an open P0, however it is written: [P0], P0:, **P0**, (P0), "Severity: P0", a
trailing "(P0)", a table cell. [BLOCKER] / [CRITICAL] / SEV0 count as P0 too. Not counted: the template placeholder
[P0|P1|P2] and a mention that says there is none ("no P0", "P0: 0"). A P0 written outside PROBLEMS (notes, loose text
under the round heading) fails the gate as well. Problem sections: PROBLEMS: / PROBLEM: / ISSUES: / Open problems:
or a heading of that name; items are numbered or bulleted lines or table rows.
A P0 is closed only by a line in the same round's FIXES block that starts with its number and the word fixed,
resolved or wontfix, for example "FIXES:" then "1. fixed: frame 0 now shows the headline". "not fixed", "will fix" and
prose without the number close nothing.

Options:
  --json      print one JSON result line on stdout (a failure prints {"ok":false,"error":"..."} instead)
  -h, --help  show this help
`;

// --json follows studio.mjs#wantsJson and main(): the last of --json / --json=<bool> / --no-json wins. Kept local because
// hooks import this module and it must not load studio.mjs. A failure prints the one-line envelope {"ok":false,"error"}
// on stdout when --json is on; the human message always goes to stderr and the exit code is the caller's.
function jsonFlag(tok) {
  if (tok === '--json') return true;
  if (tok === '--no-json') return false;
  if (tok.startsWith('--json=')) return !['0', 'false', 'no', 'off'].includes(tok.slice(7).toLowerCase());
  return undefined;
}

function wantsJson(argv) {
  let on = false;
  for (const tok of argv) {
    if (tok === '--') break;
    const v = jsonFlag(tok);
    if (v !== undefined) on = v;
  }
  return on;
}

function fail(json, message, code, usage = '') {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.stderr.write(`error: ${message}\n${usage ? `\n${usage}` : ''}`);
  return code;
}

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'studio.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

async function cli(argv) {
  const json = wantsJson(argv);
  let onlyArgs = false; // after a bare `--` nothing is an option (and the gate takes no arguments)
  for (const a of argv) {
    if (!onlyArgs) {
      if (a === '--') { onlyArgs = true; continue; }
      if (a === '-h' || a === '--help') { process.stdout.write(USAGE); return 0; }
      if (jsonFlag(a) !== undefined) continue;
    }
    return fail(json, a.startsWith('-') && !onlyArgs ? `unknown option ${a}` : `unexpected argument ${a}`, 2, USAGE);
  }
  const root = findRoot(process.cwd());
  let cfg;
  if (root) {
    try {
      // Prefer the shared validating loader; fall back to raw studio.json so the gate still answers if it is absent.
      const studio = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'studio.mjs')).href);
      cfg = studio.loadConfig(root);
    } catch (err) {
      if (err && err.code !== 'ERR_MODULE_NOT_FOUND' && !/Cannot find module/.test(String(err.message))) return fail(json, String(err.message), 1);
      cfg = undefined;
    }
  }
  const r = checkGate(root, cfg);
  if (json) {
    process.stdout.write(JSON.stringify({ pass: r.pass, reasons: r.reasons, rounds: r.rounds, minRounds: r.minRounds, minScore: r.minScore, axes: r.axes, naAllowed: r.naAllowed, requireFormats: r.requireFormats, formats: r.formats, enabled: r.enabled, last: r.last }) + '\n');
  } else {
    const lines = [];
    lines.push(`gate: ${r.pass ? 'PASS' : 'FAIL'}${r.enabled ? '' : ' (disabled)'}  rounds ${r.rounds}/${r.minRounds}  min score ${r.minScore}  na allowed: ${r.naAllowed.length ? r.naAllowed.join(', ') : 'none'}`);
    if (r.last) {
      const sc = r.axes.map((a) => `${a}=${r.last.scores[a] ?? '?'}`).join(' ');
      lines.push(`last: round ${r.last.n}${r.last.title ? ` (${r.last.title})` : ''}  ${sc}`);
      const counts = ['P0', 'P1', 'P2'].map((s) => `${s} ${r.last.problems.filter((p) => p.severity === s).length}`).join(' · ');
      lines.push(`problems: ${counts}${r.p0?.closed ? ` (${r.p0.closed} P0 closed in FIXES)` : ''}`);
    }
    if (r.formats?.required && r.formats.list) lines.push(`formats (gate.requireFormats): ${r.formats.list.map((f) => `${f} ${r.formats.covered[f].passing.length ? `ok (round ${r.formats.covered[f].passing.join(', ')})` : r.formats.covered[f].rounds.length ? 'no passing round' : 'no round'}`).join(' · ')}`);
    for (const reason of r.reasons) lines.push(`  - ${reason}`);
    if (!r.pass) lines.push('next: node tools/critique.mjs, fix the 3 worst problems, append the round to docs/review_log.md, then re-run the gate.');
    process.stdout.write(lines.join('\n') + '\n');
  }
  return r.pass ? 0 : 1;
}

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  const norm = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* keep the resolved path */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  try { return norm(process.argv[1]) === norm(fileURLToPath(metaUrl)); } catch { return false; }
}

if (isMainModule(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.exitCode = fail(wantsJson(process.argv.slice(2)), String(err?.message ?? err), 1);
    if (process.env.DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
  });
}
