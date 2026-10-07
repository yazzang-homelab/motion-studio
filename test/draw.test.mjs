// Tests for skills/studio-init/template/lib/draw.js (+ the registry in lib/fonts.js and fitFontSize in lib/layout.js):
//  1. colour parsing: rgb()/rgba() with percentages parse or throw, never NaN (a NaN colour is silently ignored by a canvas);
//  2. default family and weight: text()/font() follow the brand UI face, kinetic() the display face, and the default weight
//     is a weight the family really has (a 400-only face is never asked for a synthetic 700);
//  3. wrapText(): Korean-friendly line breaking on a fake measureText context;
//  4. browser (skips without playwright or a browser): the real runtime hands scenes the OUTPUT frame (c.frame, c.sub,
//     c.subs, c.frameT) so grain and stepTime() do not change between motion-blur subframes, boot() sets the brand font
//     defaults, and a Korean sentence wraps with NeoDunggeunmo when that font file is on this machine.
// Env: MOTION_TEMPLATE_DIR (test another template copy), MOTION_SMOKE_NODE_MODULES=<dir with playwright>,
// MOTION_TEST_KOREAN_FONT_DIR=<an assets/fonts folder holding neodunggeunmo-400.woff2, fonts.json and its OFL file>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const lib = (n) => import(pathToFileURL(path.join(TEMPLATE, 'lib', `${n}.js`)).href);
const D = await lib('draw');
const F = await lib('fonts');
const L = await lib('layout');
const S = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'studio.mjs')).href);

// ---------------------------------------------------------------------------------------------------------------
// A fake 2D context: measureText from a per-character advance table (in em), Chrome's letterSpacing semantics (added
// after every glyph, the last one included), save/restore of the properties the helpers touch.

function adv(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x1160 && cp <= 0x11ff) return 0; // conjoining vowel / final jamo add no width to their syllable
  if (cp >= 0xac00 && cp <= 0xd7a3) return 1; // Hangul syllable
  if (ch === ' ') return 0.3;
  if ('.,!?;:)]}\'"%'.includes(ch)) return 0.3;
  if (cp < 0x300) return 0.5;
  return 1;
}

function fakeCtx() {
  const state = { font: '10px sans-serif', letterSpacing: '0px', fillStyle: '#000', globalAlpha: 1, textBaseline: 'alphabetic', textAlign: 'left' };
  const stack = [];
  const fills = [];
  return {
    ...state,
    fills,
    save() { stack.push({ font: this.font, letterSpacing: this.letterSpacing, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha, textBaseline: this.textBaseline, textAlign: this.textAlign }); },
    restore() { Object.assign(this, stack.pop()); },
    measureText(s) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]);
      const ls = parseFloat(this.letterSpacing) || 0;
      return { width: [...s].reduce((w, ch) => w + adv(ch) * px + ls, 0) };
    },
    fillText(s, x, y) { fills.push({ s, x, y, font: this.font }); },
  };
}
const px10 = '400 10px "Test"';
const widthOf = (g, s, css = px10, tracking = 0) => D.textWidth(g, s, css, tracking);

// ---------------------------------------------------------------------------------------------------------------
// 1. colours

