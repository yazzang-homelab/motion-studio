// Flow analyses for lint.mjs, split out so the rule tables and the tokenizer stay readable:
//   1. URL taint: a remote URL held in a constant, array or property and loaded later (rule no-remote-fetch)
//   2. shared-rng: an RNG stream created outside the function that consumes it (rule shared-rng)
// Both read the masked code view lint.mjs builds (comments, strings and regexes blanked, offsets kept) and report
// through add(rule, index). lint.mjs is the only importer; this file must stay import-free and side-effect-free,
// because the plugin's PostToolUse hook imports lint.mjs#lintSource on every edit.

export const URL_START = /^\s*(?:(?:https?|wss?):)?\/\/[^\s/]/i;
export const REMOTE_ANYWHERE = /fonts\.googleapis\.com|fonts\.gstatic\.com|url\(\s*['"]?\s*(?:https?:)?\/\/|@import\s+(?:url\()?\s*['"]?\s*(?:https?:)?\/\//i;
// The call or assignment a value flows into: fetch/import/loaders (loadImage, loadAsset, load, preload*), constructors that
// open a connection, .src/.href/... assignments and `src:` properties.
export const LOAD_CONTEXT = /(?:(?<![\w$])(?:fetch|import|importScripts|loadFonts?|sendBeacon|createImageBitmap|load(?:[A-Z_$][\w$]*)?|preload(?:[A-Z_$][\w$]*)?)|\bnew\s+(?:Worker|SharedWorker|EventSource|WebSocket|FontFace|Audio|Request)|\.\s*open)\s*\(\s*[^()]*$|(?<![\w$])(?:from|import)\s*$|\.\s*(?:src|href|srcset|poster|data)\s*=\s*$|(?<![\w$])(?:src|href|srcset|poster)\s*:\s*$/;

const reEsc = (name) => name.replace(/[$]/g, '\\$&'); // identifiers only need their $ escaped

/**
 * The code just before a string or identifier, with wrappers peeled off so the load call is what ends the text:
 * `fetch(new URL(` -> `fetch(`, `img.src = base + ` -> `img.src =`, `img.src = (` -> `img.src =`.
 */
export function contextBefore(code, index) {
  let before = code.slice(Math.max(0, index - 240), index).trimEnd();
  // Every peel below ends on "(" or "+", so a text ending in anything else (nearly every string in a film) returns at once;
  // the regexes only ever see the tail (an unanchored scan over 240 characters per string is quadratic on a big file).
  for (let i = 0; i < 8; i++) {
    const last = before.charCodeAt(before.length - 1);
    if (last !== 40 /* ( */ && last !== 43 /* + */) break;
    const tail = before.slice(-80);
    const next = tail
      .replace(/\bnew\s+URL\s*\($/, '')
      .replace(/(=\s*)\(+$/, '$1')
      .replace(/(?:[\w$.\])]+|\s{2,})?\s*\+$/, '') // an operand and its +: the value still flows into the same place
      .trimEnd();
    if (next === tail) break;
    before = (before.slice(0, before.length - tail.length) + next).trimEnd();
  }
  return before;
}

/** Index of the innermost bracket around `index` in `code` (one of ( [ {), or -1; looks at most `maxBack` characters back. */
function enclosing(code, index, maxBack = Infinity) {
  let depth = 0;
  for (let i = index - 1, stop = Math.max(-1, index - 1 - maxBack); i > stop; i--) {
    const c = code[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') { if (depth === 0) return i; depth--; }
  }
  return -1;
}

/** Start of the member chain that ends at `index` (a '.' or identifier): ASSETS.hero.src, cfg.images[i].url. */
function chainStart(code, index) {
  let i = index;
  for (let guard = 0; guard < 64; guard++) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    if (j < 0) return i;
    if (code[j] === ']') { const open = enclosing(code, j); if (open < 0 || code[open] !== '[') return i; i = open; continue; }
    if (/[\w$]/.test(code[j])) {
      let k = j;
      while (k >= 0 && /[\w$]/.test(code[k])) k--;
      i = k + 1;
      let d = k;
      while (d >= 0 && /\s/.test(code[d])) d--;
      if (code[d] === '.') { i = d; continue; }
      return i;
    }
    return i;
  }
  return i;
}

/**
 * Names a remote URL literal is bound to: `const LOGO = 'https://…'`, `const URLS = ['https://…']`, `{ logo: 'https://…' }`.
 * A name (identifier) is tainted when the literal sits directly in it or in an array assigned to it; an object only taints
 * its property key (`brand.url` drawn as text must not make `brand.logo` a remote load) and is remembered as a container:
 * `ASSETS[key]` with a computed key may reach any of its URLs, so an indexed read in a load position counts.
 */
function bindingsOf(code, at) {
  const names = [];
  const props = [];
  const containers = [];
  let p = at;
  let viaObject = false;
  for (let hop = 0; hop < 8 && p >= 0; hop++) {
    const before = contextBefore(code, p);
    let m = before.match(/((?:[A-Za-z_$][\w$]*\s*\.\s*)*)([A-Za-z_$][\w$]*)\s*=\s*$/);
    if (m) { (m[1] ? props : viaObject ? containers : names).push(m[2]); break; } // `this.logo = …` binds a property
    m = before.match(/([A-Za-z_$][\w$]*)\s*:\s*$/);
    if (m) { props.push(m[1]); viaObject = true; }
    const open = /[[,{]$/.test(before) || m ? enclosing(code, p) : -1;
    if (open < 0 || code[open] === '(') break;
    if (code[open] === '{') viaObject = true;
    p = open;
  }
  return { names, props, containers };
}

/** Identifiers that carry a remote URL: bound directly, through aliases (`const u = LOGO`, destructuring, for…of, forEach). */
function taintedNames(code, strings) {
  const names = new Set();
  const props = new Set();
  const containers = new Set();
  for (const s of strings) {
    if (!URL_START.test(s.value) || REMOTE_ANYWHERE.test(s.value)) continue;
    const b = bindingsOf(code, (s.origin ?? s.start) - 1);
    b.names.forEach((n) => names.add(n));
    b.props.forEach((n) => props.add(n));
    b.containers.forEach((n) => containers.add(n));
  }
  for (let pass = 0; pass < 3 && names.size; pass++) {
    const before = names.size;
    for (const n of [...names]) {
      const ref = String.raw`(?<![\w$.])${reEsc(n)}(?![\w$])`;
      for (const m of code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?${ref}`, 'g'))) names.add(m[1]);
      for (const m of code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=\s*${ref}`, 'g'))) {
        for (const id of m[1].split(',')) { const alias = id.split(':').pop().split('=')[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(alias)) names.add(alias); }
      }
      for (const m of code.matchAll(new RegExp(String.raw`\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+[^)]*?${ref}`, 'g'))) names.add(m[1]);
      for (const m of code.matchAll(new RegExp(String.raw`${ref}\s*\.\s*(?:forEach|map|flatMap|filter|some|every|find)\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)`, 'g'))) names.add(m[1]);
    }
    if (names.size === before) break;
  }
  return { names, props, containers };
}

/** Reports every load of a remote URL that was bound to a name first (`const LOGO = 'https://…'; img.src = LOGO`). */
export function urlFlowProblems(code, strings, add) {
  const { names, props, containers } = taintedNames(code, strings);
  for (const n of names) {
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])${reEsc(n)}(?![\w$])`, 'g'))) {
      if (LOAD_CONTEXT.test(contextBefore(code, m.index))) add('no-remote-fetch', m.index);
    }
  }
  for (const n of containers) {
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])${reEsc(n)}\s*\[`, 'g'))) {
      if (LOAD_CONTEXT.test(contextBefore(code, m.index))) add('no-remote-fetch', m.index);
    }
  }
  for (const n of props) {
    for (const m of code.matchAll(new RegExp(String.raw`\.\s*${reEsc(n)}(?![\w$])`, 'g'))) {
      if (LOAD_CONTEXT.test(contextBefore(code, chainStart(code, m.index)))) add('no-remote-fetch', m.index);
    }
  }
}

