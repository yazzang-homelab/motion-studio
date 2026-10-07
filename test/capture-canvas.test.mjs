// skills/product-reel/scripts/canvas-frames.mjs (+ canvas-pack.mjs, png-sheet.mjs): a canvas-driven UI sampled over time into sprite sheets at an
// integer scale, and the pack step. Pure tests run anywhere (PNG reader/writer, frame-size rules, packing from synthetic sheets); the browser
// tests serve a local page whose canvas animates and changes on a click, and skip unless playwright resolves and a browser starts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { CANVAS_A, CANVAS_B, REPO, SCRIPTS, browserProject, cleanup, closeServer, noBrowser, rmTree, runNode, startSite, tmp } from '../scripts/test-support/capture-site.mjs';

const F = await import(pathToFileURL(path.join(SCRIPTS, 'canvas-frames.mjs')).href);
const P = await import(pathToFileURL(path.join(SCRIPTS, 'canvas-pack.mjs')).href);
const G = await import(pathToFileURL(path.join(SCRIPTS, 'png-sheet.mjs')).href);
after(cleanup);

// ---------------------------------------------------------------------------------------------------------------
// png-sheet.mjs: a hand-built PNG with every filter type, the other color types, damage

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32BE(body.length, 0); h.write(type, 4, 'latin1'); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([h.subarray(4), body])), 0); return Buffer.concat([h, body, c]); };
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const paeth = (a, b, c) => { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** A PNG of `px` (bpp bytes per pixel, rows of w pixels) with row y filtered by filters[y % filters.length]. */
function buildPng({ w, h, color, depth = 8, interlace = 0, px, bpp, filters = [0], extra = [] }) {
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const ft = filters[y % filters.length];
    raw[y * (stride + 1)] = ft;
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = color; ihdr[12] = interlace;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const pattern = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + (i >> 3) * 11 + (i % 5) * 3) & 0xff));

test('decodePng reads every filter type (none, sub, up, average, paeth) of an RGBA image back byte for byte', () => {
  const w = 7;
  const h = 10;
  const px = pattern(w * h * 4);
  const png = buildPng({ w, h, color: 6, px, bpp: 4, filters: [0, 1, 2, 3, 4] });
  const img = G.decodePng(png);
  assert.deepEqual([img.width, img.height], [w, h]);
  assert.ok(img.data.equals(px));
  for (const ft of [0, 1, 2, 3, 4]) assert.ok(G.decodePng(buildPng({ w, h, color: 6, px, bpp: 4, filters: [ft] })).data.equals(px), `filter ${ft}`);
});

test('decodePng: RGB, grey, grey+alpha and palette (with tRNS) images become RGBA', () => {
  const rgb = Buffer.from([10, 20, 30, 40, 50, 60]);
  assert.deepEqual([...G.decodePng(buildPng({ w: 2, h: 1, color: 2, px: rgb, bpp: 3 })).data], [10, 20, 30, 255, 40, 50, 60, 255]);
  assert.deepEqual([...G.decodePng(buildPng({ w: 2, h: 1, color: 0, px: Buffer.from([7, 200]), bpp: 1 })).data], [7, 7, 7, 255, 200, 200, 200, 255]);
  assert.deepEqual([...G.decodePng(buildPng({ w: 1, h: 2, color: 4, px: Buffer.from([9, 128, 33, 4]), bpp: 2 })).data], [9, 9, 9, 128, 33, 33, 33, 4]);
  const pal = buildPng({ w: 3, h: 1, color: 3, px: Buffer.from([0, 1, 2]), bpp: 1, extra: [chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255])), chunk('tRNS', Buffer.from([255, 100]))] });
  assert.deepEqual([...G.decodePng(pal).data], [255, 0, 0, 255, 0, 255, 0, 100, 0, 0, 255, 255]);
});

test('decodePng names what it cannot read: not a PNG, 16-bit, interlaced, bad checksum, truncated', () => {
  const good = buildPng({ w: 2, h: 2, color: 6, px: pattern(16), bpp: 4 });
  assert.throws(() => G.decodePng(Buffer.from('GIF89a......................................')), /not a PNG/);
  assert.throws(() => G.decodePng(buildPng({ w: 1, h: 1, color: 6, depth: 16, px: pattern(4), bpp: 4 })), /only 8-bit/);
  assert.throws(() => G.decodePng(buildPng({ w: 1, h: 1, color: 6, interlace: 1, px: pattern(4), bpp: 4 })), /interlaced/);
  const flipped = Buffer.from(good);
  flipped[40] ^= 0xff;
  assert.throws(() => G.decodePng(flipped), /bad checksum|corrupt|wrong length/);
  assert.throws(() => G.decodePng(good.subarray(0, good.length - 20)), /truncated|corrupt|IHDR|wrong length/);
});

