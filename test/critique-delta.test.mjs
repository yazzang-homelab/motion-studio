// Critique: stepped films (critique.stepped / critique.popIgnore), the baseline delta between runs, the film hash that pins the
// evidence to a film version (--check-hash), and the determinism cache (--skip-determinism-repeat).
// The first half is browser-free; the last test runs the real CLI on a 4 s film in the headless shell.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const T_TOOLS = path.join(TEMPLATE, 'tools');
const imp = (name) => import(pathToFileURL(path.join(T_TOOLS, name)).href);

const made = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
const rmDir = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
after(() => { for (const d of made.splice(0)) { try { rmDir(d); } catch { /* the OS temp cleanup takes it */ } } });

/** 40x40 RGBA frames: a 2x2 dot creeping right; optional planted flicker (one frame) and jumps (a block that appears and stays). */
function synthFrames(N, { flickerAt = -1, blocks = [] } = {}) {
  const W = 40; const H = 40;
  const frames = [];
  for (let k = 0; k < N; k++) {
    const b = Buffer.alloc(W * H * 4);
    for (let i = 0; i < b.length; i += 4) { b[i] = 20; b[i + 1] = 20; b[i + 2] = 19; b[i + 3] = 255; }
    const rect = (x0, y0, w, h, v) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * W + x) * 4; b[i] = v; b[i + 1] = v; b[i + 2] = v; } };
    rect(2 + Math.floor(k / 3), 4, 2, 2, 240);
    if (k === flickerAt) rect(10, 20, 20, 20, 240);
    blocks.forEach((from, i) => { if (k >= from) rect(4 + i * 8, 30, 6, 6, 200); });
    frames.push(b);
  }
  return { frames, W, H };
}

async function analyze(crit, opts) {
  const { Analyzer, CRIT_DEFAULTS } = await imp('critique-metrics.mjs');
  const N = 120;
  const { frames, W, H } = synthFrames(N, opts);
  const an = new Analyzer({ fps: 30, frames: N, crit: { ...CRIT_DEFAULTS, ...crit } });
  frames.forEach((buf, k) => an.push(buf, k, W, H));
  return an.finish({ shots: [], cues: [], beats: [] });
}
const kinds = (list) => list.map((p) => `${p.kind}@${p.frame}`);

// ---------------------------------------------------------------------------------------------------------------
// Row 7: stepped films

test('stepped: jumps become info, a flicker stays a P1 finding, and metrics say what was held back', async () => {
  const { findings, CRIT_DEFAULTS } = await imp('critique-metrics.mjs');
  const opts = { flickerAt: 40, blocks: [70, 95] };
  const plain = await analyze({}, opts);
  assert.deepEqual(kinds(plain.pops.list), ['flicker@40', 'jump@70', 'jump@95']);
  assert.deepEqual(plain.pops.info, []);
  assert.equal(plain.pops.suppressed.stepped, false);
  assert.deepEqual(plain.pops.suppressed.why, []);

  const crit = { ...CRIT_DEFAULTS, stepped: true };
  const px = await analyze({ stepped: true }, opts);
  assert.deepEqual(kinds(px.pops.list), ['flicker@40']);
  assert.deepEqual(kinds(px.pops.info), ['jump@70', 'jump@95']);
  assert.deepEqual(px.pops.ignored, []);
  assert.equal(px.pops.suppressed.stepped, true);
  assert.equal(px.pops.suppressed.steppedJumps, 2);
  assert.match(px.pops.suppressed.why[0], /critique\.stepped = true: 2 hard-jump candidate\(s\).*flicker is still a P1/);
  const r = { film: { duration: 4, fps: 30 }, px, determinism: { skipped: true }, audio: { skipped: true }, loop: { enabled: false }, sync: { cues: 0, impactShare: null, offGrid: [], shotChanges: 0, shotChangesOnDownbeat: 0 } };
  const f = findings(r, crit).filter((x) => x.metric === 'pops');
  assert.deepEqual(f.map((x) => x.severity), ['P1'], 'no P2 hard-jump finding on a stepped film');
  assert.match(f[0].text, /single-frame pop at frame 40/);
});

