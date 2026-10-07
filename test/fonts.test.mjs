// Tests for Korean/CJK font support: lib/fonts.js (entry parsing, sliced fonts, sample probes, glyph coverage) and
// tools/fonts.mjs (add-file, sniffing, the Google slice gate, coverage). Everything runs offline: the network layer is
// injected, and the "fonts" are a tiny TrueType file built here (with a Hangul glyph and its own .notdef box), so no
// licensed font ships in test/. The browser tests skip unless playwright resolves and a Chromium browser launches.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'fonts');
const F = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'fonts.mjs')).href);
const L = await import(pathToFileURL(path.join(TEMPLATE, 'lib', 'fonts.js')).href);
const S = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'studio.mjs')).href);

// Every directory a test makes is removed after the last test (a browser test may leave a node_modules junction: unlink it first,
// or the recursive delete would walk into the shared node_modules).
const made = [];
const tmp = (prefix = 'ms-fonts-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => {
  for (const d of made.splice(0)) {
    const link = path.join(d, 'node_modules');
    try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no link */ }
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
const read = (...p) => fs.readFileSync(path.join(...p));
const readJson = (...p) => JSON.parse(read(...p).toString('utf8'));
const exists = (...p) => fs.existsSync(path.join(...p));

// ---------------------------------------------------------------------------------------------------------------
// A minimal TrueType font: glyph 0 is a drawn .notdef box, then rectangles for A, B, 가 (U+AC00) and 나 (U+B098). Every
// glyph has a different shape, so no two characters share a raster.

function buildTtf(family = 'Synth') {
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0]]; // clockwise: an outer contour
  const hole = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; // counter-clockwise: a counter
  const glyphs = [
    { name: '.notdef', contours: [rect(100, 0, 700, 700), hole(200, 100, 600, 600)] },
    { name: 'A', code: 0x41, contours: [rect(100, 0, 700, 700)] },
    { name: 'B', code: 0x42, contours: [rect(100, 0, 300, 700), rect(400, 0, 700, 300)] },
    { name: 'ga', code: 0xac00, contours: [rect(100, 500, 700, 700), rect(100, 0, 300, 500)] },
    { name: 'na', code: 0xb098, contours: [rect(100, 0, 300, 700), rect(300, 300, 700, 500)] },
  ];
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
  const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const sum = (b) => { const p = pad4(b); let s = 0; for (let i = 0; i < p.length; i += 4) s = (s + p.readUInt32BE(i)) >>> 0; return s; };

  const glyf = [];
  const loca = [0];
  let maxPoints = 0;
  let maxContours = 0;
  for (const g of glyphs) {
    const pts = g.contours.flat();
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    maxPoints = Math.max(maxPoints, pts.length);
    maxContours = Math.max(maxContours, g.contours.length);
    let end = -1;
    const ends = g.contours.map((c) => (end += c.length));
    let px = 0;
    let py = 0;
    const dx = [];
    const dy = [];
    for (const [x, y] of pts) { dx.push(i16(x - px)); dy.push(i16(y - py)); px = x; py = y; }
    const data = Buffer.concat([i16(g.contours.length), i16(Math.min(...xs)), i16(Math.min(...ys)), i16(Math.max(...xs)), i16(Math.max(...ys)),
      ...ends.map(u16), u16(0), Buffer.alloc(pts.length, 0x01), ...dx, ...dy]);
    g.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    glyf.push(pad4(data));
    loca.push(loca.at(-1) + pad4(data).length);
  }
  const mapped = glyphs.map((g, i) => [g.code, i]).filter(([c]) => c !== undefined).sort((a, b) => a[0] - b[0]);
  const segs = [...mapped.map(([c, i]) => ({ start: c, end: c, delta: (i - c) & 0xffff })), { start: 0xffff, end: 0xffff, delta: 1 }];
  const sc = segs.length;
  const pow = 2 ** Math.floor(Math.log2(sc));
  const sub = Buffer.concat([u16(4), u16(16 + sc * 8), u16(0), u16(sc * 2), u16(pow * 2), u16(Math.log2(pow)), u16(sc * 2 - pow * 2),
    ...segs.map((s) => u16(s.end)), u16(0), ...segs.map((s) => u16(s.start)), ...segs.map((s) => u16(s.delta)), ...segs.map(() => u16(0))]);
  const cmap = Buffer.concat([u16(0), u16(1), u16(3), u16(1), u32(12), sub]);
  const head = Buffer.concat([u32(0x00010000), u32(0x00010000), u32(0), u32(0x5f0f3cf5), u16(3), u16(1000), Buffer.alloc(16), i16(0), i16(0), i16(800), i16(700),
    u16(0), u16(8), i16(2), i16(1), i16(0)]);
  const hhea = Buffer.concat([u32(0x00010000), i16(800), i16(-200), i16(0), u16(800), i16(0), i16(0), i16(800), i16(1), i16(0), i16(0), Buffer.alloc(8), i16(0), u16(glyphs.length)]);
  const maxp = Buffer.concat([u32(0x00010000), u16(glyphs.length), u16(maxPoints), u16(maxContours), u16(0), u16(0), u16(2), ...Array(8).fill(u16(0))]);
  const hmtx = Buffer.concat(glyphs.flatMap((g) => [u16(800), i16(g.bbox[0])]));
  const str = (s) => Buffer.from(s, 'utf16le').swap16();
  const names = [[1, family], [2, 'Regular'], [4, family], [6, family.replace(/\s/g, '')]].map(([id, s]) => ({ id, s: str(s) }));
  let off = 0;
  const nameRecs = names.map((n) => { const r = Buffer.concat([u16(3), u16(1), u16(0x409), u16(n.id), u16(n.s.length), u16(off)]); off += n.s.length; return r; });
  const name = Buffer.concat([u16(0), u16(names.length), u16(6 + names.length * 12), ...nameRecs, ...names.map((n) => n.s)]);
  const os2 = Buffer.concat([u16(3), i16(700), u16(400), u16(5), u16(0), i16(650), i16(600), i16(0), i16(75), i16(650), i16(600), i16(0), i16(350), i16(50), i16(250), i16(0),
    Buffer.alloc(10), u32(1), u32(0), u32(0), u32(0), Buffer.from('TEST'), u16(0x40), u16(0x41), u16(0xb098), i16(800), i16(-200), i16(0), u16(800), u16(200), u32(1), u32(0),
    i16(500), i16(700), u16(0), u16(0x20), u16(1)]);
  const post = Buffer.concat([u32(0x00030000), u32(0), i16(-100), i16(50), u32(0), u32(0), u32(0), u32(0), u32(0)]);
  const tables = { 'OS/2': os2, cmap, glyf: Buffer.concat(glyf), head, hhea, hmtx, loca: Buffer.concat(loca.map(u32)), maxp, name, post };
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const sr = 16 * 2 ** Math.floor(Math.log2(n));
  const dir = [u32(0x00010000), u16(n), u16(sr), u16(Math.floor(Math.log2(n))), u16(n * 16 - sr)];
  let at = 12 + n * 16;
  const body = [];
  for (const tag of tags) {
    const t = tables[tag];
    dir.push(Buffer.from(tag, 'latin1'), u32(sum(t)), u32(at), u32(t.length));
    body.push(pad4(t));
    at += pad4(t).length;
  }
  const file = Buffer.concat([...dir, ...body]);
  const headAt = 12 + n * 16 + tags.slice(0, tags.indexOf('head')).reduce((a, tg) => a + pad4(tables[tg]).length, 0);
  file.writeUInt32BE((0xb1b0afba - sum(file)) >>> 0, headAt + 8);
  return file;
}

const SYNTH = buildTtf('Synth');
const woff2 = (n = 96) => { const b = Buffer.alloc(n); b.write('wOF2', 0, 'latin1'); b.write('true', 4, 'latin1'); b.writeUInt32BE(n, 8); return b; };
const woff = (n = 96) => { const b = woff2(n); b.write('wOFF', 0, 'latin1'); return b; };
const sfnt = (tag) => { const b = Buffer.alloc(64); if (tag === 'ttf') b.writeUInt32BE(0x00010000, 0); else b.write(tag, 0, 'latin1'); b.writeUInt16BE(2, 4); return b; };

