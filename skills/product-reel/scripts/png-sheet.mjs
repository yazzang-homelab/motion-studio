// Minimal PNG reader/writer and sprite-sheet helpers for canvas-frames.mjs (Node built-ins only, no ffmpeg, no native modules).
// Reads 8-bit non-interlaced PNGs (grey, grey+alpha, RGB, RGBA, palette: what browsers and common tools write) into RGBA and
// writes RGBA PNGs. Pixels are copied, never resampled: a packed frame is byte-identical to the captured one.
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * PNG bytes -> { width, height, data } with data = RGBA (Buffer, 4 bytes per pixel). Throws a readable error for what it does not
 * read: another signature, 16-bit or interlaced images, a truncated or corrupt stream.
 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let pos = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len || pos + 12 + len > buf.length) throw new Error('truncated PNG');
    if (buf.readUInt32BE(pos + 8 + len) !== crc32(buf.subarray(pos + 4, pos + 8 + len))) throw new Error(`corrupt PNG (bad checksum in ${type})`);
    if (type === 'IHDR') ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  const { width, height, depth, color, interlace } = ihdr;
  if (depth !== 8) throw new Error(`only 8-bit PNGs are supported, got ${depth}-bit`);
  if (interlace) throw new Error('interlaced PNGs are not supported');
  if (!CHANNELS[color]) throw new Error(`unsupported PNG color type ${color}`);
  if (!width || !height || width * height > 2 ** 28) throw new Error(`unsupported PNG size ${width}x${height}`);
  const bpp = CHANNELS[color];
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error('PNG pixel data has the wrong length');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y ? px[dst - stride + x] : 0;
      const c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (ft !== 0) throw new Error(`PNG row ${y} has an unknown filter ${ft}`);
      px[dst + x] = v & 0xff;
    }
  }
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * bpp;
    const d = i * 4;
    if (color === 6) { data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = px[s + 3]; }
    else if (color === 2) { data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = 255; }
    else if (color === 0) { data[d] = data[d + 1] = data[d + 2] = px[s]; data[d + 3] = 255; }
    else if (color === 4) { data[d] = data[d + 1] = data[d + 2] = px[s]; data[d + 3] = px[s + 1]; }
    else {
      if (!palette) throw new Error('palette PNG without PLTE');
      const k = px[s];
      data[d] = palette[k * 3]; data[d + 1] = palette[k * 3 + 1]; data[d + 2] = palette[k * 3 + 2]; data[d + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { width, height, data };
}

const chunk = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
};

/** RGBA pixels -> PNG bytes (8-bit RGBA, filter 0, deflate level 9: the same input always gives the same bytes). */
export function encodePng({ width, height, data }) {
  if (!(width > 0 && height > 0) || data.length !== width * height * 4) throw new Error('encodePng: pixel data does not match the size');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Rows needed for `n` frames in `cols` columns. */
export const sheetRows = (n, cols) => Math.max(1, Math.ceil(n / cols));

/** Top-left pixel of frame slot `i` in a sheet of `cols` columns and frames of fw x fh. */
export const slotOrigin = (i, cols, fw, fh) => ({ x: (i % cols) * fw, y: Math.floor(i / cols) * fh });

/**
 * A new sheet holding the frames `indices` (slot numbers of the source sheet) in that order, `cols` per row. Whole rows of pixels
 * are copied; unused slots stay transparent.
 * @param {{ width: number, height: number, data: Buffer }} sheet decoded source sheet
 * @param {{ cols: number, frame: [number, number], indices: number[], outCols?: number }} layout
 */
export function repackSheet(sheet, { cols, frame: [fw, fh], indices, outCols = cols }) {
  const slots = Math.floor(sheet.width / fw) >= cols ? cols * Math.floor(sheet.height / fh) : 0;
  const bad = indices.find((i) => !Number.isInteger(i) || i < 0 || i >= slots);
  if (bad !== undefined) throw new Error(`frame ${bad} is outside the source sheet (${slots} slots of ${fw}x${fh})`);
  const rows = sheetRows(indices.length, outCols);
  const out = { width: outCols * fw, height: rows * fh, data: Buffer.alloc(outCols * fw * rows * fh * 4) };
  indices.forEach((src, i) => {
    const s = slotOrigin(src, cols, fw, fh);
    const d = slotOrigin(i, outCols, fw, fh);
    for (let y = 0; y < fh; y++) sheet.data.copy(out.data, ((d.y + y) * out.width + d.x) * 4, ((s.y + y) * sheet.width + s.x) * 4, ((s.y + y) * sheet.width + s.x + fw) * 4);
  });
  return out;
}
