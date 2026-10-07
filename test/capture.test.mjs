// skills/product-reel/scripts/capture.mjs, capture-fonts.mjs and capture-page.mjs: image type by magic bytes, the web fonts a
// page really uses (same-origin CSS, a cross-origin sheet the page cannot read, unused faces, fonts.json entries that
// already exist), license status (UNVERIFIED unless a URL or file turns up) and component crops that lie outside the
// page. The helper tests run anywhere; the browser test skips unless playwright resolves and a Chromium browser starts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(REPO, 'skills', 'product-reel', 'scripts');
const TEMPLATE = process.env.MOTION_TEMPLATE_DIR ? path.resolve(process.env.MOTION_TEMPLATE_DIR) : path.join(REPO, 'skills', 'studio-init', 'template');
const TEMPLATE_FONTS = path.join(TEMPLATE, 'assets', 'fonts');
const C = await import(pathToFileURL(path.join(SCRIPTS, 'capture.mjs')).href);
const F = await import(pathToFileURL(path.join(SCRIPTS, 'capture-fonts.mjs')).href);
const G = await import(pathToFileURL(path.join(SCRIPTS, 'capture-guard.mjs')).href);
const B = await import(pathToFileURL(path.join(SCRIPTS, 'capture-banner.mjs')).href);

// Every temp dir a test makes is removed when the file is done (a link to the shared node_modules is unlinked first, never followed).
const made = new Set();
const tmp = (prefix = 'ms-capture-') => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.add(dir); return dir; };
function rmTree(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; } // already gone
  let linked = false;
  for (const name of names) {
    const p = path.join(dir, name);
    let isLink = false;
    try { isLink = fs.lstatSync(p).isSymbolicLink(); } catch { /* vanished */ }
    if (!isLink) continue;
    try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { linked = true; } } // only the link goes, never what it points to
  }
  if (linked) return; // a link we could not remove: leak the temp dir rather than recurse into a shared folder
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
after(() => { for (const dir of made) rmTree(dir); });
const bundled = (name) => fs.readFileSync(path.join(TEMPLATE_FONTS, name));

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: tiny real images, and fonts built here (or the OFL woff2 files the template already ships).

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0, 40, 0, 0, 0, 22, 0, 0, 0]), Buffer.alloc(40)]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypavif', 'latin1'), Buffer.alloc(16)]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#d97757"/></svg>');

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };

/** A `name` table (format 0, Windows/English) holding { id: string }. */
function nameTable(names) {
  const list = Object.entries(names).map(([id, str]) => ({ id: Number(id), data: Buffer.from(str, 'utf16le').swap16() })).sort((a, b) => a.id - b.id);
  let off = 0;
  const recs = list.map((n) => { const r = Buffer.concat([u16(3), u16(1), u16(0x409), u16(n.id), u16(n.data.length), u16(off)]); off += n.data.length; return r; });
  return Buffer.concat([u16(0), u16(list.length), u16(6 + 12 * list.length), ...recs, ...list.map((n) => n.data)]);
}

/** A TrueType container with only a name table: enough for sniffing and license metadata, never loaded by a browser. */
function buildTtf(names) {
  const table = nameTable(names);
  return Buffer.concat([u32(0x00010000), u16(1), u16(16), u16(0), u16(0), Buffer.from('name'), u32(0), u32(28), u32(table.length), table, Buffer.alloc((4 - (table.length % 4)) % 4)]);
}

/** A WOFF (zlib) wrapper around the same name table. */
function buildWoff(names) {
  const table = nameTable(names);
  const comp = zlib.deflateSync(table);
  const total = 44 + 20 + comp.length;
  return Buffer.concat([Buffer.from('wOFF'), u32(0x00010000), u32(total), u16(1), u16(0), u32(64), u16(1), u16(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    Buffer.from('name'), u32(64), u32(comp.length), u32(table.length), u32(0), comp]);
}

/** A WOFF2 (brotli) whose only table is `name` (known-tag index 5, no transform). */
function buildWoff2(names) {
  const table = nameTable(names);
  const comp = zlib.brotliCompressSync(table);
  const base128 = (n) => { const out = [n & 0x7f]; for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 0x7f) | 0x80); return out; };
  const dir = Buffer.from([5, ...base128(table.length)]); // flags: tag 5, version 0; origLength as a UIntBase128
  const total = 48 + dir.length + comp.length;
  return Buffer.concat([Buffer.from('wOF2'), u32(0x00010000), u32(total), u16(1), u16(0), u32(table.length), u32(comp.length), u16(1), u16(0), u32(0), u32(0), u32(0), u32(0), u32(0), dir, comp]);
}

// ---------------------------------------------------------------------------------------------------------------
// Image sniffing

test('sniffImage: PNG, JPEG, WebP, GIF, ICO, AVIF and SVG by their bytes; anything else is not an image', () => {
  const want = [[PNG, '.png'], [JPG, '.jpg'], [WEBP, '.webp'], [GIF, '.gif'], [ICO, '.ico'], [AVIF, '.avif'], [SVG, '.svg'],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('  <svg viewBox="0 0 1 1"></svg>')]), '.svg']];
  for (const [buf, ext] of want) assert.equal(C.sniffImage(buf)?.ext, ext, `expected ${ext}`);
  assert.equal(C.sniffImage(PNG).type, 'image/png');
  for (const bad of [Buffer.from('<!doctype html><html><body>404</body></html>'), Buffer.from('{"error":"not found"}'), Buffer.alloc(0), Buffer.from([0, 0, 1, 0, 0, 0]),
    Buffer.from('GIF9'), Buffer.from('RIFF....WAVE'), buildTtf({ 1: 'x' })]) {
    assert.equal(C.sniffImage(bad), null, `${bad.subarray(0, 12).toString('latin1')} is no image`);
  }
});