test('parseColor: rgb()/rgba() accept numbers and percentages in both syntaxes, and never yield NaN', () => {
  assert.deepEqual(D.parseColor('rgb(255, 0, 0)'), [255, 0, 0, 1]);
  assert.deepEqual(D.parseColor('rgba(255,255,255,0.12)'), [255, 255, 255, 0.12]);
  assert.deepEqual(D.parseColor('rgb(255 255 255 / 0.12)'), [255, 255, 255, 0.12]);
  assert.deepEqual(D.parseColor('rgb(255 255 255 / 12%)'), [255, 255, 255, 0.12]);
  assert.deepEqual(D.parseColor('rgb(100%, 0%, 0%)'), [255, 0, 0, 1]);
  assert.deepEqual(D.parseColor('rgb(50% 50% 50% / 50%)'), [127.5, 127.5, 127.5, 0.5]);
  assert.deepEqual(D.parseColor('rgba(300, -5, 0, 2)'), [255, 0, 0, 1], 'out-of-range values clamp like CSS');
  assert.equal(D.rgba('rgb(255 255 255 / 12%)', 1), 'rgba(255,255,255,0.12)');
  assert.equal(D.rgba('rgb(255 255 255 / 12%)', 0.5), 'rgba(255,255,255,0.06)');
  assert.equal(D.mixColor('rgb(0 0 0 / 50%)', '#ffffff', 0.5), 'rgba(128,128,128,0.75)');
  for (const bad of ['rgb(none 0 0)', 'rgb(1 2)', 'rgb(1 2 3 4 5)', 'rgb(% 0 0)', 'rgb(a b c)', 'rgb(from red r g b)', 'hsl(0 0% 0%)', 'red']) {
    assert.throws(() => D.parseColor(bad), /unsupported colour/, bad);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 2. default family and weight

test('fonts registry: bestWeight follows CSS font matching, ranges count, unknown families are left alone', () => {
  F.registerFaces([
    { family: 'Reg Bitmap', weight: '400', style: 'normal' },
    { family: 'Reg Serif', weight: '400', style: 'normal' }, { family: 'Reg Serif', weight: '400', style: 'italic' },
    { family: 'Reg Var', weight: '100 900', style: 'normal' },
    { family: 'Reg Heavy', weight: '300', style: 'normal' }, { family: 'Reg Heavy', weight: '900', style: 'normal' },
    { family: 'Reg Light', weight: '300', style: 'normal' },
  ]);
  assert.equal(F.bestWeight('Reg Bitmap'), 400, 'a 400-only face: the default 700 becomes 400');
  assert.equal(F.bestWeight('Reg Bitmap', 400), 400);
  assert.equal(F.bestWeight('Reg Serif', 700, 'italic'), 400);
  assert.equal(F.bestWeight('Reg Var'), 700, 'a variable range covers 700');
  assert.equal(F.bestWeight('Reg Var', 1000), 900);
  assert.equal(F.bestWeight('Reg Heavy'), 900, 'above 500 heavier faces win');
  assert.equal(F.bestWeight('Reg Heavy', 400), 300, 'from 400 the lighter face when nothing sits between 400 and 500');
  assert.equal(F.bestWeight('Reg Light'), 300);
  assert.equal(F.bestWeight('Reg Light', 200), 300, 'below 400: nothing lighter, then the next heavier');
  assert.equal(F.bestWeight('Not Registered Anywhere'), 700, 'unknown family: nothing is known, the request is kept');
  assert.equal(F.bestWeight('"reg bitmap", sans-serif'), 400, 'CSS family lists and case are read like the browser reads them');
  assert.deepEqual(F.registeredFaces('Reg Serif').map((f) => `${f.style} ${f.weight}`), ['normal 400', 'italic 400']);
  assert.deepEqual(F.registeredFaces('Nope'), []);
  assert.deepEqual([F.weightRange('bold'), F.weightRange('100 900'), F.weightRange('x')], [[700, 700], [100, 900], null]);
});

test('text(), kinetic(), font(): default family from the brand faces, default weight from what is registered', () => {
  F.registerFaces([{ family: 'Def Pixel', weight: '400', style: 'normal' }, { family: 'Def Sans', weight: '100 900', style: 'normal' }]);
  const before = D.getFontDefaults();
  const g = fakeCtx();
  const warn = console.warn;
  console.warn = () => {}; // the explicit weight 700 on a 400-only face below warns; that is covered by the next test
  try {
    assert.deepEqual(before, { text: 'Inter', kinetic: 'Inter' }, 'the fallback only exists until boot() sets the brand faces');
    assert.match(D.font(40), /^normal 700 40px "Inter"$/, 'no boot, no registry entry: exactly the old default');
    assert.deepEqual(D.setFontDefaults({ text: 'Def Sans', kinetic: 'Def Pixel' }), { text: 'Def Sans', kinetic: 'Def Pixel' });
    D.text(g, 'abc', 0, 0, { size: 40 });
    D.kinetic(g, 'abc', 0, 0, 5, { size: 40, stagger: 0 });
    assert.equal(g.fills[0].font, 'normal 700 40px "Def Sans"', 'text(): brand UI face, 700 exists in the range');
    assert.ok(g.fills.slice(1).every((f) => f.font === 'normal 400 40px "Def Pixel"'), `kinetic(): brand display face, weight 400 (${g.fills.map((f) => f.font)})`);
    assert.equal(D.font(20), 'normal 700 20px "Def Sans"', 'font() follows the UI face too');
    assert.equal(D.font(20, 'Def Pixel'), 'normal 400 20px "Def Pixel"');
    assert.equal(D.font(20, 'Def Pixel', 700), 'normal 700 20px "Def Pixel"', 'an explicit weight is never rewritten');
    assert.equal(D.defaultWeight('Def Pixel'), 400);
    assert.equal(D.defaultWeight('Def Sans'), 700);
    D.setFontDefaults({ text: '  ', kinetic: 42 });
    assert.deepEqual(D.getFontDefaults(), { text: 'Def Sans', kinetic: 'Def Pixel' }, 'blank or non-string values are ignored');
  } finally { console.warn = warn; D.setFontDefaults({ text: 'Inter', kinetic: 'Inter' }); }
});

test('an explicit weight or style that no registered face backs warns once', () => {
  F.registerFaces([{ family: 'Warn Pixel', weight: '400', style: 'normal' }]);
  const seen = [];
  const warn = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try {
    D.font(30, 'Warn Pixel', 700);
    D.font(30, 'Warn Pixel', 700);
    D.font(30, 'Warn Pixel', 400, 'italic');
    D.font(30, 'Warn Pixel'); // the default weight is backed
    D.font(30, 'Warn Pixel', 400);
    D.font(30, 'Some System Font', 700); // unknown family: nothing to compare with
  } finally { console.warn = warn; }
  assert.equal(seen.length, 2, seen.join('\n'));
  assert.match(seen[0], /"Warn Pixel" has no weight 700 face registered \(has 400\).*Pass weight: 400/);
  assert.match(seen[1], /"Warn Pixel" has no italic face registered/);
});

// ---------------------------------------------------------------------------------------------------------------
// 3. wrapText

const wrap = (text, maxW, opts, css = px10) => D.wrapText(fakeCtx(), text, maxW, css, opts);

test('wrapText: breaks at spaces, greedy, every line within maxW', () => {
  const lines = wrap('안녕하세요 여러분 반갑습니다 오늘은 좋은 날입니다', 100);
  assert.deepEqual(lines, ['안녕하세요 여러분', '반갑습니다 오늘은', '좋은 날입니다']);
  const g = fakeCtx();
  for (const line of lines) assert.ok(widthOf(g, line) <= 100, line);
  assert.deepEqual(wrap('hello world again', 1000), ['hello world again'], 'fits on one line');
  assert.deepEqual(wrap('  두   칸   공백  ', 1000), ['두 칸 공백'], 'runs of spaces count as one, ends are trimmed');
  assert.deepEqual(wrap('', 100), []);
  assert.deepEqual(wrap(null, 100), []);
});

test('wrapText: a word wider than maxW starts on a fresh line and is cut between characters, never inside a syllable', () => {
  assert.deepEqual(wrap('안녕 가나다라마바사아자차카타파하 끝', 50), ['안녕', '가나다라마', '바사아자차', '카타파하', '끝']);
  // The same syllables written as conjoining jamo (NFD): a syllable is L + V (+ T), and stays in one piece.
  const nfd = '가나다라마바사아자차카타파하'.normalize('NFD');
  assert.ok(nfd.length > 14);
  const cut = wrap(nfd, 50);
  assert.equal(cut.join(''), nfd);
  for (const line of cut) assert.doesNotMatch(line, /^[ᅠ-ᇿ]/, 'no line starts inside a syllable');
  assert.deepEqual(cut.map((l) => l.normalize('NFC')), ['가나다라마', '바사아자차', '카타파하']);
});

test('wrapText: breakWords "char" fills lines across word boundaries; unknown modes throw', () => {
  assert.deepEqual(wrap('hello world', 20, { breakWords: 'char' }), ['hell', 'o wo', 'rld']);
  assert.deepEqual(wrap('hello world', 20), ['hello', 'world'].flatMap((w) => (w.length * 5 > 20 ? [w.slice(0, 4), w.slice(4)] : [w])), 'space mode keeps words together, cutting only ones wider than the line');
  assert.throws(() => wrap('a', 10, { breakWords: 'anywhere' }), /breakWords must be 'space' or 'char'/);
  assert.throws(() => wrap('a', 'wide'), /maxW must be a number/);
});

test('wrapText: no line starts with a closing mark or ends with an opening bracket', () => {
  // "가나다라마." is 53 wide: a plain wrap would leave the full stop alone on line 2.
  assert.deepEqual(wrap('가나다라마.', 52), ['가나다라', '마.']);
  assert.deepEqual(wrap('가나다라마!?', 52), ['가나다라', '마!?'], 'two marks take one syllable with them');
  assert.deepEqual(wrap('가나다라마)', 52), ['가나다라', '마)']);
  assert.deepEqual(wrap('가나다라(마바사', 51, { breakWords: 'char' }), ['가나다라', '(마바사'], 'an opening bracket never ends a line');
  for (const mark of ['.', ',', '!', '?', ')', ']', '}', '"', "'", '。', '、', '）', '”']) {
    const out = wrap(`가나다라마${mark}바사`, 52, { breakWords: 'char' });
    for (const line of out.slice(1)) assert.ok(![...'.,!?)]}"\'。、）”'].includes([...line][0]), `${JSON.stringify(mark)} ${JSON.stringify(out)}`);
    assert.equal(out.join(''), `가나다라마${mark}바사`);
  }
  // A quote that opens a word after a space is fine at the start of a line.
  assert.deepEqual(wrap('가나다라마바 "안녕"', 61), ['가나다라마바', '"안녕"']);
});

test('wrapText: newlines, blank lines, maxLines and ellipsis', () => {
  assert.deepEqual(wrap('첫째 줄\n\n둘째 줄\r\n셋째', 1000), ['첫째 줄', '', '둘째 줄', '셋째']);
  assert.deepEqual(wrap('끝\n\n', 1000), ['끝'], 'trailing blank lines are dropped');
  const text = '안녕하세요 여러분 반갑습니다 오늘은 좋은 날입니다';
  assert.deepEqual(wrap(text, 90, { maxLines: 2 }), ['안녕하세요 여러분', '반갑습니다 오늘은'], 'cut off without a mark');
  const cut = wrap(text, 90, { maxLines: 2, ellipsis: true });
  assert.deepEqual(cut, ['안녕하세요 여러분', '반갑습니다 오늘…'], 'the mark is 10 wide: one syllable goes to make room');
  assert.ok(widthOf(fakeCtx(), cut[1]) <= 90);
  assert.deepEqual(wrap(text, 90, { maxLines: 2, ellipsis: '...' })[1], '반갑습니다 오늘...');
  assert.deepEqual(wrap(text, 90, { maxLines: 5, ellipsis: true }), ['안녕하세요 여러분', '반갑습니다 오늘은', '좋은 날입니다'], 'nothing cut, no mark');
});

test('wrapText: tracking (em) is measured like text() draws it', () => {
  const text = '가나다라마 바사아자차';
  const loose = wrap(text, 108, { tracking: 0 });
  const tight = wrap(text, 108, { tracking: 0.1 });
  assert.deepEqual(loose, ['가나다라마 바사아자차']);
  assert.deepEqual(tight, ['가나다라마', '바사아자차'], 'the same text no longer fits once each glyph is 1 px wider');
  const g = fakeCtx();
  for (const line of tight) assert.ok(widthOf(g, line, px10, 0.1) <= 108);
});

// ---------------------------------------------------------------------------------------------------------------
// fitFontSize: tracking and step (lib/layout.js)

test('fitFontSize: tracking is included in the measured width, step quantizes down', () => {
  const g = fakeCtx();
  const mk = (s) => `400 ${s}px "Test"`;
  const plain = L.fitFontSize(g, 'ABCDEFGHIJ', 500, mk); // 10 glyphs x 0.5 em -> 100
  assert.ok(plain > 99.9 && plain <= 100, String(plain));
  const tracked = L.fitFontSize(g, 'ABCDEFGHIJ', 500, mk, 8, 1000, { tracking: 0.1 }); // 5 s + 9 x 0.1 s = 5.9 s -> 84.74
  assert.ok(tracked > 84.7 && tracked <= 84.75, String(tracked));
  assert.ok(widthOf(g, 'ABCDEFGHIJ', mk(tracked), 0.1) <= 500 + 1e-9);
  assert.ok(widthOf(g, 'ABCDEFGHIJ', mk(tracked + 0.05), 0.1) > 500, 'the fit is tight');
  assert.equal(L.fitFontSize(g, 'ABCDEFGHIJ', 500, mk, { tracking: 0.1 }), tracked, 'options can replace lo/hi');
  // step: a multiple of the step, never above the fit, never below the step
  assert.equal(L.fitFontSize(g, 'ABCDEFGHIJ', 500, mk, 8, 1000, { step: 16 }), 96);
  assert.equal(L.fitFontSize(g, 'ABCDEFGHIJ', 500, mk, { step: 16 }), 96);
  assert.equal(L.fitFontSize(g, 'ABCDEFGHIJ', 480, mk, { step: 16 }), 96, 'exactly 480 wide at 96: an exact fit is kept');
  assert.equal(L.fitFontSize(g, 'ABCDEFGHIJ', 479.99, mk, { step: 16 }), 80);
  assert.equal(L.fitFontSize(g, 'ABCDEFGHIJ', 1, mk, { step: 16 }), 16, 'nothing fits: the smallest step, like the lo bound');
  assert.equal(L.fitFontSize(g, 'AB', 5000, mk, 8, 300, { step: 16 }), 288, 'hi bound floors to a step too');
  assert.equal(L.fitFontSize(g, 'ABCDEFGHIJ', 500, mk, 8, 1000, { step: 16, tracking: 0.1 }), 80);
  assert.equal(L.fitFontSize(g, ['AB', 'ABCDEFGHIJKLMNOPQRST'], 500, mk, { step: 8 }), 48, 'the widest line decides');
  assert.throws(() => L.fitFontSize(g, 'A', 100, mk, { step: 0 }), /step must be > 0/);
  assert.equal(g.font, '10px sans-serif', 'the context font is restored');
});

// ---------------------------------------------------------------------------------------------------------------
// 4. browser: the real runtime

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

const KOREAN_FONT_DIRS = [
  process.env.MOTION_TEST_KOREAN_FONT_DIR,
  path.join(REPO, '..', '_scratch', 'sandbox', 'projects', 'h2e-1', 'assets', 'fonts'),
  path.join(REPO, '..', '_scratch', 'sandbox', 'projects', 'h2-textuse-1', 'assets', 'fonts'),
  path.join(REPO, '..', '_scratch', 'sandbox', 'projects', 'fonts-1', 'assets', 'fonts'),
].filter(Boolean);
const koreanFontDir = () => KOREAN_FONT_DIRS.find((d) => fs.existsSync(path.join(d, 'neodunggeunmo-400.woff2')) && fs.existsSync(path.join(d, 'fonts.json')));

/** A throw-away project (studio.json, index.html, lib, fonts, the given film.js) served over http with a launched browser. */
async function withProject(t, { film, studio = {}, fontsDir = path.join(TEMPLATE, 'assets', 'fonts') }, body) {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-draw-'));
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ title: 'Draw', duration: 4, fps: 60, subframes: 4, shutter: 0.5, formats: ['1x1'], primaryFormat: '1x1', capture: 'canvas', gate: { enabled: false }, ...studio }));
  fs.copyFileSync(path.join(TEMPLATE, 'index.html'), path.join(root, 'index.html'));
  fs.cpSync(path.join(TEMPLATE, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.cpSync(fontsDir, path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'film'));
  fs.writeFileSync(path.join(root, 'film', 'film.js'), film);
  const link = path.join(root, 'node_modules');
  try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved via the template instead */ }
  let srv = null;
  let browser = null;
  try {
    try { ({ browser } = await S.launchBrowser(root, S.loadConfig(root))); } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }
    srv = await S.startServer(root);
    await body({ root, srv, browser, open: (query = {}) => S.openFilm(browser, srv.url, { format: '1x1', scale: 0.25, query }) });
  } finally {
    if (browser) await browser.close();
    if (srv) await srv.close();
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched');
  }
}

