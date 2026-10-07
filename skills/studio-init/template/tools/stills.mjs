// Stills straight from seek(t) (no video needed) and a labelled contact sheet rendered as a tiny HTML grid in the
// browser, so there is no ffmpeg drawtext/font dependency. captureStills + contactSheet are reused by critique.mjs.
import fs from 'node:fs';
import path from 'node:path';
import {
  FORMATS, UsageError, captureFrame, closeTimeoutMs, fmtTime, isMainModule, launchBrowser, loadConfig, log, main, openFilm, parseArgs,
  projectRoot, resolveFormats, settleWithin, startServer, usage, writeFileAtomic,
} from './studio.mjs';

/** Beat times inside [0, duration): measured grid beats when present, else the bpm/offset grid. */
export function beatTimes(grid, duration, cfg = {}) {
  const measured = Array.isArray(grid?.beats) ? grid.beats.filter((b) => Number.isFinite(b)) : [];
  if (measured.length) return measured.filter((b) => b >= 0 && b < duration - 1e-9).sort((a, b) => a - b);
  const bpm = grid?.bpm > 0 ? grid.bpm : cfg.bpm > 0 ? cfg.bpm : 120;
  const offset = Number.isFinite(grid?.offset) ? grid.offset : 0;
  const spb = 60 / bpm;
  const out = [];
  for (let n = Math.ceil((0 - offset) / spb - 1e-9); ; n++) {
    const t = offset + n * spb;
    if (t >= duration - 1e-9) break;
    if (t >= -1e-9) out.push(Math.max(0, t));
  }
  return out;
}

const shotAt = (shots, t) => {
  let hit = null;
  for (const s of shots) if (t >= s.from - 1e-9 && (t < s.to - 1e-9 || s === shots.at(-1))) hit = s;
  return hit;
};
const beatAt = (beats, t) => {
  let n = null;
  for (let i = 0; i < beats.length && beats[i] <= t + 1e-4; i++) n = i;
  return n;
};

/** Evenly thin a sorted list to at most max entries (keeps first and last). */
const thin = (list, max) => {
  if (!(max >= 1) || list.length <= max) return list;
  if (max === 1) return [list[0]];
  return Array.from({ length: max }, (_, k) => list[Math.round((k * (list.length - 1)) / (max - 1))]);
};

/**
 * Capture stills at `times` (array of seconds, or a function ({ meta, duration, fps, beats, shots, grid }) → seconds[]).
 * Times are snapped to the fps grid (so a still equals a video frame), sorted, de-duplicated; times outside
 * [0, duration] are dropped. Returns [{ t, png, label, beat, shot, format, width, height }].
 */