test('parseDataUrl: base64, percent-encoded and ";utf8" data URLs; malformed ones are refused', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>';
  assert.equal(C.sniffImage(C.parseDataUrl(`data:image/svg+xml;utf8,${svg}`).body).ext, '.svg');
  assert.equal(C.sniffImage(C.parseDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`).body).ext, '.svg');
  assert.equal(C.sniffImage(C.parseDataUrl(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).body).ext, '.svg');
  assert.equal(C.parseDataUrl(`data:image/png;base64,${PNG.toString('base64')}`).type, 'image/png');
  assert.equal(C.parseDataUrl('data:,%E0%A4%A'), null);
  assert.equal(C.parseDataUrl('data:nonsense'), null);
});

// ---------------------------------------------------------------------------------------------------------------
// Font helpers

test('sniffFont: woff2, woff, ttf and otf by bytes; HTML, collections, truncated files and garbage are refused', () => {
  const inter = bundled('inter-100-900-latin.woff2');
  assert.deepEqual(F.sniffFont(inter), { kind: 'woff2', ext: '.woff2' });
  assert.deepEqual(F.sniffFont(buildWoff({ 1: 'A' })), { kind: 'woff', ext: '.woff' });
  assert.deepEqual(F.sniffFont(buildTtf({ 1: 'A' })), { kind: 'ttf', ext: '.ttf' });
  const otf = buildTtf({ 1: 'A' });
  otf.write('OTTO', 0, 'latin1');
  assert.deepEqual(F.sniffFont(otf), { kind: 'otf', ext: '.otf' });
  assert.match(F.sniffFont(inter.subarray(0, inter.length - 10)).problem, /truncated woff2/);
  assert.match(F.sniffFont(Buffer.from('<!DOCTYPE html><html>not found page</html>')).problem, /HTML page/);
  assert.match(F.sniffFont(Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(40)])).problem, /collection/);
  assert.match(F.sniffFont(Buffer.from('hello world, definitely no font')).problem, /not a font container/);
  assert.match(F.sniffFont(Buffer.alloc(4)).problem, /too small/);
});

test('parseSrc and parseFontFaces: every url() with its format hint, local() dropped, comments ignored, unicode-range kept', () => {
  const css = `/* latin */
@font-face {
  font-family: 'Roboto Flex';
  font-style: italic;
  font-weight: 100 1000;
  font-display: swap;
  src: local('Roboto Flex'), url(https://fonts.gstatic.com/s/x/a.woff2) format('woff2'), url("../fonts/a.ttf") format("truetype");
  unicode-range: U+0000-00FF, U+0131;
}
@font-face { font-family: "Plain"; src: url(plain.woff) format(woff); }`;
  const faces = F.parseFontFaces(css, 'https://site.test/css/main.css');
  assert.equal(faces.length, 2);
  assert.deepEqual([faces[0].family, faces[0].weight, faces[0].style, faces[0].unicodeRange], ['Roboto Flex', '100 1000', 'italic', 'U+0000-00FF, U+0131']);
  assert.deepEqual(F.parseSrc(faces[0].srcText, faces[0].base), [{ url: 'https://fonts.gstatic.com/s/x/a.woff2', format: 'woff2' }, { url: 'https://site.test/fonts/a.ttf', format: 'truetype' }]);
  assert.deepEqual([faces[1].family, faces[1].weight, faces[1].style, faces[1].unicodeRange], ['Plain', '400', 'normal', null]);
  assert.deepEqual(F.parseSrc(faces[1].srcText, faces[1].base), [{ url: 'https://site.test/css/plain.woff', format: 'woff' }]);
  assert.deepEqual(F.parseSrc("url(data:font/woff2;base64,AAAA) format('woff2')", 'https://x/'), [{ url: 'data:font/woff2;base64,AAAA', format: 'woff2' }]);
});

test('readFontNames: the license URL and text a font file declares (ttf, woff, woff2 with brotli, and real OFL files)', () => {
  const names = { 0: 'Copyright 2024 Someone', 13: 'Licensed under the SIL Open Font License, Version 1.1.', 14: 'https://openfontlicense.org', 1: 'Test' };
  for (const [label, buf] of [['ttf', buildTtf(names)], ['woff', buildWoff(names)], ['woff2', buildWoff2(names)]]) {
    const got = F.readFontNames(buf);
    assert.equal(got.copyright, 'Copyright 2024 Someone', label);
    assert.equal(got.licenseUrl, 'https://openfontlicense.org', label);
    assert.match(got.licenseText, /SIL Open Font License/, label);
  }
  assert.deepEqual(F.readFontNames(buildTtf({ 1: 'Only a family' })), { copyright: null, licenseText: null, licenseUrl: null });
  assert.deepEqual(F.readFontNames(Buffer.from('not a font at all')), {});
  const inter = F.readFontNames(bundled('inter-100-900-latin.woff2')); // a real Google Fonts woff2 keeps ids 0 and 14
  assert.match(inter.copyright, /Inter Project Authors/);
  assert.match(inter.licenseUrl, /openfontlicense\.org/);
});

// ---------------------------------------------------------------------------------------------------------------
// collectFonts / registerFonts with a fake request context (no browser)

function fakeContext(routes) {
  const calls = [];
  const options = [];
  const bodies = [];
  const reply = (r) => ({ ok: () => !!r && (r.status ?? 200) < 400, status: () => r?.status ?? 200, body: async () => { bodies.push(r); return Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? ''); }, headers: () => r.headers ?? {} });
  return { calls, options, bodies, request: { get: async (url, opts) => { calls.push(url); options.push(opts); const r = routes[url]; return r ? reply(r) : { ok: () => false, status: () => 404, body: async () => Buffer.alloc(0), headers: () => ({}) }; } } };
}

/** A capture guard whose DNS is a table: every host is public (93.184.216.34) unless `table` says otherwise. Hermetic: no real lookups. */
const guardFor = (target, table = {}, extra = {}) => {
  const lookups = [];
  const lookup = async (host) => { lookups.push(host); const v = host in table ? table[host] : '93.184.216.34'; if (v === null) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return [{ address: v, family: v.includes(':') ? 6 : 4 }]; };
  return Object.assign(G.createGuard({ target, lookup, ...extra }), { lookups });
};

const rule = (family, weight, style, unicodeRange, srcText, base) => ({ family, weight, style, unicodeRange, srcText, base });
const loadedFace = (family, weight, style, unicodeRange) => ({ family, weight, style, unicodeRange, status: 'loaded' });

test('collectFonts: only faces the page loaded, one file per face, woff2 preferred, the rest reported', async () => {
  const PAGE = 'https://site.test/';
  const woff2 = bundled('instrument-serif-400-latin.woff2');
  const ttf = buildTtf({ 1: 'Nolic Sans' });
  const ctx = fakeContext({
    'https://site.test/f/a.woff2': { body: woff2, headers: { 'content-type': 'text/plain' } },
    'https://site.test/f/a.ttf': { body: ttf },
    'https://site.test/f/b.woff2': { body: '<!doctype html><html>gone</html>' }, // a 200 HTML page served for a font URL
    'https://site.test/f/b.ttf': { body: ttf },
    'https://cdn.test/f/c.woff2': { body: woff2 },
    'https://cdn.test/x.css': { body: "@font-face { font-family: 'Cross Face'; src: url(/f/c.woff2) format('woff2'); }" },
  });
  const fonts = {
    rules: [
      rule('Nolic Sans', '400', 'normal', null, "url(a.ttf) format('truetype'), url(a.woff2) format('woff2')", 'https://site.test/f/x.css'), // woff2 must win
      rule('Nolic Sans', '400', 'normal', null, 'url(a.ttf)', 'https://site.test/f/x.css'), // duplicate of the face above
      rule('Broken Sans', 'bold', 'normal', null, "url(b.woff2) format('woff2'), url(b.ttf) format('truetype')", 'https://site.test/f/x.css'), // HTML first, then a real ttf
      rule('Ghost', '400', 'normal', null, 'url(a.woff2)', 'https://site.test/f/x.css'), // declared, never loaded
      rule('Legacy', '400', 'normal', null, "url(a.eot) format('embedded-opentype')", 'https://site.test/f/x.css'), // loaded, but no usable source
    ],
    allLoaded: [loadedFace('Nolic Sans', '400', 'normal', null), loadedFace('Broken Sans', '700', 'normal', null), loadedFace('Cross Face', '400', 'normal', null), loadedFace('Legacy', '400', 'normal', null),
      { family: 'Ghost', weight: '400', style: 'normal', unicodeRange: null, status: 'unloaded' }],
    unreadableSheets: ['https://cdn.test/x.css'],
  };
  const notes = [];
  const plan = await F.collectFonts(ctx, fonts, PAGE, [], notes, guardFor(PAGE));
  const by = Object.fromEntries(plan.files.map((f) => [f.family, f]));
  assert.deepEqual(Object.keys(by).sort(), ['Broken Sans', 'Cross Face', 'Nolic Sans']);
  assert.equal(by['Nolic Sans'].ext, '.woff2', 'the woff2 source is preferred over the ttf listed first');
  assert.equal(by['Broken Sans'].ext, '.ttf', 'an HTML body is refused and the next source is tried');
  assert.equal(by['Broken Sans'].weight, '700', 'bold is normalized to 700');
  assert.equal(ctx.calls.filter((u) => u === 'https://site.test/f/a.woff2').length, 1, 'a duplicate face is fetched once');
  assert.ok(!ctx.calls.some((u) => u.endsWith('a.ttf')), 'the ttf of a face with a woff2 source is not downloaded');
  assert.match(plan.skipped.find((s) => s.family === 'Legacy').reason, /no woff2, woff, ttf or otf source/);
  assert.equal(plan.unused, 1);
  assert.ok(notes.some((n) => /1 @font-face rule\(s\) were declared but not used/.test(n)), notes.join('\n'));
  assert.ok(ctx.calls.includes('https://cdn.test/x.css'), 'the unreadable sheet is fetched and parsed by Node');
});

test('collectFonts: an entry already in fonts.json (same family, style, range, weight inside its range) is left alone and not downloaded', async () => {
  const ctx = fakeContext({ 'https://site.test/a.woff2': { body: bundled('inter-100-900-latin.woff2') } });
  const existing = [{ family: 'inter', src: 'assets/fonts/mine.woff2', weight: '100 900', style: 'normal', license: 'MINE' }];
  const fonts = {
    rules: [rule('Inter', '400', 'normal', null, 'url(a.woff2)', 'https://site.test/'), rule('Inter', '400', 'italic', null, 'url(a.woff2)', 'https://site.test/'),
      rule('Inter', '400', 'normal', 'U+0000-00FF', 'url(a.woff2)', 'https://site.test/')],
    allLoaded: [loadedFace('Inter', '400', 'normal', null), loadedFace('Inter', '400', 'italic', null), loadedFace('Inter', '400', 'normal', 'U+0000-00FF')],
  };
  const plan = await F.collectFonts(ctx, fonts, 'https://site.test/', existing, [], guardFor('https://site.test/'));
  assert.deepEqual(plan.files.map((f) => `${f.style} ${f.unicodeRange}`).sort(), ['italic null', 'normal U+0000-00FF'], 'a different style or unicode-range is a different face');
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /already registered in fonts\.json \(assets\/fonts\/mine\.woff2\)/);
  assert.equal(ctx.calls.filter((u) => u.endsWith('/a.woff2')).length, 2, 'the covered face was not fetched');
});

test('collectFonts: unicode-range matching ignores leading zeros and case, and a FontFace without a range means no slicing', async () => {
  const ctx = fakeContext({ 'https://site.test/a.woff2': { body: bundled('inter-100-900-latin.woff2') } });
  const fonts = {
    rules: [rule('Sliced', '400', 'normal', 'U+0000-00FF, U+0131, u+2000-206f', 'url(a.woff2)', 'https://site.test/'), rule('Whole', '400', 'normal', null, 'url(a.woff2)', 'https://site.test/')],
    // what Chrome reports for the same faces: shortened hex, and the whole code space when the rule has no unicode-range
    allLoaded: [loadedFace('Sliced', '400', 'normal', 'U+0-FF, U+131, U+2000-206F'), loadedFace('Whole', 'normal', 'normal', 'U+0-10FFFF')],
  };
  const plan = await F.collectFonts(ctx, fonts, 'https://site.test/', [], [], guardFor('https://site.test/'));
  assert.deepEqual(plan.files.map((f) => f.family).sort(), ['Sliced', 'Whole']);
  assert.equal(plan.files.find((f) => f.family === 'Sliced').unicodeRange, 'U+0000-00FF, U+0131, U+2000-206F', 'the range is stored upper-case, as the stylesheet wrote it');
  assert.equal(plan.files.find((f) => f.family === 'Whole').unicodeRange, null);
  const again = await F.collectFonts(ctx, fonts, 'https://site.test/', [{ family: 'Sliced', src: 'x', weight: '400', style: 'normal', unicodeRange: 'U+0-FF, U+131, U+2000-206F' }], [], guardFor('https://site.test/'));
  assert.deepEqual(again.files.map((f) => f.family), ['Whole'], 'an entry written with the short form covers the long form');
});

test('collectFonts: license status is UNVERIFIED unless a URL or a file is found', async () => {
  const PAGE = 'https://site.test/';
  const bare = buildTtf({ 1: 'Bare Sans' }); // declares no license
  const declared = buildTtf({ 1: 'Decl Sans', 13: 'This Font Software is licensed under the SIL Open Font License, Version 1.1.', 14: 'https://openfontlicense.org' });
  const OFL = 'This Font Software is licensed under the SIL Open Font License, Version 1.1. See the FAQ. '.repeat(3);
  const ctx = fakeContext({
    'https://site.test/self/bare.ttf': { body: bare },
    'https://site.test/self/decl.ttf': { body: declared },
    'https://site.test/pkg/next.ttf': { body: bare },
    'https://site.test/pkg/OFL.txt': { body: OFL },
    'https://fonts.gstatic.com/s/goog.ttf': { body: bare },
    'https://other.test/x/foreign.ttf': { body: bare },
    'https://other.test/x/OFL.txt': { body: OFL }, // a different origin is never probed
    'https://site.test/self/LICENSE': { body: '<!doctype html><html>SPA fallback page that mentions licence</html>' },
  });
  const face = (family, url) => ({ rule: rule(family, '400', 'normal', null, `url(${url}) format('truetype')`, PAGE), loaded: loadedFace(family, '400', 'normal', null) });
  const list = [face('Bare Sans', 'self/bare.ttf'), face('Decl Sans', 'self/decl.ttf'), face('Next Sans', 'pkg/next.ttf'), face('Goog Sans', 'https://fonts.gstatic.com/s/goog.ttf'), face('Foreign Sans', 'https://other.test/x/foreign.ttf')];
  const plan = await F.collectFonts(ctx, { rules: list.map((x) => x.rule), allLoaded: list.map((x) => x.loaded) }, PAGE, [], [], guardFor(PAGE));
  const lic = Object.fromEntries(plan.files.map((f) => [f.family, f.license]));
  assert.equal(lic['Bare Sans'].status, 'UNVERIFIED');
  assert.match(lic['Bare Sans'].note, /check the font license before publishing/);
  assert.equal(lic['Decl Sans'].status, 'FOUND');
  assert.equal(lic['Decl Sans'].url, 'https://openfontlicense.org');
  assert.equal(lic['Decl Sans'].id, 'OFL-1.1');
  assert.equal(lic['Next Sans'].status, 'FOUND');
  assert.equal(lic['Next Sans'].url, 'https://site.test/pkg/OFL.txt');
  assert.ok(plan.files.find((f) => f.family === 'Next Sans').licenseFile, 'the text next to the font is kept for copying');
  assert.equal(lic['Goog Sans'].status, 'FOUND');
  assert.equal(lic['Goog Sans'].url, 'https://fonts.google.com/specimen/Goog+Sans');
  assert.equal(lic['Foreign Sans'].status, 'UNVERIFIED', 'no probing of another origin');
  assert.ok(!ctx.calls.includes('https://other.test/x/OFL.txt'));
  assert.equal(lic['Bare Sans'].status, 'UNVERIFIED', 'an HTML fallback page is not a license file');
});

test('registerFonts: files and fonts.json entries in the tools/fonts.mjs add-file shape; an existing entry and another family\'s file are never overwritten', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify([{ family: 'Old', src: 'assets/fonts/foo-400.woff2', weight: '400', style: 'normal' }]));
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'foo-400.woff2'), 'OLD BYTES');
  const buf = bundled('instrument-serif-400-latin.woff2');
  const lic = { status: 'UNVERIFIED', note: 'n' };
  const files = [
    { family: 'Foo', weight: '400', style: 'normal', unicodeRange: null, url: 'https://x/a.woff2', buf, kind: 'woff2', ext: '.woff2', license: lic, licenseFile: null },
    { family: 'Foo', weight: '400', style: 'italic', unicodeRange: 'U+0000-00FF', url: 'https://x/b.woff2', buf, kind: 'woff2', ext: '.woff2', license: { status: 'FOUND', url: 'https://x/OFL.txt', id: 'OFL-1.1' }, licenseFile: { body: Buffer.from('OFL TEXT'), url: 'https://x/OFL.txt', id: 'OFL-1.1' } },
    { family: 'Noto Sans KR', weight: '100 900', style: 'normal', unicodeRange: null, url: 'https://x/c.woff2', buf, kind: 'woff2', ext: '.woff2', license: lic, licenseFile: null },
  ];
  const written = F.registerFonts(root, files);
  const list = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), 'utf8'));
  assert.equal(list.length, 4);
  assert.deepEqual(list[0], { family: 'Old', src: 'assets/fonts/foo-400.woff2', weight: '400', style: 'normal' });
  assert.equal(fs.readFileSync(path.join(root, 'assets', 'fonts', 'foo-400.woff2'), 'utf8'), 'OLD BYTES', 'another family\'s file is untouched');
  assert.notEqual(list[1].src, 'assets/fonts/foo-400.woff2');
  assert.match(list[1].src, /^assets\/fonts\/foo-400-[0-9a-f]{6}\.woff2$/);
  assert.deepEqual(Object.keys(list[1]), ['family', 'src', 'weight', 'style'], 'no license keys when none was found');
  assert.match(list[2].src, /^assets\/fonts\/foo-400-italic-u[0-9a-f]{6}\.woff2$/);
  assert.equal(list[2].unicodeRange, 'U+0000-00FF');
  assert.equal(list[2].license, 'OFL-1.1');
  assert.equal(list[2].licenseFile, 'assets/fonts/OFL-Foo.txt');
  assert.equal(fs.readFileSync(path.join(root, list[2].licenseFile), 'utf8'), 'OFL TEXT');
  assert.equal(list[3].src, 'assets/fonts/noto-sans-kr-100-900.woff2');
  assert.equal(list[3].weight, '100 900');
  assert.equal(written.length, 3);
  assert.equal(written[0].license.status, 'UNVERIFIED');
  assert.throws(() => { fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), '{ nope'); F.readFontsJson(root); }, /not valid JSON/);
});

// ---------------------------------------------------------------------------------------------------------------
// End to end in Chrome

function findNodeModules() {
  const env = process.env.MOTION_SMOKE_NODE_MODULES;
  if (env) return fs.existsSync(path.join(env, 'playwright')) || fs.existsSync(path.join(env, 'playwright-core')) ? path.resolve(env) : null;
  for (const base of [path.join(REPO, 'package.json'), path.join(REPO, 'skills', 'studio-init', 'template', 'package.json')]) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return path.dirname(path.dirname(createRequire(base).resolve(`${name}/package.json`))); } catch { /* next */ }
    }
  }
  return null;
}

const listen = (handler) => new Promise((resolve) => { const srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => resolve(srv)); });
const runNode = (args, cwd) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, out, err }));
});

test('capture.mjs against a local page: image types by bytes, fonts the page loads, existing entries kept, off-page crops skipped', { timeout: 240000 }, async (t) => {
  const nm = findNodeModules();
  if (!nm) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const inter = bundled('inter-100-900-latin.woff2');
  const serif = bundled('instrument-serif-400-latin.woff2');
  const OFL = 'This Font Software is licensed under the SIL Open Font License, Version 1.1. Test copy for the capture test. '.repeat(2);
  const cors = { 'access-control-allow-origin': '*' };
  const other = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/cross.css') { res.writeHead(200, { 'content-type': 'text/css', ...cors }); res.end("@font-face { font-family: 'Cross Serif'; font-weight: 400; src: url(/serif.woff2) format('woff2'); }"); return; }
    if (url.pathname === '/serif.woff2') { res.writeHead(200, { 'content-type': 'font/woff2', ...cors }); res.end(serif); return; }
    res.writeHead(404, cors); res.end();
  });
  const otherPort = other.address().port;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test Product</title>
<meta property="og:image" content="/og.png"><link rel="icon" href="/icon.ico">
<link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="http://127.0.0.1:${otherPort}/cross.css">
<style>body{margin:0;font:400 20px "Test Sans",sans-serif}h1{font-weight:400}.drawer{position:absolute;left:-9999px;top:120px;width:300px;height:200px;background:#eee}</style></head>
<body><header style="height:60px"><a href="/"><img alt="logo" src="/logo.jpg" width="120" height="40"></a></header>
<h1>Ship <span style="font-family:'Cross Serif',serif">faster</span></h1><p style="font-family:'Pre Face',sans-serif">Pre existing face</p>
<div class="drawer">Off-canvas drawer</div>
<div style="position:relative;overflow:hidden;width:400px;height:120px"><div class="slide" style="position:absolute;left:3000px;top:0;width:300px;height:100px;background:#ccc">Slide two</div></div>
<div style="height:1600px"></div><section class="below" style="width:600px;height:200px;background:#ddd">Below the fold</section></body></html>`;
  const site = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    switch (url.pathname) {
      case '/': return send('text/html', html);
      case '/site.css': return send('text/css', `@font-face{font-family:"Test Sans";font-weight:400;src:url(/fonts/inter.woff2) format("woff2")}
@font-face{font-family:"Test Sans";font-weight:700;src:url(/fonts/inter.woff2?bold) format("woff2")}
@font-face{font-family:"Ghost Font";src:url(/fonts/ghost.woff2) format("woff2")}
@font-face{font-family:"Pre Face";font-weight:400;src:url(/fonts/inter.woff2?pre) format("woff2")}`);
      case '/fonts/inter.woff2': return send('text/plain', inter); // labelled wrongly on purpose
      case '/fonts/OFL.txt': return send('text/plain', OFL);
      case '/logo.jpg': return send('image/jpeg', PNG); // a PNG labelled JPEG
      case '/og.png': return send('image/png', WEBP); // a WebP labelled PNG
      case '/icon.ico': return send('image/x-icon', '<!doctype html><html><body>not really an icon</body></html>'); // an HTML page with a 200
      default: res.writeHead(404); return res.end('nope');
    }
  });
  const root = tmp('ms-capture-e2e-');
  try {
    fs.writeFileSync(path.join(root, 'studio.json'), '{}');
    try { fs.symlinkSync(nm, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved by the plugin repo instead */ }
    fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'fonts', 'mine.woff2'), 'MY OWN BYTES');
    const seeded = [{ family: 'Pre Face', src: 'assets/fonts/mine.woff2', weight: '400', style: 'normal', license: 'MINE' }];
    fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify(seeded));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const args = [path.join(SCRIPTS, 'capture.mjs'), url, '--root', root, '--viewports', 'desktop', '--settle', '0.1', '--selector', '.drawer', '--selector', '.slide', '--selector', '.below', '--allow-private', '--json']; // --allow-private: the cross-origin stylesheet lives on another port of 127.0.0.1
    const r = await runNode(args, root);
    if (/could not launch a browser|playwright is not installed/.test(r.err)) { t.skip(`no browser: ${r.err.split('\n')[0]}`); return; }
    assert.equal(r.code, 0, r.err);
    const json = JSON.parse(r.out.trim().split('\n').pop());
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'manifest.json'), 'utf8'));

    // images: extension from the bytes, HTML refused
    assert.deepEqual(manifest.logos.filter((l) => l.source === 'img').map((l) => path.extname(l.file)), ['.png'], JSON.stringify(manifest.logos));
    assert.deepEqual(manifest.images.map((i) => path.extname(i.file)), ['.webp']);
    assert.ok(manifest.notes.some((n) => /not an image \(declared image\/x-icon/.test(n)), manifest.notes.join('\n'));
    assert.ok(manifest.notes.some((n) => /server said image\/jpeg but the bytes are image\/png/.test(n)));

    // component crops: the drawer (x < 0) and the slide (right of the viewport) are skipped, the section below the fold is cropped
    assert.deepEqual(manifest.components.filter((c) => c.label === 'custom').map((c) => c.selector), ['.below']);
    assert.ok(manifest.notes.some((n) => /component crop skipped: \.drawer starts outside the page/.test(n)), manifest.notes.join('\n'));
    assert.ok(manifest.notes.some((n) => /component crop skipped: \.slide starts right of the 1440px viewport/.test(n)));

    // fonts: used faces only, existing entries untouched
    const list = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), 'utf8'));
    assert.deepEqual(list[0], seeded[0], 'the existing Pre Face entry is unchanged');
    assert.equal(fs.readFileSync(path.join(root, 'assets', 'fonts', 'mine.woff2'), 'utf8'), 'MY OWN BYTES');
    assert.deepEqual(list.map((f) => `${f.family} ${f.weight}`).sort(), ['Cross Serif 400', 'Pre Face 400', 'Test Sans 400'], `${r.err}
${JSON.stringify(manifest.fonts, null, 1)}`);
    const test400 = list.find((f) => f.family === 'Test Sans');
    assert.equal(test400.src, 'assets/fonts/test-sans-400.woff2');
    assert.ok(fs.readFileSync(path.join(root, test400.src)).equals(inter), 'the file is the served font, saved with the extension its bytes give');
    assert.equal(test400.licenseFile, 'assets/fonts/OFL-TestSans.txt', 'the OFL text next to the font is copied');
    assert.equal(test400.license, 'OFL-1.1');
    const cross = list.find((f) => f.family === 'Cross Serif');
    assert.ok(cross && fs.readFileSync(path.join(root, cross.src)).equals(serif), 'a font from a stylesheet the page cannot read is still captured');
    assert.equal(cross.licenseFile, undefined);
    const files = Object.fromEntries(manifest.fonts.files.map((f) => [f.family, f]));
    assert.deepEqual(Object.keys(files).sort(), ['Cross Serif', 'Test Sans']);
    assert.equal(files['Test Sans'].license.status, 'FOUND');
    assert.equal(files['Cross Serif'].license.status, 'FOUND'); // its name table declares https://scripts.sil.org/OFL
    assert.match(files['Cross Serif'].license.url, /scripts\.sil\.org\/OFL/);
    assert.ok(manifest.fonts.skipped.some((s) => s.family === 'Pre Face' && /already registered/.test(s.reason)));
    assert.ok(manifest.notes.some((n) => /1 @font-face rule\(s\)|2 @font-face rule\(s\)/.test(n) && /not used by this page/.test(n)), manifest.notes.join('\n'));
    assert.match(r.err, /fonts license: .*Check each font's license before you publish/);
    assert.equal(json.fontFiles.length, 2);

    // --no-fonts touches nothing
    fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify(seeded));
    fs.rmSync(path.join(root, test400.src));
    const off = await runNode([...args, '--no-fonts'], root);
    assert.equal(off.code, 0, off.err);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), 'utf8')), seeded);
    assert.ok(!fs.existsSync(path.join(root, test400.src)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'assets', 'manifest.json'), 'utf8')).fonts.files, []);
  } finally {
    await new Promise((r) => site.close(r));
    await new Promise((r) => other.close(r));
    rmTree(root);
    assert.ok(fs.existsSync(nm), 'shared node_modules untouched');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The built-in launcher (a project without tools/studio.mjs): bounded browser and context closes. No real browser.

/** Runs fn with process.stderr.write collected instead of printed; resolves { result, stderr }. */
async function withStderr(fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); rest.find((r) => typeof r === 'function')?.(); return true; };
  try { return { result: await fn(), stderr: lines.join('') }; } finally { process.stderr.write = write; }
}
const withEnv = async (patch, fn) => {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
/** A child process standing in for a browser process: { child, exited }. */
const sleeper = () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  return { child, exited: new Promise((resolve) => child.once('exit', () => resolve())) };
};

