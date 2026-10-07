// Tests for the text-use registry (lib/draw.js recordText/getTextUse/setTextTracking, boot() in lib/runtime.js) and the
// glyph check behind window.__studio.coverage() (lib/fonts.js coverage):
//  1. font strings: firstFamily() and parseFontSpec() read CSS font stacks and what a canvas gives back for ctx.font;
//  2. the registry on a fake canvas: off = nothing recorded and identical drawing, on = the characters text(), kinetic(),
//     textWidth(), wrapText(), fitFontSize() and recordText() handle, per { family, weight, style }, sorted and de-duplicated;
//  3. browser (skips without playwright or a browser): boot() with ?texttrack=1 or window.__TEXT_TRACK__ = true exposes
//     __studio.textUse() and __studio.coverage(): Hangul drawn with Inter (Latin only) is reported missing, drawn with
//     NeoDunggeunmo (skips without that font file) none is; every frame hash is identical with tracking on and off.
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
// 1. font strings

test('firstFamily: first name of a CSS list, quotes stripped, case kept, quote-aware', () => {
  assert.equal(F.firstFamily('Inter'), 'Inter');
  assert.equal(F.firstFamily('"Instrument Serif", serif'), 'Instrument Serif');
  assert.equal(F.firstFamily("'Noto Sans KR', sans-serif"), 'Noto Sans KR');
  assert.equal(F.firstFamily('Noto Sans KR, sans-serif'), 'Noto Sans KR');
  assert.equal(F.firstFamily('"A, B", serif'), 'A, B', 'a comma inside quotes does not end the name');
  assert.equal(F.firstFamily('  sans-serif '), 'sans-serif');
  assert.equal(F.firstFamily(''), '');
  assert.equal(F.firstFamily(null), '');
  assert.deepEqual(F.registeredFaces('"A, B", serif'), []);
});

test('parseFontSpec: style, weight and first family of a CSS font shorthand, as written or as a canvas reads it back', () => {
  const p = (s) => { const r = F.parseFontSpec(s); return r && [r.style, r.weight, r.size, r.family]; };
  assert.deepEqual(p('normal 700 48px "Instrument Serif"'), ['normal', '700', '48px', 'Instrument Serif']);
  assert.deepEqual(p('italic 400 12.5px "A, B", serif'), ['italic', '400', '12.5px', 'A, B']);
  assert.deepEqual(p('bold 20px Inter, sans-serif'), ['normal', '700', '20px', 'Inter']);
  assert.deepEqual(p('italic bold 20px/1.5 \'Noto Sans KR\''), ['italic', '700', '20px', 'Noto Sans KR']);
  assert.deepEqual(p('700 40px Inter'), ['normal', '700', '40px', 'Inter'], 'a canvas drops "normal" when it reads ctx.font back');
  assert.deepEqual(p('20px sans-serif'), ['normal', '400', '20px', 'sans-serif']);
  assert.deepEqual(p('oblique 10deg 400 20px Foo'), ['oblique', '400', '20px', 'Foo']);
  assert.deepEqual(p('normal normal 500 small-caps 16.5PX Foo Bar'), ['normal', '500', '16.5PX', 'Foo Bar'], 'variant keywords and units in any case');
  assert.deepEqual(p('bolder 2em Foo'), ['normal', 'bolder', '2em', 'Foo']);
  assert.deepEqual(p('1000 20px Foo'), ['normal', '1000', '20px', 'Foo']);
  for (const bad of ['', 'bold', '20px', '20px ,', 'italic 700', null, undefined]) assert.equal(F.parseFontSpec(bad), null, String(bad));
});

