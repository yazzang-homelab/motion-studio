// Glyph-fallback preflight of tools/critique.mjs: what the film draws, and whether the font registered for it has every glyph.
// The pages are opened with window.__TEXT_TRACK__ = true (lib/draw.js records every text()/kinetic()/textWidth() draw,
// window.__studio.textUse() hands the list over) and the coverage is measured next to the page's own fonts (lib/fonts.js
// glyphCoverage, reached through window.__studio.coverage). The verdict maths lives in critique-metrics.mjs (fontVerdict).
import { mergeTextUse, fontVerdict, fontsUnavailable } from './critique-metrics.mjs';

/**
 * A browser whose contexts set window.__TEXT_TRACK__ before any page script runs, so draw.js records every text() /
 * kinetic() / textWidth draw (window.__studio.textUse()). openFilm only needs browser.newContext.
 */
export function trackedBrowser(browser) {
  return {
    newContext: async (opts) => {
      const context = await browser.newContext(opts);
      try { await context.addInitScript(() => { window.__TEXT_TRACK__ = true; }); } catch (err) { await context.close().catch(() => {}); throw err; }
      return context;
    },
  };
}

/** What draw.js recorded on this page so far: { available: true, uses: [{ family, weight, style, chars }] } or { available: false, reason }. */
export async function readTextUse(page) {
  return page.evaluate(async () => {
    const S = window.__studio;
    if (!S || typeof S.textUse !== 'function') return { available: false, reason: 'window.__studio.textUse is not defined' };
    if (S.textTrack === false) return { available: false, reason: 'text tracking is off on this page (window.__TEXT_TRACK__ was not set before it loaded)' };
    try {
      const uses = await S.textUse();
      return Array.isArray(uses) ? { available: true, uses } : { available: false, reason: 'textUse() did not return an array' };
    } catch (err) { return { available: false, reason: `textUse() threw: ${String((err && err.message) || err).split('\n')[0]}` }; }
  });
}

// In-page half of the preflight: per font spec, the characters it cannot draw. Uses the page's own coverage check
// (window.__studio.coverage, else lib/fonts.js glyphCoverage: the rasterized check `node tools/fonts.mjs coverage` runs)
// after loading the faces those characters need (a sliced Hangul family loads only the slices a text touches).
async function pageGlyphCoverage(entries) {
  const S = window.__studio;
  const F = typeof S.coverage === 'function' ? null : await import('/lib/fonts.js');
  const bare = (s) => String(s).trim().replace(/^["']|["']$/g, '').toLowerCase();
  const registered = new Set();
  for (const face of document.fonts) registered.add(bare(face.family));
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont']);
  const label = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  const rows = [];
  for (const e of entries) {
    const chars = Array.from(e.chars);
    const row = { family: e.family, weight: e.weight, style: e.style, needed: chars.length, registered: true, reason: null, missing: [] };
    const key = bare(e.family);
    if (generic.has(key) || !registered.has(key)) {
      // Not a font the film bundles: every character is drawn by whatever this machine substitutes.
      row.registered = false;
      row.reason = generic.has(key) ? 'system' : 'unregistered';
      row.missing = chars.map((ch) => ({ ch, cp: label(ch), reason: 'fallback' }));
    } else {
      try { await document.fonts.load(`${e.style} ${e.weight} 64px "${e.family}"`, e.chars); } catch { /* glyphCoverage reports what is missing */ }
      if (F) row.missing = F.glyphCoverage([{ family: e.family, weight: e.weight, style: e.style }], e.chars).faces[0].missing;
      else row.missing = Array.from((await S.coverage(e.family, e.weight, e.style, e.chars)).missing).map((ch) => ({ ch, cp: label(ch), reason: 'fallback' }));
    }
    rows.push(row);
  }
  return rows;
}

/** Merge the pages' textUse() answers and measure coverage on `page` (any page of the film: it has the fonts loaded). */
export async function fontPreflight(page, sink) {
  const answers = sink.textUse.concat(sink.extra ?? []);
  const ok = answers.filter((a) => a?.available);
  if (!ok.length) return fontsUnavailable(answers.find((a) => a?.reason)?.reason ?? 'no page answered');
  const entries = mergeTextUse(ok.map((a) => a.uses));
  if (!entries.length) return { ...fontVerdict([]), note: 'the film drew no canvas text in the reviewed frames' };
  try {
    return fontVerdict(await page.evaluate(pageGlyphCoverage, entries));
  } catch (err) { return fontsUnavailable(`coverage check failed: ${String(err.message ?? err).split('\n')[0]}`); }
}