test('encodePng/decodePng round trip, deterministic bytes; repackSheet copies whole frames in the order asked, outside slots are refused', () => {
  const fw = 3;
  const fh = 2;
  const cols = 3;
  const frames = 6;
  const sheet = { width: cols * fw, height: 2 * fh, data: Buffer.alloc(cols * fw * 2 * fh * 4) };
  for (let i = 0; i < frames; i++) {
    const { x, y } = G.slotOrigin(i, cols, fw, fh);
    for (let yy = 0; yy < fh; yy++) for (let xx = 0; xx < fw; xx++) sheet.data.set([i * 40 + 1, xx * 50, yy * 90 + 5, 255], ((y + yy) * sheet.width + x + xx) * 4);
  }
  const png = G.encodePng(sheet);
  assert.ok(png.equals(G.encodePng(sheet)), 'the same pixels always give the same bytes');
  assert.ok(G.decodePng(png).data.equals(sheet.data));
  const packed = G.repackSheet(sheet, { cols, frame: [fw, fh], indices: [4, 1, 5], outCols: 2 });
  assert.deepEqual([packed.width, packed.height], [2 * fw, 2 * fh]);
  const at = (img, i, outCols) => { const o = G.slotOrigin(i, outCols, fw, fh); const out = []; for (let y = 0; y < fh; y++) out.push(img.data.subarray(((o.y + y) * img.width + o.x) * 4, ((o.y + y) * img.width + o.x + fw) * 4)); return Buffer.concat(out); };
  [4, 1, 5].forEach((src, i) => assert.ok(at(packed, i, 2).equals(at(sheet, src, cols)), `slot ${i} = source frame ${src}`));
  assert.deepEqual([...at(packed, 3, 2)], new Array(fw * fh * 4).fill(0), 'the unused slot stays transparent');
  assert.throws(() => G.repackSheet(sheet, { cols, frame: [fw, fh], indices: [6] }), /frame 6 is outside the source sheet/);
  assert.equal(G.sheetRows(30, 5), 6);
  assert.equal(G.sheetRows(31, 5), 7);
  assert.throws(() => G.encodePng({ width: 2, height: 2, data: Buffer.alloc(3) }), /does not match/);
});

// ---------------------------------------------------------------------------------------------------------------
// canvas-frames.mjs: the rules that keep the scale an integer

test('resolveFrame: the buffer itself, an exact divisor (--down or --frame), and a refusal for anything that would resample', () => {
  assert.deepEqual(F.resolveFrame([1280, 960]), { frame: [1280, 960], factor: 1 });
  assert.deepEqual(F.resolveFrame([1280, 960], { down: 4 }), { frame: [320, 240], factor: 4 });
  assert.deepEqual(F.resolveFrame([1280, 960], { frame: '320x240' }), { frame: [320, 240], factor: 4 });
  assert.deepEqual(F.resolveFrame([1280, 960], { frame: '640x480' }), { frame: [640, 480], factor: 2 });
  assert.throws(() => F.resolveFrame([1280, 960], { down: 3 }), /not a multiple of 3/);
  assert.throws(() => F.resolveFrame([1280, 960], { frame: '300x225' }), /not a whole-number reduction.*would resample/);
  assert.throws(() => F.resolveFrame([1280, 960], { frame: '320x480' }), /not a whole-number reduction/, 'different ratios per axis');
  assert.throws(() => F.resolveFrame([1280, 960], { frame: '2560x1920' }), /not a whole-number reduction/, 'enlarging would resample too');
  assert.throws(() => F.resolveFrame([1280, 960], { frame: '320x240', down: 2 }), /either --frame or --down/);
  assert.throws(() => F.resolveFrame([1280, 960], { frame: '320' }), /expected WxH/);
});

