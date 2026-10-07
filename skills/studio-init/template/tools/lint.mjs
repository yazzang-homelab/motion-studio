#!/usr/bin/env node
// Determinism & house-rule lint for motion-studio films.
// Imported by the plugin's PostToolUse hook, so this module must stay dependency-free (Node built-ins and its sibling
// lint-flow.mjs only), side-effect-free on import and fast (a single file lints in a few ms).
//
// Rule ideas adapted from HyperFrames' determinism rules (heygen-com/hyperframes, Apache-2.0) and the
// course's render contract; this is an independent implementation.
//
//   node tools/lint.mjs [files...] [--json]      (no files = lint the whole project)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The flow analyses (URL taint, shared RNG streams) live in a sibling file; a relative import keeps the hook's
// `lint.mjs#lintSource` path working from the plugin copy and from a scaffolded project alike.
import { URL_START, REMOTE_ANYWHERE, LOAD_CONTEXT, contextBefore, urlFlowProblems, sharedRng } from './lint-flow.mjs';

export const RULES = Object.freeze({
  'no-math-random': { severity: 'error', message: 'Math.random() gives different pixels on every render.', fix: 'Use a seeded RNG per element: rngFor(name, i) from lib/rng.js.' },
  'no-date': { severity: 'error', message: 'Wall-clock time (Date.now / new Date / performance.now) makes a frame depend on when it was rendered.', fix: 'Derive everything from the seek time t; hard-code dates you want to show.' },
  'no-timers': { severity: 'error', message: 'Timers run on wall-clock time; seek(t) must paint synchronously.', fix: 'Compute the state for time t directly (spring(t - t0), track(t, keys)).' },
  'no-raf': { severity: 'error', message: 'requestAnimationFrame drives real-time playback, not seek(t) renders.', fix: 'Paint from seek(t); preview loops live only in lib/runtime.js lines marked // studio-allow preview.' },
  'no-remote-fetch': { severity: 'error', message: 'Remote URL loaded at render time (network makes renders slow, flaky and non-reproducible).', fix: 'Download the asset into assets/ (fonts: node tools/fonts.mjs add "Family:400,700") and reference it by relative path.' },
  'no-infinite-repeat': { severity: 'error', message: 'Infinite repeat (repeat: -1 / Infinity iterations) has no defined state at time t.', fix: 'Use a finite count or loopT(t, period) so every t maps to one state.' },
  'no-css-transition': { severity: 'warn', message: 'CSS transitions/animations and element.animate() run on the compositor clock, not seek(t).', fix: 'Set styles from t inside the scene draw (spring/track from lib/motion.js).' },
  'no-will-change': { severity: 'warn', message: 'will-change rasterizes the layer once, so scaled text turns blurry.', fix: 'Remove will-change; scale through the canvas transform instead.' },
  'no-random-uuid': { severity: 'warn', message: 'crypto.randomUUID / getRandomValues are random on every render.', fix: 'Derive ids from names or indices (hash32(name, i) from lib/rng.js).' },
  'shared-rng': { severity: 'warn', message: 'An RNG stream created outside this function is consumed per frame; draw order changes every value after it.', fix: 'Create the stream inside the draw from stable parts: const r = rngFor(name, i).' },
});

const RULE_IDS = Object.keys(RULES);

// ---------------------------------------------------------------------------------------------------------------
// Tokenizer: mask comments, strings, template text and regex literals with spaces (newlines kept) so rule regexes
// only see code, while string tokens are kept for the URL rule.