// In-page helper source: decode a frame() data URL into luminance values.
const DECODE = `
window.__lum = async (o) => {
  const url = await window.__studio.frame(o);
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const out = new Float64Array(d.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return Array.from(out);
};`;

const F3_FILM = `import { defineFilm, scene } from '../lib/timeline.js';
import { grain } from '../lib/draw.js';
import { stepTime } from '../lib/motion.js';
const mode = new URLSearchParams(location.search).get('mode');
window.__seen = [];
export default defineFilm(() => ({
  background: mode === 'grain' ? '#808080' : '#000',
  scenes: [scene(0.1, 4, 'probe', (g, lt, c) => {
    window.__seen.push({ frame: c.frame, sub: c.sub, subs: c.subs, frameT: c.frameT, t: c.t, lt, frameLt: c.frameLt });
    if (mode === 'grain') grain(g, c.W, c.H, c.frame, { amount: 0.5, cell: 1, seed: 3 });
    if (mode === 'twos' || mode === 'twos-t') {
      const s = mode === 'twos' ? stepTime(c.frameLt, 12) : stepTime(lt, 12);
      g.fillStyle = Math.round(s * 12) % 2 ? '#fff' : '#000';
      g.fillRect(0, 0, c.W, c.H);
    }
  })],
}));
`;

