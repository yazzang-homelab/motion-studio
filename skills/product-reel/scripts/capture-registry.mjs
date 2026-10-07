// The font registry report of capture.mjs: for every font family the page uses, say whether it is already registered in
// assets/fonts/fonts.json, with what license state, and what this capture added. A run never adds an UNVERIFIED entry without
// saying so, and a face that arrives next to a verified entry of the same family reuses that license (capture-fonts.mjs).
import { licenseState } from './capture-fonts.mjs';
import { redactUrl } from './capture-guard.mjs';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const GENERIC = new Set(['-apple-system', 'blinkmacsystemfont', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'sans-serif', 'serif', 'monospace',
  'cursive', 'fantasy', 'emoji', 'math', 'fangsong', 'inherit', 'initial']);

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** 'verified' | 'unverified' | 'mixed' for a set of fonts.json entries. */
export function licenseSummary(entries) {
  const states = new Set(entries.map(licenseState));
  return states.size === 2 ? 'mixed' : states.has('verified') ? 'verified' : 'unverified';
}

function describeLicense(entries) {
  const verified = entries.filter((e) => licenseState(e) === 'verified');
  const sum = licenseSummary(entries);
  if (sum === 'verified') return `license verified: ${[...new Set(verified.map((e) => e.license))].join(', ')} (${[...new Set(verified.map((e) => e.licenseFile))].join(', ')})`;
  if (sum === 'mixed') return `license verified for ${verified.length} of ${entries.length} entries, UNVERIFIED for the other ${entries.length - verified.length}`;
  return 'license UNVERIFIED (no license id with a license text file on record)';
}

/**
 * One row per family in use.
 * @param {object} o
 * @param {{ family: string, usedBy?: string[], loaded?: boolean }[]} o.families families the page uses (computed styles, the wordmark, loaded faces)
 * @param {string[]} o.webFonts family names the page declares with @font-face or has loaded (a family that is not here is an installed or system font)
 * @param {object[]} o.existing fonts.json entries as they were BEFORE this capture
 * @param {object[]} o.written files this capture saved and registered (registerFonts() result)
 * @param {object[]} o.skipped faces this capture did not register, with a reason (collectFonts() result)
 * @param {boolean} o.fontsEnabled false with --no-fonts
 * @returns {{ family: string, usedBy: string[], status: 'registered' | 'registered+added' | 'added' | 'not-registered' | 'system', license: string, registered: number, added: number, text: string }[]}
 */
export function fontRegistry({ families, webFonts = [], existing = [], written = [], skipped = [], fontsEnabled = true }) {
  const seen = new Set();
  const rows = [];
  for (const f of families) {
    const key = String(f.family).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const before = existing.filter((e) => same(e.family, f.family));
    const added = written.filter((w) => same(w.family, f.family));
    const usedBy = f.usedBy ?? [];
    const row = { family: f.family, usedBy, registered: before.length, added: added.length };
    if (before.length || added.length) {
      const reused = added.filter((w) => w.license?.source === 'fonts.json');
      const unverified = added.filter((w) => !w.licenseFile);
      const found = added.filter((w) => w.licenseFile && w.license?.source !== 'fonts.json');
      const parts = [
        reused.length && `${count(reused.length, 'face')} reuse the license already on record`,
        found.length && `${count(found.length, 'file')} with a license text copied next to the font (read it before use)`,
        unverified.length && `${count(unverified.length, 'file')} with license UNVERIFIED (no license found; record one with: node tools/fonts.mjs add-file ... --license-file <path|url>)`,
      ].filter(Boolean).join('; ');
      let license;
      if (before.length) {
        license = licenseSummary(before);
        if (unverified.length && license === 'verified') license = 'mixed';
      } else license = unverified.length ? 'unverified' : 'found';
      const text = !added.length ? `registered in assets/fonts/fonts.json (${count(before.length, 'entry', 'entries')}), ${describeLicense(before)}; this capture added nothing`
        : before.length ? `registered in assets/fonts/fonts.json (${count(before.length, 'entry', 'entries')}), ${describeLicense(before)}; this capture added ${count(added.length, 'face')}: ${parts}`
          : `NOT registered before; this capture added ${count(added.length, 'file')}: ${parts}`;
      rows.push({ ...row, status: before.length && added.length ? 'registered+added' : before.length ? 'registered' : 'added', license, text });
      continue;
    }
    const isWeb = (webFonts ?? []).some((w) => same(w, f.family));
    if (GENERIC.has(key) || !isWeb) {
      rows.push({ ...row, status: 'system', license: 'n/a', text: GENERIC.has(key) ? 'system or generic font stack, nothing to register' : 'no @font-face on the page: an installed or system font, nothing to register' });
      continue;
    }
    const why = skipped.find((s) => same(s.family, f.family))?.reason;
    rows.push({ ...row, status: 'not-registered', license: 'n/a', text: !fontsEnabled ? 'a web font, NOT registered (--no-fonts)' : `a web font, NOT registered${why ? ` (${why})` : ' (the face was not loaded or could not be downloaded)'}` });
  }
  return rows;
}