const REGEX_PREV_CHARS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function blank(chars, from, to) {
  for (let i = from; i < to; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
}

function scanJS(src) {
  const chars = src.split('');
  const strings = []; // { start, value, origin } (origin: where the enclosing template literal begins, else start)
  const comments = []; // { start, end, text }
  const n = src.length;
  const stack = []; // template-expression brace depths: { depth, origin }
  let i = 0;
  let lastSig = ''; // last significant code char
  let lastWord = '';
  const isIdent = (c) => /[\w$]/.test(c);

  // Template literal text from `open` (a backtick or the `}` closing ${...}) to the next `${` or closing backtick.
  function scanTemplate(open, origin = open + 1) {
    const chunkStart = open + 1;
    blank(chars, open, open + 1);
    i = open + 1;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') {
        strings.push({ start: chunkStart, value: src.slice(chunkStart, i), origin });
        blank(chars, chunkStart, i + 1);
        i++;
        lastSig = ')'; lastWord = '';
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        strings.push({ start: chunkStart, value: src.slice(chunkStart, i), origin });
        blank(chars, chunkStart, i + 2);
        i += 2;
        stack.push({ depth: 0, origin });
        lastSig = '{'; lastWord = '';
        return;
      }
      i++;
    }
    strings.push({ start: chunkStart, value: src.slice(chunkStart, n), origin });
    blank(chars, chunkStart, n);
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      comments.push({ start: i, end: j, text: src.slice(i + 2, j) });
      blank(chars, i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      comments.push({ start: i, end: j, text: src.slice(i + 2, Math.max(i + 2, j - 2)) });
      blank(chars, i, j);
      i = j;
      continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      strings.push({ start: i + 1, value: src.slice(i + 1, Math.min(j, n)), origin: i + 1 });
      blank(chars, i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      lastSig = ')'; lastWord = '';
      continue;
    }
    if (c === '`') { scanTemplate(i); continue; }
    if (c === '/') {
      const regexOk = lastSig === '' || REGEX_PREV_CHARS.has(lastSig) || (lastSig === 'w' && REGEX_PREV_WORDS.has(lastWord));
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n && src[j] !== '\n') {
          const cj = src[j];
          if (cj === '\\') { j += 2; continue; }
          if (cj === '[') inClass = true;
          else if (cj === ']') inClass = false;
          else if (cj === '/' && !inClass) { ok = true; break; }
          j++;
        }
        if (ok) {
          j++;
          while (j < n && /[a-z]/i.test(src[j])) j++;
          blank(chars, i, j);
          i = j;
          lastSig = ')'; lastWord = '';
          continue;
        }
      }
    }
    if (stack.length && (c === '{' || c === '}')) {
      if (c === '{') stack[stack.length - 1].depth++;
      else if (stack[stack.length - 1].depth === 0) {
        const { origin } = stack.pop();
        scanTemplate(i, origin); // the `}` closes ${...}: continue the template text after it
        continue;
      } else stack[stack.length - 1].depth--;
    }
    if (isIdent(c)) {
      let j = i;
      while (j < n && isIdent(src[j])) j++;
      lastWord = src.slice(i, j);
      lastSig = 'w';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) { lastSig = c; lastWord = ''; }
    i++;
  }

  return { code: chars.join(''), strings, comments };
}

// CSS: mask comments only (URLs live in strings and must stay visible).
function scanCSS(src) {
  const chars = src.split('');
  const comments = [];
  const re = /\/\*[\s\S]*?(?:\*\/|$)/g;
  let m;
  while ((m = re.exec(src))) {
    comments.push({ start: m.index, end: m.index + m[0].length, text: m[0].slice(2, m[0].endsWith('*/') ? -2 : undefined) });
    blank(chars, m.index, m.index + m[0].length);
    if (!m[0].length) re.lastIndex++;
  }
  return { code: chars.join(''), comments };
}

// HTML: split into a JS view (inline module/classic scripts), a CSS view (<style> + style="" attributes) and the
// tag markup (comments masked). Each view keeps the file's offsets, so line/col map directly.
function splitHTML(src) {
  const markup = src.split('');
  const jsView = src.replace(/[^\n\r]/g, ' ').split('');
  const cssView = jsView.slice();
  const comments = [];
  const cre = /<!--[\s\S]*?(?:-->|$)/g;
  let m;
  while ((m = cre.exec(src))) {
    comments.push({ start: m.index, end: m.index + m[0].length, text: m[0].slice(4, m[0].endsWith('-->') ? -3 : undefined) });
    blank(markup, m.index, m.index + m[0].length);
    if (!m[0].length) cre.lastIndex++;
  }
  const masked = markup.join('');
  const copy = (view, from, to) => { for (let k = from; k < to; k++) view[k] = src[k]; };
  const sre = /<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi;
  while ((m = sre.exec(masked))) {
    const attrs = m[1];
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    const jsType = !type || /^(module|text\/javascript|application\/javascript)$/i.test(type);
    const start = m.index + m[0].indexOf('>') + 1;
    const end = start + m[2].length;
    if (jsType) copy(jsView, start, end);
    blank(markup, start, end);
  }
  const yre = /<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi;
  while ((m = yre.exec(masked))) {
    const start = m.index + m[0].indexOf('>') + 1;
    copy(cssView, start, start + m[1].length);
    blank(markup, start, start + m[1].length);
  }
  const are = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  const markupNow = markup.join('');
  while ((m = are.exec(markupNow))) {
    const start = m.index + m[0].indexOf(m[1]) + 1;
    copy(cssView, start, start + (m[2] ?? m[3]).length);
  }
  return { js: jsView.join(''), css: cssView.join(''), markup: markup.join(''), comments };
}