const stats = (a) => {
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  return { mean, std: Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length) };
};
const corr = (a, b) => {
  const A = stats(a);
  const B = stats(b);
  return a.reduce((s, v, i) => s + (v - A.mean) * (b[i] - B.mean), 0) / a.length / (A.std * B.std);
};

test('runtime: every motion-blur subframe of an output frame shares c.frame (grain has the same look at sub 1 and sub 4)', { timeout: 240000 }, async (t) => {
  await withProject(t, { film: F3_FILM }, async ({ open }) => {
    const film = await open({ mode: 'grain' });
    try {
      assert.deepEqual(film.errors.page, []);
      await film.page.evaluate(DECODE);
      const seenAfter = async (o) => {
        await film.page.evaluate(() => { window.__seen.length = 0; });
        const lum = await film.page.evaluate((x) => window.__lum(x), o);
        return { lum, seen: await film.page.evaluate(() => window.__seen.slice()) };
      };
      const fps = 60;
      const k = 10;
      const blurred = await seenAfter({ t: k / fps, sub: 4, shutter: 0.5, fps });
      assert.deepEqual(blurred.seen.map((s) => s.frame), [k, k, k, k], 'c.frame is the output frame for all 4 subframes (was [9,9,10,10])');
      assert.deepEqual(blurred.seen.map((s) => s.sub), [0, 1, 2, 3]);
      assert.deepEqual(blurred.seen.map((s) => s.subs), [4, 4, 4, 4]);
      assert.ok(blurred.seen.every((s) => s.frameT === k / fps), 'c.frameT is the output frame time for every subframe');
      assert.ok(blurred.seen.every((s) => s.frameLt === k / fps - 0.1 && Math.abs(s.frameLt - (s.lt + s.frameT - s.t)) < 1e-12), 'c.frameLt is the scene-local frame time');
      const ts = blurred.seen.map((s) => s.t);
      assert.ok(ts.every((v, i) => i === 0 || v > ts[i - 1]), `c.t is the subframe time (${ts})`);
      assert.ok(Math.abs(ts.reduce((s, v) => s + v, 0) / 4 - k / fps) < 1e-9, 'subframes are centred on the frame');
      assert.ok(Math.abs(ts[3] - ts[0] - (3 / 4) * 0.5 / fps) < 1e-9, 'and spread over the shutter');
      const plain = await seenAfter({ t: k / fps, sub: 1, fps });
      assert.deepEqual(plain.seen, [{ frame: k, sub: 0, subs: 1, frameT: k / fps, t: k / fps, lt: k / fps - 0.1, frameLt: k / fps - 0.1 }]);
      const a = stats(plain.lum);
      const b = stats(blurred.lum);
      assert.ok(a.std > 20, `the film really has grain (std ${a.std.toFixed(1)})`);
      assert.ok(Math.abs(a.std - b.std) < 0.05, `grain strength at sub 4 equals sub 1 (${b.std.toFixed(2)} vs ${a.std.toFixed(2)}; was 0.71x)`);
      assert.deepEqual(blurred.lum, plain.lum, 'a still scene with per-frame grain renders identically with and without blur');
      const next = await seenAfter({ t: (k + 1) / fps, sub: 4, shutter: 0.5, fps });
      assert.ok(Math.abs(corr(blurred.lum, next.lum)) < 0.1, `consecutive frames stay independent (r ${corr(blurred.lum, next.lum).toFixed(3)}; was 0.5)`);
      // seek(t, blur): what the page-capture renderer sends for every screenshot it averages; a bad blur argument is ignored.
      const viaSeek = await film.page.evaluate(() => {
        window.__seen.length = 0;
        window.seek(10 / 60 + 0.002, { frameT: 10 / 60, sub: 2, subs: 4 });
        window.seek(10 / 60 + 0.002, { frameT: 'soon', sub: 2, subs: 4 });
        window.seek(10 / 60 + 0.002, 7);
        return window.__seen.map(({ frame, sub, subs, frameT }) => ({ frame, sub, subs, frameT }));
      });
      assert.deepEqual(viaSeek, [{ frame: 10, sub: 2, subs: 4, frameT: 10 / 60 }, { frame: 10, sub: 0, subs: 1, frameT: 10 / 60 + 0.002 }, { frame: 10, sub: 0, subs: 1, frameT: 10 / 60 + 0.002 }]);
      const thirty = await seenAfter({ t: 5 / 30, sub: 4, shutter: 0.5, fps: 30 });
      assert.deepEqual(thirty.seen.map((s) => s.frame), [10, 10, 10, 10], 'at a 30 fps render of a 60 fps film c.frame is still the film-fps index, shared by the subframes');
    } finally { await film.context.close(); }
  });
});