/** A project on disk: studio.json plus an empty (or given) assets/fonts/fonts.json. */
function project({ fonts = [], cfg = {} } = {}) {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'studio.json'), JSON.stringify(cfg));
  fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify(fonts));
  return root;
}
const snapshot = (root) => fs.readdirSync(path.join(root, 'assets', 'fonts')).sort().map((f) => `${f}:${read(root, 'assets', 'fonts', f).length}`).join('|');

/** io stub: routes maps url -> Buffer; every request is logged. */
function fakeIo(routes = {}, sizes = {}) {
  const calls = { get: [], head: [] };
  return {
    calls,
    async get(url, what) {
      calls.get.push(url);
      const body = routes[url];
      return body ? { ok: true, status: 200, body, what } : { ok: false, status: 404, body: Buffer.alloc(0), what };
    },
    async head(url) { calls.head.push(url); return sizes[url] ?? null; },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// lib/fonts.js: pure helpers (no browser)

test('lib/fonts.js: firstCodePoint takes the first printable code point of a unicode-range', () => {
  assert.equal(L.firstCodePoint('U+AC00-D7A3'), '가');
  assert.equal(L.firstCodePoint('U+0000-00FF, U+0131'), '!', 'controls and the space are skipped');
  assert.equal(L.firstCodePoint('U+0100-02BA'), 'Ā');
  assert.equal(L.firstCodePoint('u+f9ca-fa0b, U+ff03'), '流');
  assert.equal(L.firstCodePoint('U+4??'), 'Ѐ', 'wildcard starts at the low end');
  assert.equal(L.firstCodePoint('U+0-1F, U+3000'), null, 'nothing printable in the range');
  assert.equal(L.firstCodePoint('nonsense'), null);
  assert.equal(L.firstCodePoint(''), null);
  assert.equal(L.firstCodePoint('U+D800-D8FF, U+1F600'), '\u{1F600}', 'surrogates are skipped');
});

test('lib/fonts.js: sampleFor prefers sample, then the range, then "A"', () => {
  assert.equal(L.sampleFor({ sample: '한글', unicodeRange: 'U+0041-005A' }), '한글');
  assert.equal(L.sampleFor({ unicodeRange: 'U+AC00-D7A3' }), '가');
  assert.equal(L.sampleFor({ sample: '', unicodeRange: 'U+AC00-D7A3' }), '가', 'an empty sample is no sample');
  assert.equal(L.sampleFor({}), 'A');
  assert.equal(L.sampleFor({ unicodeRange: 'bogus' }), 'A');
  assert.equal(L.probeWeight('100 900'), '400');
  assert.equal(L.probeWeight('500 900'), '500');
  assert.equal(L.probeWeight('700'), '700');
});

test('lib/fonts.js: normalizeFonts keeps sliced entries of one family and drops exact duplicates', () => {
  const items = [
    { family: 'Noto Sans KR', src: 'a/0.woff2', unicodeRange: 'U+AC00-B000' },
    { family: 'Noto Sans KR', src: 'a/1.woff2', unicodeRange: 'U+B001-B100' },
    { family: 'Noto Sans KR', src: 'a/1.woff2', unicodeRange: 'U+B001-B100' }, // exact duplicate
    { family: 'Noto Sans KR', src: 'a/2.woff2', weight: 700, style: 'italic', sample: '나' },
    { family: 'Inter', src: 'i.woff2', weight: '100 900' },
  ];
  const out = L.normalizeFonts(items);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((e) => e.sample), ['가', '뀁', '나', 'A']);
  assert.equal(out[0].spec, 'normal 400 64px "Noto Sans KR"');
  assert.equal(out[2].spec, 'italic 700 64px "Noto Sans KR"');
  assert.equal(out[3].spec, 'normal 400 64px "Inter"', 'a variable weight range probes at 400');
  assert.equal(out[0].sampled, true);
  assert.equal(out[3].sampled, false, 'a plain entry keeps the historical "font missing: <spec>" text');
  assert.throws(() => L.normalizeFonts([{ family: 'X' }]), /needs "family" and "src"/);
  assert.throws(() => L.normalizeFonts([{ family: 'X', src: 'x.woff2', sample: 5 }]), /"sample" must be a string/);
});

test('lib/fonts.js: the shipped fonts.json still normalizes to the two bundled families', () => {
  const list = readJson(TEMPLATE, 'assets', 'fonts', 'fonts.json');
  const out = L.normalizeFonts(list);
  assert.equal(out.length, list.length);
  assert.deepEqual([...new Set(out.map((e) => e.spec))], ['normal 400 64px "Instrument Serif"', 'italic 400 64px "Instrument Serif"', 'normal 400 64px "Inter"']);
  for (const e of out) assert.ok(e.sample && e.sample !== ' ', `${e.src} probes a printable character`);
});

// ---------------------------------------------------------------------------------------------------------------
// tools/fonts.mjs: sniffing, parsing, normalizing

test('sniffFont: identifies containers by magic bytes and refuses everything else with a reason', () => {
  assert.deepEqual([F.sniffFont(woff2()).kind, F.sniffFont(woff2()).ext], ['woff2', 'woff2']);
  assert.equal(F.sniffFont(woff()).ext, 'woff');
  assert.equal(F.sniffFont(sfnt('ttf')).ext, 'ttf');
  assert.equal(F.sniffFont(sfnt('true')).ext, 'ttf');
  assert.equal(F.sniffFont(sfnt('OTTO')).ext, 'otf');
  assert.equal(F.sniffFont(SYNTH).ext, 'ttf');
  for (const name of ['inter-100-900-latin.woff2', 'instrument-serif-400-latin.woff2']) {
    assert.equal(F.sniffFont(read(TEMPLATE, 'assets', 'fonts', name)).ext, 'woff2', name);
  }
  const problem = (buf) => F.sniffFont(buf).problem;
  assert.match(problem(woff2(96).subarray(0, 60)), /truncated or padded woff2: the header says 96 bytes, the file has 60/);
  assert.match(problem(Buffer.concat([woff(96), Buffer.alloc(5)])), /padded woff/);
  assert.match(problem(Buffer.from('<!DOCTYPE html><html><body>404 Not Found</body></html>')), /HTML page/);
  assert.match(problem(Buffer.from('  \n<html lang="en">' + ' '.repeat(40))), /HTML page/);
  assert.match(problem(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1234\n')), /Git LFS pointer/);
  assert.match(problem(Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(60)])), /font collection/);
  assert.match(problem(Buffer.from('this is plain text, not a font at all')), /not a font container \(starts with 0x74686973/);
  assert.match(problem(Buffer.alloc(5)), /too small/);
  assert.match(problem(Buffer.alloc(0)), /too small/);
  const broken = sfnt('ttf');
  broken.writeUInt16BE(9999, 4);
  assert.match(problem(broken), /broken ttf table directory/);
  assert.match(problem(Buffer.alloc(64)), /not a font container/, 'zero bytes are not a font');
});

test('parseCss: labelled subsets keep their name, unlabelled CJK slices become slice-N from the file URL', () => {
  const blocks = F.parseCss(fs.readFileSync(path.join(FIXTURES, 'notosanskr.css'), 'utf8'));
  assert.equal(blocks.length, 24);
  assert.deepEqual(blocks.slice(0, 3).map((b) => b.subset), ['slice-0', 'slice-1', 'slice-2']);
  assert.deepEqual(blocks.slice(-4).map((b) => b.subset), ['cyrillic', 'vietnamese', 'latin-ext', 'latin']);
  assert.equal(blocks.filter((b) => b.subset.startsWith('slice-')).length, 20);
  assert.equal(blocks[16].subset, 'slice-116', 'the number comes from the URL, not the position');
  assert.ok(blocks.every((b) => b.family === 'Noto Sans KR' && b.style === 'normal' && b.weight === '400' && /\.woff2$/.test(b.url) && b.unicodeRange.startsWith('U+')));
  // the older shape: a comment before every block, plus a [n] comment and a block without a woff2 source
  const old = F.parseCss(`/* latin */\n@font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900; src: url(https://x/a.woff2) format('woff2'); unicode-range: U+0000-00FF; }\n` +
    `/* [7] */\n@font-face { font-family: 'Inter'; src: url(https://x/b.woff2) format('woff2'); }\n@font-face { font-family: 'Inter'; src: url(https://x/c.ttf) format('truetype'); }`);
  assert.deepEqual(old.map((b) => b.subset), ['latin', 'slice-7']);
  assert.equal(old[0].weight, '100 900');
});

test('selectBlocks / describeSubsets: "korean" (cjk, slices) selects the numbered slices', () => {
  const blocks = F.parseCss(fs.readFileSync(path.join(FIXTURES, 'notosanskr.css'), 'utf8'));
  assert.equal(F.selectBlocks(blocks, ['latin', 'latin-ext']).length, 2);
  assert.equal(F.selectBlocks(blocks, ['korean']).length, 20);
  assert.equal(F.selectBlocks(blocks, ['KOREAN', 'latin']).length, 21);
  assert.equal(F.selectBlocks(blocks, ['cjk']).length, 20);
  assert.equal(F.selectBlocks(blocks, ['slice-3']).length, 1);
  assert.equal(F.selectBlocks(blocks, ['greek']).length, 0);
  assert.equal(F.describeSubsets(blocks), 'cyrillic, vietnamese, latin-ext, latin, korean (20 numbered slices)');
  assert.equal(F.describeSubsets([]), 'none');
});

test('add-file argument normalizers: weight, unicode-range, license id', () => {
  assert.equal(F.normalizeWeight(undefined), '400');
  assert.equal(F.normalizeWeight('700'), '700');
  assert.equal(F.normalizeWeight('bold'), '700');
  assert.equal(F.normalizeWeight('100 900'), '100 900');
  assert.equal(F.normalizeWeight('100..900'), '100 900');
  assert.equal(F.normalizeWeight('100-900'), '100 900');
  for (const bad of ['0', '1001', '900 100', 'heavy', '100 200 300', '4.5']) assert.throws(() => F.normalizeWeight(bad), /bad weight/, bad);

  assert.equal(F.normalizeUnicodeRange('U+AC00-D7A3'), 'U+AC00-D7A3');
  assert.equal(F.normalizeUnicodeRange('u+ac00-d7a3,U+20-7e ,u+3131'), 'U+AC00-D7A3, U+20-7E, U+3131');
  assert.equal(F.normalizeUnicodeRange('U+4??'), 'U+4??');
  for (const bad of ['', 'AC00-D7A3', 'U+ZZ', 'U+D7A3-AC00', 'U+110000', 'U+1??-2FF', 'U+1234567']) assert.throws(() => F.normalizeUnicodeRange(bad), /unicode-range|bad unicode-range/, bad);

  for (const same of ['SIL OFL 1.1', 'OFL', 'ofl-1.1', 'OFL 1.1', 'SIL Open Font License 1.1', 'sil-ofl-1.1']) assert.equal(F.normalizeLicenseId(same), 'OFL-1.1', same);
  assert.equal(F.normalizeLicenseId('Apache 2.0'), 'Apache-2.0');
  assert.equal(F.normalizeLicenseId('UFL'), 'UFL-1.0');
  assert.equal(F.normalizeLicenseId(' Custom EULA v3 '), 'Custom EULA v3', 'unknown ids are kept as typed');
});

test('inferLicense: recognizes OFL/Apache/UFL and a Reserved Font Name declaration', () => {
  const ofl = read(TEMPLATE, 'assets', 'fonts', 'OFL-Inter.txt').toString('utf8');
  assert.deepEqual(F.inferLicense(ofl), { id: 'OFL-1.1', reservedName: false });
  const rfn = fs.readFileSync(path.join(FIXTURES, 'OFL-rfn.txt'), 'utf8');
  assert.deepEqual(F.inferLicense(rfn), { id: 'OFL-1.1', reservedName: true });
  assert.equal(F.inferLicense('Apache License\nVersion 2.0, January 2004').id, 'Apache-2.0');
  assert.equal(F.inferLicense('Ubuntu Font Licence 1.0').id, 'UFL-1.0');
  assert.equal(F.inferLicense('do what you want').id, null);
});

// ---------------------------------------------------------------------------------------------------------------
// tools/fonts.mjs add-file

test('addFile: a local font + license file are copied, registered and named from the family', async () => {
  const root = project();
  const src = path.join(tmp('ms-src-'), 'whatever.bin');
  fs.writeFileSync(src, woff2(200));
  const r = await F.addFile(root, null, src, { family: 'Neo Dunggeunmo', licenseFile: path.join(FIXTURES, 'OFL-rfn.txt') });
  assert.equal(r.src, 'assets/fonts/neo-dunggeunmo-400.woff2');
  assert.equal(r.format, 'woff2');
  assert.equal(r.license, 'OFL-1.1', 'inferred from the license text');
  assert.equal(r.licenseFile, 'assets/fonts/OFL-NeoDunggeunmo.txt');
  assert.deepEqual(r.warnings, []);
  assert.match(r.notes.join(' '), /Reserved Font Name: use the font unmodified/);
  assert.deepEqual(read(root, r.src), woff2(200));
  assert.deepEqual(read(root, r.licenseFile), read(FIXTURES, 'OFL-rfn.txt'), 'license bytes are copied unchanged');
  assert.deepEqual(readJson(root, 'assets', 'fonts', 'fonts.json'), [
    { family: 'Neo Dunggeunmo', src: 'assets/fonts/neo-dunggeunmo-400.woff2', weight: '400', style: 'normal', license: 'OFL-1.1', licenseFile: 'assets/fonts/OFL-NeoDunggeunmo.txt' },
  ]);
  assert.equal(fs.readdirSync(path.join(root, 'assets', 'fonts')).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left');
});

test('addFile: an explicit --license wins, is normalized, and a text that disagrees warns', async () => {
  const root = project();
  const src = path.join(tmp('ms-src-'), 'f.woff2');
  fs.writeFileSync(src, woff2());
  const ok = await F.addFile(root, null, src, { family: 'Pixel', license: 'SIL OFL 1.1', licenseFile: path.join(FIXTURES, 'OFL-rfn.txt') });
  assert.equal(ok.license, 'OFL-1.1');
  assert.deepEqual(ok.warnings, []);
  const root2 = project();
  const mismatch = await F.addFile(root2, null, src, { family: 'Pixel', license: 'Apache 2.0', licenseFile: path.join(FIXTURES, 'OFL-rfn.txt') });
  assert.equal(mismatch.license, 'Apache-2.0');
  assert.match(mismatch.warnings.join(' '), /--license says Apache-2\.0 but .* reads as OFL-1\.1/);
  assert.equal(mismatch.licenseFile, 'assets/fonts/LICENSE-Pixel.txt', 'a non-OFL license uses the LICENSE- prefix');
});

test('addFile: warns when no license is given and omits the license keys', async () => {
  const root = project();
  const src = path.join(tmp('ms-src-'), 'f.woff2');
  fs.writeFileSync(src, woff2());
  const none = await F.addFile(root, null, src, { family: 'Mystery' });
  assert.equal(none.license, null);
  assert.equal(none.licenseFile, null);
  assert.match(none.warnings.join(' '), /no license given for Mystery/);
  assert.deepEqual(readJson(root, 'assets', 'fonts', 'fonts.json'), [{ family: 'Mystery', src: 'assets/fonts/mystery-400.woff2', weight: '400', style: 'normal' }]);
  const idOnly = await F.addFile(project(), null, src, { family: 'Mystery', license: 'OFL' });
  assert.equal(idOnly.license, 'OFL-1.1');
  assert.match(idOnly.warnings.join(' '), /no license file for Mystery/);
});

test('addFile: refuses files that are not font containers and leaves the project untouched', async () => {
  const root = project();
  const before = snapshot(root);
  const dir = tmp('ms-src-');
  const cases = {
    'html.woff2': [Buffer.from('<!DOCTYPE html><html><body>Sign in to continue</body></html>'), /HTML page/],
    'text.ttf': [Buffer.from('just some text pretending to be a font file'), /not a font container/],
    'cut.woff2': [woff2(200).subarray(0, 100), /truncated or padded woff2/],
    'empty.otf': [Buffer.alloc(0), /too small/],
    'coll.ttc': [Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(60)]), /font collection/],
  };
  for (const [name, [bytes, re]] of Object.entries(cases)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    await assert.rejects(() => F.addFile(root, null, p, { family: 'Bad', license: 'OFL' }), re, name);
  }
  await assert.rejects(() => F.addFile(root, null, path.join(dir, 'missing.woff2'), { family: 'Bad' }), /font file not found/);
  await assert.rejects(() => F.addFile(root, null, dir, { family: 'Bad' }), /not a file/);
  assert.equal(snapshot(root), before, 'nothing was written');
});

test('addFile: the container decides the extension, not the file name', async () => {
  const root = project();
  const dir = tmp('ms-src-');
  fs.writeFileSync(path.join(dir, 'looks-like.woff2'), SYNTH);
  const r = await F.addFile(root, null, path.join(dir, 'looks-like.woff2'), { family: 'Synth', license: 'OFL' });
  assert.equal(r.format, 'ttf');
  assert.equal(r.src, 'assets/fonts/synth-400.ttf');
  assert.match(r.notes.join(' '), /named \.woff2 but is a ttf: saved as \.ttf/);
});

test('addFile: https URLs go through the injected fetch; http and error pages are refused', async () => {
  const root = project();
  const io = fakeIo({
    'https://fonts.example/neodgm.woff2': woff2(300),
    'https://fonts.example/LICENSE.txt': read(FIXTURES, 'OFL-rfn.txt'),
    'https://fonts.example/login': Buffer.from('<!doctype html><title>login</title>'),
    'https://fonts.example/license.html': Buffer.from('<!DOCTYPE html><html>not a license</html>'),
  });
  const r = await F.addFile(root, null, 'https://fonts.example/neodgm.woff2?v=3', { family: 'NeoDunggeunmo', licenseFile: 'https://fonts.example/LICENSE.txt' }, io).catch((e) => e);
  assert.ok(r instanceof Error, 'a URL the stub does not know is a 404');
  assert.match(r.message, /HTTP 404 from https:\/\/fonts\.example\/neodgm\.woff2\?v=3/);
  const ok = await F.addFile(root, null, 'https://fonts.example/neodgm.woff2', { family: 'NeoDunggeunmo', licenseFile: 'https://fonts.example/LICENSE.txt' }, io);
  assert.equal(ok.src, 'assets/fonts/neodunggeunmo-400.woff2');
  assert.equal(ok.licenseFile, 'assets/fonts/OFL-NeoDunggeunmo.txt');
  assert.deepEqual(io.calls.get.slice(-2), ['https://fonts.example/neodgm.woff2', 'https://fonts.example/LICENSE.txt']);

  const before = snapshot(root);
  await assert.rejects(() => F.addFile(root, null, 'http://fonts.example/neodgm.woff2', { family: 'X' }, io), /must be https/);
  await assert.rejects(() => F.addFile(root, null, 'https://fonts.example/login', { family: 'X' }, io), /HTML page/);
  await assert.rejects(() => F.addFile(root, null, 'https://fonts.example/neodgm.woff2', { family: 'X', licenseFile: 'https://fonts.example/license.html' }, io), /HTML page, not a license text/);
  assert.equal(snapshot(root), before, 'refused downloads leave nothing behind (the bad license was checked before the font was written)');
});

test('addFile: weight ranges, italic, families with spaces, non-ASCII names and validation', async () => {
  const root = project();
  const src = path.join(tmp('ms-src-'), 'f.woff2');
  fs.writeFileSync(src, woff2());
  const v = await F.addFile(root, null, src, { family: 'Pretendard  Variable', weight: '100..900', style: 'italic', license: 'OFL' });
  assert.equal(v.src, 'assets/fonts/pretendard-variable-100-900-italic.woff2');
  assert.deepEqual(readJson(root, 'assets', 'fonts', 'fonts.json')[0], { family: 'Pretendard Variable', src: v.src, weight: '100 900', style: 'italic', license: 'OFL-1.1' });
  const ko = await F.addFile(root, null, src, { family: '네오둥근모', license: 'OFL', licenseFile: path.join(FIXTURES, 'OFL-rfn.txt') });
  assert.match(ko.src, /^assets\/fonts\/[a-z0-9-]+-400\.woff2$/, 'file names stay ASCII');
  assert.match(ko.licenseFile, /^assets\/fonts\/OFL-[A-Za-z0-9-]+\.txt$/);
  assert.equal(readJson(root, 'assets', 'fonts', 'fonts.json').at(-1).family, '네오둥근모', 'the family keeps its real name');
  await assert.rejects(() => F.addFile(root, null, src, { family: 'Bad"Name' }), /bad family name/);
  await assert.rejects(() => F.addFile(root, null, src, { family: '' }), /empty family name/);
  await assert.rejects(() => F.addFile(root, null, src, { family: 'X', style: 'oblique' }), /bad --style/);
  await assert.rejects(() => F.addFile(root, null, src, { family: 'X', weight: 'heavy' }), /bad weight/);
  await assert.rejects(() => F.addFile(root, null, src, { family: 'X', unicodeRange: 'AC00' }), /bad unicode-range token/);
  await assert.rejects(() => F.addFile(root, null, '', { family: 'X' }), /needs a font file path or https URL/);
});

test('addFile: sliced entries (one family, several unicode-ranges) get their own files and entries', async () => {
  const root = project();
  const src = path.join(tmp('ms-src-'), 'f.woff2');
  fs.writeFileSync(src, woff2(128));
  const a = await F.addFile(root, null, src, { family: 'Slicey', license: 'OFL', unicodeRange: 'U+AC00-D7A3' });
  const b = await F.addFile(root, null, src, { family: 'Slicey', license: 'OFL', unicodeRange: 'u+20-7e, u+3131-318e' });
  assert.notEqual(a.src, b.src);
  assert.match(a.src, /^assets\/fonts\/slicey-400-u[0-9a-f]{6}\.woff2$/);
  const list = readJson(root, 'assets', 'fonts', 'fonts.json');
  assert.deepEqual(list.map((e) => e.unicodeRange), ['U+AC00-D7A3', 'U+20-7E, U+3131-318E']);
  // adding the same slice again replaces its entry instead of duplicating it
  const again = await F.addFile(root, null, src, { family: 'slicey', license: 'OFL', unicodeRange: 'U+AC00-D7A3' });
  assert.equal(again.src, a.src);
  assert.deepEqual(again.replaced, [a.src]);
  assert.equal(readJson(root, 'assets', 'fonts', 'fonts.json').length, 2);
  assert.equal(readJson(root, 'assets', 'fonts', 'fonts.json').at(-1).family, 'slicey', 'the entry now carries the new spelling');
});

test('addFile: re-adding replaces the entry, deletes the old file when the format changes, keeps other families', async () => {
  const root = project({ fonts: [{ family: 'Other', src: 'assets/fonts/other-400.woff2', weight: '400', style: 'normal' }] });
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'other-400.woff2'), woff2());
  const dir = tmp('ms-src-');
  fs.writeFileSync(path.join(dir, 'a.woff2'), woff2(100));
  fs.writeFileSync(path.join(dir, 'b.ttf'), SYNTH);
  const one = await F.addFile(root, null, path.join(dir, 'a.woff2'), { family: 'Mine', licenseFile: path.join(FIXTURES, 'OFL-rfn.txt') });
  assert.equal(one.src, 'assets/fonts/mine-400.woff2');
  const two = await F.addFile(root, null, path.join(dir, 'b.ttf'), { family: 'Mine', licenseFile: path.join(FIXTURES, 'OFL-rfn.txt') });
  assert.equal(two.src, 'assets/fonts/mine-400.ttf');
  assert.deepEqual(two.replaced, ['assets/fonts/mine-400.woff2']);
  assert.deepEqual(two.deleted, ['assets/fonts/mine-400.woff2']);
  assert.equal(exists(root, 'assets', 'fonts', 'mine-400.woff2'), false);
  assert.ok(exists(root, 'assets', 'fonts', 'OFL-Mine.txt'), 'the license is shared by the replacement and stays');
  const list = readJson(root, 'assets', 'fonts', 'fonts.json');
  assert.deepEqual(list.map((e) => e.family), ['Other', 'Mine']);
  // a second weight of the same family reuses the family's license file
  fs.writeFileSync(path.join(dir, 'c.woff2'), woff2(100));
  const bold = await F.addFile(root, null, path.join(dir, 'c.woff2'), { family: 'Mine', weight: 700 });
  assert.equal(bold.licenseFile, 'assets/fonts/OFL-Mine.txt');
  assert.equal(bold.license, 'OFL-1.1');
  assert.equal(bold.src, 'assets/fonts/mine-700.woff2');
});

