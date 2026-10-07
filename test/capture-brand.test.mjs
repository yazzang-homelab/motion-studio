// capture.mjs: a brand set in type (text wordmark recorded as text instead of "ask for a logo") and the font registry report (every family in
// use: already in assets/fonts/fonts.json or not, license verified or UNVERIFIED, nothing added silently). Pure tests run anywhere; the browser
// test runs capture.mjs against a local page and skips unless playwright resolves and a browser starts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCRIPTS, bundledFont, browserProject, cleanup, closeServer, noBrowser, rmTree, runNode, startSite, tmp } from '../scripts/test-support/capture-site.mjs';

const R = await import(pathToFileURL(path.join(SCRIPTS, 'capture-registry.mjs')).href);
const F = await import(pathToFileURL(path.join(SCRIPTS, 'capture-fonts.mjs')).href);
const G = await import(pathToFileURL(path.join(SCRIPTS, 'capture-guard.mjs')).href);
after(cleanup);

const VERIFIED = { family: 'Neo', src: 'assets/fonts/neo-400.woff2', weight: '400', style: 'normal', license: 'OFL-1.1', licenseFile: 'assets/fonts/OFL-Neo.txt' };
const BARE = { family: 'Bare', src: 'assets/fonts/bare-400.woff2', weight: '400', style: 'normal' };
const row = (rows, family) => rows.find((r) => r.family === family);

// ---------------------------------------------------------------------------------------------------------------
// licenseState / fontRegistry

test('licenseState: verified needs a license id AND the license text file; "unknown", an id alone or nothing is unverified', () => {
  assert.equal(F.licenseState(VERIFIED), 'verified');
  assert.equal(F.licenseState({ ...VERIFIED, license: 'unknown' }), 'unverified');
  assert.equal(F.licenseState({ ...VERIFIED, licenseFile: undefined }), 'unverified');
  assert.equal(F.licenseState({ ...VERIFIED, license: '' }), 'unverified');
  assert.equal(F.licenseState(BARE), 'unverified');
  assert.equal(F.licenseState(null), 'unverified');
  assert.equal(R.licenseSummary([VERIFIED, VERIFIED]), 'verified');
  assert.equal(R.licenseSummary([BARE]), 'unverified');
  assert.equal(R.licenseSummary([VERIFIED, BARE]), 'mixed');
});