test('runtime: stepTime(c.frameLt) holds within an output frame, stepTime of the subframe time blends', { timeout: 240000 }, async (t) => {
  await withProject(t, { film: F3_FILM }, async ({ open }) => {
    const values = async (mode) => {
      const film = await open({ mode });
      try {
        assert.deepEqual(film.errors.page, []);
        await film.page.evaluate(DECODE);
        return await film.page.evaluate(async () => {
          const out = [];
          for (let k = 33; k <= 60; k++) {
            const lum = await window.__lum({ t: k / 60, sub: 4, shutter: 1, fps: 60 });
            out.push(Math.round(lum[0]));
          }
          return out;
        });
      } finally { await film.context.close(); }
    };
    const held = await values('twos');
    assert.ok(held.every((v) => v === 0 || v === 255), `on twos at 12 steps/s is a hard cut every 5 frames: ${held}`);
    assert.ok(held.includes(0) && held.includes(255));
    const blended = await values('twos-t');
    assert.ok(blended.some((v) => v > 20 && v < 235), `stepTime of the subframe time is a blend on the step frames: ${blended}`);
  });
});

const FONT_FILM = `import { defineFilm, scene } from '../lib/timeline.js';
import { text, kinetic } from '../lib/draw.js';
window.__fonts = [];
const P = CanvasRenderingContext2D.prototype;
const desc = Object.getOwnPropertyDescriptor(P, 'font'); // Chrome normalizes what ctx.font reads back, so record what was set
Object.defineProperty(P, 'font', { ...desc, set(v) { if (String(v).includes('"')) window.__fonts.push(String(v)); desc.set.call(this, v); } });
export default defineFilm(() => ({
  scenes: [scene(0, 4, 'type', (g, lt, c) => {
    text(g, 'Hamburg', 40, 100, { size: 48, color: '#fff' });
    kinetic(g, 'Kin', 40, 200, 5, { size: 48, stagger: 0 });
    text(g, 'Italic', 40, 300, { size: 48, style: 'italic' });
  })],
}));
`;

