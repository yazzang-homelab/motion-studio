#!/usr/bin/env node
// Samples a canvas-driven UI over time: the "screen" of a site that is one <canvas> which changes on click and animates by itself.
//   capture   node canvas-frames.mjs <url> --canvas <selector> [--clip name=<click selector>]... [--seconds 3] [--step-ms 33] [--down 4]
//   pack      node canvas-frames.mjs pack [--dir assets/brand/frames] [--range name=first:count]...
// capture writes <dir>/<clip>.png (a sprite sheet: `cols` frames per row) and <dir>/frames.json (frame size, the real time of
// every frame, a hash per frame). pack keeps only the frames the film plays, in order, in smaller sheets (<dir>/pack/).
//
// Why a canvas copy and never an element screenshot: a canvas has a pixel buffer (cv.width x cv.height) that the page scales into
// a CSS box. A screenshot of that box captures the scaled result, and when the box is not a whole multiple of the buffer (a
// bordered `border-box` of 640 px whose 2 px border leaves 636 px of content for a 1280 px bitmap, so 1280 -> 1272 device px)
// the browser resamples it: a pixel-art canvas turns blurry and its edges cross-fade. drawImage(canvas -> sheet) with image
// smoothing OFF reads the buffer itself at an integer ratio (1:1 or an exact divisor such as 1280 -> 320), so every frame is the
// page's own pixels. A ratio that is not a whole number is refused instead of resampled.
//
// The sampling loop runs in the capture page (setTimeout against a fixed start time, so a slow frame does not shift later ones;
// the real time of each frame is stored), not in the film. The film reads the sheets by frame number.
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './capture.mjs';
import { UsageError, insideRoot, parseFlags, relTo, resolveRoot, usageText, writeFileAtomic } from './capture-cli.mjs';
import { escapeProblem, makeGuard, openBrowser, openPage } from './capture-session.mjs';
import { redactText } from './capture-guard.mjs';
import { assertClipName, packClips, parseRange } from './canvas-pack.mjs';
import { sheetRows } from './png-sheet.mjs';

const MAX_SIDE = 16384; // Chrome's canvas limit per side
const MAX_FRAMES = 3000;

export const SPEC = {
  root: { type: 'string', desc: 'project folder (default: nearest folder with studio.json, else the current folder)' },
  out: { type: 'string', default: 'assets/brand/frames', desc: 'output folder inside the project' },
  canvas: { type: 'string', desc: 'selector of the <canvas> (or of a box that contains it); Playwright selectors work' },
  clip: { type: 'list', desc: 'a clip to record: <name>=<selector to click> (click at t=0), or just <name> to sample without a click (repeatable)' },
  'before-each': { type: 'string', desc: 'selector clicked before every clip, so each clip starts from the same state' },
  'before-wait': { type: 'int', default: 1200, min: 0, max: 30000, desc: 'milliseconds to wait after the --before-each click' },
  probe: { type: 'string', desc: 'selector whose text is read with every frame (e.g. a breadcrumb that names the screen)' },
  seconds: { type: 'number', default: 3, min: 0.1, max: 120, desc: 'seconds recorded per clip' },
  'step-ms': { type: 'int', default: 33, min: 4, max: 1000, desc: 'milliseconds between frames (33 = about 30 per second)' },
  cols: { type: 'int', default: 10, min: 1, max: 64, desc: 'frames per sheet row' },
  frame: { type: 'string', desc: 'frame size WxH; must be the canvas buffer divided by a whole number (default: the buffer size)' },
  down: { type: 'int', default: 1, min: 1, max: 64, desc: 'whole-number divisor of the canvas buffer (1280x960 with --down 4 -> 320x240 frames)' },
  viewport: { type: 'string', default: 'desktop', desc: 'desktop, tablet or mobile' },
  dpr: { type: 'number', min: 0.5, max: 4, desc: 'device pixel ratio (default 2 on desktop, 3 on mobile); canvases that size their buffer to it need the same value as the page they were measured on' },
  locale: { type: 'string', desc: 'browser locale, e.g. ko-KR' },
  ready: { type: 'string', desc: 'selector to wait for (attached) before sampling' },
  settle: { type: 'number', default: 1.5, min: 0, desc: 'seconds to wait after load and after scrolling the canvas into view' },
  timeout: { type: 'number', default: 45, min: 1, desc: 'navigation timeout in seconds' },
  'allow-private': { type: 'boolean', desc: 'let the page reach loopback, LAN and link-local addresses (default: only the target host); pages you trust only' },
  'no-sandbox': { type: 'boolean', desc: "start Chrome without its renderer sandbox (also MOTION_NO_SANDBOX=1, automatic as root on Linux); pages you trust only" },
  'project-launcher': { type: 'boolean', desc: "start the browser with the project's tools/studio.mjs launchBrowser (sandbox OFF); pages you trust only" },
  help: { type: 'boolean', alias: 'h', desc: 'show this help' },
};
export const PACK_SPEC = {
  root: SPEC.root,
  dir: { type: 'string', default: 'assets/brand/frames', desc: 'folder holding frames.json and the clip sheets' },
  range: { type: 'list', desc: 'keep frames <first>..<first+count-1> of a clip: <clip>=<first>[:<count>] (repeatable; without it every clip is packed whole)' },
  'trim-lead': { type: 'boolean', desc: 'start each clip (without a --range) at the first frame that differs from frame 0' },
  cols: { type: 'int', min: 1, max: 64, desc: 'frames per row in the packed sheets (default: as captured)' },
  help: SPEC.help,
};