test('capture boundClose: browser.close() is bounded and idempotent, kills a wedged browser by pid, never kills a disconnected one', async () => {
  let calls = 0;
  const hung = C.boundClose({ close: () => { calls++; return new Promise(() => {}); } }, 100);
  const abandoned = await withStderr(async () => {
    const first = hung.close();
    assert.equal(hung.close(), first, 'a second close() returns the same bounded promise');
    return first;
  });
  assert.equal(abandoned.result, false, 'abandoned after the timeout');
  assert.equal(calls, 1, 'the real close ran once');
  assert.equal(abandoned.stderr, 'note: the browser did not close within 0.1 s; not waiting for it (it is killed when this process exits)\n');

  let opts = null;
  const quick = C.boundClose({ close: async (o) => { opts = o; } }, 5000);
  assert.equal(await quick.close({ reason: 'done' }), true);
  assert.deepEqual(opts, { reason: 'done' }, 'options are passed through');
  const failing = C.boundClose({ close: async () => { throw new Error('already closed'); } }, 5000);
  assert.equal(await failing.close(), true, 'a rejected close never throws');

  const a = sleeper();
  const wedged = C.boundClose({ close: () => a.exited, isConnected: () => true }, 100, { pid: a.child.pid });
  const t0 = Date.now();
  const killed = await withStderr(() => wedged.close());
  const closeMs = Date.now() - t0;
  assert.equal(killed.result, false);
  await Promise.race([a.exited, new Promise((resolve) => setTimeout(resolve, 20000))]); // the exit event may lag on a saturated machine
  assert.ok(a.child.exitCode !== null || a.child.signalCode !== null, 'the browser process was killed');
  assert.ok(closeMs < 10000, `the bounded close took ${closeMs} ms`);
  assert.match(killed.stderr, /^note: the browser did not close within 0\.1 s; killed it\n$/);

  const b = sleeper();
  try {
    const gone = C.boundClose({ close: () => new Promise(() => {}), isConnected: () => false }, 50, { pid: b.child.pid });
    assert.equal(await (await withStderr(() => gone.close())).result, false);
    assert.equal(b.child.exitCode, null, 'a disconnected browser pid is never killed (it may have been reused)');
  } finally { b.child.kill(); await b.exited; }
});

test('capture closeTimeoutMs: MOTION_CLOSE_TIMEOUT_MS, default 8000 (as tools/studio-web.mjs)', async () => {
  await withEnv({ MOTION_CLOSE_TIMEOUT_MS: undefined }, () => assert.equal(C.closeTimeoutMs(), 8000));
  await withEnv({ MOTION_CLOSE_TIMEOUT_MS: '1500' }, () => assert.equal(C.closeTimeoutMs(), 1500));
  await withEnv({ MOTION_CLOSE_TIMEOUT_MS: 'soon' }, () => assert.equal(C.closeTimeoutMs(), 8000, 'not a number = default'));
  const S = await import(pathToFileURL(path.join(TEMPLATE, 'tools', 'studio.mjs')).href);
  await withEnv({ MOTION_CLOSE_TIMEOUT_MS: undefined }, () => assert.equal(C.closeTimeoutMs(), S.closeTimeoutMs()));
});