test('popIgnore: candidates inside a span are suppressed (jump and flicker), others stay; the ignored list names the span', async () => {
  const px = await analyze({ popIgnore: [[2.2, 2.5], [1.3, 1.4]] }, { flickerAt: 40, blocks: [70, 95] });
  // 40/30 = 1.333 s (flicker, inside 1.3-1.4), 70/30 = 2.333 s (inside 2.2-2.5), 95/30 = 3.167 s (outside)
  assert.deepEqual(kinds(px.pops.list), ['jump@95']);
  assert.deepEqual(kinds(px.pops.ignored), ['flicker@40', 'jump@70']);
  assert.deepEqual(px.pops.ignored.map((p) => p.span), [[1.3, 1.4], [2.2, 2.5]]);
  assert.equal(px.pops.suppressed.ignored, 2);
  assert.match(px.pops.suppressed.why[0], /critique\.popIgnore .*2 candidate\(s\) inside the span\(s\) suppressed/);
  const both = await analyze({ stepped: true, popIgnore: [[1.3, 1.4]] }, { flickerAt: 40, blocks: [70] });
  assert.deepEqual([kinds(both.pops.list), kinds(both.pops.info), kinds(both.pops.ignored)], [[], ['jump@70'], ['flicker@40']]);
  const { popSplit } = await imp('critique-metrics.mjs');
  const junk = popSplit([{ kind: 'jump', t: 1, frame: 30 }], { popIgnore: [[0.5], 'x', null, [0, 'a']] }, 30);
  assert.equal(junk.list.length, 1, 'malformed spans (config read defensively) never swallow a candidate');
});

test('validateConfig: critique.stepped and critique.popIgnore (and gate.requireFormats) are checked, defaults are off', async () => {
  const S = await imp('studio.mjs');
  const v = (patch) => S.validateConfig(S.deepMerge(S.DEFAULTS, patch));
  assert.equal(S.DEFAULTS.critique.stepped, false);
  assert.deepEqual(S.DEFAULTS.critique.popIgnore, []);
  assert.equal(S.DEFAULTS.gate.requireFormats, false);
  assert.deepEqual(v({ critique: { stepped: true, popIgnore: [[0, 1.5], [2, 3]] }, gate: { requireFormats: true } }), []);
  assert.deepEqual(v({ critique: { stepped: 'yes' } }), ['critique.stepped must be true or false (got "yes")']);
  assert.deepEqual(v({ critique: { popIgnore: 3 } }), ['critique.popIgnore must be an array of [t0, t1] second pairs (got 3)']);
  assert.deepEqual(v({ critique: { popIgnore: [[2, 1], [1], [-1, 2], ['a', 'b'], [1, 2]] } }).length, 4);
  assert.match(v({ critique: { popIgnore: [[2, 2]] } })[0], /^critique\.popIgnore\[0\] must be \[t0, t1\] seconds with 0 <= t0 < t1 \(got \[2,2\]\)/);
  assert.deepEqual(v({ gate: { requireFormats: 1 } }), ['gate.requireFormats must be true or false (got 1)']);
  const tpl = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'studio.json'), 'utf8'));
  assert.equal(tpl.critique.stepped, false);
  assert.deepEqual(tpl.critique.popIgnore, []);
  assert.equal(tpl.gate.requireFormats, false);
  assert.deepEqual(v(tpl), [], 'the shipped template validates');
});

// ---------------------------------------------------------------------------------------------------------------
// Row 14: baseline