export async function captureStills(root, cfg, { format, times, width = 270, browser, serverUrl, sub = 1, shutter, max } = {}) {
  const fmt = format ?? cfg.primaryFormat;
  const F = FORMATS[fmt];
  if (!F) throw new UsageError(`unknown format "${fmt}" (valid: ${Object.keys(FORMATS).join(', ')})`);
  const scale = Math.min(1, Math.max(0.1, width / F.w));
  let server = null;
  let ownBrowser = null;
  let film = null;
  try {
    if (!serverUrl) { server = await startServer(root); serverUrl = server.url; }
    if (!browser) { ownBrowser = (await launchBrowser(root, cfg)).browser; browser = ownBrowser; }
    film = await openFilm(browser, serverUrl, { format: fmt, scale });
    const capture = cfg.capture === 'auto' ? (film.meta.capture === 'page' ? 'page' : 'canvas') : cfg.capture;
    const meta = { ...film.meta, capture };
    const duration = Number.isFinite(meta.duration) ? meta.duration : cfg.duration;
    const fps = Number.isFinite(meta.fps) && meta.fps > 0 ? meta.fps : cfg.fps;
    const info = await film.page.evaluate(() => ({
      shots: typeof window.__studio.shots === 'function' ? window.__studio.shots() : [],
      grid: window.__studio.grid ?? null,
    }));
    const shots = (Array.isArray(info.shots) ? info.shots : []).filter((s) => s && Number.isFinite(s.from) && Number.isFinite(s.to));
    const beats = beatTimes(info.grid, duration, cfg);
    const wanted = typeof times === 'function' ? await times({ meta, duration, fps, beats, shots, grid: info.grid }) : times;
    const snapped = [...new Set((wanted ?? []).map(Number).filter((t) => Number.isFinite(t) && t >= 0 && t <= duration + 1e-9)
      .map((t) => Math.min(duration, Math.round(t * fps) / fps)))].sort((a, b) => a - b);
    const list = thin(snapped, max);
    if (list.length < snapped.length) log(`[${fmt}] ${snapped.length} stills requested; thinned evenly to ${list.length} (--max)`);
    const items = [];
    for (const t of list) {
      const png = await captureFrame(film.page, meta, t, { sub, shutter: shutter ?? cfg.shutter, fps });
      if (film.errors.page.length) throw new Error(`page error while capturing t=${t}: ${film.errors.page[0]}`);
      const beat = beatAt(beats, t);
      const shot = shotAt(shots, t)?.name ?? null;
      const label = [fmtTime(t), beat === null ? null : `beat ${beat}`, shot ? `shot ${shot}` : null].filter(Boolean).join(' · ');
      items.push({ t, png, label, beat, shot, format: fmt, width: meta.width, height: meta.height });
    }
    return items;
  } finally {
    if (film) await settleWithin(film.context.close(), closeTimeoutMs());
    if (ownBrowser) await ownBrowser.close().catch(() => {});
    if (server) await server.close();
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Grid of data-URL <img> tiles with optional labels, screenshotted by the browser → PNG Buffer. */
export async function contactSheet(browser, items, { cols = 6, width = 270, title = '', gap = 6 } = {}) {
  if (!browser) throw new Error('contactSheet needs a launched browser');
  if (!items?.length) throw new Error('contactSheet: no stills to lay out');
  const c = Math.max(1, Math.min(cols, items.length));
  const pad = 10;
  const sheetW = pad * 2 + c * width + (c - 1) * gap;
  const tiles = items.map((it) => {
    const src = `data:image/png;base64,${Buffer.isBuffer(it.png) ? it.png.toString('base64') : String(it.png)}`;
    return `<figure><img src="${src}" width="${width}" alt="">${it.label ? `<figcaption>${esc(it.label)}</figcaption>` : ''}</figure>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#1b1b1a}
body{padding:${pad}px;width:${sheetW - pad * 2}px;font:12px/1.35 ui-monospace,"Cascadia Mono",Consolas,Menlo,"DejaVu Sans Mono",monospace;color:#d9d6cc}
h1{font-size:13px;font-weight:600;margin:0 0 8px;color:#f0eee6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
main{display:grid;grid-template-columns:repeat(${c},${width}px);gap:${gap}px;align-items:start}
figure{margin:0}img{display:block;width:${width}px;height:auto;background:#000}
figcaption{padding:3px 1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>${title ? `<h1>${esc(title)}</h1>` : ''}<main>${tiles}</main>`;
  const context = await browser.newContext({ viewport: { width: sheetW, height: 200 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 120000 });
    await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
    return await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled', timeout: 120000 });
  } finally {
    await settleWithin(context.close(), closeTimeoutMs());
  }
}

/** Pixel size of a PNG (Buffer or base64 string) from its IHDR chunk; null when it is not a PNG. */
export function pngSize(png) {
  const b = Buffer.isBuffer(png) ? png : Buffer.from(String(png).slice(0, 64), 'base64');
  return b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
}

/** Most tiles rows fit under maxHeight px (header, captions and gaps included), at least one. */
export function rowsPerSheet(items, { width = 270, maxHeight, gap = 6, title = '' } = {}) {
  const sizes = items.map((it) => pngSize(it.png)).filter(Boolean);
  if (!(maxHeight > 0) || !sizes.length) return Infinity;
  const tile = Math.ceil(Math.max(...sizes.map((s) => (width * s.h) / s.w)));
  const caption = items.some((it) => it.label) ? 20 : 0;
  const head = title ? 28 : 0;
  return Math.max(1, Math.floor((maxHeight - 20 - head + gap) / (tile + caption + gap)));
}

/** Longest side (px) of a sheet image the critic's viewer shows at full size: it shrinks anything past about 2000 px. */
export const SHEET_MAX_SIDE = 1990;
/** Default `--page-height`: whole tile rows that keep a page under this many px (SHEET_MAX_SIDE minus a safety margin). */
export const PAGE_HEIGHT = 1800;

/** Tiles per row (at most `cols`, at least 1) that keep a sheet of `width`-px tiles under `maxWide` px wide. */
export function fitCols(cols, width, { gap = 6, maxWide = SHEET_MAX_SIDE } = {}) {
  return Math.max(1, Math.min(Math.floor(cols) || 1, Math.floor((maxWide - 20 + gap) / (width + gap))));
}

/**
 * contactSheet split into pages of at most `maxHeight` px (default 1800; 0 = one tall sheet). The image viewer a critic
 * looks through shrinks anything taller than about 2000 px, so a 120-tile sheet 10 000 px tall is unreadable; pages keep
 * every tile at its real size. `cols` is lowered when that many tiles would make a page wider than SHEET_MAX_SIDE.
 * Returns [{ png, from, to, cols }] (tile index range, to exclusive); each page's header says which.
 */
export async function contactSheetPages(browser, items, { cols = 6, width = 270, title = '', gap = 6, maxHeight = PAGE_HEIGHT } = {}) {
  const c = fitCols(Math.min(cols, items.length), width, { gap });
  const rows = rowsPerSheet(items, { width, maxHeight, gap, title });
  const per = Number.isFinite(rows) ? rows * c : items.length;
  const pages = [];
  for (let a = 0; a < items.length; a += per) pages.push([a, Math.min(items.length, a + per)]);
  const out = [];
  for (const [i, [a, b]] of pages.entries()) {
    const head = pages.length > 1 ? `${title}${title ? ' · ' : ''}page ${i + 1}/${pages.length} · tiles ${a + 1}-${b}` : title;
    out.push({ png: await contactSheet(browser, items.slice(a, b), { cols: c, width, title: head, gap }), from: a, to: b, cols: c });
  }
  return out;
}

const SHEET_LOCKED = ['EPERM', 'EBUSY', 'EACCES'];
/** writeFileAtomic, but a file another program holds open (Windows) does not throw the captured sheet away: it is written beside it. */
export function writeSheet(file, data) {
  try { return writeFileAtomic(file, data); } catch (err) {
    if (!SHEET_LOCKED.includes(err.code)) throw err;
    const alt = file.replace(/(\.[^./\\]+)?$/, (ext) => `.new${ext}`);
    writeFileAtomic(alt, data);
    log(`warning: ${file} is open in another program (an image viewer?); wrote ${alt} instead`);
    return alt;
  }
}

/**
 * File of page n (1-based) of the sheet `out`: page 1 IS `out` (contact.png always exists), page n >= 2 is `<base>-<n><ext>`
 * (contact-2.png, contact-3.png ...). stills.mjs and critique.mjs share out/review/<fmt>/ and both follow this rule.
 */
export function sheetFile(out, n) {
  if (n <= 1) return out;
  const ext = path.extname(out);
  return `${out.slice(0, out.length - ext.length)}-${n}${ext}`;
}

/** Removes pages of an earlier run that this one no longer writes: `<base>-N.png` past the last page, and `<base>-1.png` (an earlier run named page 1 that way; page 1 is `<base>.png` now). */
export function clearStaleSheets(out, pages) {
  const ext = path.extname(out);
  const base = out.slice(0, out.length - ext.length);
  let entries = [];
  try { entries = fs.readdirSync(path.dirname(out)); } catch { return; }
  const quote = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${quote(path.basename(base))}-(\\d+)${quote(ext)}$`);
  for (const name of entries) {
    const m = re.exec(name);
    if (m && (Number(m[1]) === 1 || Number(m[1]) > Math.max(1, pages))) { try { fs.rmSync(path.join(path.dirname(out), name), { force: true }); } catch { /* in use: leave it */ } }
  }
}

/** Writes the pages of one sheet (page 1 as `out`, then `<base>-2` ...) and removes the stale pages of earlier runs. Returns the files written, in page order. */
export function writeSheetPages(out, pngs) {
  const files = pngs.map((png, i) => writeSheet(sheetFile(out, i + 1), png));
  clearStaleSheets(out, pngs.length);
  return files;
}

export const SPEC = {
  at: { type: 'list', of: 'number', arg: '<t,t,...>', desc: 'Still times in seconds' },
  every: { type: 'number', arg: '<sec>', desc: 'One still every S seconds' },
  beats: { type: 'boolean', desc: 'One still per beat (the default mode)' },
  shots: { type: 'boolean', desc: 'One still per shot midpoint' },
  from: { type: 'number', arg: '<sec>', desc: 'Keep only stills at or after this time (review one chapter at a time)' },
  to: { type: 'number', arg: '<sec>', desc: 'Keep only stills at or before this time' },
  format: { type: 'list', alias: 'f', arg: '<f|all|a,b>', desc: 'Format(s) (default: primaryFormat)' },
  width: { type: 'number', default: 270, desc: 'Tile width in px (stills render at that size, not downscaled)' },
  cols: { type: 'number', default: 6, desc: `Tiles per row (lowered so a page stays under ${SHEET_MAX_SIDE} px wide)` },
  label: { type: 'boolean', default: true, desc: 'Leave tiles unlabelled' },
  out: { type: 'string', arg: '<file.png>', desc: 'Contact sheet path (default out/review/<fmt>/contact.png; a paged sheet keeps page 1 at this name and writes <name>-2.png, <name>-3.png ...; pages of an earlier run are removed)' },
  'page-height': { type: 'number', default: PAGE_HEIGHT, arg: '<px>', desc: 'Most height of one sheet image (the image viewer shrinks anything past about 2000 px); taller sheets are split into pages of whole tile rows: contact.png, contact-2.png ... (0 = one tall sheet)' },
  'frames-dir': { type: 'string', arg: '<dir>', desc: 'Also write every still as its own PNG' },
  sub: { type: 'number', default: 1, desc: 'Motion-blur subframes per still' },
  max: { type: 'number', default: 120, desc: 'Most tiles per sheet; longer lists are thinned evenly' },
  json: { type: 'boolean', desc: 'Print one JSON result line on stdout' },
};

const TITLE = `Usage: node tools/stills.mjs [--at 0.5,2,4.2] [--every S] [--beats] [--shots] [options]

Capture stills from the live film (seek(t), no render needed) and lay them out as a labelled contact sheet
("00:04.20 · beat 8 · shot hook"). Modes combine; with none given, one still per beat.
No image is taller than --page-height (default ${PAGE_HEIGHT} px) or wider than ${SHEET_MAX_SIDE} px: a longer sheet is split into pages of whole rows,
page 1 is the --out file (contact.png), then contact-2.png, contact-3.png ... (the same rule as tools/critique.mjs); open every page.`;

async function cli(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC, { title: TITLE });
  if (flags.help) { process.stdout.write(usage(TITLE, SPEC)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument ${positionals[0]}`, usage(TITLE, SPEC));
  const intIn = (name, v, lo, hi) => { if (!(Number.isInteger(v) && v >= lo && v <= hi)) throw new UsageError(`--${name} must be an integer ${lo}-${hi} (got ${v})`); };
  intIn('width', flags.width, 16, 4096); intIn('cols', flags.cols, 1, 64); intIn('sub', flags.sub, 1, 64); intIn('max', flags.max, 1, 2000);
  if (flags.every !== undefined && flags.every !== null && !(flags.every > 0)) throw new UsageError(`--every must be > 0 (got ${flags.every})`);
  const has = (v) => v !== undefined && v !== null;
  if (has(flags.from) && !(flags.from >= 0)) throw new UsageError(`--from must be >= 0 (got ${flags.from})`);
  if (has(flags.to) && !(flags.to > (flags.from ?? 0))) throw new UsageError(`--to must be greater than ${has(flags.from) ? '--from' : '0'} (got ${flags.to})`);
  if (!(flags.pageHeight >= 0) || (flags.pageHeight > 0 && flags.pageHeight < 200)) throw new UsageError(`--page-height must be 0 (one tall sheet) or at least 200 px (got ${flags.pageHeight})`);
  const range = has(flags.from) || has(flags.to) ? [flags.from ?? 0, flags.to ?? Infinity] : null;
  const root = projectRoot();
  const cfg = loadConfig(root);
  const formats = resolveFormats(cfg, flags.format);
  if (flags.out && formats.length > 1) throw new UsageError('--out names one file; use it with a single --format');
  const useBeats = flags.beats || !(flags.at?.length || flags.every || flags.shots);
  const modes = [flags.at?.length && 'at', flags.every && `every ${flags.every}s`, useBeats && 'beats', flags.shots && 'shots'].filter(Boolean);
  const times = ({ duration, beats, shots }) => {
    const ts = [...(flags.at ?? [])];
    if (flags.every) for (let k = 0; k * flags.every < duration - 1e-9; k++) ts.push(k * flags.every);
    if (useBeats) ts.push(...beats);
    if (flags.shots) ts.push(...shots.map((s) => (s.from + s.to) / 2));
    return range ? ts.filter((t) => t >= range[0] - 1e-9 && t <= range[1] + 1e-9) : ts;
  };
  const server = await startServer(root);
  let browser = null;
  const results = [];
  try {
    browser = (await launchBrowser(root, cfg)).browser;
    for (const fmt of formats) {
      const items = await captureStills(root, cfg, { format: fmt, times, width: flags.width, browser, serverUrl: server.url, sub: flags.sub, max: flags.max });
      if (!items.length) throw new Error(`[${fmt}] no still times fall inside ${range ? `${range[0]}-${Number.isFinite(range[1]) ? range[1] : cfg.duration}` : `0-${cfg.duration}`} s`);
      if (!flags.label) for (const it of items) it.label = '';
      const title = `${cfg.title} · ${fmt} · ${items.length} stills (${modes.join(', ')})${range ? ` · ${fmtTime(range[0])}-${Number.isFinite(range[1]) ? fmtTime(range[1]) : 'end'}` : ''}`;
      const pages = await contactSheetPages(browser, items, { cols: flags.cols, width: flags.width, title: flags.label ? title : '', maxHeight: flags.pageHeight });
      const out = flags.out ? path.resolve(root, flags.out) : path.join(root, 'out', 'review', fmt, 'contact.png');
      const files = writeSheetPages(out, pages.map((p) => p.png));
      const stills = items.map((it, i) => ({ t: it.t, label: it.label, beat: it.beat, shot: it.shot, file: null, i }));
      if (flags.framesDir) {
        const dir = path.resolve(root, flags.framesDir);
        items.forEach((it, i) => {
          const file = path.join(dir, `${fmt}_${String(i).padStart(3, '0')}_${it.t.toFixed(2)}s.png`);
          writeFileAtomic(file, it.png);
          stills[i].file = file;
        });
      }
      log(`[${fmt}] ${items.length} stills -> ${files.length > 1 ? `${files.length} sheets ${path.relative(root, files[0])} ... ${path.basename(files.at(-1))}` : path.relative(root, files[0])}${flags.framesDir ? ` (+ PNGs in ${flags.framesDir})` : ''}`);
      // `contact` stays the first (or only) sheet; `contacts` lists every page in order.
      results.push({ format: fmt, contact: files[0], contacts: files, pages: files.length, width: flags.width, cols: pages[0].cols, stills: stills.map(({ i, ...s }) => s) });
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close();
  }
  if (flags.json) process.stdout.write(JSON.stringify({ ok: true, formats: results }) + '\n');
  return 0;
}

if (isMainModule(import.meta.url)) main(() => cli(process.argv.slice(2)));