test('parseClip, parseRange, sheetPlan: names, selectors with "=", counts, canvas size limits', () => {
  assert.deepEqual(F.parseClip('db=.pal[data-go="db"]'), { name: 'db', click: '.pal[data-go="db"]' });
  assert.deepEqual(F.parseClip('live'), { name: 'live', click: null });
  assert.deepEqual(F.parseClip('a-1=text=Pricing'), { name: 'a-1', click: 'text=Pricing' });
  for (const bad of ['', 'a b=x', 'a[href=x]', 'x=', '.pal[data-go=db]']) assert.throws(() => F.parseClip(bad), /--clip/, bad);
  assert.deepEqual(P.parseRange('db=4:200'), { name: 'db', first: 4, n: 200 });
  assert.deepEqual(P.parseRange('db=4'), { name: 'db', first: 4, n: null });
  assert.deepEqual(P.parseRange('db=0:'), { name: 'db', first: 0, n: null });
  for (const bad of ['db', 'db=', 'db=x:2', 'db=1:0', 'a b=1:2']) assert.throws(() => P.parseRange(bad), /--range/, bad);
  assert.deepEqual(F.sheetPlan({ seconds: 9, stepMs: 33, cols: 10, frame: [320, 240] }), { count: 272, rows: 28 }, 'the emulog numbers: 272 frames of 320x240');
  assert.throws(() => F.sheetPlan({ seconds: 0.01, stepMs: 33, cols: 10, frame: [4, 4] }), /shorter than one/);
  assert.throws(() => F.sheetPlan({ seconds: 120, stepMs: 4, cols: 10, frame: [4, 4] }), /too many/);
  assert.throws(() => F.sheetPlan({ seconds: 30, stepMs: 33, cols: 10, frame: [1920, 1080] }), /16384 px canvas limit/);
  assert.deepEqual(F.parseSize('320X240'), [320, 240]);
});

test('canvas-frames.mjs copies the canvas buffer with smoothing off and never takes an element screenshot', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'canvas-frames.mjs'), 'utf8');
  assert.match(src, /imageSmoothingEnabled = false/);
  assert.match(src, /drawImage\(canvas, 0, 0, canvas\.width, canvas\.height, x, y, fw, fh\)/, 'the source rectangle is the buffer (width/height), not the CSS box');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /\.screenshot\(|getBoundingClientRect\(\)\.(width|height)\s*[,)]\s*[^;]*drawImage/, 'no element screenshot of the canvas');
});

test('canvas-frames.mjs command line: --help, missing --canvas and a pack without captures are usage errors (no browser)', async () => {
  const root = tmp('ms-canvas-cli-');
  const help = await runNode([path.join(SCRIPTS, 'canvas-frames.mjs'), '--help'], root);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /canvas-frames\.mjs <url> --canvas/);
  assert.match(help.out, /Pack options:/);
  const noCanvas = await runNode([path.join(SCRIPTS, 'canvas-frames.mjs'), 'http://127.0.0.1:9/'], root);
  assert.equal(noCanvas.code, 2);
  assert.match(noCanvas.err, /--canvas <selector> is required/);
  const pack = await runNode([path.join(SCRIPTS, 'canvas-frames.mjs'), 'pack', '--root', root], root);
  assert.equal(pack.code, 2, pack.err);
  assert.match(pack.err, /frames\.json not found: run `canvas-frames\.mjs capture` first/);
  const outside = await runNode([path.join(SCRIPTS, 'canvas-frames.mjs'), 'http://127.0.0.1:9/', '--canvas', 'canvas', '--out', '../x', '--root', root], root);
  assert.equal(outside.code, 2);
  assert.match(outside.err, /outside the project folder/);
});

// ---------------------------------------------------------------------------------------------------------------
// canvas-pack.mjs from a synthetic capture (no browser)

/** A frames.json + sheet for `n` frames of 4x3 px whose pixel (0,0) tells the frame number. */
function syntheticCapture(root, n = 7, cols = 3) {
  const dir = path.join(root, 'assets', 'brand', 'frames');
  fs.mkdirSync(dir, { recursive: true });
  const fw = 4;
  const fh = 3;
  const rows = G.sheetRows(n, cols);
  const sheet = { width: cols * fw, height: rows * fh, data: Buffer.alloc(cols * fw * rows * fh * 4) };
  for (let i = 0; i < n; i++) {
    const o = G.slotOrigin(i, cols, fw, fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) sheet.data.set([i + 1, x, y, 255], ((o.y + y) * sheet.width + o.x + x) * 4);
  }
  fs.writeFileSync(path.join(dir, 'c.png'), G.encodePng(sheet));
  // frames 0 and 1 are identical (the click had no effect yet): hashes say so
  const hashes = Array.from({ length: n }, (_, i) => (i < 2 ? 'aaaaaaaa' : `h${i}`.padEnd(8, '0')));
  fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({ version: 1, frame: [fw, fh], cols, stepMs: 33, clips: { c: { file: 'assets/brand/frames/c.png', frames: n, rows, times: Array.from({ length: n }, (_, i) => i * 33), hashes } } }));
  return { dir, sheet, fw, fh, cols };
}