test('baseline: same candidates are "same", a moved or added one is new, a missing one is gone; findings list new first', async () => {
  const B = await imp('critique-baseline.mjs');
  const { findings, CRIT_DEFAULTS } = await imp('critique-metrics.mjs');
  const range = { from: 0, to: 4, full: true };
  const first = await analyze({}, { flickerAt: 40, blocks: [70, 95] });
  assert.equal(B.compareBaseline(null, first, { tol: 2 / 30, range }), null, 'first run: nothing to compare');
  const doc = B.nextBaseline(null, first, { mode: 'live', format: '1x1', fps: 30, range, filmHash: 'aaa', at: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(doc.pops.map((p) => `${p.kind}@${p.frame}`), ['flicker@40', 'jump@70', 'jump@95']);
  assert.deepEqual(doc.deadSpans, []);
  // next run: the jump at 70 is gone, a new one at 55 appeared, the flicker and the jump at 95 are unchanged
  const second = await analyze({}, { flickerAt: 40, blocks: [55, 95] });
  const delta = B.compareBaseline(doc, second, { tol: 2 / 30, range, filmHash: 'bbb' });
  assert.deepEqual([delta.total, delta.same, delta.sameFilm], [3, 2, false]);
  assert.deepEqual(delta.new.map((c) => `${c.kind}@${c.frame}`), ['jump@55']);
  assert.deepEqual(delta.gone.map((c) => `${c.kind}@${c.frame}`), ['jump@70']);
  assert.deepEqual(second.pops.list.map((p) => p.isNew), [false, true, false]);
  const r = { film: { duration: 4, fps: 30 }, px: second, determinism: { skipped: true }, audio: { skipped: true }, loop: { enabled: false }, sync: { cues: 0, impactShare: null, offGrid: [], shotChanges: 0, shotChangesOnDownbeat: 0 } };
  const f = findings(r, CRIT_DEFAULTS).filter((x) => x.metric === 'pops');
  assert.deepEqual(f.map((x) => x.severity), ['P1', 'P2', 'P2'].sort(), 'severity still ranks first');
  const p2 = f.filter((x) => x.severity === 'P2');
  assert.equal(p2[0].new, true, 'the new P2 comes before the old P2');
  assert.match(p2[0].text, /hard jump at frame 55/);
  assert.match(p2[1].text, /hard jump at frame 95.*\[same as the previous run\]$/);
  assert.match(f.find((x) => x.severity === 'P1').text, /\[same as the previous run\]$/);
  const lines = B.deltaLines({ delta, pin: { hash: 'b'.repeat(64), files: { a: 1, b: 2 } }, firstRun: false, det: { reused: { at: '2026-10-01T00:00:00Z' } } }).join('\n');
  assert.match(lines, /same as previous run: 2 of 3 candidates/);
  assert.match(lines, /NEW since the previous run \(review these first\): 1\n  - jump f55/);
  assert.match(lines, /Gone since the previous run: 1 \(jump @/);
  assert.match(lines, /the film was edited since/);
  assert.match(lines, /Determinism: reused from the run of 2026-10-01T00:00:00Z/);
  assert.match(B.deltaLines({ delta: null, pin: { hash: 'c'.repeat(64), files: {} }, firstRun: true }).join('\n'), /Baseline: none yet; this run wrote baseline\.json/);
});

test('baseline: dead spans match by overlap, a range review compares and replaces only its own part, stepped info counts as a candidate', async () => {
  const B = await imp('critique-baseline.mjs');
  const mk = (jumps, dead) => ({ pops: { list: [], info: jumps.map((t) => ({ kind: 'jump', t, frame: Math.round(t * 30), atShotBoundary: false })) }, deadSpans: { spans: dead.map(([from, to]) => ({ from, to, sec: to - from })) } });
  const full = { from: 0, to: 12, full: true };
  const prev = B.nextBaseline(null, mk([1, 5, 9], [[2, 4.5], [10, 12]]), { mode: 'live', format: '9x16', fps: 30, range: full, filmHash: 'h1' });
  assert.equal(prev.pops.length, 3, 'stepped info jumps are part of the baseline');
  // a dead span that shrank by a little is the same one; a disjoint one is new
  const cur = mk([1.03, 5], [[2.2, 4.4], [7, 9]]);
  const d = B.compareBaseline(prev, cur, { tol: 2 / 30, range: full, filmHash: 'h1' });
  assert.deepEqual([d.total, d.same, d.sameFilm], [4, 3, true]);
  assert.deepEqual(d.new.map((c) => c.kind), ['dead']);
  assert.deepEqual(d.gone.map((c) => `${c.kind}@${c.t}`).sort(), ['dead@10', 'jump@9']);
  // a chapter review 4..8 s: only the baseline inside 4..8 is compared; the rest is kept when the baseline is rewritten
  const part = { from: 4, to: 8, full: false };
  const chap = mk([5, 6], []);
  const dc = B.compareBaseline(prev, chap, { tol: 2 / 30, range: part });
  assert.deepEqual([dc.total, dc.same, dc.new.length, dc.gone.length], [2, 1, 1, 0]);
  const next = B.nextBaseline(prev, chap, { mode: 'live', format: '9x16', fps: 30, range: part, filmHash: 'h2' });
  assert.deepEqual(next.pops.map((p) => p.t), [1, 5, 6, 9], 'outside 4..8 kept (1, 9), inside replaced (5, 6)');
  assert.equal(next.deadSpans.length, 2, 'dead spans outside the range are kept');
  assert.deepEqual(next.range, { from: 4, to: 8, full: false });
});

test('suppressedLines: empty for a plain film, names the info jumps and ignored candidates for a stepped one', async () => {
  const B = await imp('critique-baseline.mjs');
  assert.deepEqual(B.suppressedLines({ suppressed: { stepped: false, popIgnore: [], why: [] }, info: [], ignored: [] }), []);
  const px = await analyze({ stepped: true, popIgnore: [[1.3, 1.4]] }, { flickerAt: 40, blocks: [70] });
  const text = B.suppressedLines(px.pops).join('\n');
  assert.match(text, /^## Suppressed by studio\.json \(not findings\)/);
  assert.match(text, /critique\.stepped = true: 1 hard-jump candidate/);
  assert.match(text, /info \(stepped hard jumps\): jump f70 @ 2\.333 s ×/);
  assert.match(text, /ignored \(popIgnore\): flicker f40 @ 1\.333 s ×.* \(popIgnore 1\.3–1\.4 s\)/);
});

// ---------------------------------------------------------------------------------------------------------------
// Row 11: film hash

function miniProject() {
  const root = tmp('ms-pin-');
  for (const [f, c] of Object.entries({ 'film/film.js': 'export default 1;\n', 'film/scenes/ch01.js': 'export const a = 1;\n', 'lib/runtime.js': '// rt\n', 'studio.json': '{"fps":30}\n' })) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'x.png'), 'not pinned');
  return root;
}

test('filmHash: film/**, lib/** and studio.json in stable order; assets and out/ do not count; CRLF checkouts hash the same', async () => {
  const P = await imp('critique-pin.mjs');
  const root = miniProject();
  const a = P.filmHash(root);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(a.files), ['film/film.js', 'film/scenes/ch01.js', 'lib/runtime.js', 'studio.json']);
  assert.deepEqual(P.filmHash(root).hash, a.hash, 'repeatable');
  fs.writeFileSync(path.join(root, 'assets', 'x.png'), 'changed');
  fs.mkdirSync(path.join(root, 'out'));
  fs.writeFileSync(path.join(root, 'out', 'y.txt'), 'log');
  assert.equal(P.filmHash(root).hash, a.hash, 'assets and out/ are not pinned');
  fs.writeFileSync(path.join(root, 'film', 'film.js'), 'export default 1;\r\n');
  assert.equal(P.filmHash(root).hash, a.hash, 'CRLF = LF for text files');
  fs.writeFileSync(path.join(root, 'film', 'film.js'), 'export default 2;\n');
  const b = P.filmHash(root);
  assert.notEqual(b.hash, a.hash);
  assert.notEqual(b.files['film/film.js'], a.files['film/film.js']);
  assert.equal(b.files['lib/runtime.js'], a.files['lib/runtime.js']);
});

test('checkFilmHash: match, mismatch naming the changed files, and unknown evidence', async () => {
  const P = await imp('critique-pin.mjs');
  const root = miniProject();
  const dir = path.join(root, 'out', 'review', '9x16');
  fs.mkdirSync(dir, { recursive: true });
  let c = P.checkFilmHash(root, dir);
  assert.deepEqual([c.match, c.evidence, c.dir], [null, null, 'out/review/9x16']);
  assert.match(c.reason, /no film hash in out\/review\/9x16\//);
  P.writeFilmHash(dir, P.filmHash(root), { mode: 'live' });
  c = P.checkFilmHash(root, dir);
  assert.equal(c.match, true);
  assert.deepEqual(c.changed, []);
  fs.writeFileSync(path.join(root, 'film', 'film.js'), 'export default 2;\n');
  fs.writeFileSync(path.join(root, 'film', 'scenes', 'ch02.js'), 'new\n');
  c = P.checkFilmHash(root, dir);
  assert.equal(c.match, false);
  assert.deepEqual(c.changed, ['film/film.js', 'film/scenes/ch02.js']);
  assert.match(c.reason, /the film changed since this evidence was made \(film\/film\.js, film\/scenes\/ch02\.js\): do not render zoom stills/);
  // an older folder with only metrics.json filmHash still compares (no file names)
  fs.rmSync(path.join(dir, P.HASH_FILE));
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({ filmHash: 'f'.repeat(64) }));
  c = P.checkFilmHash(root, dir);
  assert.deepEqual([c.match, c.changed], [false, []]);
});

test('determinism cache: the key follows filmHash, format, range and tool; only a passing result is reused', async () => {
  const P = await imp('critique-pin.mjs');
  const dir = tmp('ms-det-');
  const parts = { filmHash: 'a'.repeat(64), format: '9x16', from: null, to: null, tool: 't1' };
  const key = P.detKey(parts);
  assert.equal(P.readDetCache(dir, key), null, 'nothing cached yet');
  const result = { skipped: false, samples: 90, passes: ['in order', 'shuffled (seeded)', 'fresh page, reverse order'], mismatches: [], pass: true };
  P.writeDetCache(dir, key, parts, result, '2026-10-01T10:00:00.000Z');
  assert.deepEqual(P.readDetCache(dir, key), { at: '2026-10-01T10:00:00.000Z', result });
  for (const patch of [{ filmHash: 'b'.repeat(64) }, { assets: 'c'.repeat(64) }, { format: '1x1' }, { from: 1 }, { to: 3 }, { tool: 't2' }]) {
    assert.notEqual(P.detKey({ ...parts, ...patch }), key, JSON.stringify(patch));
    assert.equal(P.readDetCache(dir, P.detKey({ ...parts, ...patch })), null, `never reused for ${JSON.stringify(patch)}`);
  }
  P.writeDetCache(dir, key, parts, { ...result, pass: false, mismatches: [{ t: 1 }] });
  assert.equal(P.readDetCache(dir, key), null, 'a failing result is never reused');
  P.writeDetCache(dir, key, parts, { ...result, skipped: true });
  assert.equal(P.readDetCache(dir, key), null, 'a skipped result is no result');
  assert.match(P.toolHash(), /^[0-9a-f]{16}$/);
});

test('F4: assetsHash follows every file below assets/ (content, name, links); the determinism key changes with it', async () => {
  const P = await imp('critique-pin.mjs');
  const root = tmp('ms-assets-');
  assert.equal(P.assetsHash(root), 'none', 'no assets folder');
  fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
  assert.equal(P.assetsHash(root), 'none', 'an empty folder');
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'a.woff2'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(root, 'assets', 'sprite.png'), Buffer.from([9, 9, 9]));
  const h0 = P.assetsHash(root);
  assert.match(h0, /^[0-9a-f]{64}$/);
  assert.equal(P.assetsHash(root), h0, 'stable');
  fs.writeFileSync(path.join(root, 'assets', 'sprite.png'), Buffer.from([9, 9, 8])); // same size, other content
  const h1 = P.assetsHash(root);
  assert.notEqual(h1, h0, 'a content change with the same size and name changes the hash');
  fs.writeFileSync(path.join(root, 'assets', 'new.json'), '{}');
  assert.notEqual(P.assetsHash(root), h1, 'a new file changes it');
  const parts = { filmHash: 'a'.repeat(64), format: '9x16', from: null, to: null, tool: 't1' };
  assert.notEqual(P.detKey({ ...parts, assets: h0 }), P.detKey({ ...parts, assets: h1 }), 'the cache key follows the assets');
  assert.equal(P.filmHash(root).hash, P.filmHash(root).hash);
  // assets are still not part of filmHash
  fs.mkdirSync(path.join(root, 'film'), { recursive: true });
  fs.writeFileSync(path.join(root, 'film', 'film.js'), 'export default 1;\n');
  const f0 = P.filmHash(root).hash;
  fs.writeFileSync(path.join(root, 'assets', 'new.json'), '{"x":1}');
  assert.equal(P.filmHash(root).hash, f0, 'assets stay out of filmHash');
});

