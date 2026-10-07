// Determinism lint (template/tools/lint.mjs): rules, tokenizer (comments/strings/templates/regexes), pragmas, HTML/CSS,
// lintProject and the CLI. No network, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINT = path.join(HERE, '..', 'skills', 'studio-init', 'template', 'tools', 'lint.mjs');
// JS fixtures end in .js.txt so `node --test test/` never runs them as tests; lintSource gets the real name.
const FIX = path.join(HERE, 'fixtures', 'lint');
const { lintSource, lintProject, RULES } = await import(pathToFileURL(LINT).href);

const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const pairs = (problems) => problems.map((p) => `${p.line}:${p.rule}`).sort();
/** Expected `line:rule` pairs from `expect: rule[,rule]` markers in a fixture. */
const expected = (text) => text.split(/\r?\n/).flatMap((l, i) => {
  const m = l.match(/expect:\s*([\w,-]+)/);
  return m ? m[1].split(',').map((r) => `${i + 1}:${r}`) : [];
}).sort();

test('RULES: the contract ids and severities', () => {
  const errors = ['no-math-random', 'no-date', 'no-timers', 'no-raf', 'no-remote-fetch', 'no-infinite-repeat'];
  const warns = ['no-css-transition', 'no-will-change', 'no-random-uuid', 'shared-rng'];
  assert.deepEqual(Object.keys(RULES).sort(), [...errors, ...warns].sort());
  for (const id of errors) assert.equal(RULES[id].severity, 'error', id);
  for (const id of warns) assert.equal(RULES[id].severity, 'warn', id);
  for (const r of Object.values(RULES)) { assert.ok(r.message.length > 10); assert.ok(r.fix.length > 10); }
  assert.ok(Object.isFrozen(RULES));
});

test('dirty film: every marked line and nothing else', () => {
  const text = read('dirty-film.js.txt');
  const problems = lintSource(text, 'film/film.js');
  assert.deepEqual(pairs(problems), expected(text));
  for (const p of problems) {
    assert.equal(p.severity, RULES[p.rule].severity);
    assert.ok(p.col >= 1 && Number.isInteger(p.col));
    assert.equal(typeof p.fix, 'string');
  }
});

test('clean film: banned names inside comments, strings, templates and regexes are ignored', () => {
  assert.deepEqual(lintSource(read('clean-film.js.txt'), 'film/film.js'), []);
});

test('template literal expressions are code, template text is not', () => {
  assert.deepEqual(pairs(lintSource('const a = `x ${Math.random()} y`;\n', 'a.js')), ['1:no-math-random']);
  assert.deepEqual(lintSource('const a = `Math.random() ${n} Date.now()`;\n', 'a.js'), []);
  const nested = 'const s = `a ${`b ${Date.now()}`} c`;\nconst t = `${ {k: 1}.k } Math.random()`;\n';
  assert.deepEqual(pairs(lintSource(nested, 'a.js')), ['1:no-date']);
});

test('regex literal vs division', () => {
  assert.deepEqual(lintSource('const r = /setTimeout\\(/.test(s);\nconst q = a / b / Math.PI;\n', 'a.js'), []);
  assert.deepEqual(pairs(lintSource('const q = (a) / 2; Math.random();\n', 'a.js')), ['1:no-math-random']);
});

test('pragmas: line, next-line, file-level, studio-allow preview', () => {
  const text = read('pragmas.js.txt');
  assert.deepEqual(pairs(lintSource(text, 'lib/runtime.js')), expected(text));
});

test('no-remote-fetch only in load contexts', () => {
  const src = [
    "fetch('https://api.example/x');", // 1
    "import x from 'https://esm.sh/x';", // 2
    "const u = await import(`https://cdn.example/${name}.js`);", // 3
    "img.src = 'http://example.com/a.png';", // 4
    "const f = { family: 'X', src: 'https://fonts.gstatic.com/x.woff2' };", // 5
    "const brand = { url: 'https://acme.example' };", // 6: data, not a fetch
    "text(g, 'https://acme.example', 10, 10);", // 7: drawn text
    "fetch('audio/beats.json');", // 8: relative
    "const css = '@import url(https://fonts.googleapis.com/css2?family=Inter)';", // 9
  ].join('\n');
  assert.deepEqual(pairs(lintSource(src, 'film/film.js')), ['1:no-remote-fetch', '2:no-remote-fetch', '3:no-remote-fetch', '4:no-remote-fetch', '5:no-remote-fetch', '9:no-remote-fetch']);
});

