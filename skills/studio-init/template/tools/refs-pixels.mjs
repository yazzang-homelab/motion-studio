// Pixel helpers of tools/refs.mjs (which re-exports them): a PNG encoder/decoder, frame differences, image statistics and
// the OKLab k-means palette. Plain Node: no image library, no browser.
import zlib from 'node:zlib';

// PNG encoder (RGBA, 8-bit) so tiles and diff images need no image library.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Decode an 8-bit non-interlaced PNG (gray, gray+alpha, RGB, RGBA; what browsers write) → { width, height, data RGBA }. */
export function decodePNG(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let w = 0; let h = 0; let depth = 0; let ctype = 0; let interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (depth !== 8 || !ch || interlace) throw new Error(`unsupported PNG (bit depth ${depth}, color type ${ctype}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0;
      const b = y ? px[dst - stride + x] : 0;
      const c = x >= ch && y ? px[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  if (ch === 4) return { width: w, height: h, data: px };
  const out = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const s = p * ch;
    const [r, g, b, al] = ch === 3 ? [px[s], px[s + 1], px[s + 2], 255] : ch === 1 ? [px[s], px[s], px[s], 255] : [px[s], px[s], px[s], px[s + 1]];
    out[p * 4] = r; out[p * 4 + 1] = g; out[p * 4 + 2] = b; out[p * 4 + 3] = al;
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------------------------------------------
// Pixel statistics on RGBA buffers (exported for critique.mjs)

/** Decoded video carries codec noise (a keyframe shifts every pixel by a level or two); ignore that much per channel. */
export const VIDEO_NOISE = 3;

/**
 * Mean absolute RGB difference of two same-size RGBA buffers, in 0–255 levels. `floor` drops per-channel
 * differences up to that size (0 for exact canvas pixels, VIDEO_NOISE for decoded video).
 */
export function meanAbsDiff(a, b, floor = 0) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  if (!floor) {
    for (let i = 0; i < n; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  } else {
    for (let i = 0; i < n; i += 4) {
      for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]) - floor; if (d > 0) s += d; }
    }
  }
  return s / ((n / 4) * 3 || 1);
}

const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Mean luma (0–1), RMS contrast and share of pixels with a strong local gradient (edge density). */
export function imageStats(rgba, w, h) {
  const n = w * h;
  const L = new Float32Array(n);
  let sum = 0;
  for (let i = 0, p = 0; p < n; i += 4, p++) { L[p] = luma(rgba[i], rgba[i + 1], rgba[i + 2]); sum += L[p]; }
  const mean = sum / n;
  let v = 0;
  for (let p = 0; p < n; p++) v += (L[p] - mean) ** 2;
  let edges = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const p = y * w + x;
      if (Math.abs(L[p + 1] - L[p]) + Math.abs(L[p + w] - L[p]) > 0.25) edges++;
    }
  }
  return { brightness: mean, contrast: Math.sqrt(v / n), edgeShare: edges / Math.max(1, (w - 1) * (h - 1)) };
}

// OKLab k-means palette: deterministic (seeded k-means++), perceptual distances.
const SRGB_TO_LIN = new Float64Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
function toOklab(r, g, b) {
  const R = SRGB_TO_LIN[r]; const G = SRGB_TO_LIN[g]; const B = SRGB_TO_LIN[b];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return lin.map((c) => { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, v)) * 255); });
}
const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

function kmeansOnce(pts, K, seed, iterations) {
  const rnd = mulberry32(seed);
  const cents = [pts[Math.floor(rnd() * pts.length)]];
  const dist = new Float64Array(pts.length).fill(Infinity);
  while (cents.length < K) { // k-means++ seeding
    let sum = 0;
    const c = cents[cents.length - 1];
    for (let i = 0; i < pts.length; i++) { dist[i] = Math.min(dist[i], d2(pts[i], c)); sum += dist[i]; }
    if (sum === 0) break;
    let r = rnd() * sum;
    let pick = pts.length - 1;
    for (let i = 0; i < pts.length; i++) { r -= dist[i]; if (r <= 0) { pick = i; break; } }
    cents.push(pts[pick]);
  }
  const assign = new Int32Array(pts.length);
  let inertia = 0;
  for (let it = 0; it <= iterations; it++) {
    let moved = 0;
    inertia = 0;
    for (let i = 0; i < pts.length; i++) {
      let best = 0; let bd = Infinity;
      for (let c = 0; c < cents.length; c++) { const d = d2(pts[i], cents[c]); if (d < bd) { bd = d; best = c; } }
      inertia += bd;
      if (assign[i] !== best) { assign[i] = best; moved++; }
    }
    if ((it > 0 && moved === 0) || it === iterations) break;
    const acc = cents.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) { const a = acc[assign[i]]; a[0] += pts[i][0]; a[1] += pts[i][1]; a[2] += pts[i][2]; a[3]++; }
    for (let c = 0; c < cents.length; c++) if (acc[c][3]) cents[c] = [acc[c][0] / acc[c][3], acc[c][1] / acc[c][3], acc[c][2] / acc[c][3]];
  }
  return { cents, assign, inertia };
}

/** k-means (k=6 default, 4 seeded restarts, lowest inertia wins) over RGBA buffers → [{ hex, share }] by share. */
export function palette(buffers, { k = 6, maxPoints = 24000, iterations = 30, restarts = 4 } = {}) {
  let total = 0;
  for (const b of buffers) total += b.length / 4;
  const stride = Math.max(1, Math.floor(total / maxPoints));
  const pts = [];
  let idx = 0;
  for (const b of buffers) {
    for (let i = 0; i < b.length; i += 4, idx++) if (idx % stride === 0) pts.push(toOklab(b[i], b[i + 1], b[i + 2]));
  }
  if (!pts.length) return [];
  const K = Math.min(k, pts.length);
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const run1 = kmeansOnce(pts, K, 0x5eed + r * 7919, iterations);
    if (!best || run1.inertia < best.inertia) best = run1;
  }
  const counts = new Array(best.cents.length).fill(0);
  for (let i = 0; i < pts.length; i++) counts[best.assign[i]]++;
  return best.cents.map((c, i) => ({ hex: hex(fromOklab(c)), share: Math.round((counts[i] / pts.length) * 1000) / 1000 }))
    .filter((p) => p.share > 0).sort((a, b) => b.share - a.share || a.hex.localeCompare(b.hex));
}