test('addFile: keeps the { fonts: [...] } wrapper form of fonts.json', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'studio.json'), '{}');
  fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify({ note: 'kept', fonts: [{ family: 'Old', src: 'assets/fonts/old.woff2' }] }));
  const src = path.join(tmp('ms-src-'), 'f.woff2');
  fs.writeFileSync(src, woff2());
  await F.addFile(root, null, src, { family: 'New', license: 'OFL' });
  const json = readJson(root, 'assets', 'fonts', 'fonts.json');
  assert.equal(json.note, 'kept');
  assert.deepEqual(json.fonts.map((f) => f.family), ['Old', 'New']);
});

test('addFile: does not overwrite another family\'s file that has the same name', async () => {
  const root = project({ fonts: [{ family: 'Foo Bar', src: 'assets/fonts/foo-bar-400.woff2', weight: '400', style: 'normal' }] });
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'foo-bar-400.woff2'), woff2(80));
  const src = path.join(tmp('ms-src-'), 'f.woff2');
  fs.writeFileSync(src, woff2(120));
  const r = await F.addFile(root, null, src, { family: 'foo-bar', license: 'OFL' });
  assert.notEqual(r.src, 'assets/fonts/foo-bar-400.woff2');
  assert.match(r.src, /^assets\/fonts\/foo-bar-400-[0-9a-f]{6}\.woff2$/);
  assert.equal(read(root, 'assets', 'fonts', 'foo-bar-400.woff2').length, 80, 'the other family\'s file is intact');
});