test('shared-rng: outer streams consumed in nested functions warn; per-draw streams do not', () => {
  const src = [
    "import { mulberry32, rngFor, range } from '../lib/rng.js';",
    'const R = mulberry32(1);',
    'const once = R();', // module scope: evaluated once, deterministic
    'export function draw(g, t) {',
    '  const x = range(R, 0, 10);', // 5
    '  const own = rngFor("dot", 3);',
    '  if (t > 1) { g.fillRect(own(), 0, 1, 1); }', // nested block, same function: fine
    '  const f = () => R();', // 8: arrow body without braces
    '}',
  ].join('\n');
  assert.deepEqual(pairs(lintSource(src, 'film/film.js')), ['5:shared-rng', '8:shared-rng']);
});

// -- qa-tools:F6 ----------------------------------------------------------------------------------------------------------

/** Rules reported for a snippet, one entry per rule. */
const rulesOf = (src, file = 'film/film.js') => [...new Set(lintSource(src, file).map((p) => p.rule))];
const wrapDraw = (body) => `function draw(g, t) {\n const r = rngFor('x', 1);\n${body}\n}`;

test('shared-rng: a stream made inside the draw and read by a callback the same call runs is not shared', () => {
  const clean = {
    'Array.from': 'const pts = Array.from({ length: 5 }, () => r());',
    map: 'const a = [1, 2].map((k) => k + r());',
    'forEach, braces': '[1, 2].forEach((k) => { g.x = r(); });',
    'forEach, function expression': '[1, 2].forEach(function (k) { g.x = r(); });',
    reduce: 'const s = [1, 2].reduce((acc, k) => acc + r(), 0);',
    'sort comparator': '[3, 1].sort((a, b) => r() - 0.5);',
    'async map': 'await Promise.all([1, 2].map(async (k) => { g.x = r(); }));',
    'private helper': 'const f = () => r();\n f(); f();',
    'private function helper': 'function f() { return r(); }\n f();',
    'for loop': 'for (let i = 0; i < 5; i++) { const v = r(); }',
  };
  for (const [name, body] of Object.entries(clean)) assert.deepEqual(rulesOf(wrapDraw(body)), [], name);
  // the factory-scope precompute: the stream and its reader run once, at build time
  assert.deepEqual(rulesOf("export default function film(L) {\n const r = rngFor('x', 1);\n const offsets = [0, 1, 2].map(() => r());\n return { scenes: [] };\n}"), []);
  assert.deepEqual(rulesOf("export default defineFilm((L) => {\n const r = rngFor('x', 1);\n const offsets = [0, 1, 2].map(() => r());\n return { scenes: [scene(0, 1, 'a', (g) => { g.x = offsets[0]; })] };\n});"), []);
  // a one-line scene whose draw builds its own stream
  assert.deepEqual(rulesOf("scene(0, 2, 'x', (g, lt, c) => { const r = rngFor('x', 1); return [0, 1].map(() => r()); })"), []);
  // two draws that both call their stream `r`: each name binds to its own function
  assert.deepEqual(rulesOf("scene(0, 1, 'a', (g) => { const r = rngFor('a', 1); g.x = r(); });\nscene(1, 2, 'b', (g) => { const r = rngFor('b', 1); g.x = r(); });"), []);
  assert.deepEqual(rulesOf("const r = 5;\nfunction a() { const r = rngFor('x', 1); return r(); }\nfunction b() { const r = rngFor('y', 2); return [1].map(() => r()); }"), []);
  // module scope: evaluated once at load
  assert.deepEqual(rulesOf('const R = mulberry32(1);\nconst once = R();\nconst xs = [1, 2].map(() => R());'), []);
});