// shared-rng heuristic: `const r = mulberry32(..)` / `rngFor(..)` declared in an outer scope (the module, a film factory) and
// consumed inside a function nested below it (a draw called per frame): every call advances the stream, so a value depends
// on how many frames were drawn before. A stream created in the draw itself is per frame; the same holds for a callback the
// iteration methods run at once (`Array.from({ length: 5 }, () => r())`, `.map`, `.forEach`) and for a private helper the
// function calls itself (`const f = () => r(); f();`). Function bodies are found from braces and arrows, no parser.
const ITERATOR_CALLEE = /(?:\.\s*(?:map|forEach|filter|reduce|reduceRight|flatMap|some|every|find|findIndex|findLast|findLastIndex|sort|toSorted)|\bArray\s*\.\s*from|\bnew\s+Promise)\s*$/;

/** Start of the parameter list of the arrow whose head ends at `end` (the char before `=>`): `(a, b)` or a bare `x`; -1 if none. */
function arrowHead(code, end) {
  let j = end;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (code[j] === ')') {
    let depth = 0;
    for (; j >= 0; j--) {
      if (code[j] === ')') depth++;
      else if (code[j] === '(') { depth--; if (depth === 0) return j; }
    }
    return -1;
  }
  let k = j;
  while (k >= 0 && /[\w$]/.test(code[k])) k--;
  return k < j ? k + 1 : -1;
}

/** Head start of the function whose body opens at the `{` at `i` (an arrow, `function`, or a method), or -1 for any other block. */
function braceFunctionHead(code, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (j >= 1 && code[j] === '>' && code[j - 1] === '=') return Math.max(0, arrowHead(code, j - 2));
  if (code[j] !== ')') return -1;
  let depth = 0;
  for (; j >= 0; j--) {
    if (code[j] === ')') depth++;
    else if (code[j] === '(') { depth--; if (depth === 0) break; }
  }
  if (j < 0) return -1;
  const head = code.slice(Math.max(0, j - 60), j);
  if (/\b(?:if|for|while|switch|catch|with)\s*$/.test(head)) return -1;
  if (/\bfunction\s*\*?\s*[\w$]*\s*$/.test(head)) return j;
  return /[\w$\]]\s*$/.test(head) ? j : -1; // method shorthand `draw(g) {` or `get x() {`
}