test('font(): generic families stay unquoted, others are quoted (GENERIC_FAMILIES moved to lib/fonts.js)', () => {
  assert.equal(D.font(20, 'sans-serif', 400), 'normal 400 20px sans-serif');
  assert.equal(D.font(20, 'system-ui', 400), 'normal 400 20px system-ui');
  assert.equal(D.font(20, 'Some Font', 400), 'normal 400 20px "Some Font"');
  assert.equal(D.font(20, '"Some Font", serif', 400), 'normal 400 20px "Some Font", serif');
  for (const g of ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace']) assert.ok(F.GENERIC_FAMILIES.has(g), g);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. the registry on a fake canvas (per-character advance table, Chrome's letterSpacing semantics)

function adv(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0xac00 && cp <= 0xd7a3) return 1;
  if (ch === ' ') return 0.3;
  return cp < 0x300 ? 0.5 : 1;
}
function fakeCtx() {
  const stack = [];
  const fills = [];
  const props = ['font', 'letterSpacing', 'fillStyle', 'globalAlpha', 'textBaseline', 'textAlign'];
  return {
    font: '10px sans-serif', letterSpacing: '0px', fillStyle: '#000', globalAlpha: 1, textBaseline: 'alphabetic', textAlign: 'left',
    fills,
    save() { stack.push(Object.fromEntries(props.map((k) => [k, this[k]]))); },
    restore() { Object.assign(this, stack.pop()); },
    measureText(s) {
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
      const px = m ? Number(m[1]) : 10;
      const ls = parseFloat(this.letterSpacing) || 0;
      return { width: [...s].reduce((w, ch) => w + adv(ch) * px + ls, 0) };
    },
    fillText(s, x, y) { fills.push({ s, x: Math.round(x * 1000) / 1000, y, font: this.font, a: this.globalAlpha }); },
    beginPath() {}, rect() {}, clip() {},
  };
}

/** Runs body with the registry on (and empty), and puts it back afterwards. */
function tracked(body) {
  D.setTextTracking(true);
  D.resetTextUse();
  try { return body(); } finally { D.setTextTracking(false); D.resetTextUse(); }
}
const use = () => D.getTextUse();
const asMap = (list) => Object.fromEntries(list.map((u) => [`${u.family}|${u.weight}|${u.style}`, u.chars]));

test('registry is off by default: nothing is recorded, drawing is the same', () => {
  assert.equal(D.isTextTracking(), false, 'off unless window.__TEXT_TRACK__ === true or ?texttrack=1 turned it on');
  D.resetTextUse();
  const g = fakeCtx();
  D.text(g, '한글 abc', 10, 20, { size: 30, family: 'Inter', weight: 400 });
  D.kinetic(g, 'kin', 10, 20, 5, { size: 30, family: 'Inter', weight: 400 });
  D.textWidth(g, 'width', '400 30px "Inter"');
  D.wrapText(g, 'wrap me', 100, '400 30px "Inter"');
  L.fitFontSize(g, 'fit', 200, (s) => `400 ${s}px "Inter"`);
  D.recordText('raw', '400 30px "Inter"');
  assert.deepEqual(use(), []);
});

test('text(): family, weight, style and the sorted unique non-whitespace characters', () => {
  tracked(() => {
    const g = fakeCtx();
    D.text(g, 'ba 가\ta\nb', 10, 20, { size: 30, family: 'Inter', weight: 700 });
    D.text(g, 'zz Z', 10, 60, { size: 30, family: 'Inter', weight: 700 });
    D.text(g, '\u{1F600}x', 10, 90, { size: 30, family: 'Inter', weight: 700 });
    assert.deepEqual(use(), [{ family: 'Inter', weight: '700', style: 'normal', chars: 'Zabxz가\u{1F600}' }], 'sorted by code point; a surrogate pair is one character; blanks and controls are not recorded');
    assert.equal(g.fills.length, 3, 'and the text was drawn as usual');
  });
});

test('text(): the weight is the one drawn (a registered default, or bold/normal keywords), the family is the first name, style is kept', () => {
  F.registerFaces([{ family: 'Use Pixel', weight: '400', style: 'normal' }]);
  const warn = console.warn;
  console.warn = () => {}; // weight 'bold' on a 400-only face warns once; draw.test.mjs covers that message
  try {
    tracked(() => {
      const g = fakeCtx();
      D.text(g, 'p', 0, 0, { family: 'Use Pixel' });
      D.text(g, 'q', 0, 0, { family: 'Use Pixel', weight: 'bold' });
      D.text(g, 'r', 0, 0, { family: '"Noto Sans KR", sans-serif', weight: 'normal', style: 'italic' });
      D.text(g, 's', 0, 0, { family: 'Elsewhere', weight: 300, style: 'italic' });
      D.text(g, 't', 0, 0, { family: 'Elsewhere', weight: 300, style: 'italic' });
      D.text(g, 'u', 0, 0, { family: 'ELSEWHERE', weight: '300', style: 'italic' });
      assert.deepEqual(use(), [
        { family: 'Elsewhere', weight: '300', style: 'italic', chars: 'stu' },
        { family: 'Noto Sans KR', weight: '400', style: 'italic', chars: 'r' },
        { family: 'Use Pixel', weight: '400', style: 'normal', chars: 'p' },
        { family: 'Use Pixel', weight: '700', style: 'normal', chars: 'q' },
      ], 'a 400-only face draws 400 by default; bold is 700; family case-variants are one font (first spelling kept)');
    });
  } finally { console.warn = warn; }
});

test('text(): what is not drawn is not recorded (empty text, alpha 0, a non-finite position)', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    tracked(() => {
      const g = fakeCtx();
      D.text(g, '', 0, 0, { family: 'Skip', weight: 400 });
      D.text(g, null, 0, 0, { family: 'Skip', weight: 400 });
      D.text(g, 'hidden', 0, 0, { family: 'Skip', weight: 400, alpha: 0 });
      D.text(g, 'nan', Number.NaN, 0, { family: 'Skip', weight: 400 });
      D.text(g, '   ', 0, 0, { family: 'Blank', weight: 400 });
      assert.deepEqual(use(), [], 'spaces alone need no glyph, so that font is not listed either');
      assert.equal(g.fills.length, 1, 'only the blank string reached the canvas');
    });
  } finally { console.warn = warn; }
});