// ---------------------------------------------------------------------------------------------------------------
// tools/fonts.mjs add (Google Fonts): the slice gate

const CSS = fs.readFileSync(path.join(FIXTURES, 'notosanskr.css'), 'utf8');
const cssIo = (extra = {}, sizes = {}) => {
  const routes = { ...extra };
  const io = fakeIo(routes, sizes);
  const inner = io.get;
  io.get = async (url, what) => {
    if (url.startsWith('https://fonts.googleapis.com/css2')) { io.calls.get.push(url); return { ok: true, status: 200, body: Buffer.from(CSS), what }; }
    if (url.startsWith('https://fonts.gstatic.com/')) { io.calls.get.push(url); return { ok: true, status: 200, body: woff2(1000 + (url.length % 7)), what }; }
    return inner(url, what);
  };
  return io;
};

test('add: more than 12 slices prints count and size and needs --yes; nothing is downloaded or written without it', async () => {
  const root = project();
  const before = snapshot(root);
  const io = cssIo({}, Object.fromEntries(F.parseCss(CSS).map((b) => [b.url, 20000])));
  await assert.rejects(
    () => F.add(root, null, 'Noto Sans KR:400', { subsets: ['korean', 'latin'] }, io),
    (err) => {
      assert.equal(err.name, 'UsageError');
      assert.match(err.message, /Noto Sans KR: 21 files, 410 KB, for --subsets korean,latin: more than 12 slices, so nothing was downloaded/);
      assert.match(err.message, /repeat the command with --yes/);
      assert.match(err.message, /add-file with a full Hangul woff2/);
      return true;
    },
  );
  assert.equal(io.calls.get.filter((u) => u.includes('gstatic')).length, 0, 'no font file was requested');
  assert.equal(io.calls.get.filter((u) => u.includes('raw.githubusercontent')).length, 0, 'not even the license');
  assert.equal(io.calls.head.length, 21, 'sizes were measured with HEAD');
  assert.equal(snapshot(root), before);
});