test('capture launch() without tools/studio.mjs: the browser and its contexts close within MOTION_CLOSE_TIMEOUT_MS, a hung browser is killed by the pid read over CDP', async () => {
  const root = tmp('ms-capture-launch-');
  fs.writeFileSync(path.join(root, 'studio.json'), '{}'); // no tools/ folder: the built-in launcher runs
  const pw = path.join(root, 'node_modules', 'playwright');
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), '{"name":"playwright","version":"0.0.0","main":"index.js"}');
  // A fake playwright: with globalThis.__msFake set, the browser's close() only ends when its "process" exits and every
  // context.close() hangs forever (a wedged Chrome on Windows); without it every close() resolves at once.
  fs.writeFileSync(path.join(pw, 'index.js'), `
exports.chromium = { async launch(opts) {
  globalThis.__msFakeLaunch = opts;
  return {
    version: () => 'fake 1.0', isConnected: () => true,
    close: () => (globalThis.__msFake ? globalThis.__msFake.exited : Promise.resolve()),
    newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [{ type: 'gpu', id: 1 }, { type: 'browser', id: globalThis.__msFake && globalThis.__msFake.pid }] }), detach: async () => {} }),
    async newContext() { return { close: () => (globalThis.__msFake ? new Promise(() => {}) : Promise.resolve()) }; },
  };
} };`);
  const proc = sleeper();
  try {
    await withEnv({ MOTION_CLOSE_TIMEOUT_MS: '200', MOTION_CHROME_PATH: '' }, async () => {
      const quick = await C.launch(root);
      // 'auto' starts the bundled headless shell on Windows (an installed Chrome there counts a failed logon per launch), Chrome elsewhere
      assert.equal(quick.via, process.platform === 'win32' ? 'chromium-headless-shell' : 'chrome');
      assert.equal(globalThis.__msFakeLaunch.headless, true);
      assert.equal(globalThis.__msFakeLaunch.channel, process.platform === 'win32' ? undefined : 'chrome');
      assert.ok(globalThis.__msFakeLaunch.args.includes('--force-color-profile=srgb'), 'the launch flags are unchanged');
      const ctx = await quick.browser.newContext();
      assert.equal(await ctx.close(), true);
      assert.equal(await quick.browser.close(), true);

      globalThis.__msFake = { pid: proc.child.pid, exited: proc.exited };
      const wedged = await C.launch(root);
      const wctx = await wedged.browser.newContext();
      const t0 = Date.now();
      const { result, stderr } = await withStderr(async () => {
        const first = wctx.close();
        assert.equal(wctx.close(), first, 'a second context.close() returns the same promise');
        const context = await first;
        const closing = wedged.browser.close();
        assert.equal(wedged.browser.close(), closing, 'and so does browser.close()');
        return { context, browser: await closing };
      });
      assert.deepEqual(result, { context: false, browser: false }, 'both abandoned/killed after the timeout instead of hanging');
      assert.ok(Date.now() - t0 < 15000, `two bounded closes took ${Date.now() - t0} ms`);
      await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 20000))]); // the exit event may lag on a saturated machine
      assert.ok(proc.child.exitCode !== null || proc.child.signalCode !== null, 'the browser process was killed by its pid');
      assert.match(stderr, /note: the browser did not close within 0\.2 s; killed it\n/);
    });
  } finally {
    delete globalThis.__msFake;
    delete globalThis.__msFakeLaunch;
    proc.child.kill();
    await proc.exited;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Main-module detection: a script reached through a symlink or junction must still run (it used to exit 0, silently)

/** A link to `target` in a fresh temp dir, or null when the platform refuses to create one. */
function linkTo(target, name = 'link') {
  const dir = tmp('ms-capture-link-');
  const link = path.join(dir, name);
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { return null; }
  return link;
}

test('isMain: compares real paths, so a script started through a symlink or junction is still the main module', (t) => {
  const real = path.join(SCRIPTS, 'capture.mjs');
  const url = pathToFileURL(real).href;
  assert.equal(C.isMain(url, real), true);
  assert.equal(C.isMain(url, path.join(SCRIPTS, '..', 'scripts', 'capture.mjs')), true, 'a non-normalized path');
  if (process.platform === 'win32') assert.equal(C.isMain(url, real.toUpperCase()), true, 'drive-letter and name case do not matter on Windows');
  assert.equal(C.isMain(url, path.join(SCRIPTS, 'capture-fonts.mjs')), false, 'another file');
  assert.equal(C.isMain(url, null), false);
  assert.equal(C.isMain(url, ''), false);
  assert.equal(C.isMain(url, path.join(os.tmpdir(), 'ms-does-not-exist', 'capture.mjs')), false, 'a missing file falls back to the resolved path and does not throw');
  const link = linkTo(SCRIPTS);
  if (!link) { t.skip('cannot create a symlink or junction here'); return; }
  assert.equal(C.isMain(url, path.join(link, 'capture.mjs')), true, 'through the link');
});

test('capture.mjs run through a symlink or junction prints its usage instead of exiting silently', async (t) => {
  const link = linkTo(SCRIPTS);
  if (!link) { t.skip('cannot create a symlink or junction here'); return; }
  const viaLink = await runNode([path.join(link, 'capture.mjs'), '--help'], REPO);
  const direct = await runNode([path.join(SCRIPTS, 'capture.mjs'), '--help'], REPO);
  assert.equal(viaLink.code, 0, viaLink.err);
  assert.match(viaLink.out, /Usage: node capture\.mjs <url>/);
  assert.equal(viaLink.out, direct.out);
});

// ---------------------------------------------------------------------------------------------------------------
// Chrome's renderer sandbox

test('sandboxDecision: on by default; off only for --no-sandbox, MOTION_NO_SANDBOX=1 or root on Linux', () => {
  const D = (over) => C.sandboxDecision({ env: {}, platform: 'win32', uid: null, ...over });
  for (const platform of ['win32', 'darwin', 'linux']) assert.deepEqual(D({ platform, uid: platform === 'linux' ? 1000 : null }), { off: false, why: null }, `${platform} keeps the sandbox`);
  assert.equal(D({ flag: true }).off, true);
  assert.match(D({ flag: true }).why, /--no-sandbox/);
  for (const v of ['1', 'true', 'YES', 'on']) assert.equal(D({ env: { MOTION_NO_SANDBOX: v } }).off, true, `MOTION_NO_SANDBOX=${v}`);
  for (const v of ['', '0', 'false', 'no']) assert.equal(D({ env: { MOTION_NO_SANDBOX: v } }).off, false, `MOTION_NO_SANDBOX=${v}`);
  assert.deepEqual(D({ platform: 'linux', uid: 0 }), { off: true, why: 'running as root on Linux, where Chrome does not start with its sandbox' });
  assert.equal(D({ platform: 'darwin', uid: 0 }).off, false, 'root on macOS is not special-cased');
  assert.equal(D({ platform: 'win32', uid: 0 }).off, false);
});

/** A project whose node_modules/playwright is a fake that records the launch options. */
function fakePlaywrightProject({ failWith = null, studioJson = '{}' } = {}) {
  const root = tmp('ms-capture-fakepw-');
  fs.writeFileSync(path.join(root, 'studio.json'), studioJson);
  const pw = path.join(root, 'node_modules', 'playwright');
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), '{"name":"playwright","version":"0.0.0","main":"index.js"}');
  fs.writeFileSync(path.join(pw, 'index.js'), `
globalThis.__msLaunches = globalThis.__msLaunches || [];
exports.chromium = { async launch(opts) {
  globalThis.__msLaunches.push(opts);
  ${failWith ? `throw new Error(${JSON.stringify(failWith)});` : ''}
  return { version: () => 'fake', isConnected: () => true, close: async () => {}, newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [] }), detach: async () => {} }), async newContext() { return { close: async () => {} }; } };
} };`);
  return root;
}

test('launch(): the renderer sandbox stays on unless asked off, with a note whenever it is off; the project launcher is never used', async () => {
  const root = fakePlaywrightProject();
  // A project launcher that adds --no-sandbox everywhere (as Playwright does by default) must not be called: capture loads untrusted pages.
  fs.mkdirSync(path.join(root, 'tools'));
  fs.writeFileSync(path.join(root, 'tools', 'studio.mjs'), "export async function launchBrowser() { throw new Error('PROJECT LAUNCHER USED'); }\n");
  try {
    await withEnv({ MOTION_CHROME_PATH: '', MOTION_NO_SANDBOX: undefined }, async () => {
      globalThis.__msLaunches = [];
      const on = await withStderr(() => C.launch(root));
      const opts = globalThis.__msLaunches[0];
      assert.equal(on.result.sandbox, true);
      assert.equal(opts.chromiumSandbox, true, 'Playwright must be told to keep the sandbox (it adds --no-sandbox otherwise)');
      assert.equal(opts.timeout, 60000, 'a cold Chrome may need more than the 30 s default (as the template launcher)');
      assert.ok(!opts.args.includes('--no-sandbox'));
      assert.equal(on.stderr, '', 'no note while the sandbox is on');

      const flag = await withStderr(() => C.launch(root, { noSandbox: true }));
      assert.equal(flag.result.sandbox, false);
      assert.equal(globalThis.__msLaunches[1].chromiumSandbox, false);
      assert.ok(globalThis.__msLaunches[1].args.includes('--no-sandbox'));
      assert.match(flag.stderr, /renderer sandbox is OFF \(the --no-sandbox flag\)/);

      await withEnv({ MOTION_NO_SANDBOX: '1' }, async () => {
        const env = await withStderr(() => C.launch(root));
        assert.equal(env.result.sandbox, false);
        assert.match(env.stderr, /renderer sandbox is OFF \(MOTION_NO_SANDBOX is set\)/);
      });
    });
  } finally { rmTree(root); delete globalThis.__msLaunches; }
});

test('launch(): a sandbox start failure names the fix (--no-sandbox / MOTION_NO_SANDBOX=1); studio.json "browser" picks the channel', async () => {
  const failing = fakePlaywrightProject({ failWith: 'Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted (sandbox)' });
  const pinned = fakePlaywrightProject({ studioJson: '{"browser":"msedge"}' });
  const missing = fakePlaywrightProject({ studioJson: JSON.stringify({ browser: path.join(os.tmpdir(), 'ms-no-such-chrome.exe') }) });
  try {
    // "msedge" is an explicit opt-in to the installed Edge: on Windows it warns and is counted in the launch log (a temp one here)
    await withEnv({ MOTION_CHROME_PATH: '', MOTION_BROWSER: undefined, MOTION_LAUNCH_LOG: path.join(tmp(), 'launches.json') }, async () => {
      await assert.rejects(() => C.launch(failing), (err) => /could not launch a browser/.test(err.message) && /--no-sandbox/.test(err.message) && /MOTION_NO_SANDBOX=1/.test(err.message));
      globalThis.__msLaunches = [];
      assert.equal((await withStderr(() => C.launch(pinned))).result.via, 'msedge');
      assert.equal(globalThis.__msLaunches.length, 1);
      assert.equal(globalThis.__msLaunches[0].channel, 'msedge');
      await assert.rejects(() => C.launch(missing), /file not found/);
    });
  } finally { for (const r of [failing, pinned, missing]) rmTree(r); delete globalThis.__msLaunches; }
});

// ---------------------------------------------------------------------------------------------------------------
// Network policy (SSRF)

test('isPrivateAddress: loopback, RFC 1918, CGNAT, link-local (cloud metadata), IPv6 ULA/link-local, mapped v4 and reserved ranges are private; public addresses are not', () => {
  for (const ip of ['127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255', '169.254.169.254', '169.254.0.1', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.1.1', '::ffff:169.254.169.254',
    '64:ff9b::7f00:1', '2002:7f00:1::', '[::1]', 'fe80::1%eth0', 'not-an-ip', '']) {
    assert.equal(G.isPrivateAddress(ip), true, `${ip} is private`);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1', '192.0.3.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(G.isPrivateAddress(ip), false, `${ip} is public`);
  }
});

test('createGuard.check: private addresses, local names, names that resolve to private addresses and non-web schemes are refused; the target\'s own host and public hosts pass', async () => {
  const guard = guardFor('https://shop.example/landing', { 'internal.corp': '10.1.2.3', 'rebind.example': '127.0.0.1', 'v6.example': 'fd00::5', 'nx.example': null });
  const ok = async (url) => assert.equal((await guard.check(url)).ok, true, `${url} should pass`);
  const no = async (url, re) => { const v = await guard.check(url); assert.equal(v.ok, false, `${url} should be refused`); if (re) assert.match(v.reason, re, url); };
  await ok('https://shop.example/a.png');
  await ok('https://cdn.other.example/font.woff2');
  await ok('data:image/png;base64,AAAA');
  await ok('about:blank');
  await ok('blob:https://shop.example/1234');
  await ok('http://8.8.8.8/x');
  await ok('https://nx.example/x'); // not resolvable here: nothing to connect to, so nothing to refuse
  await no('http://127.0.0.1:8080/admin', /private, local or link-local/);
  await no('http://localhost:3000/', /local name/);
  await no('http://app.localhost/', /local name/);
  await no('http://LOCALHOST./', /local name/);
  await no('http://[::1]:9229/json', /private, local or link-local/);
  await no('http://[::ffff:127.0.0.1]/', /private, local or link-local/);
  await no('http://2130706433/', /private, local or link-local/); // 127.0.0.1 written as one decimal number
  await no('http://0x7f.1/', /private, local or link-local/);
  await no('http://192.168.1.1/reboot', /private, local or link-local/);
  await no('http://169.254.169.254/latest/meta-data/', /private, local or link-local/);
  await no('http://metadata.google.internal/computeMetadata/v1/', /local name/);
  await no('http://internal.corp/wiki', /resolves to the private address 10\.1\.2\.3/);
  await no('http://internal.corp/other', /resolves to the private address 10\.1\.2\.3/);
  await no('http://rebind.example/', /resolves to the private address 127\.0\.0\.1/);
  await no('https://v6.example/', /resolves to the private address fd00::5/);
  await no('file:///C:/Windows/win.ini', /file: requests are not allowed/);
  await no('ftp://ftp.example/x', /ftp: requests are not allowed/);
  await no('chrome://settings', /chrome: requests are not allowed/);
  await no('chrome-extension://abc/x.js', /not allowed/);
  await no('view-source:https://shop.example/', /not allowed/);
  await no('not a url', /not a valid URL/);
  assert.ok(guard.blocked.length >= 15);
  assert.ok(guard.blocked.every((b) => !/[?&]token=[^*]/.test(b.url)));
  assert.match(guard.notes()[0], /^blocked \d+ request\(s\) to private, local or non-web addresses: /);
  assert.match(guard.notes()[0], /--allow-private/);
  assert.ok(guard.notes().some((n) => /1 host\(s\) could not be resolved from this machine.*nx\.example/.test(n)));
  assert.equal(guard.lookups.filter((h) => h === 'internal.corp').length, 1, 'DNS answers are cached per host');
});

test('createGuard: the target\'s own host:port is always allowed (local dev server, intranet page), other ports and hosts are not; --allow-private lifts addresses but never the scheme check', async () => {
  const dev = guardFor('http://127.0.0.1:3000/');
  assert.equal((await dev.check('http://127.0.0.1:3000/app.js')).ok, true);
  assert.equal((await dev.check('http://127.0.0.1:3001/api')).ok, false, 'another port of the same machine is another service');
  assert.equal((await dev.check('http://localhost:3000/')).ok, false);
  assert.equal(dev.lookups.length, 0, 'the own host needs no lookup');
  const intranet = guardFor('http://wiki.corp/home', { 'wiki.corp': '10.9.9.9', 'files.corp': '10.9.9.10' });
  assert.equal((await intranet.check('http://wiki.corp/img.png')).ok, true);
  assert.equal((await intranet.check('http://files.corp/img.png')).ok, false);
  const open = guardFor('https://public.example/', {}, { allowPrivate: true });
  assert.equal((await open.check('http://192.168.0.5/')).ok, true);
  assert.equal((await open.check('http://169.254.169.254/')).ok, true);
  assert.equal((await open.check('file:///etc/passwd')).ok, false, 'file: stays refused');
  assert.equal((await open.check('chrome://version')).ok, false);
  assert.equal(open.notes().length, 1);
});