test('kinetic(): the whole string is recorded as soon as it is called, by character or by word', () => {
  tracked(() => {
    const g = fakeCtx();
    D.kinetic(g, 'ab 가', 10, 20, -5, { size: 30, family: 'Inter', weight: 500 }); // lt < 0: nothing has sprung in yet
    assert.equal(g.fills.length, 0, 'no glyph was drawn on this frame');
    D.kinetic(g, 'wd 한', 10, 20, 5, { size: 30, family: 'Inter', weight: 500, by: 'word' });
    D.kinetic(g, 'x', 10, 20, 5, { size: 30, family: 'Inter', weight: 500, mask: true });
    D.kinetic(g, '', 10, 20, 5, { size: 30, family: 'Empty' });
    assert.deepEqual(use(), [{ family: 'Inter', weight: '500', style: 'normal', chars: 'abdwx가한' }]);
  });
});

test('textWidth(), wrapText() and fitFontSize() record what they measure with the font they measure it in', () => {
  tracked(() => {
    const g = fakeCtx();
    D.textWidth(g, 'width 폭', 'italic 700 30px "Meas Font", serif', 0.02);
    D.wrapText(g, 'wrap 줄 me', 100, '400 20px "Wrap Font"');
    L.fitFontSize(g, ['fit 맞', 'z'], 400, (s) => `bold ${s}px 'Fit Font'`);
    L.fitFontSize(g, 'tr', 400, (s) => `400 ${s}px "Fit Font"`, { tracking: 0.05, step: 8 });
    D.textWidth(g, 'unreadable font', 'not a font string');
    D.textWidth(g, '', '400 20px "Empty"');
    assert.deepEqual(asMap(use()), {
      'Fit Font|400|normal': 'rt',
      'Fit Font|700|normal': 'fitz맞',
      'Meas Font|700|italic': 'dhitw폭',
      'Wrap Font|400|normal': 'aemprw줄',
    });
    assert.equal(g.font, '10px sans-serif', 'measuring still restores the context font');
  });
});