test('add: with --yes every slice is downloaded and registered with its unicode-range', async () => {
  const root = project();
  const io = cssIo();
  const r = await F.add(root, null, 'Noto Sans KR:400', { subsets: ['korean'], yes: true }, io);
  assert.equal(r.files.length, 20);
  const list = readJson(root, 'assets', 'fonts', 'fonts.json');
  assert.equal(list.length, 20);
  assert.ok(list.every((e) => e.family === 'Noto Sans KR' && /^assets\/fonts\/noto-sans-kr-400-slice-\d+\.woff2$/.test(e.src) && e.unicodeRange.startsWith('U+')));
  assert.equal(new Set(list.map((e) => e.src)).size, 20);
  for (const e of list) assert.equal(F.sniffFont(read(root, e.src)).kind, 'woff2');
  assert.equal(r.estimate.bytes, null, 'no Content-Length from the stub: the size is reported as unknown');
});

test('add: up to 12 files need no --yes and no size probe; the estimate extrapolates from measured files', async () => {
  const root = project();
  const io = cssIo();
  const r = await F.add(root, null, 'Noto Sans KR:400', { subsets: ['latin', 'latin-ext'] }, io);
  assert.equal(r.files.length, 2);
  assert.equal(io.calls.head.length, 0);
  assert.equal(F.MAX_SLICES, 12);
  const urls = F.parseCss(CSS).filter((b) => b.subset.startsWith('slice-')).map((b) => b.url);
  const io2 = cssIo({}, { [urls[0]]: 10000, [urls[1]]: 30000 });
  await assert.rejects(() => F.add(project(), null, 'Noto Sans KR:400', { subsets: ['korean'] }, io2), /20 files, about 391 KB \(extrapolated from 2 measured files\)/);
  const exactly12 = F.parseCss(CSS).filter((b) => b.subset.startsWith('slice-')).slice(0, 12).map((b) => b.subset);
  const ok = await F.add(project(), null, 'Noto Sans KR:400', { subsets: exactly12 }, cssIo());
  assert.equal(ok.files.length, 12, '12 slices are allowed without --yes');
  await assert.rejects(() => F.add(project(), null, 'Noto Sans KR:400', { subsets: [...exactly12, 'slice-12'] }, cssIo()), /13 files/);
});

test('add: an unknown subset lists what the family offers, folding the numbered slices', async () => {
  await assert.rejects(() => F.add(project(), null, 'Noto Sans KR:400', { subsets: ['greek'] }, cssIo()),
    /no woff2 for subsets greek \(available: cyrillic, vietnamese, latin-ext, latin, korean \(20 numbered slices\)\)/);
});

test('list / remove handle sliced families: files and the shared license go together', async () => {
  const root = project();
  await F.add(root, null, 'Noto Sans KR:400', { subsets: ['korean'], yes: true }, cssIo({ 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/OFL.txt': read(TEMPLATE, 'assets', 'fonts', 'OFL-Inter.txt') }));
  const fams = F.list(root);
  assert.equal(fams.length, 1);
  assert.equal(fams[0].files, 20);
  assert.deepEqual(fams[0].license, ['OFL-1.1']);
  assert.deepEqual(fams[0].missing, []);
  assert.ok(exists(root, 'assets', 'fonts', 'OFL-NotoSansKR.txt'));
  const gone = F.remove(root, { brand: { fonts: { ui: 'noto sans kr' } } }, 'NOTO SANS KR');
  assert.equal(gone.entries, 20);
  assert.equal(gone.deleted.length, 21);
  assert.deepEqual(gone.brandRoles, ['ui']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'assets', 'fonts')), ['fonts.json']);
  assert.throws(() => F.remove(root, null, 'Noto Sans KR'), /no "Noto Sans KR" in assets\/fonts\/fonts\.json/);
});

// -- qa-tools:F5 / crossplatform-security:F7 ------------------------------------------------------------------------------

/** The same file through a Windows admin share (`//localhost/C$/…`): a UNC path on the same machine; null where that is not reachable. */
function uncOf(file) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(file);
  if (process.platform !== 'win32' || !m) return null;
  const unc = `//localhost/${m[1]}$/${m[2].replace(/\\/g, '/')}`;
  try { return fs.existsSync(unc) ? unc : null; } catch { return null; }
}