test('runtime: boot() makes brand.fonts.ui the default for text()/font() and brand.fonts.display the default for kinetic()', { timeout: 240000 }, async (t) => {
  // Swapped on purpose: the UI face is the 400-only serif, the display face is the variable sans.
  const studio = { brand: { name: '', url: '', colors: { bg: '#141413', fg: '#F0EEE6', accent: '#D97757', muted: '#6C6B73' }, fonts: { ui: 'Instrument Serif', display: 'Inter' } } };
  await withProject(t, { film: FONT_FILM, studio }, async ({ open }) => {
    const film = await open();
    try {
      assert.deepEqual(film.errors.page, []);
      const r = await film.page.evaluate(async () => {
        window.__fonts.length = 0;
        window.seek(1);
        const d = await import('/lib/draw.js');
        return { fonts: window.__fonts.slice(), defaults: d.getFontDefaults(), w: d.defaultWeight() };
      });
      assert.deepEqual(r.defaults, { text: 'Instrument Serif', kinetic: 'Inter' });
      assert.equal(r.w, 400, 'the UI face has only 400: the default weight is 400, not a synthetic 700');
      assert.deepEqual(r.fonts, ['normal 400 48px "Instrument Serif"', 'normal 700 48px "Inter"', 'italic 400 48px "Instrument Serif"'],
        'text(): UI face at 400 (the only weight it has); kinetic(): display face at 700 (inside its variable range); italic: the registered italic face');
    } finally { await film.context.close(); }
  });
});