test('recordText(): a film that draws with g.fillText itself can report the text and font', () => {
  tracked(() => {
    D.recordText('raw text', 'normal 500 24px "Raw Font"');
    D.recordText('more', 'normal 500 24px "Raw Font"');
    D.recordText('nothing', 'nonsense');
    D.recordText(null, '400 10px Foo');
    D.recordText(42, '400 10px Foo');
    assert.deepEqual(asMap(use()), { 'Foo|400|normal': '24', 'Raw Font|500|normal': 'aemortwx' });
  });
});

test('recording changes nothing that is drawn or measured', () => {
  F.registerFaces([{ family: 'Same Pixel', weight: '400', style: 'normal' }]);
  const scene = (g) => {
    D.text(g, '한글 abc', 10.5, 20, { size: 30, family: 'Same Pixel', tracking: 0.05, align: 'center' });
    D.kinetic(g, 'Hangul 한글', 10, 90, 0.12, { size: 44, family: 'Same Pixel', mask: true, align: 'right' });
    D.kinetic(g, 'two words', 10, 90, 0.4, { size: 44, family: 'Same Pixel', by: 'word', tracking: 0.02 });
    const w = D.textWidth(g, 'measure', '400 30px "Same Pixel"', 0.1);
    const lines = D.wrapText(g, '줄바꿈 wrap 테스트 문장 입니다', 120, '400 20px "Same Pixel"');
    const fit = L.fitFontSize(g, 'fit 맞춤', 300, (s) => `400 ${s}px "Same Pixel"`, { step: 8 });
    return { w, lines, fit };
  };
  const off = fakeCtx();
  const a = scene(off);
  const on = tracked(() => {
    const g = fakeCtx();
    return { g, r: scene(g), u: use() };
  });
  assert.deepEqual(on.g.fills, off.fills, 'the same fillText calls (text, position, font, alpha)');
  assert.deepEqual(on.r, a, 'the same widths, lines and fitted size');
  assert.ok(on.u.length === 1 && on.u[0].chars.includes('한') && on.u[0].chars.includes('맞'), JSON.stringify(on.u));
});

test('resetTextUse() forgets; many frames of changing strings stay one small entry per font', () => {
  tracked(() => {
    const g = fakeCtx();
    for (let f = 0; f < 3000; f++) {
      D.text(g, `frame ${f}`, 10, 20, { size: 30, family: 'Inter', weight: 400 });
      D.kinetic(g, f % 2 ? '가나다' : '라마바', 10, 60, f / 60, { size: 30, family: 'Inter', weight: 700 });
      D.text(g, 'same every frame', 10, 100, { size: 30 + (f % 7), family: 'Inter', weight: 400 });
    }
    const u = asMap(use());
    assert.deepEqual(Object.keys(u), ['Inter|400|normal', 'Inter|700|normal']);
    assert.equal(u['Inter|400|normal'], '0123456789aefmrsvy');
    assert.equal(u['Inter|700|normal'], '가나다라마바');
    D.resetTextUse();
    assert.deepEqual(use(), []);
    D.text(g, 'same every frame', 10, 20, { size: 30, family: 'Inter', weight: 400 });
    assert.deepEqual(use(), [{ family: 'Inter', weight: '400', style: 'normal', chars: 'aefmrsvy' }], 'a string seen before the reset is recorded again');
  });
});

test('an unregistered or generic family is not rejected by text()/kinetic(): it is drawn, recorded, and left to textUse()/coverage()', () => {
  // Boot-time validation covers brand.fonts only (runtime.js assertBrandFonts, an async document.fonts check). A per-call family is
  // legal (system fonts, emoji faces), and a synchronous throw inside paint() would kill a whole render for it.
  const warn = console.warn;
  const said = [];
  console.warn = (...a) => said.push(a.join(' '));
  try {
    tracked(() => {
      const g = fakeCtx();
      assert.doesNotThrow(() => {
        D.text(g, 'sys', 0, 0, { family: 'Some System Face', size: 20 });
        D.text(g, 'gen', 0, 0, { family: 'sans-serif', size: 20, weight: 400 });
        D.text(g, 'emo', 0, 0, { family: '"Apple Color Emoji", "Segoe UI Emoji"', size: 20 });
        D.kinetic(g, 'kin', 0, 0, 5, { family: 'Some System Face', size: 20 });
      });
      assert.equal(g.fills.length, 6, 'the text is drawn (3 text() calls and 3 kinetic() letters)');
      assert.deepEqual(asMap(use()), {
        'Apple Color Emoji|700|normal': 'emo',
        'Some System Face|700|normal': 'iknsy',
        'sans-serif|400|normal': 'egn',
      }, 'the family is listed as written (first name of the stack), default weight 700 when nothing is known about it');
    });
  } finally { console.warn = warn; }
  assert.deepEqual(said, [], 'no warning either: nothing is known about a family that was never registered');
});