test('createGuard.blocksSync (WebSocket predicate): literal private IPs, local names and already-resolved private hosts', async () => {
  const guard = guardFor('https://shop.example/', { 'sneaky.example': '192.168.1.9' });
  assert.equal(guard.blocksSync('ws://127.0.0.1:9229/x'), true);
  assert.equal(guard.blocksSync('wss://localhost/x'), true);
  assert.equal(guard.blocksSync('ws://[::1]:1/'), true);
  assert.equal(guard.blocksSync('wss://shop.example/socket'), false);
  assert.equal(guard.blocksSync('wss://other.example/socket'), false);
  assert.equal(guard.blocksSync('wss://sneaky.example/socket'), false, 'not resolved yet: the predicate cannot await');
  await guard.check('https://sneaky.example/'); // an earlier request resolved it
  assert.equal(guard.blocksSync('wss://sneaky.example/socket'), true);
  assert.equal(guard.blocksSync('file:///x'), true);
});

test('createGuard.get: every redirect hop is checked (max 5, by hand), oversized bodies are refused before they are read', async () => {
  const guard = guardFor('https://shop.example/', { 'files.example': '93.184.216.34' });
  // public -> redirect to the machine's own admin port: refused at the second hop, the internal URL is never requested
  const ctx = fakeContext({
    'https://files.example/i': { status: 302, headers: { location: 'http://127.0.0.1:2732/internal.svg' } },
    'http://127.0.0.1:2732/internal.svg': { body: '<svg xmlns="http://www.w3.org/2000/svg"><!-- INTERNAL-SECRET --></svg>' },
  });
  const r = await guard.get(ctx, 'https://files.example/i', { maxBytes: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^blocked: 127\.0\.0\.1 is a private, local or link-local address/);
  assert.deepEqual(ctx.calls, ['https://files.example/i'], 'the internal URL is not fetched');
  assert.ok(ctx.options.every((o) => o.maxRedirects === 0), 'Playwright is told not to follow redirects itself');

  // redirect chain to a public URL works, relative Location included
  const chain = fakeContext({
    'https://files.example/a': { status: 301, headers: { location: '/b' } },
    'https://files.example/b': { status: 307, headers: { location: 'https://cdn.example/c.png' } },
    'https://cdn.example/c.png': { body: 'PNGDATA', headers: { 'content-type': 'image/png' } },
  });
  const ok = await guard.get(chain, 'https://files.example/a', { headers: { Referer: 'https://shop.example/' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.url, 'https://cdn.example/c.png');
  assert.equal(ok.body.toString(), 'PNGDATA');
  assert.equal(chain.calls.length, 3);

  // more than 5 redirects
  const loop = {};
  for (let i = 0; i < 10; i++) loop[`https://files.example/r${i}`] = { status: 302, headers: { location: `https://files.example/r${i + 1}` } };
  const looping = fakeContext(loop);
  const tooMany = await guard.get(looping, 'https://files.example/r0');
  assert.deepEqual([tooMany.ok, tooMany.reason], [false, 'more than 5 redirects']);
  assert.equal(looping.calls.length, 6, 'the first request plus five redirects');

  // a declared Content-Length over the cap is refused before body() is called
  const big = fakeContext({ 'https://files.example/big': { body: 'x', headers: { 'content-length': String(50 * 1048576) } }, 'https://files.example/small': { body: 'x'.repeat(2000) } });
  const over = await guard.get(big, 'https://files.example/big', { maxBytes: 5 * 1048576 });
  assert.equal(over.ok, false);
  assert.match(over.reason, /50\.0 MB is over the 5\.0 MB limit/);
  assert.equal(big.bodies.length, 0, 'the body was never read');
  const late = await guard.get(big, 'https://files.example/small', { maxBytes: 1000 });
  assert.equal(late.ok, false, 'no Content-Length: refused after reading');
  assert.equal((await guard.get(big, 'https://files.example/missing')).reason, 'HTTP 404');
});

test('collectFonts: the guard applies to stylesheets, font files and license probes; a redirect to a private host is not followed', async () => {
  const PAGE = 'https://site.test/';
  const woff2 = bundled('instrument-serif-400-latin.woff2');
  const ctx = fakeContext({
    'https://site.test/f/a.woff2': { status: 302, headers: { location: 'http://192.168.1.10/router.woff2' } },
    'http://192.168.1.10/router.woff2': { body: woff2 },
    'https://cdn.test/private.css': { status: 302, headers: { location: 'http://127.0.0.1:9/x.css' } },
    'https://site.test/f/b.woff2': { body: woff2 },
  });
  const guard = guardFor(PAGE);
  const notes = [];
  const fonts = {
    rules: [rule('Bounced', '400', 'normal', null, "url(a.woff2) format('woff2')", 'https://site.test/f/x.css'), rule('Fine', '400', 'normal', null, "url(b.woff2) format('woff2')", 'https://site.test/f/x.css')],
    allLoaded: [loadedFace('Bounced', '400', 'normal', null), loadedFace('Fine', '400', 'normal', null)],
    unreadableSheets: ['https://cdn.test/private.css'],
  };
  const plan = await F.collectFonts(ctx, fonts, PAGE, [], notes, guard);
  assert.deepEqual(plan.files.map((f) => f.family), ['Fine']);
  assert.match(plan.skipped.find((s) => s.family === 'Bounced').reason, /blocked: 192\.168\.1\.10 is a private, local or link-local address/);
  assert.ok(notes.some((n) => /font stylesheet could not be fetched: https:\/\/cdn\.test\/private\.css/.test(n)));
  assert.ok(!ctx.calls.some((u) => /192\.168|127\.0\.0\.1/.test(u)), `no private URL requested: ${ctx.calls.join(' ')}`);
  assert.ok(ctx.options.every((o) => o.headers?.Referer === 'https://site.test/'), 'only the origin is sent as Referer');
  assert.equal(guard.blocked.length, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// Credentials and tokens in URLs

test('redactUrl / redactText: user:password@ and secret-looking query or fragment values never survive; ordinary parameters do', () => {
  assert.equal(G.redactUrl('http://admin:hunter2@127.0.0.1:2281/?token=abc123'), 'http://127.0.0.1:2281/?token=***');
  assert.equal(G.redactUrl('https://user@example.com/path?page=2&access_token=XYZ&lang=en'), 'https://example.com/path?page=2&access_token=***&lang=en');
  assert.equal(G.redactUrl('https://x.example/i.png?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA%2F2026&w=200'), 'https://x.example/i.png?X-Amz-Signature=***&X-Amz-Credential=***&w=200');
  assert.equal(G.redactUrl('https://x.example/?apiKey=k1&api_key=k2&apikey=k3&Key=k4&secret=s&client_secret=c&password=p&passwd=q&pwd=r&auth=a&sig=g&session=s1&sessionid=s2&jwt=j&code=c1'),
    'https://x.example/?apiKey=***&api_key=***&apikey=***&Key=***&secret=***&client_secret=***&password=***&passwd=***&pwd=***&auth=***&sig=***&session=***&sessionid=***&jwt=***&code=***');
  assert.equal(G.redactUrl('https://x.example/app#/route?token=t1&tab=2'), 'https://x.example/app#/route?token=***&tab=2');
  assert.equal(G.redactUrl('https://x.example/cb#access_token=zzz&state=ok'), 'https://x.example/cb#access_token=***&state=ok');
  assert.equal(G.redactUrl('https://x.example/?q=monkey&keyword=key&author=me&utm_source=x&page=3'), 'https://x.example/?q=monkey&keyword=key&author=me&utm_source=x&page=3', 'only whole secret words count');
  assert.equal(G.redactUrl('https://x.example/?%74oken=a'), 'https://x.example/?%74oken=***', 'percent-encoded names');
  assert.equal(G.redactUrl('https://a:b@x.example/?token=abc12'.slice(0, 33)), 'https://x.example/?token=***', 'a truncated URL is still redacted');
  assert.equal(G.redactUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(G.redactText('GET "https://u:p@x.example/a?sig=1&b=2" failed, see https://y.example/?token=t.'), 'GET "https://x.example/a?sig=***&b=2" failed, see https://y.example/?token=***.');
  assert.equal(G.redactText('no url here, token=abc stays as prose'), 'no url here, token=abc stays as prose');
  assert.deepEqual(G.redactDeep({ url: 'https://u:p@x.example/?key=1', list: ['https://x.example/?ok=1&secret=2', 3, null], n: { deep: 'a https://x.example/?sig=9 b' } }),
    { url: 'https://x.example/?key=***', list: ['https://x.example/?ok=1&secret=***', 3, null], n: { deep: 'a https://x.example/?sig=*** b' } });
  for (const name of ['token', 'access_token', 'accessToken', 'ID_TOKEN', 'apiKey', 'X-Api-Key', 'sig', 'signature', 'X-Goog-Signature', 'password', 'pass', 'auth', 'session', 'PHPSESSID', 'sid', 'code', 'otp', 'credential']) {
    assert.equal(G.isSensitiveParam(name), true, name);
  }
  for (const name of ['page', 'q', 'utm_source', 'lang', 'id', 'size', 'w', 'keyword', 'author', 'monkey', 'state', 'redirect']) assert.equal(G.isSensitiveParam(name), false, name);
});

test('parseTarget: navigation keeps the real query, the user:password goes to httpCredentials, the display form is redacted', () => {
  const t = G.parseTarget(C.normalizeUrl('http://admin:hunter2@127.0.0.1:2281/dash?token=abc123&page=2'));
  assert.equal(t.url, 'http://127.0.0.1:2281/dash?token=abc123&page=2', 'the real URL, without userinfo');
  assert.deepEqual(t.credentials, { username: 'admin', password: 'hunter2', origin: 'http://127.0.0.1:2281' });
  assert.equal(t.display, 'http://127.0.0.1:2281/dash?token=***&page=2');
  const enc = G.parseTarget('https://me%40corp:p%40ss%3A1@example.com/');
  assert.deepEqual([enc.credentials.username, enc.credentials.password], ['me@corp', 'p@ss:1']);
  assert.equal(G.parseTarget('https://example.com/?a=1').credentials, null);
  assert.equal(C.normalizeUrl('example.com/x?token=1'), 'https://example.com/x?token=1');
  assert.throws(() => C.normalizeUrl('file:///etc/passwd'), /only http\(s\) URLs/);
});

// ---------------------------------------------------------------------------------------------------------------
// Decompression bombs in fonts

const zeros = (n) => Buffer.alloc(n);

/** A WOFF whose only table is `name`: `stream` is the deflate data, `declaredOrig` what the directory claims it inflates to. */
function woffWith(stream, declaredOrig) {
  const total = 44 + 20 + stream.length;
  return Buffer.concat([Buffer.from('wOFF'), u32(0x00010000), u32(total), u16(1), u16(0), u32(64), u16(1), u16(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    Buffer.from('name'), u32(64), u32(stream.length), u32(declaredOrig), u32(0), stream]);
}
/** A WOFF2 whose only table is `name` with a declared length of `len` bytes and the given brotli stream. */
function woff2With(stream, len) {
  const base128 = (n) => { const out = [n & 0x7f]; for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 0x7f) | 0x80); return out; };
  const dir = Buffer.from([5, ...base128(len)]);
  return Buffer.concat([Buffer.from('wOF2'), u32(0x00010000), u32(48 + dir.length + stream.length), u16(1), u16(0), u32(len), u32(stream.length), u16(1), u16(0), u32(0), u32(0), u32(0), u32(0), u32(0), dir, stream]);
}
const arrayBuffersMiB = () => process.memoryUsage().arrayBuffers / 1048576;

test('font decompression bombs: a header that declares a huge name table is refused before anything is inflated', () => {
  const tiny = zlib.deflateSync(zeros(2 * 1024 * 1024)); // ~2 KB
  const brotli = zlib.brotliCompressSync(zeros(2 * 1024 * 1024), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } });
  const gib = woffWith(tiny, 1024 * 1024 * 1024);
  const w2 = woff2With(brotli, 512 * 1024 * 1024);
  const before = arrayBuffersMiB();
  assert.match(F.sniffFont(gib).problem, /decompression bomb: the header declares 1024\.0 MB of name table from \d+ compressed bytes/);
  assert.deepEqual(F.readFontNames(gib), {}, 'no license info and no allocation');
  const mid = woffWith(tiny, 8 * 1024 * 1024); // 4000x: over the 200x ratio, under 256 MiB
  assert.match(F.sniffFont(mid).problem, /decompression bomb/);
  assert.deepEqual(F.readFontNames(mid), {});
  assert.match(F.sniffFont(w2).problem, /decompression bomb: the header declares 512\.0 MB of table data/);
  assert.deepEqual(F.readFontNames(w2), {});
  assert.ok(arrayBuffersMiB() - before < 64, `no large buffers were allocated (${(arrayBuffersMiB() - before).toFixed(1)} MiB)`);
});

test('font decompression bombs: a header that lies low cannot make the inflater allocate more than it declared', () => {
  const stream = zlib.deflateSync(zeros(16 * 1024 * 1024)); // really 16 MiB, about 16 KB compressed
  const liar = woffWith(stream, 1024 * 1024); // claims 1 MiB: plausible against 16 KB compressed, so the header check passes
  const brotli = zlib.brotliCompressSync(zeros(16 * 1024 * 1024), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } });
  const liar2 = woff2With(brotli, 4096);
  assert.equal(F.sniffFont(liar).kind, 'woff', 'looks plausible to the header check');
  const t0 = Date.now();
  const before = arrayBuffersMiB();
  assert.deepEqual(F.readFontNames(liar), {}, 'the inflater stops at the declared size and fails this one font');
  assert.deepEqual(F.readFontNames(liar2), {});
  assert.ok(arrayBuffersMiB() - before < 8, `stopped early (${(arrayBuffersMiB() - before).toFixed(1)} MiB)`);
  assert.ok(Date.now() - t0 < 5000);
});

test('font limits keep real fonts working: ordinary WOFF/WOFF2 name tables (also with a 40:1 ratio) still give their license', () => {
  const names = { 0: 'Copyright 2024 Someone', 13: 'SIL Open Font License, Version 1.1. '.repeat(40), 14: 'https://openfontlicense.org' };
  for (const buf of [buildWoff(names), buildWoff2(names)]) {
    assert.ok(F.sniffFont(buf).kind, 'accepted');
    assert.equal(F.readFontNames(buf).licenseUrl, 'https://openfontlicense.org');
  }
  const inter = bundled('inter-100-900-latin.woff2');
  assert.equal(F.sniffFont(inter).kind, 'woff2');
  assert.equal(F.inflateProblem(inter), null);
  assert.equal(F.inflateProblem(buildTtf({ 1: 'x' })), null, 'raw sfnt has nothing to inflate');
  assert.equal(F.inflateProblem(Buffer.from('nope')), null);
});

test('collectFonts: a bomb font fails that one face, its next source and the other faces are still captured', async () => {
  const PAGE = 'https://site.test/';
  const bomb = woffWith(zlib.deflateSync(zeros(1024 * 1024)), 900 * 1024 * 1024);
  const good = bundled('instrument-serif-400-latin.woff2');
  const ctx = fakeContext({
    'https://site.test/f/bomb.woff': { body: bomb },
    'https://site.test/f/only-bomb.woff': { body: bomb },
    'https://site.test/f/ok.ttf': { body: buildTtf({ 1: 'Second Source' }) },
    'https://site.test/f/other.woff2': { body: good },
  });
  const fonts = {
    rules: [rule('Two Sources', '400', 'normal', null, "url(bomb.woff) format('woff'), url(ok.ttf) format('truetype')", 'https://site.test/f/x.css'),
      rule('Only Bomb', '400', 'normal', null, "url(only-bomb.woff) format('woff')", 'https://site.test/f/x.css'),
      rule('Other', '400', 'normal', null, "url(other.woff2) format('woff2')", 'https://site.test/f/x.css')],
    allLoaded: [loadedFace('Two Sources', '400', 'normal', null), loadedFace('Only Bomb', '400', 'normal', null), loadedFace('Other', '400', 'normal', null)],
  };
  const plan = await F.collectFonts(ctx, fonts, PAGE, [], [], guardFor(PAGE));
  const by = Object.fromEntries(plan.files.map((f) => [f.family, f]));
  assert.deepEqual(Object.keys(by).sort(), ['Other', 'Two Sources']);
  assert.equal(by['Two Sources'].ext, '.ttf', 'the bomb woff was refused, the ttf source used');
  assert.match(plan.skipped.find((s) => s.family === 'Only Bomb').reason, /decompression bomb/);
});

// ---------------------------------------------------------------------------------------------------------------
// File names: Unicode slugs without collisions

test('slugify keeps Unicode letters and digits (Hangul, kana, accents); makeSlugger gives two different inputs two different names', () => {
  assert.equal(C.slugify('text=구동 보고'), 'text-구동-보고');
  assert.equal(C.slugify('button:has-text("검색")'), 'button-has-text-검색');
  assert.equal(C.slugify('Café Menü 2026'), 'café-menü-2026');
  assert.equal(C.slugify('text=料金プラン'), 'text-料金プラン');
  assert.equal(C.slugify('.card > a:nth-child(2)'), 'card-a-nth-child-2');
  assert.equal(C.slugify('!!!'), 'item');
  assert.equal(C.slugify(''), 'item');
  assert.ok(![...C.slugify('가'.repeat(100))].some((c) => c === '\ufffd'), 'no half surrogate pairs');
  assert.equal([...C.slugify('가'.repeat(100))].length, 40);
  assert.equal([...C.slugify('𠀀'.repeat(60))].length, 40, 'astral characters count once');
  assert.match(C.slugify('a/b\\c:d*e?f"g<h>i|j'), /^[a-z-]+$/, 'nothing a file system dislikes');

  const slug = C.makeSlugger(32);
  const a = slug('text=구동 보고');
  const b = slug('text=인사이트');
  assert.equal(a, 'text-구동-보고');
  assert.equal(b, 'text-인사이트');
  const c = slug('button:has-text("검색")');
  const d = slug('button:has-text("등록")');
  assert.equal(c, 'button-has-text-검색');
  assert.equal(d, 'button-has-text-등록');
  // sanitising to the same slug: the second gets a short hash of its own text
  const e = slug('.card');
  const f = slug('#card');
  assert.equal(e, 'card');
  assert.match(f, /^card-[0-9a-f]{6}$/);
  assert.equal(slug('.card'), 'card', 'the same input keeps its name');
  assert.equal(slug('#card'), f, 'and so does the second one');
  // truncation to 32 characters: long selectors that differ only at the end
  const long1 = slug('.pricing-grid .plan-card:nth-child(1) .cta');
  const long2 = slug('.pricing-grid .plan-card:nth-child(2) .cta');
  assert.notEqual(long1, long2);
  // punctuation-only selectors do not collapse onto each other
  const p1 = slug('***');
  const p2 = slug('???');
  assert.notEqual(p1, p2);
});

// ---------------------------------------------------------------------------------------------------------------
// Banner dismissal

test('consentKind: accept/agree/allow labels in English, Korean, Japanese, Chinese, German, French and Spanish are strong; ok/close style labels are weak; the rest is neither', () => {
  const strong = ['Accept', 'Accept all', 'Accept All Cookies', 'ACCEPT & CLOSE', 'I agree', 'Agree', 'Allow all cookies', 'Allow', '동의', '모두 동의', '모두동의', '동의합니다', '전체 동의', '수락', '모두 수락', '허용', '모두 허용', '쿠키 허용',
    '同意する', 'すべて同意', '許可', 'すべて許可', '受け入れる', '接受', '接受全部', '同意', '我同意', '允许', '全部允许', 'Akzeptieren', 'Alle akzeptieren', 'Zustimmen', 'Alle zulassen', 'Einverstanden',
    'Tout accepter', 'Accepter', "J'accepte", 'J\u2019accepte', "D'accord", 'Autoriser', 'Aceptar', 'Aceptar todas', 'Permitir todo', 'Estoy de acuerdo', 'Aceptar y continuar', '  Accept all cookies \u2713 ', '\ud83c\udf6a Accept'];
  const weak = ['OK', 'Ok', 'Okay', 'Got it', 'Got it!', 'I understand', 'Understood', 'Close', '확인', '닫기', '閉じる', '了解', '确定', '好的', '关闭', 'Verstanden', 'Schlie\u00dfen', 'Compris', 'Fermer', 'Entendido', 'Cerrar'];
  for (const label of strong) assert.equal(B.consentKind(label), 'strong', label);
  for (const label of weak) assert.equal(B.consentKind(label), 'weak', label);
  for (const label of ['Reject all', 'Decline', 'Learn more', 'Cookie settings', 'Manage preferences', 'Continue', 'Sign up', 'Accept the terms and conditions of the service and continue to checkout', '거부', '설정', '자세히 보기', '拒绝', 'Ablehnen', 'Refuser', 'Rechazar', '', '   ', null, undefined, 'Try it free']) {
    assert.equal(B.consentKind(label), null, String(label));
  }
  assert.ok(B.CONSENT_STRONG.length >= 100 && B.CONSENT_WEAK.length >= 30);
  for (const label of [...B.CONSENT_STRONG]) assert.equal(B.consentKind(label), 'strong', label);
  for (const label of [...B.CONSENT_WEAK]) assert.ok(B.consentKind(label), label);
  assert.equal(B.bannerNote('desktop', { clicked: '모두 동의', checked: 4 }), 'desktop: clicked cookie banner button "모두 동의"');
  assert.match(B.bannerNote('mobile', { clicked: null, checked: 7 }), /^mobile: dismiss-banners: no banner matched \(7 visible buttons and links checked .*English, Korean, Japanese, Chinese, German, French and Spanish/);
  assert.match(B.bannerNote('mobile', { clicked: null, checked: 0, error: 'boom' }), /the check failed \(boom\)/);
});

// ---------------------------------------------------------------------------------------------------------------
// Redirect hops: Playwright's route never sees them, so a second DevTools Fetch session fails the refused ones

const ticks = async () => { for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve)); };
function fakeCdp() {
  const handlers = {};
  const sent = [];
  return { sent, on: (name, fn) => { handlers[name] = fn; }, send: async (method, params) => { sent.push([method, params]); }, emit: (name, ev) => handlers[name](ev) };
}
function fakePage(cdp) {
  const listeners = {};
  const context = { newCDPSession: async () => cdp, on() {}, route: async () => {} };
  return { listeners, context: () => context, on: (name, fn) => { listeners[name] = fn; }, mainFrame: () => 'main' };
}

test('guard.watch: a redirect hop to a refused address is failed before it is sent, everything else continues; auth challenges are answered for the target origin only', async () => {
  const creds = { username: 'admin', password: 'hunter2', origin: 'https://shop.example' };
  const guard = guardFor('https://shop.example/', { 'rebind.example': '127.0.0.1' }, { credentials: creds });
  const cdp = fakeCdp();
  const page = fakePage(cdp);
  await guard.watch(page);
  await guard.watch(page); // a second call reuses the session
  assert.deepEqual(cdp.sent, [['Fetch.enable', { patterns: [{ urlPattern: '*' }], handleAuthRequests: true }]]);
  const paused = (requestId, url, hop = true) => cdp.emit('Fetch.requestPaused', { requestId, request: { url }, ...(hop ? { redirectedRequestId: `job-${requestId}` } : {}) });
  paused('1', 'https://shop.example/a.png', false); // the first URL of a request was judged by the route
  paused('2', 'http://127.0.0.1:2732/internal.svg', false); // (also continued here: the route aborts it)
  paused('3', 'https://cdn.example/x.png');
  paused('4', 'http://169.254.169.254/latest/meta-data/');
  paused('5', 'http://rebind.example/');
  paused('6', 'file:///etc/passwd');
  paused('7', 'http://localhost:9229/json');
  await ticks();
  const by = (id) => cdp.sent.filter(([, p]) => p?.requestId === id).map(([m, p]) => [m, p.errorReason]);
  assert.deepEqual(by('1'), [['Fetch.continueRequest', undefined]]);
  assert.deepEqual(by('2'), [['Fetch.continueRequest', undefined]]);
  assert.deepEqual(by('3'), [['Fetch.continueRequest', undefined]]);
  for (const id of ['4', '5', '6', '7']) assert.deepEqual(by(id), [['Fetch.failRequest', 'BlockedByClient']], `hop ${id}`);
  assert.equal(guard.blocked.length, 4);

  const auth = (requestId, url) => cdp.emit('Fetch.authRequired', { requestId, request: { url } });
  auth('a1', 'https://shop.example/private');
  auth('a1', 'https://shop.example/private'); // the same request asking again: the password was wrong, do not loop
  auth('a2', 'https://evil.example/login'); // another origin never gets the password
  await ticks();
  const answers = cdp.sent.filter(([m]) => m === 'Fetch.continueWithAuth').map(([, p]) => [p.requestId, p.authChallengeResponse]);
  assert.deepEqual(answers, [['a1', { response: 'ProvideCredentials', username: 'admin', password: 'hunter2' }], ['a1', { response: 'Default' }], ['a2', { response: 'Default' }]]);
});

test('guard.protectBrowser: a browser-wide session judges every http(s) request (first URLs too); other schemes continue; a browser without the session gets a note', async () => {
  const guard = guardFor('https://shop.example/', { 'rebind.example': '127.0.0.1' });
  const cdp = fakeCdp();
  assert.equal(await guard.protectBrowser({ newBrowserCDPSession: async () => cdp }), true);
  assert.deepEqual(cdp.sent, [['Fetch.enable', { patterns: [{ urlPattern: '*' }] }]], 'no auth handling here: challenges go to the page sessions');
  const paused = (requestId, url) => cdp.emit('Fetch.requestPaused', { requestId, request: { url } });
  paused('1', 'https://shop.example/a.png');
  paused('2', 'http://127.0.0.1:9229/json'); // a SharedWorker's or <link rel=prerender>'s first URL: no route and no redirect hop involved
  paused('3', 'http://rebind.example/');
  paused('4', 'chrome-error://chromewebdata/');
  paused('5', 'blob:https://shop.example/1234');
  paused('6', 'https://cdn.example/x.js');
  paused('7', 'http://169.254.169.254/latest/meta-data/');
  await ticks();
  const by = (id) => cdp.sent.filter(([, p]) => p?.requestId === id).map(([m, p]) => [m, p.errorReason]);
  for (const id of ['1', '4', '5', '6']) assert.deepEqual(by(id), [['Fetch.continueRequest', undefined]], `request ${id}`);
  for (const id of ['2', '3', '7']) assert.deepEqual(by(id), [['Fetch.failRequest', 'BlockedByClient']], `request ${id}`);
  assert.equal(guard.blocked.length, 3);

  const broken = guardFor('https://shop.example/');
  assert.equal(await broken.protectBrowser({ newBrowserCDPSession: async () => { throw new Error('Protocol error: not supported\n    at somewhere'); } }), false);
  assert.ok(broken.notes().some((n) => /^the browser-wide request filter could not start \(Protocol error: not supported\); SharedWorker and <link rel=prerender> requests are not filtered$/.test(n)), broken.notes().join('\n'));
});

test('guard.protect: the route aborts refused requests and continues the rest; an answered redirect hop to a refused address is reported by settle()', async () => {
  const guard = guardFor('https://shop.example/');
  const handlers = {};
  let routeFn = null;
  const context = { route: async (pattern, fn) => { assert.equal(pattern, '**/*'); routeFn = fn; }, on: (name, fn) => { handlers[name] = fn; } };
  await guard.protect(context);
  const outcomes = [];
  const route = (url) => ({ request: () => ({ url: () => url }), abort: async (code) => { outcomes.push(['abort', code]); }, continue: async () => { outcomes.push(['continue']); } });
  await routeFn(route('https://shop.example/logo.png'));
  await routeFn(route('http://192.168.0.1/reboot'));
  await routeFn(route('ftp://files.example/x'));
  assert.deepEqual(outcomes, [['continue'], ['abort', 'blockedbyclient'], ['abort', 'blockedbyclient']]);

  const response = (url, hop) => ({ request: () => ({ url: () => url, redirectedFrom: () => (hop ? {} : null) }) });
  handlers.response(response('http://10.0.0.5/admin?token=abc123', true)); // answered although refused: it escaped
  handlers.response(response('http://127.0.0.1:1/direct', false)); // not a hop: the route judged it
  handlers.response(response('https://cdn.example/ok.png', true)); // an allowed hop
  const escaped = await guard.settle();
  assert.deepEqual(escaped, [{ url: 'http://10.0.0.5/admin?token=***', reason: '10.0.0.5 is a private, local or link-local address' }]);
});

// ---------------------------------------------------------------------------------------------------------------
// End to end in Chrome: an untrusted page, private addresses, credentials, banners

/** A project dir with studio.json and a link to the shared node_modules, or null when playwright is not resolvable. */
function browserProject() {
  const nm = findNodeModules();
  if (!nm) return null;
  const root = tmp('ms-capture-e2e-');
  fs.writeFileSync(path.join(root, 'studio.json'), '{}');
  try { fs.symlinkSync(nm, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* resolved by the plugin repo instead */ }
  return root;
}
const closeServer = (srv) => new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(() => resolve()); });
const noBrowser = (r) => /could not launch a browser|playwright is not installed/.test(r.err);
const readAll = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? readAll(path.join(dir, d.name)) : [path.join(dir, d.name)]));