test('shared-rng: a stream that outlives the call still warns (module, factory, stored closure, draw property, method)', () => {
  const shared = {
    'module stream in draw': 'const R = mulberry32(1);\nexport function draw(g, t) { g.x = R(); }',
    'factory stream in a scene draw': "export default defineFilm((L) => {\n const r = rngFor('x', 1);\n return { scenes: [scene(0, 1, 'a', (g) => { g.x = r(); })] };\n});",
    'factory stream in an expression draw': "export default defineFilm((L) => {\n const r = rngFor('x', 1);\n return { scenes: [scene(0, 1, 'a', (g) => r())] };\n});",
    'factory helper called from the draw': "export default defineFilm((L) => {\n const r = rngFor('x', 1);\n const stars = (g) => { g.x = r(); };\n return { scenes: [scene(0, 1, 'a', (g) => { stars(g); })] };\n});",
    'factory helper passed as the draw': "export default defineFilm((L) => {\n const r = rngFor('x', 1);\n const stars = (g) => { g.x = r(); };\n return { scenes: [scene(0, 1, 'a', stars)] };\n});",
    'draw property': "export default defineFilm((L) => {\n const r = rngFor('x', 1);\n return { scenes: [scene({ from: 0, to: 1, name: 'a', draw: (g) => { g.x = r(); } })] };\n});",
    'method draw': 'const R = mulberry32(1);\nconst s = { draw(g) { g.x = R(); } };',
    'closure returned by a map callback': "function make(items) {\n const r = rngFor('x', 1);\n return items.map((it) => (g) => { g.x = r(); });\n}",
  };
  for (const [name, src] of Object.entries(shared)) assert.deepEqual(rulesOf(src), ['shared-rng'], name);
});

// -- qa-tools:F3 ----------------------------------------------------------------------------------------------------------

test('no-remote-fetch: a URL held in a constant, array, object or loader and used later is still a network load', () => {
  const remote = {
    'const then img.src': 'const LOGO = "https://cdn.example.com/logo.png";\nconst img = new Image();\nimg.src = LOGO;',
    'const + path': 'const CDN = "https://cdn.example.com/assets";\nimg.src = CDN + "/logo.png";',
    'const then fetch': 'const LOGO = "https://cdn.example.com/logo.png";\nawait fetch(LOGO);',
    'protocol-relative': 'const base = "//cdn.example.com/x";\nimg.src = base;',
    'object property': 'const o = { logo: "https://cdn.example.com/a.png" };\nimg.src = o.logo;',
    'object, computed key': "const ASSETS = { logo: 'https://cdn.example.com/a.png' };\nloadImage(ASSETS[k]);",
    'array iterated': 'const urls = ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"];\nfor (const u of urls) { const i = new Image(); i.src = u; }',
    'array forEach': 'const urls = ["https://cdn.example.com/a.png"];\nurls.forEach((u) => { new Image().src = u; });',
    alias: 'const LOGO = "https://cdn.example.com/logo.png";\nconst u = LOGO;\nfetch(u);',
    'own loader helper': "const load = (src) => new Promise((r) => { const i = new Image(); i.onload = r; i.src = src; });\nconst logo = await load('https://cdn.example.com/logo.png');",
    loadImage: 'loadImage("https://cdn.example.com/a.png");',
    'loadImage, //': 'loadImage("//cdn.example.com/a.png");',
    setAttribute: 'img.setAttribute("src", "https://cdn.example.com/a.png");',
    WebSocket: 'new WebSocket("wss://x.example.com/live");',
    'fetch(new URL())': 'fetch(new URL("https://cdn.example.com/a.png"));',
  };
  for (const [name, src] of Object.entries(remote)) assert.ok(rulesOf(src).includes('no-remote-fetch'), name);
  // the report points at the use, not the declaration
  const at = lintSource('const LOGO = "https://cdn.example.com/logo.png";\nconst img = new Image();\nimg.src = LOGO;', 'film/film.js');
  assert.deepEqual(at.map((p) => `${p.line}:${p.rule}`), ['3:no-remote-fetch']);
  // a URL drawn as text, kept as data or a relative path is not a load
  const local = [
    "const brand = { url: 'https://acme.example' };\ng.fillText(brand.url, 0, 0);",
    "text(g, 'https://acme.example', 10, 10);",
    "const URL_TEXT = 'https://acme.example';\ng.fillText(URL_TEXT, 0, 0);",
    "fetch('audio/beats.json');",
    "const ASSETS = { logo: 'assets/logo.png' };\nloadImage(ASSETS[k]);",
  ];
  for (const src of local) assert.deepEqual(rulesOf(src), [], src);
});