test('insideFontsDir: only a relative path that stays under assets/fonts/ may be deleted (drive, UNC, absolute and .. escape are refused)', () => {
  const root = project();
  for (const ok of ['assets/fonts/a.woff2', 'assets/fonts/sub/a.woff2', './assets/fonts/a.woff2', 'assets/fonts/x/../a.woff2']) assert.equal(F.insideFontsDir(root, ok), true, ok);
  const outside = ['V:/victim.txt', 'V:\\victim.txt', 'v:victim.txt', 'C:/Windows/x.woff2', '//srv/share/x.woff2', '\\\\srv\\share\\x.woff2', '//localhost/C$/x.woff2', '/etc/passwd', '\\x.woff2',
    '../x.woff2', 'assets/fonts/../../x.woff2', 'assets/fonts/../x.woff2', 'assets/x.woff2', 'studio.json', 'assets/fonts', 'assets/fonts/', '.', '', 'a\0b', null, undefined, 42, {}];
  for (const bad of outside) assert.equal(F.insideFontsDir(root, bad), false, String(bad));
  assert.equal(F.insideFontsDir(root, path.join(root, 'assets', 'fonts', 'a.woff2')), false, 'an absolute path is refused even when it points inside');
});

test('remove: a fonts.json entry pointing outside assets/fonts/ is dropped but its file is never deleted', () => {
  const root = project();
  const outer = tmp('ms-victim-');
  const victim = path.join(outer, 'victim.txt');
  const licence = path.join(outer, 'licence.txt');
  fs.writeFileSync(victim, 'PRECIOUS DATA');
  fs.writeFileSync(licence, 'PRECIOUS LICENCE');
  const unc = uncOf(victim);
  const uncLic = uncOf(licence);
  const evil = [
    { family: 'Evil Abs', src: victim.replace(/\\/g, '/'), weight: '400', style: 'normal', licenseFile: licence },
    { family: 'Evil Rel', src: path.relative(root, victim), weight: '400', style: 'normal' },
    { family: 'Evil Num', src: 42, weight: '400', style: 'normal' },
    ...(unc ? [{ family: 'Evil Unc', src: unc, weight: '400', style: 'normal', licenseFile: uncLic }] : []),
  ];
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify(evil));
  for (const e of evil) {
    const r = F.remove(root, null, e.family);
    assert.deepEqual(r.deleted, [], e.family);
    assert.ok(r.skipped.length >= 1, `${e.family}: reported as left alone`);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'PRECIOUS DATA', `${e.family}: the file outside the project survives`);
    assert.equal(fs.readFileSync(licence, 'utf8'), 'PRECIOUS LICENCE', `${e.family}: so does the licence`);
  }
  assert.deepEqual(readJson(root, 'assets', 'fonts', 'fonts.json'), [], 'every entry was removed from fonts.json');
});

test('addFile: replacing an entry whose src lies outside assets/fonts/ leaves that file alone and warns', async () => {
  const outer = tmp('ms-victim-');
  const victim = path.join(outer, 'victim.woff2');
  fs.writeFileSync(victim, 'PRECIOUS DATA');
  const unc = uncOf(victim);
  for (const src of [victim.replace(/\\/g, '/'), ...(unc ? [unc] : [])]) {
    const root = project({ fonts: [{ family: 'Evil', src, weight: '400', style: 'normal' }] });
    const font = path.join(tmp('ms-src-'), 'f.woff2');
    fs.writeFileSync(font, woff2(120));
    const r = await F.addFile(root, null, font, { family: 'Evil', weight: 400, license: 'OFL' });
    assert.deepEqual(r.replaced, [src]);
    assert.deepEqual(r.deleted, []);
    assert.match(r.warnings.join('\n'), /left alone \(not inside assets\/fonts\/\)/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'PRECIOUS DATA', src);
    assert.equal(readJson(root, 'assets', 'fonts', 'fonts.json').length, 1);
    assert.equal(exists(root, r.src), true);
  }
});

test('CLI remove: says which file it left alone and exits 0', () => {
  const root = cliProject();
  const outer = tmp('ms-victim-');
  const victim = path.join(outer, 'victim.txt');
  fs.writeFileSync(victim, 'PRECIOUS DATA');
  const list = readJson(root, 'assets', 'fonts', 'fonts.json');
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify([...list, { family: 'Evil Font', src: victim.replace(/\\/g, '/'), weight: '400', style: 'normal' }]));
  const r = cli(root, ['remove', 'Evil Font']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed Evil Font: 1 entry, deleted 0 file\(s\)/);
  assert.match(r.stdout, /left alone, not inside assets\/fonts\/: .*victim\.txt/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'PRECIOUS DATA');
  const json = cli(root, ['remove', 'Inter', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout.trim().split('\n').at(-1)).skipped, []);
});

// ---------------------------------------------------------------------------------------------------------------
// coverage: text input and report shaping (no browser)

test('readTextInput: --text and --text-file are combined, BOM stripped, empty input refused', () => {
  const dir = tmp('ms-text-');
  const file = path.join(dir, 't.txt');
  fs.writeFileSync(file, String.fromCharCode(0xfeff) + '구동 보고 18,517건\n');
  assert.equal(F.readTextInput({ text: '에뮬', textFile: file }), '에뮬\n구동 보고 18,517건\n');
  assert.equal(F.readTextInput({ textFile: file }), '구동 보고 18,517건\n');
  assert.throws(() => F.readTextInput({}), /coverage needs the text to check/);
  assert.throws(() => F.readTextInput({ text: '   ' }), /coverage needs the text to check/);
  assert.throws(() => F.readTextInput({ textFile: path.join(dir, 'nope.txt') }), /cannot read --text-file .*file not found/);
  assert.deepEqual(F.describeText('에뮬 ABC 123 ,.!'), { unique: 11, hangul: 2, latin: 3, digits: 3, other: 3 });
});

test('coverageFaces: one face per family/style/probe weight; --family narrows and unknown names are listed', () => {
  const root = project({ fonts: [
    { family: 'Inter', src: 'a', weight: '100 900' }, { family: 'Inter', src: 'b', weight: '100 900', unicodeRange: 'U+0100' },
    { family: 'Serif', src: 'c', style: 'italic' }, { family: 'Serif', src: 'd' }, { family: 'Serif', src: 'e', weight: 700 },
  ] });
  const all = F.coverageFaces(root, { fonts: [{ family: 'Extra', src: 'x' }] }, undefined);
  assert.deepEqual(all.map((f) => `${f.family}|${f.style}|${f.weight}`), ['Inter|normal|400', 'Serif|italic|400', 'Serif|normal|400', 'Serif|normal|700', 'Extra|normal|400']);
  assert.deepEqual(F.coverageFaces(root, null, ['serif']).map((f) => f.family), ['Serif', 'Serif', 'Serif']);
  assert.throws(() => F.coverageFaces(root, null, ['Nope', 'inter']), /no "Nope" in the registered fonts \(have: Inter, Serif\)/);
  assert.throws(() => F.coverageFaces(project(), null, undefined), /no fonts registered/);
});

