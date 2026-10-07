#!/usr/bin/env node
// Generates fixtures/contact.png for the critique-writes-log eval: a 12-still contact sheet (one still per beat of a
// 6 s, 120 BPM, 9:16 teaser) with four planted defects the critic must find by looking at the image:
//   00:02.00-00:02.50  centered title on a purple-blue gradient, second still washed out (banned default look)
//   00:03.00           two words drawn on top of each other (text overlap during a swap)
//   00:03.50           corner labels in all four corners + a frame border
//   00:04.00-00:05.00  three identical, nearly empty stills (dead beats)
// Pure Node (zlib only) so the fixture is reproducible anywhere: `node make-contact-sheet.mjs [--check] [--out P]`.
// --check decodes the committed PNG and compares its pixels with a fresh render (exit 1 on mismatch).
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = join(HERE, 'fixtures', 'contact.png');

// ---------- 5x7 bitmap font (uppercase, digits, a few marks) ----------
const GLYPHS = {
  'A': '.###.|#...#|#...#|#####|#...#|#...#|#...#', 'B': '####.|#...#|#...#|####.|#...#|#...#|####.',
  'C': '.###.|#...#|#....|#....|#....|#...#|.###.', 'D': '####.|#...#|#...#|#...#|#...#|#...#|####.',
  'E': '#####|#....|#....|####.|#....|#....|#####', 'F': '#####|#....|#....|####.|#....|#....|#....',
  'G': '.###.|#...#|#....|#.###|#...#|#...#|.####', 'H': '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  'I': '.###.|..#..|..#..|..#..|..#..|..#..|.###.', 'J': '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  'K': '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', 'L': '#....|#....|#....|#....|#....|#....|#####',
  'M': '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', 'N': '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  'O': '.###.|#...#|#...#|#...#|#...#|#...#|.###.', 'P': '####.|#...#|#...#|####.|#....|#....|#....',
  'Q': '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', 'R': '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  'S': '.####|#....|#....|.###.|....#|....#|####.', 'T': '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  'U': '#...#|#...#|#...#|#...#|#...#|#...#|.###.', 'V': '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  'W': '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.', 'X': '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  'Y': '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', 'Z': '#####|....#|...#.|..#..|.#...|#....|#####',
  '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  '2': '.###.|#...#|....#|...#.|..#..|.#...|#####', '3': '#####|...#.|..#..|...#.|....#|#...#|.###.',
  '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', '5': '#####|#....|####.|....#|....#|#...#|.###.',
  '6': '..##.|.#...|#....|####.|#...#|#...#|.###.', '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
  '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.', '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....', '.': '.....|.....|.....|.....|.....|.##..|.##..',
  '·': '.....|.....|.....|.##..|.##..|.....|.....', '-': '.....|.....|.....|#####|.....|.....|.....',
  '/': '.....|....#|...#.|..#..|.#...|#....|.....', '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
};
const FONT = Object.fromEntries(Object.entries(GLYPHS).map(([ch, rows]) => [ch, rows.split('|')]));

// ---------- tiny RGB raster ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, p) => a.map((v, i) => Math.round(v + (b[i] - v) * p));