test('capture.mjs refuses a hostile page\'s requests to loopback, link-local and non-web addresses (page, redirects, Node downloads); --allow-private lifts it', { timeout: 300000 }, async (t) => {
  const root = browserProject();
  if (!root) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const internalHits = [];
  const siteHits = [];
  const internal = await listen((req, res) => {
    internalHits.push(req.url);
    if (req.url === '/internal.svg') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><!-- INTERNAL-SECRET-123 --></svg>'); }
    if (/\.png$/.test(req.url)) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('deleted item 1');
  });
  internal.on('upgrade', (req, socket) => { internalHits.push(`UPGRADE ${req.url}`); socket.destroy(); });
  const iPort = internal.address().port;
  const html = (variant) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hostile</title>
<link rel="icon" href="/i"><meta property="og:image" content="/k">
${variant === 'blocked' ? '<link rel="apple-touch-icon" href="/j"><link rel="stylesheet" href="ftp://127.0.0.1/x.css">' : ''}
</head><body><header><a href="/"><img alt="logo" src="/own.png" width="120" height="40"></a></header><h1>Ship faster</h1>
<img src="http://127.0.0.1:${iPort}/pixel.png" width="40" height="40"><img src="http://localhost:${iPort}/pixel2.png" width="40" height="40"><img src="/redir.png" width="40" height="40"><iframe src="/frame" width="20" height="20"></iframe>
<link rel="prerender" href="http://127.0.0.1:${iPort}/prerender-link">
<script>fetch('http://127.0.0.1:${iPort}/fetch', { mode: 'no-cors' }).catch(() => {}); try { new WebSocket('ws://127.0.0.1:${iPort}/ws'); } catch (e) {}
try { new SharedWorker(URL.createObjectURL(new Blob(["fetch('http://127.0.0.1:${iPort}/from-shared', { mode: 'no-cors' })"]))); } catch (e) {}</script>
${variant === 'blocked' ? `<div><button onclick="fetch('/clicked')">OK</button></div>` : `<div role="dialog" style="position:fixed;left:0;bottom:0;background:#eee;padding:8px"><button onclick="fetch('/ok-clicked')">OK</button></div>`}
</body></html>`;
  let variant = 'blocked';
  const site = await listen((req, res) => {
    siteHits.push(req.url);
    const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };
    switch (req.url) {
      case '/': res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html(variant));
      case '/own.png': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG);
      case '/i': return redirect(`http://127.0.0.1:${iPort}/internal.svg`);
      case '/k': return redirect(`http://127.0.0.1:${iPort}/admin/delete?id=1`);
      case '/j': return redirect('http://169.254.169.254/latest/meta-data/');
      case '/redir.png': return redirect(`http://127.0.0.1:${iPort}/pixel3.png`);
      case '/frame': return redirect(`http://127.0.0.1:${iPort}/frame.html`);
      default: res.writeHead(404); return res.end('nope');
    }
  });
  try {
    const url = `http://127.0.0.1:${site.address().port}/`;
    const base = [path.join(SCRIPTS, 'capture.mjs'), url, '--root', root, '--viewports', 'desktop', '--settle', '0.1', '--no-fonts', '--dismiss-banners', '--json'];

    // 1. default policy: nothing reaches the internal server, whatever the route (page request, redirect, fetch, WebSocket, Node download)
    const r1 = await runNode(base, root);
    if (noBrowser(r1)) { t.skip(`no browser: ${r1.err.split('\n')[0]}`); return; }
    assert.equal(r1.code, 0, r1.err);
    assert.deepEqual(internalHits, [], `the internal server was reached: ${internalHits.join(', ')}`);
    const m1 = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'manifest.json'), 'utf8'));
    assert.equal(m1.sandbox, !C.sandboxDecision().off, 'the renderer sandbox is on unless the platform forces it off');
    assert.doesNotMatch(r1.err, /renderer sandbox is OFF/, r1.err);
    const refused = m1.blocked.map((b) => b.url);
    const has = (re) => assert.ok(refused.some((u) => re.test(u)), `${re} in ${refused.join('\n')}`);
    has(new RegExp(`127\\.0\\.0\\.1:${iPort}/pixel\\.png`)); // an <img> with a private IP
    has(new RegExp(`localhost:${iPort}/pixel2\\.png`)); // a local name
    has(new RegExp(`127\\.0\\.0\\.1:${iPort}/pixel3\\.png`)); // the redirect hop of an image request
    has(new RegExp(`127\\.0\\.0\\.1:${iPort}/frame\\.html`)); // the redirect hop of an iframe navigation
    has(new RegExp(`127\\.0\\.0\\.1:${iPort}/internal\\.svg`)); // the redirect hop of the browser's own favicon request
    has(new RegExp(`127\\.0\\.0\\.1:${iPort}/fetch`)); // page script fetch
    has(new RegExp(`ws://127\\.0\\.0\\.1:${iPort}/ws`)); // WebSocket
    has(new RegExp(`127\\.0\\.0\\.1:${iPort}/internal\\.svg`)); // Node-side icon download, redirect hop
    has(new RegExp(`127\\.0\\.0\\.1:${iPort}/admin/delete`)); // Node-side og:image download, redirect hop
    has(/169\.254\.169\.254\/latest\/meta-data/); // cloud metadata
    // <link rel=prerender>: a full Chrome sends it and no route sees it. Playwright's headless shell (the Windows default) never sends
    // it, so nothing exists to block there and the internalHits check above is the proof.
    const prerenders = m1.browser !== 'chromium-headless-shell';
    if (prerenders) has(new RegExp(`127\\.0\\.0\\.1:${iPort}/prerender-link`));
    has(new RegExp(`127\\.0\\.0\\.1:${iPort}/from-shared`)); // a SharedWorker's fetch: no route sees it either
    has(/^ftp:\/\/127\.0\.0\.1\/x\.css/); // non-web scheme
    assert.ok(m1.blocked.every((b) => typeof b.reason === 'string' && b.reason));
    assert.ok(m1.notes.some((n) => /^blocked \d+ request\(s\) to private, local or non-web addresses: /.test(n) && /--allow-private/.test(n)), m1.notes.join('\n'));
    assert.match(r1.err, /note: blocked \d+ request\(s\)/);
    assert.equal(m1.images.length, 0, 'the og:image redirect to the internal server was not saved');
    assert.ok(!m1.logos.some((l) => /icon/.test(l.source)), 'no icon came from a redirect to the internal server');
    assert.ok(readAll(path.join(root, 'assets')).every((f) => !fs.readFileSync(f).includes('INTERNAL-SECRET-123')), 'the internal response was not written into the project');
    const own = m1.logos.filter((l) => l.source === 'img');
    assert.equal(own.length, 1, 'the logo from the target\'s own host is captured');
    assert.equal(path.extname(own[0].file), '.png');
    assert.ok(siteHits.includes('/own.png'));
    assert.ok(!siteHits.includes('/clicked'), 'a generic "OK" outside any overlay is not clicked');
    assert.ok(m1.notes.some((n) => /desktop: dismiss-banners: no banner matched \(\d+ visible buttons and links checked/.test(n)), m1.notes.join('\n'));

    // 2. --allow-private: the same page now reaches the internal server, so the assertions above prove the policy and not a quiet page.
    //    (Also --no-sandbox, and an overlay "OK" button that --dismiss-banners may click.)
    variant = 'allowed';
    siteHits.length = 0;
    const r2 = await runNode([...base, '--allow-private', '--no-sandbox'], root);
    assert.equal(r2.code, 0, r2.err);
    for (const want of ['/pixel.png', '/pixel2.png', '/pixel3.png', '/frame.html', '/fetch', '/internal.svg', '/admin/delete?id=1', 'UPGRADE /ws', ...(prerenders ? ['/prerender-link'] : []), '/from-shared']) {
      assert.ok(internalHits.includes(want), `${want} should be reachable with --allow-private, got: ${internalHits.join(', ')}`);
    }
    const m2 = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'manifest.json'), 'utf8'));
    assert.deepEqual(m2.blocked, [], 'the blocked list of the earlier run is replaced');
    assert.equal(m2.sandbox, false);
    assert.match(r2.err, /note: Chrome's renderer sandbox is OFF \(the --no-sandbox flag\)/);
    assert.ok(readAll(path.join(root, 'assets')).some((f) => fs.readFileSync(f).includes('INTERNAL-SECRET-123')), 'control: the internal SVG was fetched and saved');
    assert.ok(siteHits.includes('/ok-clicked'), 'a weak "OK" label inside a dialog overlay is clicked');
    assert.ok(m2.notes.some((n) => n === 'desktop: clicked cookie banner button "OK"'), m2.notes.join('\n'));
  } finally {
    await closeServer(site);
    await closeServer(internal);
    rmTree(root);
  }
});