test('summarizeCoverage: table, missing list with code points, truncation and the ok flag', () => {
  const missing = (n) => Array.from({ length: n }, (_, i) => ({ ch: String.fromCodePoint(0xac00 + i), cp: `U+${(0xac00 + i).toString(16).toUpperCase()}`, reason: i % 2 ? 'tofu' : 'fallback' }));
  const result = { faces: [
    { family: 'Neo', style: 'normal', weight: '400', needed: 45, present: 45, missing: [] },
    { family: 'Instrument Serif', style: 'italic', weight: '400', needed: 45, present: 3, missing: missing(42) },
  ] };
  const s = F.summarizeCoverage(result);
  assert.equal(s.ok, false);
  assert.equal(s.missingTotal, 42);
  assert.deepEqual(s.rows.map((r) => [r.family, r.missing, r.ok]), [['Neo', 0, true], ['Instrument Serif', 42, false]]);
  const text = s.lines.join('\n');
  assert.match(text, /Neo\s+normal 400\s+45\s+0\s+OK/);
  assert.match(text, /Instrument Serif\s+italic 400\s+45\s+42\s+MISSING/);
  assert.match(text, /Instrument Serif italic 400: 42 of 45 characters have no glyph \(a system font would draw it; draws the missing-glyph box\)/);
  assert.match(text, /가 U\+AC00/);
  assert.match(text, /\.\.\. \+2 more/);
  assert.equal(F.summarizeCoverage({ faces: [result.faces[0]] }).ok, true);
});

// ---------------------------------------------------------------------------------------------------------------
// CLI (spawned; no browser needed for these paths)

function cliProject() {
  const root = tmp('ms-cli-');
  for (const d of ['lib', 'tools', 'assets']) fs.cpSync(path.join(TEMPLATE, d), path.join(root, d), { recursive: true });
  for (const f of ['studio.json', 'package.json']) fs.copyFileSync(path.join(TEMPLATE, f), path.join(root, f)); // package.json: "type": "module"
  return root;
}
const cli = (root, args, env = {}) => spawnSync(process.execPath, [path.join(root, 'tools', 'fonts.mjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, DEBUG: '', ...env }, timeout: 180000 });

test('CLI: add-file --json registers a font; list and remove see it; usage errors exit 2', () => {
  const root = cliProject();
  const src = path.join(root, 'neo.woff2');
  fs.writeFileSync(src, woff2(150));
  const added = cli(root, ['add-file', src, '--family', 'NeoDunggeunmo', '--weight', '400', '--license-file', path.join(FIXTURES, 'OFL-rfn.txt'), '--license', 'SIL OFL 1.1',
    '--unicode-range', 'U+AC00-D7A3,U+3131-318E', '--json']);
  assert.equal(added.status, 0, added.stderr);
  const j = JSON.parse(added.stdout.trim().split('\n').at(-1));
  assert.equal(j.ok, true);
  assert.equal(j.family, 'NeoDunggeunmo');
  assert.equal(j.unicodeRange, 'U+AC00-D7A3, U+3131-318E');
  assert.equal(j.license, 'OFL-1.1');
  assert.match(j.src, /^assets\/fonts\/neodunggeunmo-400-u[0-9a-f]{6}\.woff2$/);
  assert.equal(readJson(root, 'assets', 'fonts', 'fonts.json').at(-1).unicodeRange, 'U+AC00-D7A3, U+3131-318E');

  const listed = cli(root, ['list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /NeoDunggeunmo\s+weights 400 · normal · 1 file\(s\)/);

  const noFamily = cli(root, ['add-file', src]);
  assert.equal(noFamily.status, 2);
  assert.match(noFamily.stderr, /add-file needs --family NAME/);
  const badFile = cli(root, ['add-file', path.join(root, 'nope.woff2'), '--family', 'X']);
  assert.equal(badFile.status, 1);
  assert.match(badFile.stderr, /font file not found/);
  const noText = cli(root, ['coverage']);
  assert.equal(noText.status, 2);
  assert.match(noText.stderr, /coverage needs the text to check/);
  const unknown = cli(root, ['coverage', '--text', 'a', '--family', 'Nope']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no "Nope" in the registered fonts \(have: Instrument Serif, Inter, NeoDunggeunmo\)/);
  const gone = cli(root, ['remove', 'NeoDunggeunmo']);
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(exists(root, j.src), false);
  assert.equal(exists(root, j.licenseFile), false);
});

test('CLI: --help documents add-file, coverage and the Korean route', () => {
  const root = cliProject();
  const help = cli(root, ['--help']);
  assert.equal(help.status, 0);
  for (const s of ['add-file', 'coverage', '--license-file', '--unicode-range', '--text-file', '--yes', 'korean', 'full Hangul woff2']) assert.ok(help.stdout.includes(s), s);
  const bad = cli(root, ['frobnicate']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown command "frobnicate"/);
});

// ---------------------------------------------------------------------------------------------------------------
// Real browser: loadFonts with sliced fonts, hasFont, glyph coverage (skip cleanly without playwright + Chromium)

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

/** A project with the template's lib/, tools/, assets/ plus the synthetic fonts, and playwright linked in. */
function browserProject(nm, { fonts = [] } = {}) {
  const root = cliProject();
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'synth.ttf'), SYNTH);
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'synth-b.ttf'), SYNTH);
  const list = readJson(root, 'assets', 'fonts', 'fonts.json');
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify([...list, ...fonts], null, 2));
  try { fs.symlinkSync(nm, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved through NODE_PATH-less lookup below */ }
  return root;
}

async function withBrowser(t, fn) {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const root = browserProject(nm);
  let handle = null;
  try {
    try { handle = await S.launchBrowser(root, S.loadConfig(root)); } catch (err) { t.skip(`no browser: ${String(err.message).split('\n')[0]}`); return; }
    await fn({ root, nm, browser: handle.browser });
  } finally {
    if (handle) await handle.browser.close().catch(() => {});
    try { fs.unlinkSync(path.join(root, 'node_modules')); } catch { try { fs.rmdirSync(path.join(root, 'node_modules')); } catch { /* not linked */ } }
  }
}

/** Runs `body(F)` inside a blank page on the project's server; F is the module lib/fonts.js. */
async function inPage(browser, root, body, arg) {
  const srv = await S.startServer(root);
  const context = await browser.newContext({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.route('**/__t.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8">' }));
    await page.goto(`${srv.url}/__t.html`);
    return await page.evaluate(new Function('arg', `return (async () => { const F = await import('/lib/fonts.js'); return (${body.toString()})(F, arg); })()`), arg);
  } finally {
    await context.close().catch(() => {});
    await srv.close();
  }
}

test('browser: loadFonts loads every slice of a Hangul-only font, asserts it with a Hangul sample, and hasFont agrees', { timeout: 240000 }, async (t) => {
  await withBrowser(t, async ({ root, browser }) => {
    const slices = [
      { family: 'SynthSlice', src: 'assets/fonts/synth.ttf', unicodeRange: 'U+AC00-D7A3' }, // no space, no Latin: the old probe (a space) fails
      { family: 'SynthSlice', src: 'assets/fonts/synth-b.ttf', unicodeRange: 'U+0041-0042' },
    ];
    const out = await inPage(browser, root, async (F, arg) => {
      const res = {};
      res.specs = await F.loadFonts(arg.slices, { manifest: null });
      res.faces = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'SynthSlice').map((f) => f.status);
      res.hasSlice = await F.hasFont('SynthSlice');
      res.hasSliceCase = await F.hasFont('synthslice');
      res.hasOther = await F.hasFont('NoSuchFamily');
      res.hasExplicit = await F.hasFont('SynthSlice', '400', 'normal', '가');
      res.hasWrongText = await F.hasFont('SynthSlice', '400', 'normal', 'z');
      // the historical probe (no text = a space) really cannot see a Hangul-only face: this is what loadFonts used to trip over
      res.oldProbe = (await document.fonts.load('normal 400 64px "SynthSlice"')).length;
      // the same set with an explicit sample outside every range fails with the documented message
      try { await F.loadFonts([{ family: 'SynthBad', src: 'assets/fonts/synth.ttf', unicodeRange: 'U+AC00-D7A3', sample: 'z' }], { manifest: null }); res.bad = 'no error'; } catch (e) { res.bad = e.message; }
      try { await F.loadFonts([{ family: 'SynthGone', src: 'assets/fonts/nope.ttf' }], { manifest: null }); res.gone = 'no error'; } catch (e) { res.gone = e.message; }
      try { await F.loadFonts([{ family: 'SynthRange', src: 'assets/fonts/synth.ttf', unicodeRange: 'not a range' }], { manifest: null }); res.range = 'no error'; } catch (e) { res.range = e.message; }
      return res;
    }, { slices });
    assert.deepEqual(out.specs, ['normal 400 64px "SynthSlice"']);
    assert.deepEqual(out.faces, ['loaded', 'loaded'], 'both slices are loaded at boot, none waits for its first glyph');
    assert.equal(out.hasSlice, true, 'hasFont uses the characters loadFonts proved');
    assert.equal(out.hasSliceCase, true, 'family names match case-insensitively');
    assert.equal(out.hasOther, false);
    assert.equal(out.hasExplicit, true);
    assert.equal(out.hasWrongText, false, 'a character outside every slice is not covered');
    assert.equal(out.oldProbe, 0, 'a space is outside both slices');
    assert.match(out.bad, /^font missing: normal 400 64px "SynthBad" \(no loaded face covers U\+007A "z"; entry assets\/fonts\/synth\.ttf\)$/);
    assert.match(out.gone, /^font failed to load: SynthGone normal 400 from assets\/fonts\/nope\.ttf/);
    assert.match(out.range, /^font failed to load: SynthRange normal 400 from assets\/fonts\/synth\.ttf \(.*not a range/, 'a bad descriptor names the entry and the offending value');
  });
});