test('textWidth() with hundreds of distinct font strings stays correct once the request memo is full', () => {
  tracked(() => {
    const g = fakeCtx();
    for (let size = 10; size < 700; size++) D.textWidth(g, size % 2 ? 'odd' : 'even', `400 ${size}px "Memo Font"`); // > 512 distinct requests
    D.textWidth(g, 'after', '700 20px "Other Font"');
    D.textWidth(g, 'again', '400 900px "Memo Font"');
    assert.deepEqual(asMap(use()), { 'Memo Font|400|normal': 'adeginov', 'Other Font|700|normal': 'aefrt' });
  });
});

test('coverage() and the boot wiring: errors in Node, and runtime.js reads both switches', async () => {
  await assert.rejects(() => F.coverage('', '400', 'normal', 'a'), /family is required/);
  await assert.rejects(() => F.coverage('Inter', '400', 'normal', 'a'), /needs a browser canvas/, 'outside a browser there is no canvas to rasterize on');
  const src = fs.readFileSync(path.join(TEMPLATE, 'lib', 'runtime.js'), 'utf8');
  assert.match(src, /window\.__TEXT_TRACK__ === true/);
  assert.match(src, /params\.get\('texttrack'\)/);
  assert.match(src, /textUse: \(\) => Promise\.resolve\(getTextUse\(\)\)/);
  assert.match(src, /^\s+coverage,$/m, 'the coverage check is the one in lib/fonts.js, not a copy');
  assert.match(src, /get textTrack\(\) \{ return isTextTracking\(\); \}/, 'textTrack follows the registry instead of a value frozen at boot');
});

// ---------------------------------------------------------------------------------------------------------------
// 3. browser: the real runtime

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
async function withProject(t, { film, fontsDir = path.join(TEMPLATE, 'assets', 'fonts') }, body) {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-textuse-'));
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify({ title: 'TextUse', duration: 4, fps: 60, subframes: 4, shutter: 0.5, formats: ['1x1'], primaryFormat: '1x1', capture: 'canvas', gate: { enabled: false } }));
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

const sortedChars = (s) => [...new Set([...s].filter((c) => !/\s/.test(c)))].sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).join('');
const HANGUL = '한글은 아름답다';
const SYSTEM = '시스템 글꼴';

const koFilm = (neo) => `import { defineFilm, scene } from '../lib/timeline.js';
import { text, kinetic, wrapText, font } from '../lib/draw.js';
import { fitFontSize } from '../lib/layout.js';
export default defineFilm(() => ({
  background: '#141413',
  scenes: [scene(0, 4, 'type', (g, lt, c) => {
    text(g, ${JSON.stringify(HANGUL)}, 60, 200, { size: 64, family: 'Inter' });
    text(g, 'Latin only', 60, 300, { size: 64, family: 'Instrument Serif', weight: 400 });
    kinetic(g, 'Kinetic', 60, 400, lt + 0.3, { size: 64, family: 'Inter', weight: 500 });
    kinetic(g, 'late', 60, 500, lt - 3, { size: 64, family: 'Instrument Serif', weight: 400, style: 'italic' });
    text(g, ${JSON.stringify(SYSTEM)}, 60, 800, { size: 40, family: 'Not Registered Sans' });
    text(g, 'generic', 60, 860, { size: 40, family: 'sans-serif', weight: 400 });
    ${neo ? `text(g, ${JSON.stringify(HANGUL)}, 60, 600, { size: 64, family: 'NeoDunggeunmo' });
    const lines = wrapText(g, '줄바꿈 테스트', 300, font(32, 'NeoDunggeunmo'));
    lines.forEach((l, i) => text(g, l, 60, 700 + i * 50, { size: 32, family: 'NeoDunggeunmo' }));
    fitFontSize(g, '맞춤', 400, (s) => font(s, 'NeoDunggeunmo'));` : ''}
  })],
}));
`;

