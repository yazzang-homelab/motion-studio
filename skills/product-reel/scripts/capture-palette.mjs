// Palette maths for capture.mjs: suggested bg, fg, accent and muted roles from color samples of the page.
// Palette maths in sRGB 0..255: close colors merge into the heavier one; roles are suggestions.
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const hex = (c) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
function lum(c) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function sat(c) {
  const mx = Math.max(...c.slice(0, 3)) / 255, mn = Math.min(...c.slice(0, 3)) / 255, l = (mx + mn) / 2;
  return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
}

export function buildPalette(samples, themeColor) {
  const clusters = [];
  for (const s of [...samples].sort((a, b) => b.w - a.w)) {
    const hit = clusters.find((c) => dist(c.rgb, s.rgb) < 12);
    if (hit) { hit.w += s.w; hit.by[s.kind] = (hit.by[s.kind] || 0) + s.w; } else clusters.push({ rgb: s.rgb, w: s.w, by: { [s.kind]: s.w } });
  }
  const total = clusters.reduce((a, c) => a + c.w, 0) || 1;
  const palette = clusters.slice(0, 10).map((c) => ({ hex: hex(c.rgb), share: +(c.w / total).toFixed(4), sources: Object.keys(c.by).sort() }));
  const byKind = (k) => clusters.filter((c) => c.by[k]).sort((a, b) => b.by[k] - a.by[k]);
  const bg = byKind('background')[0]?.rgb ?? [255, 255, 255];
  const texts = byKind('text');
  // Body copy is often a softer gray than headlines; the ink color is the frequent high-contrast one.
  const fg = texts.find((c) => contrast(c.rgb, bg) >= 7)?.rgb ?? texts.find((c) => contrast(c.rgb, bg) >= 4.5)?.rgb
    ?? texts[0]?.rgb ?? (lum(bg) > 0.4 ? [20, 20, 19] : [240, 238, 230]);
  const score = (c) => 3 * (c.by.interactive || 0) + (c.by.link || 0) * 2 + c.w * 0.25;
  const candidates = clusters.filter((c) => sat(c.rgb) >= 0.25 && lum(c.rgb) > 0.02 && lum(c.rgb) < 0.9 && dist(c.rgb, bg) > 40 && dist(c.rgb, fg) > 40);
  let accent = candidates.sort((a, b) => score(b) - score(a))[0]?.rgb ?? null;
  if (!accent && themeColor && sat(themeColor) >= 0.2) accent = themeColor;
  const muted = texts.find((c) => sat(c.rgb) < 0.2 && dist(c.rgb, fg) > 30 && dist(c.rgb, bg) > 30)?.rgb
    ?? fg.map((v, i) => v * 0.55 + bg[i] * 0.45);
  return { palette, suggested: { bg: hex(bg), fg: hex(fg), accent: accent ? hex(accent) : null, muted: hex(muted) } };
}