test('banned APIs behind window./globalThis., destructuring, brackets or an alias are still found', () => {
  const cases = {
    'new window.Date()': ['no-date', 'const t = new window.Date();'],
    'window.Date.now()': ['no-date', 'const t = window.Date.now();'],
    'globalThis.Date.now()': ['no-date', 'const t = globalThis.Date.now();'],
    'const { random } = Math': ['no-math-random', 'const { random } = Math;\nrandom();'],
    'Math["random"]()': ['no-math-random', 'const v = Math["random"]();'],
    'timer alias': ['no-timers', 'const st = setTimeout;\nst(f, 10);'],
    'el.style["transition"]': ['no-css-transition', 'el.style["transition"] = "all 1s";'],
  };
  for (const [name, [rule, src]] of Object.entries(cases)) assert.ok(rulesOf(src).includes(rule), name);
});

// -- qa-tools:F7 ----------------------------------------------------------------------------------------------------------

test('no-css-transition / no-will-change judge CSS, not on-screen copy or a film method called animate', () => {
  const copy = [
    "g.fillText('Transition: from A to B', 0, 0);",
    "const items = ['Transition: Fade', 'Animation: Spring'];",
    "const tags = ['will-change: transform'];",
    "g.fillText('transition: all 0.3s ease', 0, 0);",
    'mascot.animate(t);',
    'mascot.animate(t, 2);',
  ];
  for (const src of copy) assert.deepEqual(rulesOf(src), [], src);
  // the same declarations reaching a style sink are CSS
  const css = {
    cssText: "el.style.cssText = 'transition: opacity 0.3s';",
    'style attribute': "el.setAttribute('style', 'animation: spin 1s linear');",
    insertRule: "sheet.insertRule('@keyframes k { from { opacity: 0 } to { opacity: 1 } }');",
    innerHTML: "el.innerHTML = '<div style=\"transition: all 1s\">x</div>';",
    'template rule block': 'const css = `.a { transition: all 0.3s ease; }`;',
    'will-change in cssText': "el.style.cssText = 'will-change: transform';",
    'style.transition': "el.style.transition = 'opacity 0.3s';",
    'element.animate(keyframes)': 'el.animate([{ opacity: 0 }, { opacity: 1 }], 300);',
    'element.animate(x, options)': 'el.animate(frames, { duration: 300, easing: "ease" });',
  };
  for (const [name, src] of Object.entries(css)) assert.ok(rulesOf(src).some((r) => r === 'no-css-transition' || r === 'no-will-change'), name);
});

test('HTML: <link rel="canonical|alternate|author|license"> names a page and loads nothing; stylesheets, icons and preloads do', () => {
  const html = (tag) => rulesOf(`<!doctype html>\n<head>${tag}</head>`, 'index.html');
  for (const tag of ['<link rel="canonical" href="https://example.com/">', '<link href="https://e.com/x" rel="alternate">', "<link rel='author license' href='https://e.com/l'>", '<link rel=canonical href=https://e.com/>']) {
    assert.deepEqual(html(tag), [], tag);
  }
  for (const tag of ['<link rel="stylesheet" href="https://e.com/a.css">', '<link rel="alternate stylesheet" href="https://e.com/a.css">', '<link rel="icon" href="https://e.com/i.png">',
    '<link rel="preload" href="https://e.com/f.woff2" as="font">', '<link rel="preconnect" href="https://e.com">', '<link href="https://e.com/a.css">', '<script src="https://e.com/a.js"></script>']) {
    assert.deepEqual(html(tag), ['no-remote-fetch'], tag);
  }
});

test('HTML: inline module script, markup, <style> and style="" are linted with file line numbers', () => {
  assert.deepEqual(pairs(lintSource(read('index.html'), 'index.html')), [
    '10:no-css-transition', '10:no-infinite-repeat', '13:no-will-change', '14:no-remote-fetch', '18:no-math-random',
    '4:no-remote-fetch', '8:no-css-transition', '9:no-css-transition',
  ].sort());
});

test('CSS files', () => {
  assert.deepEqual(pairs(lintSource(read('styles.css'), 'film/look.css')), [
    '2:no-remote-fetch', '4:no-css-transition', '5:no-will-change', '6:no-css-transition', '6:no-infinite-repeat', '7:no-remote-fetch',
  ].sort());
});