test('fontRegistry: registered+verified, registered+unverified, added, added next to a verified entry (reused), not registered, system - each says what happened', () => {
  const written = [
    { family: 'Fresh', weight: '400', style: 'normal', file: 'assets/fonts/fresh-400.woff2', licenseFile: null, license: { status: 'UNVERIFIED' } },
    { family: 'Neo', weight: '700', style: 'normal', file: 'assets/fonts/neo-700.woff2', licenseFile: 'assets/fonts/OFL-Neo.txt', license: { status: 'FOUND', source: 'fonts.json', file: 'assets/fonts/OFL-Neo.txt' } },
    { family: 'Bare', weight: '700', style: 'normal', file: 'assets/fonts/bare-700.woff2', licenseFile: null, license: { status: 'UNVERIFIED' } },
    { family: 'Found', weight: '400', style: 'normal', file: 'assets/fonts/found-400.woff2', licenseFile: 'assets/fonts/OFL-Found.txt', license: { status: 'FOUND', source: 'license file next to the font', file: 'assets/fonts/OFL-Found.txt' } },
  ];
  const rows = R.fontRegistry({
    families: [{ family: 'Neo', usedBy: ['wordmark', 'body'] }, { family: 'Bare', usedBy: ['h1'] }, { family: 'Fresh', usedBy: ['p'] }, { family: 'Found', usedBy: ['nav'] },
      { family: 'Lost', usedBy: ['button'] }, { family: '-apple-system', usedBy: ['body'] }, { family: 'Arial', usedBy: ['input'] }, { family: 'neo', usedBy: [] }],
    webFonts: ['Neo', 'Bare', 'Fresh', 'Found', 'Lost'],
    existing: [VERIFIED, BARE], written, skipped: [{ family: 'Lost', reason: 'HTTP 404' }], fontsEnabled: true,
  });
  assert.equal(rows.length, 7, 'a family listed twice (any case) is one row');
  const neo = row(rows, 'Neo');
  assert.deepEqual([neo.status, neo.license, neo.registered, neo.added], ['registered+added', 'verified', 1, 1]);
  assert.match(neo.text, /registered in assets\/fonts\/fonts\.json \(1 entry\), license verified: OFL-1\.1 \(assets\/fonts\/OFL-Neo\.txt\); this capture added 1 face: 1 face reuse the license already on record/);
  const bare = row(rows, 'Bare');
  assert.deepEqual([bare.status, bare.license], ['registered+added', 'unverified']);
  assert.match(bare.text, /license UNVERIFIED.*added 1 face: 1 file with license UNVERIFIED/);
  const fresh = row(rows, 'Fresh');
  assert.deepEqual([fresh.status, fresh.license, fresh.registered, fresh.added], ['added', 'unverified', 0, 1]);
  assert.match(fresh.text, /^NOT registered before; this capture added 1 file: 1 file with license UNVERIFIED/);
  assert.deepEqual([row(rows, 'Found').status, row(rows, 'Found').license], ['added', 'found']);
  const lost = row(rows, 'Lost');
  assert.deepEqual([lost.status, lost.license], ['not-registered', 'n/a']);
  assert.match(lost.text, /a web font, NOT registered \(HTTP 404\)/);
  assert.deepEqual([row(rows, '-apple-system').status, row(rows, 'Arial').status], ['system', 'system']);
  assert.match(row(rows, 'Arial').text, /no @font-face on the page: an installed or system font/);
  assert.deepEqual(R.registryUnverified(rows).sort(), ['Bare', 'Fresh']);
  assert.equal(R.registryLines(rows).length, 7);
  assert.match(R.registryLines(rows)[0], /^font registry: Neo \(wordmark, body\): registered in/);

  const off = R.fontRegistry({ families: [{ family: 'Lost' }], webFonts: ['Lost'], existing: [], written: [], skipped: [], fontsEnabled: false });
  assert.match(off[0].text, /NOT registered \(--no-fonts\)/);
  const same = R.fontRegistry({ families: [{ family: 'Neo' }], existing: [VERIFIED], written: [], skipped: [] });
  assert.deepEqual([same[0].status, same[0].license], ['registered', 'verified']);
  assert.match(same[0].text, /this capture added nothing/);
});

// ---------------------------------------------------------------------------------------------------------------
// collectFonts + registerFonts: a new face beside a verified entry reuses its license

function fakeContext(routes) {
  const reply = (r) => ({ ok: () => true, status: () => 200, body: async () => r.body, headers: () => ({}) });
  return { request: { get: async (url) => (routes[url] ? reply(routes[url]) : { ok: () => false, status: () => 404, body: async () => Buffer.alloc(0), headers: () => ({}) }) } };
}