test('packClips: a range keeps exactly those frames in order with their times; --trim-lead starts at the first change; errors name the clip', () => {
  const root = tmp('ms-pack-');
  const { dir, sheet, fw, fh, cols } = syntheticCapture(root);
  const pack = P.packClips({ root, dir, ranges: [P.parseRange('c=2:4')], outCols: 2 });
  const c = pack.clips.c;
  assert.deepEqual([c.first, c.n, c.cols, c.rows, c.frame], [2, 4, 2, 2, [4, 3]]);
  assert.deepEqual(c.times, [66, 99, 132, 165]);
  assert.equal(c.file, 'assets/brand/frames/pack/c.png');
  const out = G.decodePng(fs.readFileSync(path.join(root, c.file)));
  [2, 3, 4, 5].forEach((src, i) => {
    const o = G.slotOrigin(i, 2, fw, fh);
    const s = G.slotOrigin(src, cols, fw, fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      assert.deepEqual([...out.data.subarray(((o.y + y) * out.width + o.x + x) * 4, ((o.y + y) * out.width + o.x + x) * 4 + 4)],
        [...sheet.data.subarray(((s.y + y) * sheet.width + s.x + x) * 4, ((s.y + y) * sheet.width + s.x + x) * 4 + 4)], `slot ${i} px ${x},${y}`);
    }
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'pack', 'pack.json'), 'utf8')).clips.c.first, 2);
  assert.equal(P.firstChange(['a', 'a', 'b', 'c']), 2);
  assert.equal(P.firstChange(['a', 'a']), 0);
  assert.equal(P.packClips({ root, dir, trimLead: true }).clips.c.first, 2, '--trim-lead: the first frame that differs from frame 0');
  assert.equal(P.packClips({ root, dir }).clips.c.n, 7, 'no range: the whole clip');
  assert.equal(P.packClips({ root, dir, ranges: [P.parseRange('c=5:99')] }).clips.c.n, 2, 'a count past the end is clamped');
  assert.throws(() => P.packClips({ root, dir, ranges: [P.parseRange('c=7:1')] }), /starts at frame 7 but the clip has 7 frames/);
  assert.throws(() => P.packClips({ root, dir, ranges: [P.parseRange('zzz=0:1')] }), /no clip of that name.*have: c/);
});