test('CRLF, BOM, empty and unterminated input do not throw', () => {
  assert.deepEqual(pairs(lintSource('﻿const a = 1;\r\nconst b = Date.now();\r\n', 'a.js')), ['2:no-date']);
  assert.deepEqual(lintSource('', 'a.js'), []);
  assert.deepEqual(lintSource(undefined, 'a.js'), []);
  assert.doesNotThrow(() => lintSource('const s = `unterminated ${ Math.random() ', 'a.js'));
  assert.doesNotThrow(() => lintSource('/* open comment', 'a.css'));
  assert.doesNotThrow(() => lintSource('<script>let a = "x', 'index.html'));
});

test('lintProject: index.html + film/** + lib/**, skips node_modules, dot dirs and tools/', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lint-'));
  try {
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    put('studio.json', '{}');
    put('index.html', '<canvas id="stage"></canvas><script type="module">import f from "./film/film.js";</script>');
    put('film/film.js', 'export default 1;\nconst t = Date.now();\n');
    put('film/scenes/ch01_intro.js', 'export const a = Math.random();\n');
    put('lib/runtime.js', 'requestAnimationFrame(loop); // studio-allow preview\n');
    put('lib/node_modules/pkg/index.js', 'Math.random();\n');
    put('film/.cache/x.js', 'Math.random();\n');
    put('tools/render.mjs', 'const t0 = Date.now();\n');
    const r = lintProject(root);
    assert.deepEqual(r.files, ['index.html', 'film/film.js', 'film/scenes/ch01_intro.js', 'lib/runtime.js']);
    assert.deepEqual(r.problems.map((p) => `${p.file}:${p.line}:${p.rule}`), ['film/film.js:2:no-date', 'film/scenes/ch01_intro.js:1:no-math-random']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fast enough for a hook: a 3000-line file lints in well under a second', () => {
  const big = Array.from({ length: 100 }, () => read('clean-film.js.txt')).join('\n');
  lintSource(big, 'film/film.js'); // warm up the regexes
  const t0 = process.hrtime.bigint();
  const problems = lintSource(big, 'film/film.js');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(problems.length, 0);
  assert.ok(ms < 1000, `took ${ms.toFixed(1)} ms`);
  const t1 = process.hrtime.bigint();
  lintSource(read('dirty-film.js.txt'), 'film/film.js');
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 100);
});

const cli = (args, cwd = FIX) => spawnSync(process.execPath, [LINT, ...args], { cwd, encoding: 'utf8' });
const cliAsync = (args, cwd = FIX) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [LINT, ...args], { cwd, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('CLI: exit codes, --json, --help, unknown flag', () => {
  const dirty = cli(['dirty-film.js.txt', '--json']);
  assert.equal(dirty.status, 1);
  const lines = dirty.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  assert.equal(j.ok, false);
  assert.equal(j.errors, 11);
  assert.equal(j.warnings, 6);
  assert.ok(j.problems.every((p) => p.file === 'dirty-film.js.txt'));
  assert.equal(cli(['clean-film.js.txt']).status, 0);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node tools\/lint\.mjs/);
  const bad = cli(['--nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option --nope/);
  assert.equal(cli(['missing-file.js']).status, 1);
});

// A usage or runtime failure with --json prints exactly one {"ok":false,"error"} line (the human message stays on stderr,
// the exit code is unchanged), so a script that parses stdout never reads an empty string from a failed run.
test('CLI --json failures: one {"ok":false,"error"} line for a bad flag and for a run outside a project', async () => {
  const oneLine = (r) => {
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `stdout: ${JSON.stringify(r.stdout)}`);
    return JSON.parse(lines[0]);
  };
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lintcli-'));
  try {
    const outside = (() => { for (let d = path.dirname(bare); ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, 'studio.json'))) return false; if (path.dirname(d) === d) return true; } })();
    // Node start-up is slow on some machines, so the cases run side by side.
    const [bad, quiet, off, last, dash, none] = await Promise.all([
      cliAsync(['--nope', '--json']), cliAsync(['--nope']), cliAsync(['--json', '--no-json', '--nope']),
      cliAsync(['--json=false', '--nope', '--json=true']), cliAsync(['--json', '--', '-not-here.js']),
      outside ? cliAsync(['--json'], bare) : null,
    ]);
    assert.equal(bad.status, 2);
    assert.deepEqual(oneLine(bad), { ok: false, error: 'unknown option --nope' });
    assert.match(bad.stderr, /error: unknown option --nope[\s\S]*Usage: node tools\/lint\.mjs/);
    assert.equal(quiet.stdout, '', 'no envelope without --json');
    // --json=<bool> / --no-json: the last switch wins, as in every other tool.
    assert.equal(off.stdout, '');
    assert.equal(off.status, 2);
    assert.equal(oneLine(last).ok, false);
    // Everything after a bare -- is a file, so a path that starts with a dash is not an unknown option.
    assert.equal(dash.status, 1);
    assert.equal(oneLine(dash).problems[0].rule, 'read-error', 'a missing file stays a lint result, not an envelope');
    if (none) {
      assert.equal(none.status, 1);
      assert.deepEqual(oneLine(none), { ok: false, error: 'no studio.json found here or above; pass files or run inside a film project.' });
      assert.match(none.stderr, /error: no studio\.json found here or above/);
    }
  } finally { fs.rmSync(bare, { recursive: true, force: true }); }
});