test('capture.mjs with credentials and a token in the URL: the real URL is used, nothing secret is logged or written; a Korean consent banner is clicked', { timeout: 240000 }, async (t) => {
  const root = browserProject();
  if (!root) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const want = `Basic ${Buffer.from('admin:hunter2').toString('base64')}`;
  const seen = [];
  const site = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || null });
    if (req.headers.authorization !== want) { res.writeHead(401, { 'www-authenticate': 'Basic realm="staging"' }); return res.end('login required'); }
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/icon.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    if (u.pathname === '/agreed' || u.pathname === '/confirm') { res.writeHead(204); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Staging</title><link rel="icon" href="/icon.png?sig=SIGVALUE123&size=32"><script type="speculationrules">{"prefetch":[{"source":"list","urls":["/next"]}]}</script></head><body><h1>Product</h1>
<form onsubmit="return false"><button onclick="fetch('/confirm')">확인</button></form>
<div class="cookie-banner" style="position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:16px"><span>이 사이트는 쿠키를 사용합니다.</span> <button>설정</button> <button onclick="fetch('/agreed'); this.parentElement.remove()">모두 동의</button></div></body></html>`);
  });
  try {
    const port = site.address().port;
    const args = [path.join(SCRIPTS, 'capture.mjs'), `http://admin:hunter2@127.0.0.1:${port}/?token=abc123&page=2`, '--root', root, '--viewports', 'desktop', '--settle', '0.1', '--no-fonts', '--dismiss-banners', '--apply-brand', '--json'];
    const r = await runNode(args, root);
    if (noBrowser(r)) { t.skip(`no browser: ${r.err.split('\n')[0]}`); return; }
    assert.equal(r.code, 0, r.err);
    const shown = `http://127.0.0.1:${port}/?token=***&page=2`;
    const manifestText = fs.readFileSync(path.join(root, 'assets', 'manifest.json'), 'utf8');
    const studioText = fs.readFileSync(path.join(root, 'studio.json'), 'utf8');
    for (const [name, text] of [['stderr', r.err], ['stdout', r.out], ['manifest.json', manifestText], ['studio.json', studioText]]) {
      for (const secret of ['hunter2', 'abc123', 'SIGVALUE123']) assert.ok(!text.includes(secret), `${secret} leaked into ${name}`);
    }
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.url, shown);
    assert.equal(manifest.finalUrl, shown);
    assert.equal(JSON.parse(studioText).brand.url, shown, 'studio.json brand.url is the redacted form');
    assert.equal(JSON.parse(r.out.trim().split('\n').pop()).applied.url, shown);
    assert.match(r.err, new RegExp(`capture: http://127\\.0\\.0\\.1:${port}/\\?token=\\*\\*\\*&page=2 \\(browser `));
    // navigation used the real URL, with the credentials sent to the site's origin after its 401
    assert.ok(seen.some((s) => s.url === '/?token=abc123&page=2' && s.auth === want), JSON.stringify(seen));
    const icon = manifest.logos.find((l) => l.source === 'icon');
    assert.ok(icon && path.extname(icon.file) === '.png', `the signed icon URL was downloaded with the credentials: ${JSON.stringify(manifest.logos)}`);
    assert.equal(icon.url, `http://127.0.0.1:${port}/icon.png?sig=***&size=32`);
    // banner: the Korean strong label inside the fixed overlay is clicked, the generic "확인" of a form is not
    assert.ok(seen.some((s) => s.url === '/agreed' && s.auth === want), 'the consent button was clicked');
    assert.ok(!seen.some((s) => s.url === '/confirm'), 'a weak label outside an overlay is left alone');
    assert.ok(manifest.notes.includes('desktop: clicked cookie banner button "모두 동의"'), manifest.notes.join('\n'));
    // speculation rules are prefetched by Chrome's browser process, which no request filter sees: the manifest says so
    assert.ok(manifest.notes.some((n) => /^desktop: the page declares speculation rules\. Chrome fetches those URLs itself and this tool cannot filter them/.test(n)), manifest.notes.join('\n'));
  } finally {
    await closeServer(site);
    rmTree(root);
  }
});