// ---------------------------------------------------------------------------------------------------------------
// Rule matchers. Each returns [{ rule, index }].

const GLOBAL_PREFIX = String.raw`(?:(?:window|globalThis|self)\s*\.\s*)?`;
const JS_CODE_PATTERNS = [
  // Math.random, window.Math.random, and `const { random } = Math`
  ['no-math-random', new RegExp(String.raw`\bMath\s*\.\s*random\b|\{[^{}]*\brandom\b[^{}]*\}\s*=\s*${GLOBAL_PREFIX}Math\b`, 'g')],
  // new Date / Date.now / Date() with or without window. / globalThis., performance.now, and `const { now } = Date`
  ['no-date', new RegExp(String.raw`\bnew\s+${GLOBAL_PREFIX}Date\b|(?<![\w$.])${GLOBAL_PREFIX}Date\s*(?:\.\s*now\b|\()|\bperformance\s*\.\s*now\b|\{[^{}]*\bnow\b[^{}]*\}\s*=\s*${GLOBAL_PREFIX}(?:Date|performance)\b`, 'g')],
  // a timer call, or the timer function taken as a value (`const st = setTimeout; st(f)`)
  ['no-timers', new RegExp(String.raw`(?<![\w$])(?:setTimeout|setInterval|setImmediate|requestIdleCallback)\s*\(|(?:[=,(:]|\breturn)\s*${GLOBAL_PREFIX}(?:setTimeout|setInterval|setImmediate|requestIdleCallback)\s*(?=[;,)\]}]|$)`, 'gm')],
  ['no-raf', /(?<![\w$])(?:requestAnimationFrame|webkitRequestAnimationFrame|mozRequestAnimationFrame)\b/g],
  ['no-infinite-repeat', /\b(?:repeat|iterations|repeatCount|iterationCount)\s*[:=]\s*(?:-\s*1(?![\d.])|(?:Number\s*\.\s*POSITIVE_INFINITY|Infinity)\b)|\.\s*repeat\s*\(\s*-\s*1\s*\)/g],
  // element.animate(keyframes, options): a keyframes literal, or an options object; `mascot.animate(t)` is the film's own method
  ['no-css-transition', /\.\s*animate\s*\(\s*(?:[[{]|null\b)|\.\s*animate\s*\([^()\n]*,\s*\{\s*(?:duration|easing|fill|iterations|delay|direction|composite)\b|\.\s*style\s*\.\s*(?:transition|animation)\w*\s*=(?!=)|\bnew\s+(?:Animation|KeyframeEffect)\s*\(/g],
  ['no-will-change', /\.\s*style\s*\.\s*willChange\b|\bwillChange\s*:/g],
  ['no-random-uuid', /\bcrypto\s*\.\s*randomUUID\b|\bgetRandomValues\b/g],
];

const CSS_PATTERNS = [
  ['no-remote-fetch', /url\(\s*['"]?\s*(?:https?:)?\/\/|@import\s+(?:url\(\s*)?['"]?\s*(?:https?:)?\/\//gi],
  ['no-infinite-repeat', /animation-iteration-count\s*:\s*infinite\b|(?<![\w-])animation\s*:[^;{}]*\binfinite\b/gi],
  ['no-css-transition', /(?<![\w-])(?:transition|animation)(?:-[a-z-]+)?\s*:(?!:)|@keyframes\b/gi],
  ['no-will-change', /(?<![\w-])will-change\s*:/gi],
];

// CSS declarations inside a JS string are styles only where the string reaches a style sink (cssText, setAttribute('style'),
// insertRule, innerHTML) or is a rule block itself. On-screen copy such as fillText('Transition: Fade') or a code sample
// drawn as text is not CSS.
const CSS_IN_STRING = [
  ['no-css-transition', /(?:^|[;{\s"'])(?:transition|animation)(?:-[a-z-]+)?\s*:\s*[^;]+|@keyframes\b/i],
  ['no-will-change', /(?:^|[;{\s"'])will-change\s*:/i],
];
const CSS_SINK_BEFORE = /\bcssText\s*\+?=\s*$|\binsertRule\s*\(\s*$|\.\s*replace(?:Sync)?\s*\(\s*$|\b(?:innerHTML|outerHTML)\s*\+?=\s*$|\binsertAdjacentHTML\s*\(\s*,\s*$/;
const STYLE_ATTR_BEFORE = /\.\s*setAttribute\s*\(\s*['"]style['"]\s*,\s*$/;
const CSS_RULE_BLOCK = /\{[^{}]*\}/;

const SET_SRC_ATTR = /\.\s*setAttribute\s*\(\s*['"](?:src|href|srcset|poster|data|xlink:href)['"]\s*,\s*$/;
// receiver[ 'member' ] where the member is a banned API
const INDEXED_BANS = {
  Math: { random: 'no-math-random' }, Date: { now: 'no-date' }, performance: { now: 'no-date' },
  window: { setTimeout: 'no-timers', setInterval: 'no-timers', setImmediate: 'no-timers', requestIdleCallback: 'no-timers', requestAnimationFrame: 'no-raf' },
  crypto: { randomUUID: 'no-random-uuid', getRandomValues: 'no-random-uuid' },
};
INDEXED_BANS.globalThis = INDEXED_BANS.window;
INDEXED_BANS.self = INDEXED_BANS.window;
const STYLE_PROP = /^(?:(transition|animation)(?:-[a-z-]+)?|(will-?change))$/i;

function jsProblems(code, strings, add, raw = code) {
  for (const [rule, re] of JS_CODE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) add(rule, m.index);
  }
  for (const s of strings) {
    const v = s.value;
    const origin = s.origin ?? s.start;
    const before = contextBefore(code, origin - 1);
    if (REMOTE_ANYWHERE.test(v)) add('no-remote-fetch', s.start);
    else if (URL_START.test(v) && (LOAD_CONTEXT.test(before) || SET_SRC_ATTR.test(raw.slice(Math.max(0, origin - 120), origin - 1).trimEnd()))) add('no-remote-fetch', s.start);
    // CSS text: only where a string is used as a style; a rule block or @keyframes is a stylesheet wherever it goes
    const styled = CSS_SINK_BEFORE.test(before) || STYLE_ATTR_BEFORE.test(raw.slice(Math.max(0, origin - 120), origin - 1).trimEnd()) || CSS_RULE_BLOCK.test(v);
    for (const [rule, re] of CSS_IN_STRING) if ((styled || /@keyframes\b/i.test(v)) && re.test(v)) add(rule, s.start);
    // `receiver['member']` spellings of banned APIs, and style properties given by name
    const idx = before.endsWith('[') ? before.match(/([A-Za-z_$][\w$]*)\s*\[\s*$/) : null; // contextBefore trims the end, so only a "[" can match
    if (idx && INDEXED_BANS[idx[1]]?.[v]) add(INDEXED_BANS[idx[1]][v], s.start);
    const prop = STYLE_PROP.exec(v);
    if (prop && (/\.\s*style\s*\[\s*$/.test(before) || /\.\s*setProperty\s*\(\s*$/.test(before))) add(prop[1] ? 'no-css-transition' : 'no-will-change', s.start);
  }
  urlFlowProblems(code, strings, add);
  sharedRng(code, add);
}

function cssProblems(code, add) {
  for (const [rule, re] of CSS_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) add(rule, m.index);
  }
}

// <link rel> values that only name a related page: the browser never requests it, so a URL there is metadata, not a load.
const LINK_INERT_REL = new Set(['canonical', 'alternate', 'author', 'license', 'help', 'prev', 'previous', 'next', 'bookmark', 'search', 'me', 'tag', 'external', 'nofollow', 'noopener', 'noreferrer']);

function htmlMarkupProblems(markup, add) {
  const re = /<(link|script|img|source|video|audio|iframe|embed|track|object|image|use)\b[^>]*?\b(href|src|srcset|data|poster|xlink:href)\s*=\s*["']?\s*(?:https?:)?\/\/[^\s"'>]/gi;
  let m;
  while ((m = re.exec(markup))) {
    if (m[1].toLowerCase() === 'link') {
      const end = markup.indexOf('>', m.index);
      const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(markup.slice(m.index, end < 0 ? undefined : end));
      const tokens = rel ? (rel[1] ?? rel[2] ?? rel[3]).toLowerCase().split(/\s+/).filter(Boolean) : [];
      if (tokens.length && tokens.every((t) => LINK_INERT_REL.has(t))) continue; // <link rel="canonical" href="https://…">
    }
    add('no-remote-fetch', m.index);
  }
}


// ---------------------------------------------------------------------------------------------------------------
// Pragmas

function parseRuleList(rest) {
  const ids = [];
  for (const tok of rest.split(/[\s,]+/)) {
    if (!tok) continue;
    if (tok === '--' || tok.startsWith('--')) break;
    if (RULES[tok]) ids.push(tok);
    else break;
  }
  return ids.length ? ids : RULE_IDS;
}

function pragmas(comments, lineOf) {
  const fileOff = new Set();
  const lineOff = new Map(); // line -> Set(rule)
  const addLine = (line, ids) => {
    if (!lineOff.has(line)) lineOff.set(line, new Set());
    for (const id of ids) lineOff.get(line).add(id);
  };
  for (const c of comments) {
    const re = /studio-lint-disable(-next-line|-line)?(?![\w-])([^\n]*)/g;
    let m;
    while ((m = re.exec(c.text))) {
      const ids = parseRuleList(m[2].replace(/\*\/.*$/, '').replace(/-->.*$/, ''));
      if (!m[1]) ids.forEach((id) => fileOff.add(id));
      else if (m[1] === '-line') addLine(lineOf(c.start), ids);
      else addLine(lineOf(c.end) + 1, ids);
    }
  }
  return { fileOff, lineOff };
}

// ---------------------------------------------------------------------------------------------------------------

function kindOf(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.css') return 'css';
  return 'js';
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  return { starts, lineOf };
}

/** Lint one source text. `filename` picks the language (.html/.htm, .css, else JS). */
export function lintSource(text, filename = 'file.js') {
  const src = String(text ?? '').replace(/^﻿/, '');
  const { starts, lineOf } = lineIndex(src);
  const rawLines = src.split('\n');
  const hits = [];
  const add = (rule, index) => hits.push({ rule, index });
  let comments = [];
  const kind = kindOf(filename);
  if (kind === 'css') {
    const css = scanCSS(src);
    comments = css.comments;
    cssProblems(css.code, add);
  } else if (kind === 'html') {
    const h = splitHTML(src);
    const js = scanJS(h.js);
    const css = scanCSS(h.css);
    comments = [...h.comments, ...js.comments, ...css.comments];
    jsProblems(js.code, js.strings, add, h.js);
    cssProblems(css.code, add);
    htmlMarkupProblems(h.markup, add);
  } else {
    const js = scanJS(src);
    comments = js.comments;
    jsProblems(js.code, js.strings, add, src);
  }
  const { fileOff, lineOff } = pragmas(comments, lineOf);
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (fileOff.has(h.rule)) continue;
    const line = lineOf(h.index);
    if (/studio-allow preview/.test(rawLines[line - 1] || '')) continue;
    if (lineOff.get(line)?.has(h.rule)) continue;
    const key = `${h.rule}:${line}`;
    if (seen.has(key)) continue; // one report per rule per line
    seen.add(key);
    const r = RULES[h.rule];
    out.push({ rule: h.rule, severity: r.severity, line, col: h.index - starts[line - 1] + 1, message: r.message, fix: r.fix });
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col || a.rule.localeCompare(b.rule));
  return out;
}

const SCAN_EXT = new Set(['.js', '.mjs', '.css', '.html', '.htm']);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && SCAN_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
}

/** Lint index.html + film/** + lib/** of a project. Returns { files (relative, /), problems (with file) }. */
export function lintProject(root) {
  const abs = [];
  const index = path.join(root, 'index.html');
  if (fs.existsSync(index)) abs.push(index);
  walk(path.join(root, 'film'), abs);
  walk(path.join(root, 'lib'), abs);
  const files = [];
  const problems = [];
  for (const f of abs) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    files.push(rel);
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (err) {
      problems.push({ file: rel, rule: 'read-error', severity: 'error', line: 1, col: 1, message: String(err.message || err), fix: 'Check the file permissions.' });
      continue;
    }
    for (const p of lintSource(text, f)) problems.push({ file: rel, ...p });
  }
  return { files, problems };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI (only when run directly; importing this module never runs it)

const USAGE = `Usage: node tools/lint.mjs [files...] [--json]

Determinism and house-rule lint for index.html, film/** and lib/**.
With no files, lints the whole project (the nearest folder with studio.json).

Options:
  --json      print one JSON result line on stdout (a failure prints {"ok":false,"error":"..."} instead)
  -h, --help  show this help

Pragmas:
  // studio-lint-disable-line <rule>        this line
  // studio-lint-disable-next-line <rule>   the next line
  /* studio-lint-disable <rule> */          the whole file (no rule = all rules)
  ... // studio-allow preview               preview-only code in lib/runtime.js

Rules:
${RULE_IDS.map((id) => `  ${id.padEnd(20)} ${RULES[id].severity.padEnd(5)} ${RULES[id].message}`).join('\n')}
`;

function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'studio.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

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

function cli(argv) {
  const json = wantsJson(argv);
  try {
    return run(argv, json);
  } catch (err) {
    const code = fail(json, String(err?.message ?? err), 1);
    if (process.env.DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
    return code;
  }
}

function run(argv, json) {
  const files = [];
  let onlyFiles = false; // after a bare `--` every argument is a file, even one that starts with a dash
  for (const a of argv) {
    if (!onlyFiles) {
      if (a === '--') { onlyFiles = true; continue; }
      if (a === '-h' || a === '--help') { process.stdout.write(USAGE); return 0; }
      if (jsonFlag(a) !== undefined) continue;
      if (a.startsWith('-')) return fail(json, `unknown option ${a}`, 2, USAGE);
    }
    files.push(a);
  }
  let result;
  if (files.length) {
    const problems = [];
    for (const f of files) {
      const rel = f.split(path.sep).join('/');
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch (err) {
        problems.push({ file: rel, rule: 'read-error', severity: 'error', line: 1, col: 1, message: String(err.message || err), fix: 'Pass an existing file.' });
        continue;
      }
      for (const p of lintSource(text, f)) problems.push({ file: rel, ...p });
    }
    result = { root: null, files: files.map((f) => f.split(path.sep).join('/')), problems };
  } else {
    const root = findRoot(process.cwd());
    if (!root) return fail(json, 'no studio.json found here or above; pass files or run inside a film project.', 1);
    result = { root, ...lintProject(root) };
  }
  const errors = result.problems.filter((p) => p.severity === 'error').length;
  const warnings = result.problems.length - errors;
  if (json) {
    process.stdout.write(JSON.stringify({ ok: errors === 0, errors, warnings, files: result.files, problems: result.problems }) + '\n');
  } else {
    for (const p of result.problems) {
      process.stdout.write(`${p.file}:${p.line}:${p.col}  ${p.severity.padEnd(5)}  ${p.rule}  ${p.message}\n    fix: ${p.fix}\n`);
    }
    process.stdout.write(`${result.files.length} file(s): ${errors} error(s), ${warnings} warning(s)\n`);
  }
  return errors ? 1 : 0;
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
const isMain = isMainModule(import.meta.url);
if (isMain) process.exitCode = cli(process.argv.slice(2));