export function usage() {
  return [usageText(['Usage:',
    '  node canvas-frames.mjs <url> --canvas <selector> [--clip name=<click selector>]... [options]   sample the canvas into sprite sheets',
    '  node canvas-frames.mjs pack [--dir <folder>] [--range name=first:count]...                    keep only the frames the film plays', '',
    'Capture options:'], SPEC), '', usageText(['Pack options:'], PACK_SPEC)].join('\n');
}

/** `name=selector` or `name` -> { name, click }. A clip name is letters, digits, _ and - (not a Windows device name such as con or nul); the selector is everything after the first "=". */
export function parseClip(text) {
  const s = String(text);
  const eq = s.indexOf('=');
  const name = eq === -1 ? s : s.slice(0, eq);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new UsageError(`--clip "${s}": expected <name>=<selector>, where the name is letters, digits, _ or - (e.g. db=.tab[data-go="db"])`);
  assertClipName(name, `--clip "${s}": clip name`);
  const click = eq === -1 ? null : s.slice(eq + 1);
  if (eq !== -1 && !click) throw new UsageError(`--clip "${s}": the selector after "=" is empty`);
  return { name, click };
}

/** "320x240" -> [320, 240]. */
export function parseSize(text) {
  const m = /^(\d+)x(\d+)$/i.exec(String(text).trim());
  if (!m || !Number(m[1]) || !Number(m[2])) throw new UsageError(`--frame "${text}": expected WxH, e.g. 320x240`);
  return [Number(m[1]), Number(m[2])];
}

/**
 * The frame size for a canvas buffer: the buffer itself, `--down N` (buffer / N) or `--frame WxH`. The ratio must be a whole number on
 * both axes and the same on both: anything else would be resampled, which is exactly what this tool exists to avoid.
 * @returns {{ frame: [number, number], factor: number }} factor = how many canvas pixels become one frame pixel
 * @throws {UsageError}
 */
export function resolveFrame([bw, bh], { frame = null, down = 1 } = {}) {
  let size;
  if (frame) {
    if (down !== 1) throw new UsageError('use either --frame or --down, not both');
    size = parseSize(frame);
  } else {
    if (bw % down || bh % down) throw new UsageError(`--down ${down}: the canvas buffer is ${bw}x${bh} px, which is not a multiple of ${down} on both sides; pick a divisor of ${bw} and ${bh}`);
    size = [bw / down, bh / down];
  }
  const [fw, fh] = size;
  const fx = bw / fw;
  const fy = bh / fh;
  if (!Number.isInteger(fx) || !Number.isInteger(fy) || fx < 1 || fx !== fy) {
    throw new UsageError(`a ${fw}x${fh} frame is not a whole-number reduction of the ${bw}x${bh} canvas buffer (ratios ${+fx.toFixed(4)} and ${+fy.toFixed(4)}); that would resample the pixels. Use a size such as ${bw}x${bh}${bw % 2 === 0 && bh % 2 === 0 ? ` or ${bw / 2}x${bh / 2}` : ''}, or --down <divisor>`);
  }
  return { frame: [fw, fh], factor: fx };
}

/** Checks the sheet fits a canvas (Chrome: 16384 px per side) and the clip length is sane. */
export function sheetPlan({ seconds, stepMs, cols, frame: [fw, fh] }) {
  const count = Math.floor((seconds * 1000) / stepMs);
  if (count < 1) throw new UsageError('--seconds is shorter than one --step-ms');
  if (count > MAX_FRAMES) throw new UsageError(`${count} frames per clip is too many (limit ${MAX_FRAMES}); shorten --seconds or raise --step-ms`);
  const rows = sheetRows(count, cols);
  if (cols * fw > MAX_SIDE || rows * fh > MAX_SIDE) throw new UsageError(`a sheet of ${count} frames at ${cols} columns would be ${cols * fw}x${rows * fh} px, over the ${MAX_SIDE} px canvas limit; use fewer frames, a smaller --frame/--down, or a different --cols`);
  return { count, rows };
}