test('capture.mjs error output never contains the URL\'s token, and a refused navigation says why', { timeout: 240000 }, async (t) => {
  const root = browserProject();
  if (!root) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const closed = await listen(() => {});
  const port = closed.address().port;
  await closeServer(closed); // now nothing listens there
  try {
    const r = await runNode([path.join(SCRIPTS, 'capture.mjs'), `http://admin:hunter2@127.0.0.1:${port}/?token=abc123`, '--root', root, '--viewports', 'desktop', '--timeout', '15', '--no-fonts'], root);
    if (noBrowser(r)) { t.skip(`no browser: ${r.err.split('\n')[0]}`); return; }
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /capture: .*ERR_CONNECTION_REFUSED/);
    for (const secret of ['hunter2', 'abc123']) assert.ok(!r.err.includes(secret), `${secret} leaked: ${r.err}`);
    assert.ok(!fs.existsSync(path.join(root, 'assets', 'manifest.json')), 'a failed run writes no manifest');
  } finally {
    rmTree(root);
  }
});

test('capture.mjs prints the private-address hint when the navigation itself is refused (redirect from the target to an internal host)', { timeout: 240000 }, async (t) => {
  const root = browserProject();
  if (!root) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const internalHits = [];
  const internal = await listen((req, res) => { internalHits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>internal admin</body></html>'); });
  const site = await listen((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${internal.address().port}/admin?token=abc123` }); res.end(); });
  try {
    const r = await runNode([path.join(SCRIPTS, 'capture.mjs'), `http://127.0.0.1:${site.address().port}/`, '--root', root, '--viewports', 'desktop', '--timeout', '15', '--no-fonts'], root);
    if (noBrowser(r)) { t.skip(`no browser: ${r.err.split('\n')[0]}`); return; }
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /navigation refused \(127\.0\.0\.1 is a private, local or link-local address\): http:\/\/127\.0\.0\.1:\d+\/admin\?token=\*\*\*\. Pass --allow-private/);
    assert.deepEqual(internalHits, []);
  } finally {
    await closeServer(site);
    await closeServer(internal);
    rmTree(root);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Browser policy in the built-in launcher (the policy itself is tested in test/browser-policy.test.mjs, with the template's launcher)

test('launch(): a MOTION_CHROME_PATH at the bundled headless shell is silent; at chrome.exe, or "browser": "chrome", it warns once and is logged on Windows', async () => {
  const dir = tmp('ms-capture-policy-');
  const shell = path.join(dir, 'chrome-headless-shell.exe');
  const chrome = path.join(dir, 'chrome.exe');
  for (const f of [shell, chrome]) fs.writeFileSync(f, ''); // handed to a fake playwright, never run
  const plain = fakePlaywrightProject();
  const pinned = fakePlaywrightProject({ studioJson: '{"browser":"chrome"}' });
  const win = process.platform === 'win32';
  const log = path.join(dir, 'launches.json');
  try {
    await withEnv({ MOTION_CHROME_PATH: undefined, MOTION_BROWSER: undefined, MOTION_LAUNCH_LOG: log }, async () => {
      globalThis.__msLaunches = [];
      const bundled = await withEnv({ MOTION_CHROME_PATH: shell }, () => withStderr(() => C.launch(plain)));
      assert.equal(bundled.result.via, 'chromium-headless-shell');
      assert.equal(globalThis.__msLaunches[0].executablePath, path.resolve(shell));
      assert.equal(bundled.stderr, '');
      assert.equal(fs.existsSync(log), false, 'the bundled browser is not counted');

      const installed = await withEnv({ MOTION_CHROME_PATH: chrome }, () => withStderr(() => C.launch(plain)));
      assert.equal(installed.result.via, `executable:${path.resolve(chrome)}`);
      const viaConfig = await withStderr(() => C.launch(pinned));
      assert.equal(viaConfig.result.via, 'chrome');
      assert.equal(globalThis.__msLaunches[2].channel, 'chrome');
      if (win) {
        for (const r of [installed, viaConfig]) assert.equal(r.stderr.trim().split('\n').length, 1, `one warning line: ${JSON.stringify(r.stderr)}`);
        assert.match(installed.stderr, /^warning: starting .* on Windows counts as one failed logon/);
        assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).length, 2);
      } else {
        assert.equal(installed.stderr + viaConfig.stderr, '', 'the blank-password check is Windows-only');
        assert.equal(fs.existsSync(log), false);
      }
    });
  } finally { for (const r of [plain, pinned]) rmTree(r); delete globalThis.__msLaunches; }
});

// states.mjs starts its browser through capture.mjs launch(), the shared browser policy. Run against a playwright stub that records every
// launch request and then refuses (no browser is ever started): on Windows 'auto' asks for the bundled browser only; an installed Chrome/Edge
// is an explicit choice that warns once and is counted in the launch log; and the guard refuses it once too many fall inside the window.
test('states.mjs: on Windows "auto" asks only for the bundled browser, an installed Chrome/Edge needs an explicit choice, warns once and is guarded', async () => {
  const win = process.platform === 'win32';
  const dir = tmp('ms-scout-policy-');
  const shell = path.join(dir, 'chrome-headless-shell.exe');
  const chrome = path.join(dir, 'chrome.exe');
  const edge = path.join(dir, 'msedge.exe');
  for (const f of [shell, chrome, edge]) fs.writeFileSync(f, ''); // named in MOTION_CHROME_PATH only, never run
  const projects = [];
  const run = async ({ studioJson = '{}', env = {}, log = null } = {}) => {
    const root = fakePlaywrightProject({ studioJson });
    projects.push(root);
    const record = path.join(root, 'launches.jsonl');
    const launchLog = path.join(root, 'system-browser-launches.json'); // the guard's log, inside the temp project: never the real one
    if (log) fs.writeFileSync(launchLog, JSON.stringify(log));
    fs.writeFileSync(path.join(root, 'node_modules', 'playwright', 'index.js'), `
const fs = require('node:fs');
exports.chromium = { async launch(opts) { fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ channel: opts.channel ?? null, executablePath: opts.executablePath ?? null }) + '\\n'); throw new Error('stub: refusing to start a browser'); } };
`);
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(SCRIPTS, 'states.mjs'), 'http://127.0.0.1:9/', '--root', root, '--viewport=desktop'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MOTION_CHROME_PATH: '', MOTION_BROWSER: '', MOTION_SYSTEM_BROWSER_MAX: '', MOTION_ALLOW_LOCKOUT_RISK: '', MOTION_LAUNCH_LOG: launchLog, ...env },
      });
      let err = '';
      child.stdout.on('data', () => {});
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, err }));
    });
    const jsonLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const logged = fs.existsSync(launchLog) ? JSON.parse(fs.readFileSync(launchLog, 'utf8')) : [];
    return { ...r, launches: jsonLines(record), logged, warnings: r.err.split('\n').filter((l) => /^warning: starting /.test(l)) };
  };
  try {
    const recent = [Date.now() - 1000]; // one installed-browser launch a second ago
    const [auto, pinnedChrome, pinnedEdge, exeChrome, exeEdge, exeShell, refused, overridden, invalid] = await Promise.all([
      run(),
      run({ studioJson: '{"browser":"chrome"}' }),
      run({ studioJson: '{"browser":"msedge"}' }),
      run({ env: { MOTION_CHROME_PATH: chrome } }),
      run({ env: { MOTION_CHROME_PATH: edge } }),
      run({ env: { MOTION_CHROME_PATH: shell } }),
      run({ studioJson: '{"browser":"chrome"}', env: { MOTION_SYSTEM_BROWSER_MAX: '2' }, log: recent }), // limit 2 = one launch allowed per 10 minutes
      run({ studioJson: '{"browser":"chrome"}', env: { MOTION_SYSTEM_BROWSER_MAX: '2', MOTION_ALLOW_LOCKOUT_RISK: '1' }, log: recent }),
      run({ env: { MOTION_BROWSER: 'firefox' } }),
    ]);
    assert.equal(auto.code, 1, auto.err);
    assert.match(auto.err, /could not launch a browser/);
    assert.deepEqual([auto.warnings, auto.logged], [[], []], 'the bundled browser is neither warned about nor counted');
    if (win) {
      assert.deepEqual(auto.launches, [{ channel: null, executablePath: null }], 'auto = the bundled browser only');
      assert.match(auto.err, /no safe browser found/, 'the policy\'s failure text with the install command');
      assert.match(auto.err, /npx playwright install chromium-headless-shell/);
    } else {
      assert.deepEqual(auto.launches.map((l) => l.channel), ['chrome', 'msedge', null], 'macOS and Linux keep chrome, msedge, bundled');
    }

    // An explicit choice of an installed browser: launched (the stub refuses), on Windows with one warning line and one log entry.
    for (const [r, want] of [[pinnedChrome, { channel: 'chrome', executablePath: null }], [pinnedEdge, { channel: 'msedge', executablePath: null }],
      [exeChrome, { channel: null, executablePath: path.resolve(chrome) }], [exeEdge, { channel: null, executablePath: path.resolve(edge) }]]) {
      assert.equal(r.code, 1, r.err);
      assert.deepEqual(r.launches, [want], JSON.stringify(want));
      if (win) {
        assert.equal(r.warnings.length, 1, `one warning line: ${r.err}`);
        assert.match(r.warnings[0], /on Windows counts as one failed logon (.*); launch 1 of 3 allowed in 10 min/);
        assert.equal(r.logged.length, 1, 'the launch is counted');
      } else assert.deepEqual([r.warnings, r.logged], [[], []], 'the blank-password check is Windows-only');
    }
    assert.deepEqual(exeShell.launches, [{ channel: null, executablePath: path.resolve(shell) }], 'the headless shell path is launched as given');
    assert.deepEqual([exeShell.warnings, exeShell.logged], [[], []], 'and is silent and not counted');

    // The guard: with the window full the installed browser is refused before it starts (Windows), or is not counted at all (elsewhere).
    if (win) {
      assert.equal(refused.code, 1, refused.err);
      assert.deepEqual(refused.launches, [], 'refused before any launch');
      assert.match(refused.err, /refusing to start chrome: 1 launches of an installed Chrome\/Edge in the last 10 minutes/);
      assert.match(refused.err, /npx playwright install chromium-headless-shell/, 'the way out is named');
      assert.deepEqual(refused.logged, recent, 'a refused launch is not logged');
      assert.equal(overridden.code, 1, overridden.err);
      assert.deepEqual(overridden.launches, [{ channel: 'chrome', executablePath: null }], 'MOTION_ALLOW_LOCKOUT_RISK=1 lets it through');
      assert.match(overridden.warnings[0] ?? '', /\(over the limit: MOTION_ALLOW_LOCKOUT_RISK is set\)/);
      assert.equal(overridden.logged.length, 2, 'still counted');
    } else {
      assert.deepEqual(refused.launches.map((l) => l.channel), ['chrome'], 'no guard outside Windows');
      assert.deepEqual(refused.logged, recent);
    }

    // A wrong MOTION_BROWSER is a usage error before any launch, on every OS.
    assert.equal(invalid.code, 2, invalid.err);
    assert.match(invalid.err, /MOTION_BROWSER=firefox is not valid/);
    assert.deepEqual(invalid.launches, []);
  } finally { for (const r of projects) rmTree(r); rmTree(dir); }
});