test('S4: film/ and lib/ files and folders that are symbolic links or junctions are pinned too', async (t) => {
  const P = await imp('critique-pin.mjs');
  const root = tmp('ms-links-');
  const real = path.join(root, 'real');
  fs.mkdirSync(path.join(root, 'film'), { recursive: true });
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'x.js'), 'export default 1;\n');
  fs.writeFileSync(path.join(real, 'y.js'), 'export default 2;\n');
  fs.writeFileSync(path.join(root, 'film', 'film.js'), 'export default 0;\n');
  try {
    fs.symlinkSync(real, path.join(root, 'film', 'linked'), 'junction'); // a junction on Windows (no privilege needed), a symlink elsewhere
    fs.symlinkSync(path.join(real, 'y.js'), path.join(root, 'film', 'y-link.js'), 'file');
  } catch (err) { t.skip(`links cannot be created here: ${err.code ?? err.message}`); return; }
  const files = P.filmFiles(root);
  assert.ok(files.includes('film/linked/x.js'), `the linked folder is walked: ${files.join(', ')}`);
  assert.ok(files.includes('film/linked/y.js'));
  assert.ok(files.includes('film/y-link.js'), 'a linked file is pinned');
  const before = P.filmHash(root);
  assert.match(P.checkFilmHash(root, root).reason, /no film hash|older/, 'sanity');
  fs.writeFileSync(path.join(real, 'x.js'), 'export default 99;\n'); // edit the TARGET
  const after = P.filmHash(root);
  assert.notEqual(after.hash, before.hash, 'editing the target of a link changes the film hash');
  assert.deepEqual(Object.keys(after.files).filter((k) => after.files[k] !== before.files[k]), ['film/linked/x.js']);
});