// ---- in the page ------------------------------------------------------------------------------------------------------

// Reads the canvas facts. Runs in the page; touches nothing.
function canvasInfoInPage(cv) {
  const r = cv.getBoundingClientRect();
  return { buffer: [cv.width, cv.height], dpr: window.devicePixelRatio, css: [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100], label: cv.getAttribute('aria-label') || null };
}

// Draws `count` frames of the canvas into one sheet, `stepMs` apart. Runs in the page. drawImage(canvas -> sheet) with smoothing off
// copies the canvas buffer (cv.width x cv.height) at an integer ratio; getBoundingClientRect and screenshots are never involved.
async function sampleInPage({ canvas, click, probe, count, stepMs, cols, fw, fh }) {
  const rows = Math.ceil(count / cols);
  const sheet = document.createElement('canvas');
  sheet.width = cols * fw;
  sheet.height = rows * fh;
  const sg = sheet.getContext('2d', { willReadFrequently: true });
  sg.imageSmoothingEnabled = false; // after the resize: setting width/height resets the context state
  const bw = canvas.width;
  const bh = canvas.height;
  const times = [];
  const hashes = [];
  const probes = [];
  let resized = 0;
  let blank = 0;
  let maxLag = 0;
  const t0 = performance.now();
  if (click) click.click();
  for (let i = 0; i < count; i++) {
    const due = t0 + i * stepMs;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    const x = (i % cols) * fw;
    const y = Math.floor(i / cols) * fh;
    if (canvas.width !== bw || canvas.height !== bh) resized++;
    sg.drawImage(canvas, 0, 0, canvas.width, canvas.height, x, y, fw, fh);
    const now = performance.now();
    times.push(Math.round(now - t0));
    maxLag = Math.max(maxLag, Math.round(now - due));
    const px = new Uint32Array(sg.getImageData(x, y, fw, fh).data.buffer);
    let h = 0x811c9dc5;
    let any = 0;
    for (let k = 0; k < px.length; k++) { h = Math.imul(h ^ px[k], 16777619) >>> 0; any |= px[k]; }
    hashes.push(h.toString(16).padStart(8, '0'));
    if (!any) blank++;
    if (probe) probes.push((probe.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120));
  }
  let png = null;
  let error = null;
  try { png = sheet.toDataURL('image/png'); } catch (e) { error = String((e && e.message) || e); }
  return { times, hashes, probes, resized, blank, maxLag, rows, png, error };
}

// ---- capture ----------------------------------------------------------------------------------------------------------

const msg = (e) => redactText(String((e && e.message) || e).split('\n')[0]);
const uniqueRuns = (list) => list.reduce((acc, v, i) => { if (!acc.length || acc[acc.length - 1].value !== v) acc.push({ value: v, from: i }); return acc; }, []);

/**
 * Records the canvas of `opts.url`. `opts`: { url, root, out (absolute), canvas, clips: [{name, click}], beforeEach, beforeWait, probe, seconds,
 * stepMs, cols, frame, down, viewport, dpr, locale, ready, settle, timeout, allowPrivate, noSandbox, projectLauncher, log }.
 * Writes <out>/<clip>.png and <out>/frames.json; returns the frames.json object. Throws when the canvas cannot be read exactly.
 */