test('browser: the shipped fonts.json still boots through loadFonts (Instrument Serif, Inter) and hasFont sees them', { timeout: 240000 }, async (t) => {
  await withBrowser(t, async ({ root, browser }) => {
    const out = await inPage(browser, root, async (F) => {
      const specs = await F.loadFonts([]);
      return { specs, serif: await F.hasFont('Instrument Serif'), inter: await F.hasFont('Inter'), italic: await F.hasFont('Instrument Serif', '400', 'italic'), nope: await F.hasFont('Neo') };
    });
    assert.deepEqual(out.specs, ['normal 400 64px "Instrument Serif"', 'italic 400 64px "Instrument Serif"', 'normal 400 64px "Inter"']);
    assert.deepEqual([out.serif, out.inter, out.italic, out.nope], [true, true, true, false]);
  });
});

test('browser: glyphCoverage finds the characters a family cannot draw (own .notdef, system fallback, unicode-range)', { timeout: 240000 }, async (t) => {
  await withBrowser(t, async ({ root, browser }) => {
    const entries = [
      { family: 'Synth', src: 'assets/fonts/synth.ttf' },
      { family: 'SynthSlice', src: 'assets/fonts/synth.ttf', unicodeRange: 'U+AC00-D7A3' },
      { family: 'SynthSlice', src: 'assets/fonts/synth-b.ttf', unicodeRange: 'U+0041' }, // A only: B is in the file but outside the range
    ];
    const out = await inPage(browser, root, async (F, arg) => {
      await F.loadFonts(arg.entries); // the shipped manifest (Instrument Serif, Inter) plus the synthetic entries
      const text = 'AB가나다C 가';
      const cov = F.glyphCoverage([{ family: 'Synth' }, { family: 'SynthSlice' }, { family: 'Instrument Serif' }, { family: 'Inter', weight: '100 900' }, { family: 'NotRegistered' }], text);
      const only = (name) => cov.faces.find((f) => f.family === name);
      const chars = (name) => only(name).missing.map((m) => m.ch).join('');
      return { tofu: cov.tofu, invisible: cov.invisible, characters: cov.characters, synth: chars('Synth'), slice: chars('SynthSlice'), serif: chars('Instrument Serif'), inter: chars('Inter'),
        unregistered: chars('NotRegistered'), needed: only('Synth').needed, present: only('Synth').present,
        reasons: [...new Set(only('Synth').missing.map((m) => m.reason))], cps: only('Synth').missing.map((m) => m.cp),
        empty: F.glyphCoverage([{ family: 'Synth' }], ' \n\t' + String.fromCharCode(0x200b)).faces[0].missing.length,
        // U+FFFE is a noncharacter no font has: a family that draws its own .notdef box must be labelled 'tofu', and so must a Latin-only bundled font
        nonchar: F.glyphCoverage([{ family: 'Synth' }, { family: 'Instrument Serif' }], 'A' + String.fromCodePoint(0xfffe)).faces.map((x) => x.family + ':' + x.missing.map((m) => m.cp + '=' + m.reason).join()) };
    }, { entries });
    assert.ok(['U+FFFF', 'U+10FFFF', 'U+0378', 'U+2FFFF'].includes(out.tofu), `a missing-glyph reference was found (${out.tofu})`);
    assert.equal(out.characters, 7, 'A B 가 나 다 C and the space: unique characters');
    assert.equal(out.invisible, 1, 'the space is not drawn on purpose');
    assert.equal(out.needed, 6);
    assert.equal(out.synth, '다C', 'Synth draws A B 가 나 and lacks 다 and C');
    assert.equal(out.present, 4);
    assert.deepEqual(out.cps.sort(), ['U+0043', 'U+B2E4']);
    assert.ok(out.reasons.every((r) => ['fallback', 'tofu'].includes(r)), out.reasons.join());
    assert.equal(out.slice, 'B다C', 'SynthSlice: B is in the file but outside the A-only range, 다 is in the Hangul range but not in the file');
    assert.equal(out.serif.includes('가') && out.serif.includes('나') && out.serif.includes('다'), true, 'a Latin-only bundled font has no Hangul');
    assert.equal(out.serif.includes('A'), false, 'but it does have Latin');
    assert.equal(out.inter.includes('가'), true);
    assert.equal(out.inter.includes('A') || out.inter.includes('B') || out.inter.includes('C'), false);
    assert.equal(out.unregistered, 'AB가나다C', 'an unregistered family contributes nothing (an unloaded name is all fallback)');
    assert.equal(out.empty, 0, 'spaces, newlines, tabs and zero-width characters are never reported');
    assert.deepEqual(out.nonchar, ['Synth:U+FFFE=tofu', 'Instrument Serif:U+FFFE=tofu']);
  });
});

test('browser: coverage CLI exits 1 with a table naming the missing characters, 0 when everything is drawn', { timeout: 300000 }, async (t) => {
  await withBrowser(t, async ({ root, nm }) => {
    const list = readJson(root, 'assets', 'fonts', 'fonts.json');
    fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify([...list, { family: 'Synth', src: 'assets/fonts/synth.ttf', weight: '400', style: 'normal' }], null, 2));
    const env = { NODE_PATH: nm };
    const bad = cli(root, ['coverage', '--family', 'Synth,Inter', '--text', 'AB가나다', '--format', '1x1'], env);
    assert.equal(bad.status, 1, bad.stderr + bad.stdout);
    assert.match(bad.stdout, /coverage of 5 distinct characters \(Hangul 3, Latin 2, digits 0, other 0\)/);
    assert.match(bad.stdout, /Synth\s+normal 400\s+5\s+1\s+MISSING/);
    assert.match(bad.stdout, /Inter\s+normal 400\s+5\s+3\s+MISSING/);
    assert.match(bad.stdout, /다 U\+B2E4/);
    assert.match(bad.stdout, /2 of 2 face\(s\) lack characters/);
    const good = cli(root, ['coverage', '--family', 'Synth', '--text', 'AB가나', '--json'], env);
    assert.equal(good.status, 0, good.stderr + good.stdout);
    const j = JSON.parse(good.stdout.trim().split('\n').at(-1));
    assert.equal(j.ok, true);
    assert.deepEqual(j.faces.map((f) => [f.family, f.needed, f.present, f.missing.length]), [['Synth', 4, 4, 0]]);
    const file = path.join(root, 'text.txt');
    fs.writeFileSync(file, 'A가\n');
    const viaFile = cli(root, ['coverage', '--family', 'Synth', '--text-file', file, '--text', 'B'], env);
    assert.equal(viaFile.status, 0, viaFile.stderr + viaFile.stdout);
    assert.match(viaFile.stdout, /coverage of 3 distinct characters/);
  });
});