test('Chrome: textUse() lists what was drawn per font; coverage() reports Hangul missing for Inter and none for NeoDunggeunmo', { timeout: 240000 }, async (t) => {
  const dir = koreanFontDir();
  await withProject(t, { film: koFilm(!!dir), ...(dir ? { fontsDir: dir } : {}) }, async ({ open }) => {
    const film = await open({ texttrack: 1 });
    try {
      assert.deepEqual(film.errors.page, []);
      const r = await film.page.evaluate(async () => {
        const s = window.__studio;
        const before = await s.textUse(); // frame 0 is painted at boot
        for (const t of [0.5, 1, 2, 3.5]) window.seek(t);
        const use = await s.textUse();
        const covers = {};
        for (const u of use) covers[`${u.family}|${u.weight}|${u.style}`] = await s.coverage(u.family, u.weight, u.style, u.chars);
        return {
          track: s.textTrack, before, use, covers,
          viaList: await s.coverage('"Inter", sans-serif', 400, 'normal', ['한글', 'abc']),
          nothing: await s.coverage('Inter', '400', 'normal', ' \n\t'),
          unloaded: await s.coverage('Not A Loaded Family', '400', 'normal', 'abc'),
          types: { textUse: typeof s.textUse, coverage: typeof s.coverage },
        };
      });
      assert.equal(r.track, true, '__studio.textTrack says the registry is on');
      assert.deepEqual(r.types, { textUse: 'function', coverage: 'function' });
      assert.ok(r.before.length >= 2, 'frame 0 is already recorded');
      const byKey = Object.fromEntries(r.use.map((u) => [`${u.family}|${u.weight}|${u.style}`, u.chars]));
      assert.equal(byKey['Inter|700|normal'], sortedChars(HANGUL), 'text() without a weight: Inter is variable, so 700');
      assert.equal(byKey['Instrument Serif|400|normal'], sortedChars('Latin only'));
      assert.equal(byKey['Inter|500|normal'], sortedChars('Kinetic'));
      assert.equal(byKey['Instrument Serif|400|italic'], sortedChars('late'), 'kinetic() before its start time (lt < 0) is recorded too');
      // An unregistered or generic family is not rejected by text() (no page error above): it is listed, and nothing in it is covered.
      assert.equal(byKey['Not Registered Sans|700|normal'], sortedChars(SYSTEM), 'an unregistered family is recorded as written');
      assert.equal(byKey['sans-serif|400|normal'], sortedChars('generic'));
      if (dir) {
        assert.equal(byKey['NeoDunggeunmo|400|normal'], sortedChars(`${HANGUL}줄바꿈 테스트맞춤`), 'text(), wrapText() and fitFontSize() with the bitmap face; weight = the only one it has');
        assert.equal(r.use.length, 7);
      } else assert.equal(r.use.length, 6);
      assert.equal(r.covers['Not Registered Sans|700|normal'].missing, sortedChars(SYSTEM), 'a family that was never registered has no glyph of its own');
      assert.equal(r.covers['sans-serif|400|normal'].missing, sortedChars('generic'), 'nor does a generic name: only a bundled face counts');
      // The point of it all: Hangul in a Latin-only face is a tofu box or a system font, and coverage() says so.
      assert.equal(r.covers['Inter|700|normal'].missing, sortedChars(HANGUL), 'every Hangul syllable of the film is missing from Inter');
      assert.equal(r.covers['Inter|700|normal'].checked, sortedChars(HANGUL).length);
      assert.equal(r.covers['Instrument Serif|400|normal'].missing, '');
      assert.equal(r.covers['Inter|500|normal'].missing, '');
      if (dir) {
        assert.equal(r.covers['NeoDunggeunmo|400|normal'].missing, '', 'NeoDunggeunmo has every syllable the film draws');
        assert.ok(r.covers['NeoDunggeunmo|400|normal'].checked > 10);
      }
      assert.deepEqual(r.viaList, { missing: '글한', checked: 5 }, 'a CSS list counts by its first name; chars may be an array; the result is sorted');
      assert.deepEqual(r.nothing, { missing: '', checked: 0 }, 'blank characters are not checked');
      assert.equal(r.unloaded.missing, 'abc', 'a family that is not loaded has no glyph of its own');
    } finally { await film.context.close(); }
  });
});