test('S4: a link cycle does not loop; a broken link is ignored', async (t) => {
  const P = await imp('critique-pin.mjs');
  const root = tmp('ms-linkcycle-');
  fs.mkdirSync(path.join(root, 'film', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'film', 'sub', 'a.js'), 'export default 1;\n');
  try {
    fs.symlinkSync(path.join(root, 'film'), path.join(root, 'film', 'sub', 'back'), 'junction');
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'film', 'gone'), 'file');
  } catch (err) { t.skip(`links cannot be created here: ${err.code ?? err.message}`); return; }
  assert.deepEqual(P.filmFiles(root), ['film/sub/a.js']);
});

test('critique --check-hash: exit 0 on a match, 1 on a mismatch or unknown evidence, no browser needed', async () => {
  const P = await imp('critique-pin.mjs');
  const root = tmp('ms-pin-cli-');
  fs.cpSync(TEMPLATE, root, { recursive: true, filter: (src) => !/[\/](node_modules|out)([\/]|$)/.test(src) });
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ fps: 30, formats: ['9x16'], primaryFormat: '9x16' }));
  const dir = path.join(root, 'out', 'review', '9x16');
  fs.mkdirSync(dir, { recursive: true });
  const cli = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, 'tools', 'critique.mjs'), '--check-hash', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
  let r = await cli([]);
  assert.equal(r.code, 1, r.err);
  assert.match(r.out + r.err, /film hash UNKNOWN \(out\/review\/9x16\/\)/);
  P.writeFilmHash(dir, P.filmHash(root), { mode: 'live' });
  r = await cli([]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^film hash MATCH [0-9a-f]{16}\.\.\. \(out\/review\/9x16\/\)/);
  fs.writeFileSync(path.join(root, 'film', 'film.js'), 'export default 3;\n');
  r = await cli(['--json']);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out.trim());
  assert.deepEqual([j.ok, j.match, j.changed], [false, false, ['film/film.js']]);
  r = await cli(['--video']);
  assert.equal(r.code, 1, 'the video folder has its own evidence (none here)');
  assert.match(r.out, /UNKNOWN \(out\/review\/9x16\/video\/\)/);
});