class Raster {
  constructor(w, h, bg) { this.w = w; this.h = h; this.px = new Uint8Array(w * h * 3); this.rect(0, 0, w, h, bg); }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 3; this.px[o] = c[0]; this.px[o + 1] = c[1]; this.px[o + 2] = c[2];
  }
  rect(x, y, w, h, c) {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.set(i, j, c);
  }
  frame(x, y, w, h, t, c) { this.rect(x, y, w, t, c); this.rect(x, y + h - t, w, t, c); this.rect(x, y, t, h, c); this.rect(x + w - t, y, t, h, c); }
  vgrad(x, y, w, h, top, bottom) { for (let j = 0; j < h; j++) this.rect(x, y + j, w, 1, mix(top, bottom, j / (h - 1))); }
  text(str, x, y, scale, c) {
    let cx = x;
    for (const ch of str.toUpperCase()) {
      const g = FONT[ch] || FONT[' '];
      for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r][q] === '#') this.rect(cx + q * scale, y + r * scale, scale, scale, c);
      cx += 6 * scale;
    }
    return cx - x - scale;
  }
  textWidth(str, scale) { return str.length * 6 * scale - scale; }
  // Mouse-pointer arrow: filled right triangle with a short tail; tip at (x, y).
  cursor(x, y, s, fill, edge) {
    for (let j = 0; j <= 16 * s; j++) for (let i = 0; i <= j * 0.62; i++) this.set(x + Math.round(i), y + j, (i >= j * 0.62 - s || i < s) ? edge : fill);
    this.rect(x + 5 * s, y + 13 * s, 3 * s, 7 * s, edge);
  }
}

// ---------- the teaser: 12 stills, one per beat ----------
const C = { bg: hex('#141413'), fg: hex('#F0EEE6'), accent: hex('#D97757'), muted: hex('#6C6B73'), card: hex('#232321'),
  purple: hex('#5B3FD1'), blue: hex('#2C7BE5'), white: hex('#FFFFFF'), sheet: hex('#0E0E0D'), label: hex('#BDBAB0') };
const TW = 270, TH = 480;                       // 9:16 still at 1/4 of 1080x1920

function still(r, x0, y0, beat) {
  const T = (s, x, y, k, c) => r.text(s, x0 + x, y0 + y, k, c);
  const R = (x, y, w, h, c) => r.rect(x0 + x, y0 + y, w, h, c);
  const centered = (s, y, k, c) => T(s, Math.round((TW - r.textWidth(s, k)) / 2), y, k, c);
  switch (beat) {
    case 0: T('SHIP', 24, 150, 9, C.fg); R(24, 226, 80, 8, C.accent); break;
    case 1: T('SHIP', 24, 150, 9, C.fg); T('NOTES', 24, 226, 7, C.fg); R(24, 286, 150, 8, C.accent); break;
    case 2: T('SHIP', 24, 150, 9, C.fg); T('NOTES', 24, 226, 7, C.fg); T('FASTER', 24, 290, 6, C.accent); R(24, 340, 222, 8, C.accent); break;
    case 3:
      R(24, 150, 222, 190, C.card); T('NEW NOTE', 44, 176, 3, C.fg);
      R(44, 214, 170, 6, C.muted); R(44, 230, 120, 6, C.muted);
      R(44, 272, 110, 40, C.accent); T('SAVE', 62, 285, 3, C.bg); r.cursor(x0 + 140, y0 + 296, 1, C.white, C.bg); break;
    case 4: r.vgrad(x0, y0, TW, TH, C.purple, C.blue); centered('DRIFTNOTE', 214, 4, C.white); centered('NOTES REIMAGINED', 258, 2, C.white); break;
    case 5: r.vgrad(x0, y0, TW, TH, C.purple, C.blue); centered('DRIFTNOTE', 214, 4, mix(C.purple, C.white, 0.35)); break;
    case 6: T('CAPTURE', 30, 200, 5, C.fg); T('ORGANIZE', 16, 214, 5, C.accent); break;
    case 7:
      r.frame(x0 + 8, y0 + 8, TW - 16, TH - 16, 3, C.muted);
      T('V1.0', 18, 18, 2, C.label); T('2026', TW - 18 - r.textWidth('2026', 2), 18, 2, C.label);
      T('BETA', 18, TH - 32, 2, C.label); T('#01', TW - 18 - r.textWidth('#01', 2), TH - 32, 2, C.label);
      R(55, 190, 160, 100, C.card); centered('SYNC', 222, 5, C.fg); break;
    case 8: case 9: case 10: r.frame(x0 + 95, y0 + 210, 80, 60, 2, C.card); break;
    case 11:
      R(24, 206, 44, 44, C.accent); T('DRIFTNOTE', 80, 214, 3, C.fg);
      T('DRIFTNOTE.APP', TW - 10 - r.textWidth('DRIFTNOTE.APP', 1), TH - 14, 1, C.muted); break;
    default: break;
  }
}