export async function captureCanvasFrames(opts) {
  const { root, out, log = () => {} } = opts;
  const clips = opts.clips.length ? opts.clips : [{ name: 'live', click: null }];
  const names = new Set();
  for (const c of clips) { if (names.has(c.name)) throw new UsageError(`clip "${c.name}" is listed twice`); names.add(c.name); }
  const { target, guard } = makeGuard(opts.url, { allowPrivate: !!opts.allowPrivate });
  const notes = [];
  const { browser, via, sandbox, launcher } = await openBrowser(root, { noSandbox: !!opts.noSandbox, projectLauncher: !!opts.projectLauncher, log });
  await guard.protectBrowser(browser);
  let meta;
  try {
    const { context, page } = await openPage(browser, target, guard, { viewport: opts.viewport, dpr: opts.dpr, locale: opts.locale, timeout: opts.timeout, settle: opts.settle, notes });
    try {
      if (opts.ready) await page.locator(opts.ready).first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => notes.push(`--ready ${redactText(opts.ready)} never appeared; sampling anyway`));
      const box = page.locator(opts.canvas).first();
      await box.waitFor({ state: 'attached', timeout: 10000 }).catch(() => { throw new Error(`--canvas ${redactText(opts.canvas)}: nothing matched within 10 s`); });
      const handle = (await box.evaluateHandle((el) => (el.tagName === 'CANVAS' ? el : el.querySelector('canvas')))).asElement();
      if (!handle) throw new Error(`--canvas ${redactText(opts.canvas)}: the element is not a <canvas> and holds none`);
      await handle.scrollIntoViewIfNeeded().catch(() => {});
      if (opts.settle > 0) await page.waitForTimeout(opts.settle * 1000);
      const info = await handle.evaluate(canvasInfoInPage);
      const { frame, factor } = resolveFrame(info.buffer, { frame: opts.frame, down: opts.down });
      const { count, rows } = sheetPlan({ seconds: opts.seconds, stepMs: opts.stepMs, cols: opts.cols, frame });
      const ratio = (info.css[0] * info.dpr) / info.buffer[0]; // device pixels the page gives the canvas / buffer pixels it has
      const whole = (r) => Math.abs(r - Math.round(r)) < 0.005;
      if (!whole(ratio) && !whole(1 / ratio)) {
        notes.push(`the canvas is shown at ${info.css.join('x')} CSS px (${+(info.css[0] * info.dpr).toFixed(2)} device px) from a ${info.buffer.join('x')} px buffer, a ratio of ${+ratio.toFixed(4)}: an element screenshot would resample it, the buffer copies made here do not`);
      }
      fs.mkdirSync(out, { recursive: true });
      const probeHandle = opts.probe ? await page.locator(opts.probe).first().elementHandle({ timeout: 5000 }).catch(() => null) : null;
      if (opts.probe && !probeHandle) notes.push(`--probe ${redactText(opts.probe)}: nothing matched; no per-frame text recorded`);
      const result = {};
      for (const clip of clips) {
        if (opts.beforeEach) {
          await page.locator(opts.beforeEach).first().click({ timeout: 4000 }).catch((e) => { throw new Error(`--before-each ${redactText(opts.beforeEach)}: ${msg(e)}`); });
          await page.waitForTimeout(opts.beforeWait);
        }
        let clickHandle = null;
        if (clip.click) {
          const loc = page.locator(clip.click).first();
          await loc.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { throw new Error(`clip ${clip.name}: ${redactText(clip.click)} is not visible`); });
          clickHandle = await loc.elementHandle({ timeout: 4000 });
        }
        const r = await page.evaluate(sampleInPage, { canvas: handle, click: clickHandle, probe: probeHandle, count, stepMs: opts.stepMs, cols: opts.cols, fw: frame[0], fh: frame[1] });
        if (r.error || !r.png) throw new Error(`clip ${clip.name}: the canvas cannot be read back (${r.error ?? 'no data'}); a canvas that drew a cross-origin image without CORS is tainted`);
        if (r.resized) throw new Error(`clip ${clip.name}: the canvas changed its buffer size during sampling (${r.resized} frames); the frames would not share a scale. Fix the viewport/dpr so it stays fixed`);
        const file = path.join(out, `${clip.name}.png`);
        fs.writeFileSync(file, Buffer.from(r.png.split(',')[1], 'base64'));
        const distinct = new Set(r.hashes).size;
        if (distinct === 1) notes.push(`clip ${clip.name}: the canvas never changed in ${opts.seconds} s${r.blank === count ? ' and every frame is empty (a WebGL canvas without preserveDrawingBuffer reads back blank outside its draw call)' : ' (nothing animated, or the click did nothing)'}`);
        else if (r.blank) notes.push(`clip ${clip.name}: ${r.blank} of ${count} frames are fully transparent`);
        if (r.maxLag > opts.stepMs * 2) notes.push(`clip ${clip.name}: sampling fell behind by up to ${r.maxLag} ms (step ${opts.stepMs} ms); the real times are in frames.json, use them instead of the nominal step`);
        result[clip.name] = {
          file: relTo(root, file), click: clip.click, frames: count, rows: r.rows, times: r.times, hashes: r.hashes, distinct, blank: r.blank, maxLagMs: r.maxLag,
          firstChange: Math.max(0, r.hashes.findIndex((h) => h !== r.hashes[0])), label: await handle.evaluate((cv) => cv.getAttribute('aria-label')),
          ...(probeHandle ? { probe: uniqueRuns(r.probes).map((u) => ({ text: u.value, fromFrame: u.from })) } : {}),
        };
        log(`clip ${clip.name}: ${count} frames, ${distinct} distinct, ${frame.join('x')} px from a ${info.buffer.join('x')} buffer`);
      }
      const problem = await escapeProblem(guard, opts.viewport);
      if (problem) throw new Error(problem);
      meta = {
        version: 1, tool: 'motion-studio product-reel canvas-frames', url: target.display, capturedAt: new Date().toISOString(), browser: via, launcher, sandbox,
        viewport: opts.viewport, dpr: opts.dpr ?? null,
        canvas: { selector: redactText(opts.canvas), buffer: info.buffer, css: info.css, label: info.label },
        frame, scale: { mode: factor === 1 ? '1:1' : 'down', factor }, smoothing: false, stepMs: opts.stepMs, seconds: opts.seconds, cols: opts.cols, clips: result,
      };
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
  notes.push(...guard.notes());
  meta.blocked = guard.blocked.slice(0, 20);
  meta.notes = notes.map(redactText);
  writeFileAtomic(path.join(out, 'frames.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { ...meta, file: relTo(root, path.join(out, 'frames.json')) };
}

async function main(argv) {
  const first = argv[0];
  if (first === 'pack') {
    const { flags, positionals } = parseFlags(argv.slice(1), PACK_SPEC);
    if (flags.help) { process.stdout.write(`${usage()}\n`); return 0; }
    if (positionals.length) throw new UsageError(`unexpected argument "${positionals[0]}"`);
    const root = resolveRoot(flags.root);
    const dir = insideRoot(root, flags.dir, 'folder');
    const pack = packClips({ root, dir, ranges: flags.range.map(parseRange), outCols: flags.cols ?? null, trimLead: flags['trim-lead'] });
    for (const [name, c] of Object.entries(pack.clips)) process.stderr.write(`pack ${name}: frames ${c.first}..${c.first + c.n - 1} -> ${c.file} (${c.cols}x${c.rows} sheet, ${c.bytes} bytes)\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, pack: relTo(root, path.join(dir, 'pack', 'pack.json')), clips: Object.fromEntries(Object.entries(pack.clips).map(([k, c]) => [k, { first: c.first, n: c.n, file: c.file }])) })}\n`);
    return 0;
  }
  const { flags, positionals } = parseFlags(argv[0] === 'capture' ? argv.slice(1) : argv, SPEC);
  if (flags.help) { process.stdout.write(`${usage()}\n`); return 0; }
  if (positionals.length !== 1) throw new UsageError(positionals.length ? 'expected exactly one <url>' : 'missing <url>');
  if (!flags.canvas) throw new UsageError('--canvas <selector> is required');
  if (!['desktop', 'tablet', 'mobile'].includes(flags.viewport)) throw new UsageError('--viewport must be desktop, tablet or mobile');
  const root = resolveRoot(flags.root);
  const log = (line) => process.stderr.write(`${line}\n`);
  const r = await captureCanvasFrames({
    url: positionals[0], root, out: insideRoot(root, flags.out), canvas: flags.canvas, clips: flags.clip.map(parseClip), beforeEach: flags['before-each'], beforeWait: flags['before-wait'],
    probe: flags.probe, seconds: flags.seconds, stepMs: flags['step-ms'], cols: flags.cols, frame: flags.frame, down: flags.down, viewport: flags.viewport, dpr: flags.dpr,
    locale: flags.locale, ready: flags.ready, settle: flags.settle, timeout: flags.timeout, allowPrivate: flags['allow-private'], noSandbox: flags['no-sandbox'],
    projectLauncher: flags['project-launcher'], log,
  });
  for (const n of r.notes) log(`note: ${n}`);
  process.stdout.write(`${JSON.stringify({ ok: true, frames: r.file, frame: r.frame, scale: r.scale, clips: Object.fromEntries(Object.entries(r.clips).map(([k, c]) => [k, { file: c.file, frames: c.frames, distinct: c.distinct }])), via: r.browser, sandbox: r.sandbox, notes: r.notes })}\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    if (err instanceof UsageError) { process.stderr.write(`canvas-frames: ${err.message}\n\n${usage()}\n`); process.exitCode = 2; return; }
    process.stderr.write(`canvas-frames: ${redactText(err.message)}\n`);
    if (process.env.DEBUG) process.stderr.write(`${redactText(err.stack)}\n`);
    process.exitCode = 1;
  });
}