test('collectFonts + registerFonts: a face next to a verified entry of its family keeps that license (no second UNVERIFIED entry); another family stays UNVERIFIED', async () => {
  const PAGE = 'https://site.test/';
  const woff2 = bundledFont('instrument-serif-400-latin.woff2');
  const ctx = fakeContext({ 'https://site.test/f/neo-700.woff2': { body: woff2 }, 'https://site.test/f/other.woff2': { body: woff2 } });
  const fonts = {
    rules: [
      { family: 'Neo', weight: '700', style: 'normal', unicodeRange: null, srcText: "url(neo-700.woff2) format('woff2')", base: 'https://site.test/f/x.css' },
      { family: 'Other', weight: '400', style: 'normal', unicodeRange: null, srcText: "url(other.woff2) format('woff2')", base: 'https://site.test/f/x.css' },
    ],
    allLoaded: [{ family: 'Neo', weight: '700', style: 'normal', unicodeRange: null, status: 'loaded' }, { family: 'Other', weight: '400', style: 'normal', unicodeRange: null, status: 'loaded' }],
  };
  const root = tmp('ms-brand-reg-');
  fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify([VERIFIED]));
  const plan = await F.collectFonts(ctx, fonts, PAGE, [VERIFIED], [], G.createGuard({ target: PAGE, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
  const neo = plan.files.find((f) => f.family === 'Neo');
  assert.deepEqual(neo.reuse, { id: 'OFL-1.1', file: 'assets/fonts/OFL-Neo.txt', from: 'assets/fonts/neo-400.woff2', basis: "the entry records no source; the new file's own license check found nothing that contradicts it" });
  assert.equal(neo.license.reusedFrom, 'assets/fonts/neo-400.woff2', 'the manifest says which entry the license came from');
  assert.equal(neo.source, 'https://site.test/f/', 'the face records where it came from');
  assert.equal(neo.license.source, 'fonts.json');
  assert.equal(plan.files.find((f) => f.family === 'Other').reuse, null);
  const written = F.registerFonts(root, plan.files);
  const list = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), 'utf8'));
  assert.equal(list.length, 3);
  const added = list.find((e) => e.family === 'Neo' && e.weight === '700');
  assert.equal(added.license, 'OFL-1.1');
  assert.equal(added.licenseFile, 'assets/fonts/OFL-Neo.txt', 'the existing license text is referenced, not copied again');
  assert.equal(list.filter((e) => e.family === 'Neo' && F.licenseState(e) === 'unverified').length, 0, 'Neo has no UNVERIFIED entry');
  assert.equal(F.licenseState(list.find((e) => e.family === 'Other')), 'unverified');
  assert.equal(written.find((w) => w.family === 'Neo').license.file, 'assets/fonts/OFL-Neo.txt');
  assert.equal(fs.readdirSync(path.join(root, 'assets', 'fonts')).filter((f) => f.endsWith('.txt')).length, 0, 'no license file was copied');
  const rows = R.fontRegistry({ families: [{ family: 'Neo' }, { family: 'Other' }], webFonts: ['Neo', 'Other'], existing: [VERIFIED], written, skipped: plan.skipped });
  assert.deepEqual([row(rows, 'Neo').license, row(rows, 'Other').license], ['verified', 'unverified']);
});

// F3: a verified license is not carried over to a file from another distribution just because the family name matches
async function plan1(existing, faceUrl, routes = {}, woff2 = Buffer.concat([Buffer.from([0, 1, 0, 0, 0, 1]), Buffer.alloc(58)])) { // default: a bare sfnt header, no name table and so no license metadata
  const PAGE = 'https://site.test/';
  const ctx = fakeContext({ [faceUrl]: { body: woff2 }, ...routes });
  const fonts = {
    rules: [{ family: 'Neo', weight: '700', style: 'normal', unicodeRange: null, srcText: `url(${faceUrl}) format('woff2')`, base: PAGE }],
    allLoaded: [{ family: 'Neo', weight: '700', style: 'normal', unicodeRange: null, status: 'loaded' }],
  };
  const guard = G.createGuard({ target: PAGE, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  return F.collectFonts(ctx, fonts, PAGE, existing, [], guard, { allowPrivate: true });
}

test('reuseBasis: a recorded source must share the new file origin; an entry without a source is judged by the new file own license check', () => {
  assert.equal(F.reuseBasis({ ...VERIFIED, source: 'https://cdn.a.test/fonts/' }, 'https://cdn.a.test/other/neo-700.woff2'), 'same-source');
  assert.equal(F.reuseBasis({ ...VERIFIED, source: 'https://cdn.a.test/fonts/' }, 'https://cdn.b.test/fonts/neo-700.woff2'), null);
  assert.equal(F.reuseBasis({ ...VERIFIED, source: 'https://cdn.a.test/fonts/' }, 'data:font/woff2;base64,AAAA'), null);
  assert.equal(F.reuseBasis(VERIFIED, 'https://cdn.b.test/neo.woff2'), 'unrecorded');
  assert.equal(F.sourceDirOf('https://cdn.a.test/fonts/neo.woff2?token=SECRET#x'), 'https://cdn.a.test/fonts/');
  assert.equal(F.sourceDirOf('data:font/woff2;base64,AAAA'), null);
});

test('collectFonts: same family from the recorded source reuses the license; from another origin it is checked on its own and NOT reused', async () => {
  const same = await plan1([{ ...VERIFIED, source: 'https://site.test/f/' }], 'https://site.test/f/neo-700.woff2');
  assert.equal(same.files[0].reuse?.basis, 'same source origin as the entry');
  assert.equal(same.files[0].reuse.from, 'assets/fonts/neo-400.woff2');
  const other = await plan1([{ ...VERIFIED, source: 'https://other-foundry.test/f/' }], 'https://site.test/f/neo-700.woff2');
  assert.equal(other.files.length, 1);
  assert.equal(other.files[0].reuse, null, 'no reuse across origins');
  assert.equal(other.files[0].license.status, 'UNVERIFIED', 'findLicense ran for the new file');
  assert.match(other.files[0].license.note, /verified Neo entry \(OFL-1\.1\) but this file comes from another source, so that license was not reused/);
  const root = tmp('ms-brand-f3-');
  fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify([{ ...VERIFIED, source: 'https://other-foundry.test/f/' }]));
  const written = F.registerFonts(root, other.files);
  const list = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), 'utf8'));
  const added = list.find((e) => e.weight === '700');
  assert.equal(F.licenseState(added), 'unverified', 'the new face does not inherit the verified state');
  assert.equal(added.source, 'https://site.test/f/', 'and records where it came from');
  assert.equal(written[0].license.status, 'UNVERIFIED');
});