/** The families whose fonts.json state still needs a license decision. */
export const registryUnverified = (rows) => rows.filter((r) => ['unverified', 'mixed'].includes(r.license)).map((r) => r.family);

/** Console lines, one per family. */
export const registryLines = (rows) => rows.map((r) => `font registry: ${r.family}${r.usedBy.length ? ` (${r.usedBy.join(', ')})` : ''}: ${r.text}`);

/**
 * The wordmark as it may be stored and printed. `link` is the raw href of the link around it: relative values such as "/?token=..." are
 * not absolute URLs, so redactDeep() leaves them alone. The link keeps only the path (no query, no fragment: neither says anything about the
 * brand) and the html loses secret-looking query values in any attribute.
 */
export function safeWordmark(w) {
  if (!w) return w;
  const link = typeof w.link === 'string' ? redactUrl(w.link.replace(/[?#].*$/s, '')) : w.link ?? null;
  return { ...w, link, html: typeof w.html === 'string' ? redactUrl(w.html) : w.html ?? null };
}

/**
 * Everything capture.mjs says about the brand's type: the text wordmark record (null when a logo image or SVG exists), the font
 * registry rows for every family in use (computed styles, the wordmark, loaded faces) and the notes for the manifest.
 * @returns {{ wordmark: object | null, registry: object[], notes: string[] }}
 */
export function brandReport({ info, wordmarkCrop = null, existingFonts = [], fontsWritten = [], fontPlan = null, fontsEnabled = true }) {
  const wordmark = info.wordmark ? { ...safeWordmark(info.wordmark), crop: wordmarkCrop } : null;
  const byFamily = new Map();
  const add = (family, usedBy = [], loaded = false) => {
    const key = String(family).toLowerCase();
    const row = byFamily.get(key) ?? { family, usedBy: [], loaded: false };
    row.usedBy = [...new Set([...row.usedBy, ...usedBy])];
    row.loaded = row.loaded || !!loaded;
    byFamily.set(key, row);
  };
  for (const f of info.fonts.families) add(f.family, f.usedBy, f.loaded);
  if (wordmark) add(wordmark.font.family, ['wordmark'], wordmark.fontLoaded);
  for (const l of info.fonts.allLoaded) if (l.status === 'loaded') add(l.family);
  const registry = fontRegistry({
    families: [...byFamily.values()], existing: existingFonts, written: fontsWritten, skipped: fontPlan?.skipped ?? [], fontsEnabled,
    webFonts: [...info.fonts.rules.map((r) => r.family), ...info.fonts.allLoaded.map((l) => l.family)],
  });
  const notes = [];
  if (wordmark) {
    const row = registry.find((r) => r.family.toLowerCase() === String(wordmark.font.family).toLowerCase());
    wordmark.fontRegistry = row ? { status: row.status, license: row.license, text: row.text } : null;
    const colors = Object.entries(wordmark.colors).map(([k, v]) => `${k} ${v}`).join(', ');
    notes.push(`no logo image or SVG found; the brand is a text wordmark "${wordmark.text}"${wordmark.html ? ` (${wordmark.html})` : ''} in ${wordmark.font.family} ${wordmark.font.weight} ${wordmark.font.size}, ${colors}; recorded as text in the manifest under brand.wordmark${wordmarkCrop ? ` with a reference crop at ${wordmarkCrop}` : ''}. Rebuild it from that record (same font, same per-part colors, letter-spacing ${wordmark.font.letterSpacing}); ask the user for an SVG or PNG logo only if the film needs an exact lockup or a mark beyond the type`);
  }
  notes.push(...registryLines(registry));
  const open = registryUnverified(registry);
  if (open.length) notes.push(`font registry: license UNVERIFIED or mixed for ${open.join(', ')}; add no further entry for ${open.length === 1 ? 'it' : 'them'} until a license is recorded (node tools/fonts.mjs add-file ... --license-file <path|url>)`);
  return { wordmark, registry, notes };
}