// ---------------------------------------------------------------------------------------------------------------
// End to end: the real CLI, twice with --skip-determinism-repeat, then after an edit

function findNodeModules() {
  const env = process.env.MOTION_SMOKE_NODE_MODULES;
  if (env) return fs.existsSync(path.join(env, 'playwright')) || fs.existsSync(path.join(env, 'playwright-core')) ? path.resolve(env) : null;
  for (const base of [path.join(REPO, 'package.json'), path.join(TEMPLATE, 'package.json')]) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return path.dirname(path.dirname(createRequire(base).resolve(`${name}/package.json`))); } catch { /* next */ }
    }
  }
  return null;
}
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1)); } catch { return null; } })() }));
});
// A stepped film: the background colour flips (a hard step) at 1.5 s and 2.75 s, the box slides smoothly.
const STEPPED_FILM = `import { defineFilm, scene } from '../lib/timeline.js';
export default defineFilm(() => ({
  scenes: [
    scene(0, 4, 'bg', (g, lt, c) => {
      g.fillStyle = lt < 1.5 ? '#204060' : lt < 2.75 ? '#a04060' : '#40a060'; g.fillRect(0, 0, c.W, c.H);
      g.fillStyle = '#e8b04a'; g.fillRect(c.W * (0.1 + 0.6 * (lt / 4)), c.H * 0.2, c.W * 0.15, c.H * 0.15);
    }),
  ],
}));
`;