/** End of an expression-bodied arrow's body that starts at `from`: the first `,` `;` or unmatched closer, or a new statement line. */
function arrowBodyEnd(code, from) {
  const n = code.length;
  let depth = 0;
  for (let k = from; k < n; k++) {
    const c = code[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return k; depth--; }
    else if (depth === 0 && (c === ',' || c === ';')) return k;
    else if (depth === 0 && c === '\n' && /^\s*(?:const|let|var|function|return|export|import|if|for|while|class)\b/.test(code.slice(k + 1, k + 40))) return k;
  }
  return n;
}

/** Every function body in `code`: { head, from, to, name, exported, immediate, private }. */
function functionBodies(code) {
  const n = code.length;
  const fns = [];
  const stack = [];
  for (let i = 0; i < n; i++) {
    const c = code[i];
    if (c === '{') {
      const head = braceFunctionHead(code, i);
      const rec = head >= 0 ? { head, from: i + 1, to: n } : null;
      if (rec) fns.push(rec);
      stack.push(rec);
    } else if (c === '}') {
      const rec = stack.pop();
      if (rec) rec.to = i;
    } else if (c === '=' && code[i + 1] === '>') {
      let k = i + 2;
      while (k < n && /\s/.test(code[k])) k++;
      if (code[k] !== '{') fns.push({ head: Math.max(0, arrowHead(code, i - 1)), from: k, to: arrowBodyEnd(code, k) });
      i++;
    }
  }
  const named = [
    /\b(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?$/d,
    /\b(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\*?\s*[\w$]*\s*$/d,
    /\b(export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*$/d,
  ];
  for (const f of fns) {
    const start = Math.max(0, f.head - 100);
    const before = code.slice(start, f.head);
    f.name = null; f.exported = false; f.private = false;
    for (const re of named) {
      const m = re.exec(before);
      if (m) { f.name = m[2]; f.nameAt = start + m.indices[2][0]; f.exported = !!m[1]; break; }
    }
    // Immediate: the function itself (not something it returns) is an argument of an iteration call: `.map(`, `Array.from(x, `.
    const lead = /(?:\basync\s+)?(?:\bfunction\s*\*?\s*[\w$]*\s*)?$/.exec(before);
    let p = f.head - (lead ? lead[0].length : 0) - 1;
    while (p >= 0 && /\s/.test(code[p])) p--;
    const open = enclosing(code, f.head, 1500);
    f.immediate = (code[p] === '(' || code[p] === ',') && open >= 0 && code[open] === '(' && ITERATOR_CALLEE.test(code.slice(Math.max(0, open - 40), open));
  }
  return fns;
}

/** Reports each use of an RNG stream (`const r = rngFor(..)`) inside a function that runs later than the stream's declaration. */
export function sharedRng(code, add) {
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:mulberry32|rngFor)\s*\(/g;
  const decls = [];
  let m;
  while ((m = decl.exec(code))) decls.push({ name: m[1], index: m.index, end: m.index + m[0].length });
  if (!decls.length) return;
  const n = code.length;
  const fns = functionBodies(code);
  // level[i] = how many function bodies that run later (not at once) contain index i
  const levels = () => {
    const diff = new Int16Array(n + 2);
    for (const f of fns) if (!f.immediate && !f.private) { diff[f.from]++; diff[Math.min(f.to, n)]--; }
    for (let i = 1; i <= n; i++) diff[i] += diff[i - 1];
    return diff;
  };
  // A named helper whose every use is a direct call from the function that declares it runs inside that call.
  const first = levels();
  for (const f of fns) {
    if (!f.name || f.exported || f.immediate) continue;
    const re = new RegExp(String.raw`(?<![\w$.])${reEsc(f.name)}(?![\w$])`, 'g');
    let refs = 0;
    let onlyCalls = true;
    let r;
    while (onlyCalls && (r = re.exec(code))) {
      if (r.index === f.nameAt || (r.index >= f.from && r.index < f.to)) continue;
      refs++;
      if (!/^\s*\(/.test(code.slice(r.index + f.name.length, r.index + f.name.length + 12)) || first[r.index] !== first[f.head]) onlyCalls = false;
    }
    f.private = onlyCalls && refs > 0;
  }
  const level = levels();
  for (const d of decls) {
    let scope = null; // the innermost function around the declaration (else the whole file)
    for (const f of fns) if (f.from <= d.index && d.index < f.to && (!scope || f.from > scope.from)) scope = f;
    const to = scope ? scope.to : n;
    const base = level[d.index];
    const esc = reEsc(d.name);
    const use = new RegExp(String.raw`(?<![\w$.])${esc}\s*\(|\b(?:range|pick|shuffle)\s*\(\s*${esc}\b`, 'g');
    use.lastIndex = scope ? scope.from : 0;
    let u;
    while ((u = use.exec(code)) && u.index < to) {
      if (u.index >= d.index && u.index < d.end) continue;
      if (level[u.index] > base) add('shared-rng', u.index);
    }
  }
}