test('collectFonts: an entry without a source is not trusted when the new file declares another license id', async () => {
  const apache = Buffer.from('Licensed under the Apache License, Version 2.0 https://www.apache.org/licenses/LICENSE-2.0 text text text text text text text text text text text text text text text text text text text.');
  const dir = 'https://site.test/f/';
  const r = await plan1([VERIFIED], `${dir}neo-700.woff2`, { [`${dir}LICENSE.txt`]: { body: apache } });
  assert.equal(r.files[0].reuse, null);
  assert.equal(r.files[0].license.id, 'Apache-2.0');
  assert.equal(r.files[0].licenseFile.id, 'Apache-2.0');
});

test('registerFonts: a different license text never overwrites the license file already on disk', () => {
  const root = tmp('ms-brand-f3b-');
  fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'OFL-Neo.txt'), 'ORIGINAL LICENSE TEXT');
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), JSON.stringify([VERIFIED]));
  const buf = bundledFont('instrument-serif-400-latin.woff2');
  const face = { family: 'Neo', weight: '700', style: 'normal', unicodeRange: null, buf, kind: 'woff2', ext: '.woff2', url: 'https://x.test/n.woff2', source: 'https://x.test/',
    license: { status: 'FOUND' }, licenseFile: { id: 'OFL-1.1', body: Buffer.from('OTHER LICENSE TEXT') }, reuse: null };
  F.registerFonts(root, [face]);
  assert.equal(fs.readFileSync(path.join(root, 'assets', 'fonts', 'OFL-Neo.txt'), 'utf8'), 'ORIGINAL LICENSE TEXT');
  const list = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'fonts', 'fonts.json'), 'utf8'));
  const added = list.find((e) => e.weight === '700');
  assert.notEqual(added.licenseFile, 'assets/fonts/OFL-Neo.txt');
  assert.equal(fs.readFileSync(path.join(root, added.licenseFile), 'utf8'), 'OTHER LICENSE TEXT');
});