test('S2: packClips validates frames.json clip names and paths: nothing is written outside <dir>/pack or read from outside the project', () => {
  const root = tmp('ms-pack-s2-');
  const { dir } = syntheticCapture(root);
  const metaFile = path.join(dir, 'frames.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const write = (m) => fs.writeFileSync(metaFile, JSON.stringify(m));
  write({ ...meta, clips: { '../../evilpack': meta.clips.c } });
  assert.throws(() => P.packClips({ root, dir }), /clip name "\.\.\/\.\.\/evilpack": a clip name is letters, digits, _ or - only/);
  assert.equal(fs.existsSync(path.join(root, 'assets', 'brand', 'evilpack.png')), false);
  assert.equal(fs.existsSync(path.join(dir, 'pack', 'pack.json')), false, 'nothing was packed');
  write({ ...meta, clips: { 'a\b': meta.clips.c } });
  assert.throws(() => P.packClips({ root, dir }), /letters, digits/);
  write({ ...meta, clips: { c: { ...meta.clips.c, file: '../../outside.png' } } });
  assert.throws(() => P.packClips({ root, dir }), /clip c: sprite sheet \.\.\/\.\.\/outside\.png is outside the project folder/);
  write({ ...meta, clips: { c: { ...meta.clips.c, file: path.resolve(root, '..', 'abs.png') } } });
  assert.throws(() => P.packClips({ root, dir }), /outside the project folder/);
  write(meta);
  assert.equal(P.packClips({ root, dir }).clips.c.n, 7, 'a normal frames.json still packs');
});

test('S3: Windows device names are not clip names (parseClip, parseRange, packClips)', () => {
  for (const bad of ['con', 'CON', 'nul', 'Aux', 'prn', 'com1', 'LPT9', 'com0']) {
    assert.throws(() => F.parseClip(`${bad}=.x`), /reserved Windows device name/, bad);
    assert.throws(() => P.parseRange(`${bad}=0:1`), /reserved Windows device name/, bad);
    assert.throws(() => P.assertClipName(bad), /reserved Windows device name/, bad);
  }
  for (const ok of ['console', 'con1', 'null', 'com10', 'lpt', 'a-con', 'auxiliary', 'c']) assert.equal(P.assertClipName(ok), ok);
  assert.deepEqual(F.parseClip('conn=.x'), { name: 'conn', click: '.x' });
  const root = tmp('ms-pack-s3-');
  const { dir } = syntheticCapture(root);
  const metaFile = path.join(dir, 'frames.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, clips: { nul: meta.clips.c } }));
  assert.throws(() => P.packClips({ root, dir }), /reserved Windows device name/);
});

// ---------------------------------------------------------------------------------------------------------------
// In Chrome: a canvas that animates and changes on a click

const pixel = (img, frame, cols, fw, fh, x, y) => { const o = G.slotOrigin(frame, cols, fw, fh); const k = ((o.y + y) * img.width + o.x + x) * 4; return [...img.data.subarray(k, k + 3)]; };

test('canvas-frames.mjs in Chrome: frames are the canvas buffer at an exact 2:1 reduction (only the page\'s own colors, no blending), times are real, the click changes the canvas, pack reproduces slots', { timeout: 300000 }, async (t) => {
  const root = browserProject();
  if (!root) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const site = await startSite();
  try {
    const port = site.address().port;
    const r = await runNode([path.join(SCRIPTS, 'canvas-frames.mjs'), `http://127.0.0.1:${port}/`, '--root', root, '--canvas', '#screen canvas', '--clip=a', '--clip=b=#mode',
      '--seconds', '1', '--step-ms', '33', '--down', '2', '--cols', '5', '--probe', '#state', '--settle', '0.3'], root);
    if (noBrowser(r)) { t.skip(`no browser: ${r.err.split('\n')[0]}`); return; }
    assert.equal(r.code, 0, `${r.err}\n${r.out}`);
    const summary = JSON.parse(r.out.trim().split('\n').pop());
    assert.equal(summary.ok, true);
    const dir = path.join(root, 'assets', 'brand', 'frames');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
    assert.deepEqual(meta.canvas.buffer, [64, 48], 'the canvas buffer, not the CSS box');
    assert.deepEqual(meta.frame, [32, 24]);
    assert.deepEqual(meta.scale, { mode: 'down', factor: 2 });
    assert.equal(meta.smoothing, false);
    assert.equal(meta.canvas.label, 'demo screen');
    assert.equal(meta.canvas.css[0], 196, 'a 200 px box with a 2 px border: 196 px of content');
    assert.ok(meta.notes.some((n) => /shown at 196x146 CSS px.*an element screenshot would resample it/.test(n)), meta.notes.join('\n'));
    assert.deepEqual(Object.keys(meta.clips), ['a', 'b']);

    const [fw, fh] = meta.frame;
    for (const name of ['a', 'b']) {
      const clip = meta.clips[name];
      assert.equal(clip.frames, 30);
      assert.equal(clip.times.length, 30);
      assert.ok(clip.times.every((v, i) => i === 0 || v >= clip.times[i - 1]), 'times never go back');
      assert.ok(clip.times[0] < 25 && clip.times[29] >= 29 * 33 - 5, `real times start at the click and span the clip: ${clip.times[0]}..${clip.times[29]}`);
      assert.ok(clip.distinct > 5, `${name}: the moving square makes frames differ (${clip.distinct} distinct)`);
      const sheet = G.decodePng(fs.readFileSync(path.join(root, clip.file)));
      assert.deepEqual([sheet.width, sheet.height], [5 * fw, 6 * fh]);
      const allowed = new Set(name === 'a' ? [CANVAS_A.join()] : [CANVAS_A.join(), CANVAS_B.join()]).add('255,255,255');
      for (let i = 0; i < clip.frames; i++) {
        const seen = new Map();
        for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) { const k = pixel(sheet, i, 5, fw, fh, x, y).join(); seen.set(k, (seen.get(k) || 0) + 1); }
        for (const k of seen.keys()) assert.ok(allowed.has(k) || (k === CANVAS_B.join() && name === 'b'), `${name} frame ${i}: unexpected color ${k}: smoothing would blend (${[...seen.keys()].join(' | ')})`);
        assert.equal(seen.get('255,255,255'), 16, `${name} frame ${i}: the 8x8 square is exactly 4x4 after an exact 2:1 reduction`);
      }
    }
    const a = meta.clips.a;
    const b = meta.clips.b;
    const sheetA = G.decodePng(fs.readFileSync(path.join(root, a.file)));
    const sheetB = G.decodePng(fs.readFileSync(path.join(root, b.file)));
    assert.deepEqual(pixel(sheetA, 29, 5, fw, fh, 0, 0), CANVAS_A, 'no click: still mode A at the end');
    assert.deepEqual(pixel(sheetB, 0, 5, fw, fh, 0, 0), CANVAS_A, 'frame 0 is the instant of the click');
    assert.deepEqual(pixel(sheetB, 29, 5, fw, fh, 0, 0), CANVAS_B, 'the click changed the canvas');
    assert.ok(b.firstChange >= 1 && b.firstChange < 10, `the change shows up within a few frames (${b.firstChange})`);
    assert.deepEqual(a.probe, [{ text: 'home', fromFrame: 0 }]);
    assert.deepEqual(b.probe, [{ text: 'mode-b', fromFrame: 0 }]);
    assert.equal(a.hashes.length, 30);

    // pack: slots are source frames first+i, pixels copied
    const pk = await runNode([path.join(SCRIPTS, 'canvas-frames.mjs'), 'pack', '--root', root, '--range', 'b=3:10', '--cols', '4'], root);
    assert.equal(pk.code, 0, pk.err);
    const pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack', 'pack.json'), 'utf8'));
    assert.deepEqual([pack.clips.b.first, pack.clips.b.n, pack.clips.b.cols, pack.clips.b.rows], [3, 10, 4, 3]);
    assert.deepEqual(Object.keys(pack.clips), ['b']);
    const packed = G.decodePng(fs.readFileSync(path.join(root, pack.clips.b.file)));
    for (let i = 0; i < 10; i++) {
      for (const [x, y] of [[0, 0], [3, 20 / 2], [fw - 1, fh - 1]]) assert.deepEqual(pixel(packed, i, 4, fw, fh, x, y), pixel(sheetB, 3 + i, 5, fw, fh, x, y), `slot ${i} (${x},${y})`);
    }
    assert.deepEqual(pack.clips.b.times, b.times.slice(3, 13));
  } finally {
    await closeServer(site);
    rmTree(root);
  }
});

test('canvas-frames.mjs in Chrome: a frame size that would resample the canvas is refused (exit 2), as is a selector that matches nothing', { timeout: 300000 }, async (t) => {
  const root = browserProject();
  if (!root) { t.skip('playwright is not resolvable (npm install, or set MOTION_SMOKE_NODE_MODULES)'); return; }
  const site = await startSite();
  try {
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bad = await runNode([path.join(SCRIPTS, 'canvas-frames.mjs'), url, '--root', root, '--canvas', '#screen canvas', '--frame', '40x30', '--seconds', '0.2', '--settle', '0.1'], root);
    if (noBrowser(bad)) { t.skip(`no browser: ${bad.err.split('\n')[0]}`); return; }
    assert.equal(bad.code, 2, bad.err);
    assert.match(bad.err, /a 40x30 frame is not a whole-number reduction of the 64x48 canvas buffer/);
    assert.equal(fs.existsSync(path.join(root, 'assets', 'brand', 'frames', 'frames.json')), false, 'nothing is written');
    const none = await runNode([path.join(SCRIPTS, 'canvas-frames.mjs'), url, '--root', root, '--canvas', '#nothing-here canvas', '--seconds', '0.2', '--settle', '0.1'], root);
    assert.equal(none.code, 1, none.err);
    assert.match(none.err, /--canvas #nothing-here canvas: nothing matched within 10 s/);
  } finally {
    await closeServer(site);
    rmTree(root);
  }
});