export function renderSheet() {
  const cols = 6, rows = 2, gap = 12, pad = 16, titleH = 34, labelH = 34;
  const W = pad * 2 + cols * TW + (cols - 1) * gap;
  const H = pad * 2 + titleH + rows * (TH + labelH) + (rows - 1) * gap;
  const r = new Raster(W, H, C.sheet);
  r.text('DRIFTNOTE TEASER · 9X16 · 1 STILL PER BEAT · 120 BPM', pad, pad + 4, 2, C.label);
  for (let beat = 0; beat < cols * rows; beat++) {
    const x = pad + (beat % cols) * (TW + gap), y = pad + titleH + Math.floor(beat / cols) * (TH + labelH + gap);
    r.rect(x, y, TW, TH, C.bg);
    still(r, x, y, beat);
    const t = beat * 0.5, label = `00:0${Math.floor(t)}.${t % 1 ? '50' : '00'} · BEAT ${beat}`;
    r.text(label, x + 2, y + TH + 10, 2, C.label);
  }
  return { width: W, height: H, rgb: r.px };
}

// ---------- PNG encode / decode (8-bit RGB, non-interlaced) ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

export function encodePNG({ width, height, rgb }) {
  const stride = width * 3, out = Buffer.alloc((stride + 1) * height), cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride), up = y ? rgb.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {       // standard min-sum-of-abs heuristic, deterministic tie-break (lowest filter)
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0, b = up ? up[i] : 0, c = up && i >= 3 ? up[i - 3] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i] - pred) & 0xff; cand[f][i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    out[y * (stride + 1)] = best; cand[best].copy(out, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error('decodePNG supports 8-bit RGB non-interlaced only');
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 3, rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? rgb[y * stride + i - 3] : 0, b = y ? rgb[(y - 1) * stride + i] : 0, c = y && i >= 3 ? rgb[(y - 1) * stride + i - 3] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      rgb[y * stride + i] = (src[i] + pred) & 0xff;
    }
  }
  return { width, height, rgb };
}

export const pixelHash = ({ width, height, rgb }) => createHash('sha256').update(`${width}x${height}\n`).update(rgb).digest('hex');

async function cli(argv) {
  const usage = 'usage: node make-contact-sheet.mjs [--out PATH] [--check]\n  --out PATH  where to write the PNG (default fixtures/contact.png)\n  --check     compare the existing PNG with a fresh render; exit 1 if the pixels differ';
  let out = DEFAULT_OUT, check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { process.stdout.write(usage + '\n'); return 0; }
    else if (a === '--check') check = true;
    else if (a === '--out' && argv[i + 1]) out = resolve(argv[++i]);
    else if (a.startsWith('--out=')) out = resolve(a.slice(6));
    else { process.stderr.write(`unknown argument: ${a}\n${usage}\n`); return 2; }
  }
  const sheet = renderSheet();
  if (check) {
    const got = pixelHash(decodePNG(readFileSync(out))), want = pixelHash(sheet);
    process.stderr.write(`${out}: ${got === want ? 'OK' : 'MISMATCH'} (${readFileSync(out).length} bytes)\n`);
    return got === want ? 0 : 1;
  }
  const png = encodePNG(sheet);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  process.stderr.write(`wrote ${out} (${sheet.width}x${sheet.height}, ${png.length} bytes)\n`);
  return 0;
}

// Node realpaths the main module (import.meta.url) but leaves process.argv[1] as typed: compare real paths, or a run through
// a symlink or junction exits 0 without doing anything.
function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { let r = resolve(p); try { r = realpathSync.native(r); } catch { /* keep the resolved path */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return real(process.argv[1]) === real(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; });
}