// lint-flow.mjs holds the URL-taint and shared-rng analyses. lint.mjs stays the hook's entry point (lintSource) and imports
// the sibling by a relative path, so the pair works from the plugin copy and from a scaffolded project alike.
test('lint.mjs + lint-flow.mjs: split by a relative import, lint.mjs stays under 600 lines, the pair is self-contained', async () => {
  const TOOLS = path.dirname(LINT);
  const lines = (f) => fs.readFileSync(f, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/).length;
  assert.ok(lines(LINT) < 600, `lint.mjs has ${lines(LINT)} lines`);
  const main = fs.readFileSync(LINT, 'utf8');
  const flowFile = path.join(TOOLS, 'lint-flow.mjs');
  const flowSrc = fs.readFileSync(flowFile, 'utf8');
  assert.match(main, /from '\.\/lint-flow\.mjs'/);
  // The hook imports lint.mjs on every edit: node built-ins and the sibling only, never studio.mjs or a dependency.
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = [...code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(specs.sort(), ['./lint-flow.mjs', 'node:fs', 'node:path', 'node:url']);
  assert.doesNotMatch(code, /studio\.mjs|\bimport\s*\(/, 'no lazy import either');
  assert.doesNotMatch(main, /function (taintedNames|bindingsOf|functionBodies|sharedRng)\b/, 'the analyses live in lint-flow.mjs');
  assert.doesNotMatch(flowSrc, /^\s*import\b/m, 'lint-flow.mjs imports nothing');
  assert.deepEqual(Object.keys(await import(pathToFileURL(flowFile).href)).sort(), ['LOAD_CONTEXT', 'REMOTE_ANYWHERE', 'URL_START', 'contextBefore', 'sharedRng', 'urlFlowProblems']);
  // The same result from a directory that holds only these two files (what a hook or a copied tools/ sees).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lintpair-'));
  try {
    for (const f of ['lint.mjs', 'lint-flow.mjs']) fs.copyFileSync(path.join(TOOLS, f), path.join(dir, f));
    const pair = await import(pathToFileURL(path.join(dir, 'lint.mjs')).href);
    for (const name of ['dirty-film.js.txt', 'clean-film.js.txt', 'index.html', 'styles.css']) {
      const file = name.replace(/\.txt$/, '');
      assert.deepEqual(pair.lintSource(read(name), file), lintSource(read(name), file), name);
    }
    // Both flow analyses reach lintSource through the split: a URL held in a constant, and an RNG stream shared by draws.
    const flow = pair.lintSource("const LOGO = 'https://cdn.example.com/x.png';\nconst r = rngFor('a');\nexport const draw = (g) => { img.src = LOGO; return r(); };\n", 'film/film.js');
    assert.deepEqual(flow.map((p) => `${p.line}:${p.rule}`).sort(), ['3:no-remote-fetch', '3:shared-rng']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('importing lint.mjs has no side effects (the hook imports it)', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(LINT).href)}); console.log(process.exitCode ?? 'unset');`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'unset');
});