test('Chrome: tracking off records nothing, and every frame hash is identical with tracking on (?texttrack=1 or window.__TEXT_TRACK__)', { timeout: 240000 }, async (t) => {
  const dir = koreanFontDir();
  await withProject(t, { film: koFilm(!!dir), ...(dir ? { fontsDir: dir } : {}) }, async ({ open, srv, browser }) => {
    const sample = () => window.__studio.textUse().then(async (use) => {
      const s = window.__studio;
      const hashes = [];
      for (const t of [0, 0.25, 0.5, 1, 2, 3.9]) {
        hashes.push(await s.hash({ t, sub: 1 }));
        hashes.push(await s.hash({ t, sub: 4, shutter: 0.5 }));
      }
      return { track: s.textTrack, hashes, use: await s.textUse(), before: use };
    });
    const off = await open();
    let base;
    let toggled;
    try {
      assert.deepEqual(off.errors.page, []);
      base = await off.page.evaluate(sample);
      // __studio.textTrack follows setTextTracking(), so a switch made after boot is reported (and only later frames are recorded).
      toggled = await off.page.evaluate(async () => {
        const d = await import('/lib/draw.js'); // the module instance the film and the runtime already use
        const s = window.__studio;
        const a = s.textTrack;
        d.setTextTracking(true);
        const b = s.textTrack;
        window.seek(1);
        const use = await s.textUse();
        d.setTextTracking(false);
        return { a, b, c: s.textTrack, families: use.map((u) => u.family) };
      });
    } finally { await off.context.close(); }
    assert.deepEqual([toggled.a, toggled.b, toggled.c], [false, true, false]);
    assert.ok(toggled.families.includes('Inter') && toggled.families.includes('Instrument Serif'), `frames painted after the switch are recorded: ${toggled.families}`);
    assert.equal(base.track, false);
    assert.deepEqual(base.before, [], 'nothing recorded at boot');
    assert.deepEqual(base.use, [], 'nothing recorded after painting 12 frames');
    assert.equal(new Set(base.hashes).size >= 3, true, `the film really changes over time (${new Set(base.hashes).size} distinct hashes)`);

    const viaQuery = await open({ texttrack: 1 });
    try {
      const on = await viaQuery.page.evaluate(sample);
      assert.equal(on.track, true);
      assert.deepEqual(on.hashes, base.hashes, '?texttrack=1: pixels identical with the registry on');
      assert.ok(on.use.length >= 4);
    } finally { await viaQuery.context.close(); }

    // window.__TEXT_TRACK__ set before the page loads (the critique's route): its own context with an init script.
    const context = await browser.newContext({ viewport: { width: 270, height: 270 }, deviceScaleFactor: 1 });
    try {
      await context.addInitScript(() => { window.__RENDER__ = true; window.__TEXT_TRACK__ = true; });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${srv.url}/index.html?render=1&format=1x1&scale=0.25`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__studio && window.__studio.ready, null, { timeout: 60000 });
      await page.evaluate(() => window.__studio.ready);
      const on = await page.evaluate(sample);
      assert.deepEqual(errors, []);
      assert.equal(on.track, true);
      assert.deepEqual(on.hashes, base.hashes, 'window.__TEXT_TRACK__: pixels identical with the registry on');
      assert.ok(on.use.some((u) => u.family === 'Inter' && u.chars.includes('한')));
    } finally { await context.close(); }
  });
});