test('runtime + NeoDunggeunmo: a Korean sentence wraps to lines that fit, on the 16 px grid', { timeout: 240000 }, async (t) => {
  const dir = koreanFontDir();
  if (!dir) { t.skip('neodunggeunmo-400.woff2 is not on this machine (set MOTION_TEST_KOREAN_FONT_DIR)'); return; }
  const studio = { brand: { name: '', url: '', colors: { bg: '#141413', fg: '#F0EEE6', accent: '#D97757', muted: '#6C6B73' }, fonts: { ui: 'NeoDunggeunmo', display: 'NeoDunggeunmo' } } };
  const film = `import { defineFilm, scene } from '../lib/timeline.js';
export default defineFilm(() => ({ scenes: [scene(0, 4, 'blank', () => {})] }));
`;
  await withProject(t, { film, studio, fontsDir: dir }, async ({ open }) => {
    const page = await open();
    try {
      assert.deepEqual(page.errors.page, []);
      const r = await page.page.evaluate(async () => {
        const { wrapText, font, textWidth, getFontDefaults, defaultWeight } = await import('/lib/draw.js');
        const { fitFontSize } = await import('/lib/layout.js');
        const g = document.createElement('canvas').getContext('2d');
        const sentence = '에뮬레이션을 한국어로 만들면 긴 문장도 어절 단위로 자연스럽게 줄바꿈되어야 합니다.';
        const css = font(32, 'NeoDunggeunmo');
        const maxW = 400;
        const lines = wrapText(g, sentence, maxW, css);
        const tracked = wrapText(g, sentence, maxW, css, { tracking: 0.1 });
        const chars = wrapText(g, sentence, maxW, css, { breakWords: 'char' });
        const long = wrapText(g, '가'.repeat(40), maxW, css);
        const widths = (arr, tr = 0) => arr.map((l) => textWidth(g, l, css, tr));
        const fit = fitFontSize(g, '에뮬레이션을 한국어로', 500, (s) => font(s, 'NeoDunggeunmo'), { step: 16 });
        const fitTracked = fitFontSize(g, '에뮬레이션을 한국어로', 500, (s) => font(s, 'NeoDunggeunmo'), { step: 16, tracking: 0.1 });
        const one = (s, tr = 0) => textWidth(g, '에뮬레이션을 한국어로', font(s, 'NeoDunggeunmo'), tr);
        return { sentence, css, lines, tracked, chars, long, w: widths(lines), wt: widths(tracked, 0.1), wc: widths(chars), wl: widths(long), fit, fitTracked, fitW: one(fit), nextW: one(fit + 16), fitTW: one(fitTracked, 0.1), nextTW: one(fitTracked + 16, 0.1), defaults: getFontDefaults(), weight: defaultWeight() };
      });
      assert.equal(r.css, 'normal 400 32px "NeoDunggeunmo"', 'no weight given: the only registered weight');
      assert.deepEqual(r.defaults, { text: 'NeoDunggeunmo', kinetic: 'NeoDunggeunmo' });
      assert.ok(r.lines.length >= 3, `the sentence needs several lines: ${JSON.stringify(r.lines)}`);
      assert.equal(r.lines.join(' '), r.sentence, 'eojeol stay whole and nothing is lost');
      assert.ok(r.w.every((w) => w <= 400), `every line fits: ${r.w}`);
      assert.ok(r.lines.every((l) => !/^[.,!?)]/.test(l)));
      assert.ok(r.tracked.length >= r.lines.length && r.wt.every((w) => w <= 400), `tracked lines fit: ${r.wt}`);
      assert.equal(r.chars.join('').replace(/ /g, ''), r.sentence.replace(/ /g, ''));
      assert.ok(r.chars.length <= r.lines.length && r.wc.every((w) => w <= 400), 'char mode packs at least as tightly');
      assert.ok(r.long.length >= 3 && r.long.every((l) => [...l].every((c) => c === '가')) && r.wl.every((w) => w <= 400), `a 40-syllable word is cut between syllables: ${r.long}`);
      assert.equal(r.fit % 16, 0);
      assert.ok(r.fit >= 16 && r.fitW <= 500 && r.nextW > 500, `fitFontSize step 16: ${r.fit} fits (${r.fitW}), ${r.fit + 16} does not (${r.nextW})`);
      assert.equal(r.fitTracked % 16, 0);
      assert.ok(r.fitTW <= 500 && r.nextTW > 500, `with tracking: ${r.fitTracked} fits (${r.fitTW}), ${r.fitTracked + 16} does not (${r.nextTW})`);
      assert.ok(r.fitTracked <= r.fit);
    } finally { await page.context.close(); }
  });
});
