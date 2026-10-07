// Image type detection for capture.mjs downloads: by the file's first bytes, never by Content-Type or URL.

/**
 * Image type from the first bytes, never from Content-Type or the URL: servers label images wrongly (image/png for a
 * WebP, text/plain for an SVG, image/x-icon for a PNG favicon) and serve HTML error pages with a 200.
 * @returns {{ ext: string, type: string } | null}
 */
export function sniffImage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const at = (from, to) => b.toString('latin1', from, to);
  if (b.length >= 8 && b[0] === 0x89 && at(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { ext: '.png', type: 'image/png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: '.jpg', type: 'image/jpeg' };
  if (b.length >= 12 && at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return { ext: '.webp', type: 'image/webp' };
  if (b.length >= 6 && (at(0, 6) === 'GIF87a' || at(0, 6) === 'GIF89a')) return { ext: '.gif', type: 'image/gif' };
  if (b.length >= 12 && at(4, 8) === 'ftyp' && (at(8, 12) === 'avif' || at(8, 12) === 'avis')) return { ext: '.avif', type: 'image/avif' };
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b.readUInt16LE(4) >= 1 && b.readUInt16LE(4) <= 256) return { ext: '.ico', type: 'image/x-icon' };
  const head = b.toString('utf8', 0, 2048).replace(/^\uFEFF/, '');
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return { ext: '.svg', type: 'image/svg+xml' };
  return null;
}

/** data: URL -> { body, type }; extra parameters such as ";utf8" or ";charset=utf-8" are allowed. */
export function parseDataUrl(url) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!m) return null;
  try {
    return { type: m[1].toLowerCase(), body: /;base64$/i.test(m[2]) ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8') };
  } catch {
    return null; // malformed percent-escapes
  }
}