// ---------------------------------------------------------------------------------------------------------------
// In Chrome: capture.mjs against the local page

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('capture.mjs in Chrome: a text wordmark lands in manifest.brand.wordmark with its note, and every font family gets a registry row without a second UNVERIFIED entry', { timeout: 300000 }, async (t) => {
  const root = browserProject();
  if (!root) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  // The user registered Px Mono 400 with a verified license (as `tools/fonts.mjs add-file --license-file` writes it); Other Face is unknown to the project.
  const fonts = path.join(root, 'assets', 'fonts');
  fs.mkdirSync(fonts, { recursive: true });
  fs.writeFileSync(path.join(fonts, 'px-mono-400.woff2'), bundledFont('inter-100-900-latin.woff2'));
  fs.writeFileSync(path.join(fonts, 'OFL-PxMono.txt'), 'SIL OPEN FONT LICENSE Version 1.1 - test copy');
  const registered = { family: 'Px Mono', src: 'assets/fonts/px-mono-400.woff2', weight: '400', style: 'normal', license: 'OFL-1.1', licenseFile: 'assets/fonts/OFL-PxMono.txt' };
  fs.writeFileSync(path.join(fonts, 'fonts.json'), JSON.stringify([registered], null, 2));
  const site = await startSite();
  try {
    const base = `http://127.0.0.1:${site.address().port}`;
    const r = await runNode([path.join(SCRIPTS, 'capture.mjs'), `${base}/`, '--root', root, '--viewports', 'desktop', '--settle', '0.3', '--json'], root);
    if (noBrowser(r)) { t.skip(`no browser: ${r.err.split('\n')[0]}`); return; }
    assert.equal(r.code, 0, `${r.err}\n${r.out}`);
    const result = JSON.parse(r.out.trim().split('\n').pop());
    const manifest = readJson(path.join(root, 'assets', 'manifest.json'));

    // row 3: the wordmark is recorded as text
    const wm = manifest.brand?.wordmark;
    assert.ok(wm, 'brand.wordmark is in the manifest');
    assert.equal(wm.text, 'pxstudio');
    assert.equal(wm.html, 'px<span>studio</span>');
    assert.equal(wm.link, '/');
    assert.deepEqual(wm.parts.map((p) => [p.text, p.tag, p.role, p.color]), [['px', null, 'base', '#CFD8FF'], ['studio', 'span', 'accent', '#5B8CFF']]);
    assert.deepEqual(wm.colors, { base: '#CFD8FF', accent: '#5B8CFF' });
    assert.deepEqual([wm.font.family, wm.font.weight, wm.font.size, wm.font.letterSpacing], ['Px Mono', '700', '32px', '2px']);
    assert.equal(wm.fontLoaded, true);
    assert.equal(wm.crop, 'assets/brand/logo/wordmark-crop.png');
    assert.ok(fs.statSync(path.join(root, wm.crop)).size > 100, 'the reference crop exists');
    assert.deepEqual(manifest.logos.filter((l) => l.source !== 'favicon' && !/icon/.test(l.source)), [], 'no logo image or SVG was found');
    const note = manifest.notes.find((n) => /text wordmark/.test(n));
    assert.ok(note, manifest.notes.join('\n'));
    assert.match(note, /^no logo image or SVG found; the brand is a text wordmark "pxstudio" \(px<span>studio<\/span>\) in Px Mono 700 32px, base #CFD8FF, accent #5B8CFF; recorded as text in the manifest under brand\.wordmark/);
    assert.ok(!manifest.notes.some((n) => /ask the user for an SVG or PNG logo$/.test(n)), 'the old "ask for a logo" dead end is gone');
    assert.match(r.err, /wordmark: "pxstudio" \(px<span>studio<\/span>\) in Px Mono 700 32px/);
    assert.equal(result.wordmark.text, 'pxstudio');

    // row 5: one registry row per family, on the console and in the manifest
    const reg = manifest.fonts.registry;
    const px = reg.find((x) => x.family === 'Px Mono');
    assert.equal(px.status, 'registered+added');
    assert.equal(px.license, 'verified');
    assert.ok(px.usedBy.includes('wordmark') && px.usedBy.includes('p'));
    assert.match(px.text, /registered in assets\/fonts\/fonts\.json \(1 entry\), license verified: OFL-1\.1 \(assets\/fonts\/OFL-PxMono\.txt\); this capture added 1 face: 1 face reuse the license already on record/);
    const other = reg.find((x) => x.family === 'Other Face');
    assert.deepEqual([other.status, other.license], ['added', 'unverified']);
    assert.equal(reg.find((x) => x.family === '-apple-system').status, 'system');
    assert.deepEqual(wm.fontRegistry, { status: px.status, license: px.license, text: px.text });
    for (const x of reg) assert.ok(r.err.includes(`font registry: ${x.family}`), `console line for ${x.family}`);
    assert.ok(manifest.notes.some((n) => /^font registry: license UNVERIFIED or mixed for Other Face; add no further entry/.test(n)), manifest.notes.join('\n'));
    assert.deepEqual(result.fontRegistry.map((x) => x.family).sort(), reg.map((x) => x.family).sort());

    // the project's fonts.json: Px Mono got its 700 face with the registered license, no second UNVERIFIED entry; Other Face is the only UNVERIFIED family
    const list = readJson(path.join(fonts, 'fonts.json'));
    const pxEntries = list.filter((e) => e.family === 'Px Mono');
    assert.equal(pxEntries.length, 2);
    assert.ok(pxEntries.every((e) => F.licenseState(e) === 'verified'), JSON.stringify(pxEntries));
    assert.deepEqual(pxEntries[0], registered, 'the existing entry is untouched');
    assert.deepEqual(list.filter((e) => F.licenseState(e) === 'unverified').map((e) => e.family), ['Other Face']);

    // a second run changes nothing in fonts.json and keeps one row per family
    const before = fs.readFileSync(path.join(fonts, 'fonts.json'), 'utf8');
    const again = await runNode([path.join(SCRIPTS, 'capture.mjs'), `${base}/`, '--root', root, '--viewports', 'desktop', '--settle', '0.3', '--json'], root);
    assert.equal(again.code, 0, again.err);
    assert.equal(fs.readFileSync(path.join(fonts, 'fonts.json'), 'utf8'), before, 'nothing new is registered on the second run');
    const second = readJson(path.join(root, 'assets', 'manifest.json'));
    assert.ok(second.fonts.registry.every((x) => x.status !== 'added' && x.status !== 'registered+added'), 'no family is added a second time');
    assert.deepEqual(['Other Face', 'Px Mono'].map((f) => second.fonts.registry.find((x) => x.family === f).status), ['registered', 'registered']);
    assert.match(second.fonts.registry.find((x) => x.family === 'Other Face').text, /license UNVERIFIED/, 'the report keeps saying it is UNVERIFIED');

    // a page with a logo image records no wordmark, and the stale one is removed
    const withLogo = await runNode([path.join(SCRIPTS, 'capture.mjs'), `${base}/with-logo`, '--root', root, '--viewports', 'desktop', '--settle', '0.3', '--no-fonts', '--json'], root);
    assert.equal(withLogo.code, 0, withLogo.err);
    const third = readJson(path.join(root, 'assets', 'manifest.json'));
    assert.ok(!third.brand?.wordmark, 'brand.wordmark is gone');
    assert.ok(third.logos.some((l) => /logo/.test(l.source) || /img/.test(l.source)), JSON.stringify(third.logos));
    assert.ok(!third.notes.some((n) => /text wordmark/.test(n)));
    assert.equal(fs.existsSync(path.join(root, wm.crop)), false, 'the old wordmark crop is replaced along with the other captured files');
    assert.ok(third.fonts.registry.every((x) => x.status !== 'added'), 'no new entries with --no-fonts');
  } finally {
    await closeServer(site);
    rmTree(root);
  }
});

// S1: the wordmark link is a raw (often relative) href: "/?token=..." must not reach the manifest, stdout or stderr
test('safeWordmark: a relative wordmark link loses query and fragment; secret query values in the html are masked', () => {
  const w = { text: 'acme', html: '<a href="/?a=1&amp;token=SECRETTOKEN123">ac<span>me</span></a>', link: '/?token=SECRETTOKEN123#frag', font: { family: 'X' } };
  const s = R.safeWordmark(w);
  assert.equal(s.link, '/');
  assert.doesNotMatch(JSON.stringify(s), /SECRETTOKEN123/);
  assert.match(s.html, /a=1/, 'harmless parameters stay');
  assert.equal(R.safeWordmark({ ...w, link: 'https://u:p@acme.test/home?x=1' }).link, 'https://acme.test/home');
  assert.equal(R.safeWordmark({ ...w, link: null, html: null }).link, null);
  assert.equal(R.safeWordmark(null), null);
  const info = { wordmark: { ...w, colors: { base: '#fff' }, fontLoaded: false }, fonts: { families: [], rules: [], allLoaded: [] } };
  const report = R.brandReport({ info });
  assert.doesNotMatch(JSON.stringify(report), /SECRETTOKEN123/, 'wordmark record and notes are clean');
});