test('critique (live): baseline delta, film hash, stepped info and the determinism cache on a real run', { timeout: 900000 }, async (t) => {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = tmp('ms-critdelta-');
  fs.cpSync(TEMPLATE, root, { recursive: true, filter: (src) => !/[\\/](node_modules|out)([\\/]|$)/.test(src) });
  const studioPath = path.join(root, 'studio.json');
  const setStudio = (patch) => {
    const s = JSON.parse(fs.readFileSync(studioPath, 'utf8'));
    fs.writeFileSync(studioPath, JSON.stringify({ ...s, ...patch, critique: { ...s.critique, ...(patch.critique ?? {}) } }, null, 2));
  };
  setStudio({ title: 'Delta', duration: 4, fps: 12, subframes: 1, formats: ['1x1'], primaryFormat: '1x1', gate: { enabled: false } });
  fs.writeFileSync(path.join(root, 'film', 'film.js'), STEPPED_FILM);
  const link = path.join(root, 'node_modules');
  try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* NODE_PATH */ }
  const review = path.join(root, 'out', 'review', '1x1');
  const critique = (args) => run(process.execPath, [path.join(root, 'tools', 'critique.mjs'), '--json', ...args], { cwd: root, env: { ...process.env, DEBUG: '', NODE_PATH: nm, MOTION_CLOSE_TIMEOUT_MS: '3000' } });
  const readJ = (f) => JSON.parse(fs.readFileSync(path.join(review, f), 'utf8'));
  try {
    try {
      const S = await imp('studio.mjs');
      const { browser } = await S.launchBrowser(root, S.loadConfig(root));
      await browser.close();
    } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }

    // run 1: no baseline yet; the two colour steps are P2 hard jumps; the passes run and are cached
    const r1 = await critique([]);
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r1.json.summary.determinism, 'pass');
    assert.equal(r1.json.delta, null);
    const jumps1 = r1.json.findings.filter((f) => f.metric === 'pops');
    assert.equal(jumps1.length, 2, JSON.stringify(r1.json.findings));
    assert.ok(jumps1.every((f) => f.severity === 'P2' && /hard jump/.test(f.text)));
    const m1 = readJ('metrics.json');
    assert.match(m1.filmHash, /^[0-9a-f]{64}$/);
    assert.equal(readJ('film-hash.json').filmHash, m1.filmHash, 'every evidence folder carries the hash');
    assert.equal(readJ('baseline.json').pops.length, 2);
    assert.equal(m1.baseline.first, true);
    assert.equal(readJ('determinism-cache.json').result.pass, true);
    assert.match(fs.readFileSync(path.join(review, 'metrics.md'), 'utf8'), /Baseline: none yet; this run wrote baseline\.json/);
    const check = (args = []) => run(process.execPath, [path.join(root, 'tools', 'critique.mjs'), '--check-hash', ...args], { cwd: root, env: { ...process.env, NODE_PATH: nm } });
    assert.equal((await check()).code, 0);

    // run 2: unchanged film + --skip-determinism-repeat: the passes are reused, every candidate is "same"
    const r2 = await critique(['--skip-determinism-repeat']);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.json.summary.determinism, 'reused');
    assert.deepEqual(r2.json.delta, { same: 2, total: 2, new: 0, gone: 0 });
    assert.ok(r2.json.findings.filter((f) => f.metric === 'pops').every((f) => /\[same as the previous run\]$/.test(f.text)));
    const md2 = fs.readFileSync(path.join(review, 'metrics.md'), 'utf8');
    assert.match(md2, /same as previous run: 2 of 2 candidates/);
    assert.match(md2, /\| determinism \| n\/a +\| reused from the run of /);
    assert.equal(readJ('metrics.json').determinismCache.reused, true);
    assert.equal(readJ('metrics.json').filmHash, m1.filmHash);

    // run 3: studio.json changes (stepped: true) = a different filmHash: the passes MUST run again even with the flag; jumps are info
    setStudio({ critique: { stepped: true } });
    assert.equal((await check()).code, 1, 'the evidence no longer matches the live film');
    const r3 = await critique(['--skip-determinism-repeat']);
    assert.equal(r3.code, 0, r3.stderr);
    assert.equal(r3.json.summary.determinism, 'pass', 'a different hash never reuses');
    assert.equal(r3.json.findings.filter((f) => f.metric === 'pops').length, 0);
    assert.deepEqual(r3.json.delta, { same: 2, total: 2, new: 0, gone: 0 }, 'info candidates are still baseline candidates');
    const m3 = readJ('metrics.json');
    assert.notEqual(m3.filmHash, m1.filmHash);
    assert.equal(m3.pops.info.length, 2);
    assert.equal(m3.pops.suppressed.stepped, true);
    assert.equal(m3.determinismCache.reused, false);
    const md3 = fs.readFileSync(path.join(review, 'metrics.md'), 'utf8');
    assert.match(md3, /## Suppressed by studio\.json \(not findings\)/);
    assert.match(md3, /info \(stepped hard jumps\): jump f/);
    assert.equal((await check()).code, 0);

    // run 4: an edit of the film makes the hash differ; --check-hash names the file
    fs.writeFileSync(path.join(root, 'film', 'film.js'), STEPPED_FILM.replace('2.75', '2.5'));
    const bad = await check(['--json']);
    assert.equal(bad.code, 1);
    assert.deepEqual(JSON.parse(bad.stdout.trim()).changed, ['film/film.js']);
  } finally {
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
    try { rmDir(root); } catch { /* the after() hook retries */ }
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched');
  }
});
