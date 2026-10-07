// Render the seek(t) film to H.264: W worker pages capture frames in parallel, a reorder buffer feeds ONE ffmpeg in
// order. Output is staged and only published (renamed) when every frame was encoded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  UsageError, captureFrame, closeTimeoutMs, ensureDir, ffmpeg, ffmpegSink, fmtTime, isMainModule, launchBrowser, loadConfig, log, main,
  openFilm, parseArgs, projectRoot, readJSON, renameWithRetry, resolveFormats, settleWithin, sha256, startServer, usage, writeFileAtomic,
  writeJSON,
} from './studio.mjs';

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'placebo'];
const cpuCount = () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
export const defaultWorkers = () => Math.min(4, Math.max(1, Math.floor(cpuCount() / 3)));

export const SPEC = {
  format: { type: 'list', alias: 'f', arg: '<f|all|a,b>', desc: 'Formats to render (default: primaryFormat)' },
  fps: { type: 'number', desc: 'Output frames per second (default: studio.json fps)' },
  sub: { type: 'number', desc: 'Motion-blur subframes per frame (default: studio.json subframes)' },
  shutter: { type: 'number', desc: 'Shutter as a fraction of one frame, 0-1 (default: studio.json shutter)' },
  from: { type: 'number', arg: '<sec>', desc: 'Start time; a partial range writes clip_<from>-<to>.mp4 (default 0)' },
  to: { type: 'number', arg: '<sec>', desc: 'End time (default: duration)' },
  scale: { type: 'number', desc: 'Resolution scale 0.1-1 (default 1)' },
  workers: { type: 'number', desc: `Parallel capture pages (default ${defaultWorkers()} on this machine)` },
  crf: { type: 'number', desc: 'x264 CRF (default: encode.crf; 23 with --draft)' },
  preset: { type: 'string', desc: 'x264 preset (default: encode.preset; encode.previewPreset with --draft)' },
  draft: { type: 'boolean', desc: 'Fast preview encode (previewPreset, CRF 23)' },
  chunk: { type: 'number', arg: '<sec>', desc: 'Resumable segments of this length, joined with concat (long films)' },
  out: { type: 'string', arg: '<dir>', default: 'out', desc: 'Output root; files go to <dir>/<format>/' },
  final: { type: 'boolean', desc: 'Final master: full range, scale 1, no draft; recorded in render.json' },
  poster: { type: 'boolean', default: true, desc: 'Skip poster.png (the previous cut\'s poster is removed, not left beside the new video)' },
  hash: { type: 'boolean', desc: 'Write frames.sha256 (index, t, sha256 of each frame PNG)' },
  json: { type: 'boolean', desc: 'Print one JSON result line on stdout' },
};

const TITLE = `Usage: node tools/render.mjs [options]

Render the film (index.html + film/film.js) to <out>/<format>/silent.mp4 with render.json, poster.png and
optionally frames.sha256. Capture runs in parallel pages; frames are encoded in order by one ffmpeg.`;

// Snap times to the output frame grid so a clip's frames are the very frames of the full render.
const snapToFrame = (x, fps) => Math.round(x * fps) / fps;
/** Time of frame k of a range starting at `from`: (frame index in the film) / fps, bit-identical to the full render's t. */
export const frameTime = (from, k, fps) => (Math.round(from * fps) + k) / fps;
const pad6 = (n) => String(n).padStart(6, '0');

/**
 * The frames a render covers, decided in whole frames (never by comparing seconds: 2 s at 29.97 fps is 60 frames = 2.002 s,
 * 1.3 s at 24 fps is 31 frames = 1.2917 s, and neither is a partial clip). `from`/`to` (seconds, either may be omitted)
 * are snapped to the frame grid. { from, to } are the snapped seconds, `frames` the count, `partial` is true only when the
 * range leaves out frames of the film, i.e. an explicit --from > 0 or --to before the last frame.
 */
export function frameRange(duration, fps, from, to) {
  const total = Math.max(1, Math.round(duration * fps));
  const f0 = Math.round(Math.max(0, from ?? 0) * fps);
  const f1 = Math.min(total, Math.round((to ?? duration) * fps));
  return { from: f0 / fps, to: f1 / fps, frames: f1 - f0, partial: f0 > 0 || f1 < total, total };
}

/** Longest wait for a file another program holds open when publishing (env MOTION_PUBLISH_WAIT_MS, default 30 s). */
export const publishWaitMs = () => (process.env.MOTION_PUBLISH_WAIT_MS !== undefined && Number.isFinite(Number(process.env.MOTION_PUBLISH_WAIT_MS)) ? Math.max(0, Number(process.env.MOTION_PUBLISH_WAIT_MS)) : 30000);

/**
 * Existing files that cannot be replaced right now. On Windows a rename onto itself fails (EBUSY/EPERM) exactly when another
 * program holds the file open without delete sharing, which is the case that also blocks publishing; elsewhere it is a no-op.
 */
export function lockedFiles(files) {
  return files.filter((f) => {
    if (!fs.existsSync(f)) return false;
    try { fs.renameSync(f, f); return false; } catch (err) { return ['EPERM', 'EBUSY', 'EACCES'].includes(err.code); }
  });
}

/**
 * Replaces published outputs with staged ones as ONE unit. entries: [{ to, from }] in publish order; `from` is a staged
 * file, or null to remove `to` (a stale poster or hash list of the previous render). Old files are first moved into
 * `backupDir`; only when every old file is out of the way do the new ones move in, so a file another program holds open
 * (Windows) fails the whole publish while nothing has changed yet. Any failure puts everything back and throws an Error
 * naming the file (`err.file`, `err.code`); the staged files are untouched. `onWait(file)` runs when a wait begins;
 * `rename` replaces fs.renameSync (tests).
 */
export function publishFiles(entries, { backupDir, waitMs = 30000, onWait, rename = fs.renameSync } = {}) {
  ensureDir(backupDir);
  const moved = [];
  const placed = [];
  const fail = (err, file, doing) => Object.assign(new Error(`cannot ${doing} ${file}: ${err.code ?? 'error'}: ${String(err.message).replace(/^[A-Z]+: /, '').split(', ')[0]}` +
    `${['EPERM', 'EBUSY', 'EACCES'].includes(err.code) ? ' (another program has it open: a video player or image viewer?)' : ''}`), { file, code: err.code });
  try {
    entries.forEach((e, i) => {
      if (!fs.existsSync(e.to)) return;
      const backup = path.join(backupDir, `${i}-${path.basename(e.to)}`);
      try { renameWithRetry(e.to, backup, { waitMs, onWait: () => onWait?.(e.to), rename }); } catch (err) { throw fail(err, e.to, 'replace'); }
      moved.push({ to: e.to, backup });
    });
    for (const e of entries) {
      if (!e.from) continue;
      ensureDir(path.dirname(e.to));
      try { renameWithRetry(e.from, e.to, { waitMs: Math.min(waitMs, 5000), rename }); } catch (err) { throw fail(err, e.to, 'write'); }
      placed.push(e);
    }
  } catch (err) {
    for (const p of placed.reverse()) { try { rename(p.to, p.from); } catch { /* stays published; the old file is restored below or reported */ } }
    for (const m of moved.reverse()) {
      try { renameWithRetry(m.backup, m.to, { waitMs: 2000, rename }); } catch (e2) { err.message += `\nCould not restore ${m.to}: the previous file is in ${m.backup} (${e2.message})`; }
    }
    throw err;
  }
}

/** ffmpeg arguments for PNG frames on stdin → bt709-tagged yuv420p H.264 (page capture adds the tmix/select blur). */
export function encodeArgs({ fps, sub = 1, capture = 'canvas', crf, preset, tune, out }) {
  const blend = capture === 'page' && sub > 1;
  const vf = [];
  // tmix averages SUB screenshots; select keeps the last frame of each aligned group (never framestep: wrong window).
  if (blend) vf.push(`tmix=frames=${sub}`, `select='eq(mod(n\\,${sub})\\,${sub - 1})'`, `setpts=N/${fps}/TB`);
  vf.push('pad=ceil(iw/2)*2:ceil(ih/2)*2', 'scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p');
  return ['-y', '-f', 'image2pipe', '-framerate', String(blend ? fps * sub : fps), '-c:v', 'png', '-i', '-',
    '-vf', vf.join(','), '-r', String(fps), '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    ...(tune ? ['-tune', tune] : []), '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709',
    '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', out];
}

/** Subframe times centred on t, matching the runtime's in-page accumulation (used by page capture). */
export const subTimes = (t, sub, shutter, fps) => Array.from({ length: sub }, (_, j) => (sub > 1 ? t + ((j + 0.5) / sub - 0.5) * shutter / fps : t));

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Worker pages that join as they finish booting: capture starts on the first page while the others spin up
 * (a Chromium renderer takes 1-5 s to start on Windows). listen(cb) gets (null, film) per late page or (err).
 */
export function filmPool(first, pending = []) {
  const pool = { ready: [first], all: [first], error: null, size: 1 + pending.length, listeners: new Set() };
  pool.settled = Promise.allSettled(pending.map((p) => p.then((film) => {
    pool.all.push(film);
    pool.ready.push(film);
    for (const l of pool.listeners) l(null, film);
  }, (err) => {
    pool.error ??= err;
    for (const l of pool.listeners) l(err);
  })));
  // Bounded: a page still booting (or a wedged browser) must not hold the teardown; browser.close() ends the rest.
  pool.close = async () => {
    await settleWithin(pool.settled, closeTimeoutMs());
    await Promise.all(pool.all.map((f) => settleWithin(f.context.close(), closeTimeoutMs())));
  };
  return pool;
}

/**
 * Frame dispenser + reorder buffer. Workers take indices in order, wait while they are more than `cap` frames ahead of
 * the writer, and the single writer streams frames to the sink strictly in order.
 */
export async function runPipeline({ pool, meta, fps, sub, shutter, from, startFrame = 0, count, sink, hashes, onWritten, abort }) {
  const cap = 4 * pool.size;
  const frameTimeout = Number(process.env.MOTION_FRAME_TIMEOUT_MS) || 120000;
  let next = 0;
  let written = 0;
  let failed = null;
  const slots = new Map();
  const capWaiters = [];
  const slot = (i) => {
    if (!slots.has(i)) {
      let resolve, reject;
      const p = new Promise((a, b) => { resolve = a; reject = b; });
      p.catch(() => {});
      slots.set(i, { p, resolve, reject });
    }
    return slots.get(i);
  };
  const wake = () => { for (const w of capWaiters.splice(0)) w(); };
  const fail = (err) => {
    if (failed) return;
    failed = err;
    for (const s of slots.values()) s.reject(err);
    wake();
    sink.kill();
  };
  if (abort) abort.fail = fail;

  const captureOne = async (film, t) => {
    if (meta.capture !== 'page') return captureFrame(film.page, meta, t, { sub, shutter, fps });
    const shots = [];
    for (const [j, ts] of subTimes(t, sub, shutter, fps).entries()) shots.push(await captureFrame(film.page, meta, ts, { blur: { frameT: t, sub: j, subs: sub } }));
    return shots;
  };
  const worker = async (film) => {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= count) return;
      while (!failed && i >= written + cap) await new Promise((r) => capWaiters.push(r));
      if (failed) return;
      const k = startFrame + i;
      const t = frameTime(from, k, fps);
      try {
        const data = await withTimeout(captureOne(film, t), frameTimeout, `frame ${k} (t=${t.toFixed(3)} s)`);
        if (film.errors.page.length) throw new Error(`page error: ${film.errors.page[0]}`);
        slot(i).resolve(data);
      } catch (err) {
        fail(new Error(`capture failed at frame ${k} (t=${t.toFixed(3)} s): ${String(err.message).split('\n').slice(0, 6).join('\n')}`));
        return;
      }
    }
  };
  const writer = async () => {
    for (let i = 0; i < count; i++) {
      const data = await slot(i).p;
      slots.delete(i);
      const bufs = Array.isArray(data) ? data : [data];
      for (const b of bufs) await sink.write(b);
      // Page capture blends in ffmpeg, so its frame hash covers the concatenated subframe screenshots.
      if (hashes) hashes.push(sha256(bufs.length === 1 ? bufs[0] : Buffer.concat(bufs)));
      written = i + 1;
      wake();
      onWritten?.(startFrame + written);
    }
  };
  const writing = writer().catch((err) => fail(err));
  const workers = pool.ready.map(worker);
  let finished = false;
  const join = (err, film) => { if (finished) return; if (err) fail(err); else workers.push(worker(film)); };
  pool.listeners.add(join);
  if (pool.error) fail(pool.error);
  try {
    await writing;
  } finally {
    finished = true;
    pool.listeners.delete(join);
  }
  if (failed) throw failed;
  await Promise.all(workers);
  await sink.end();
}

function progressReporter(fmt, total, fps) {
  const t0 = Date.now();
  let base = 0;
  let lastSecond = -1;
  return {
    skip(n) { base += n; },
    tick(done) {
      const second = Math.floor(done / fps);
      if (second === lastSecond && done !== total) return;
      lastSecond = second;
      const el = (Date.now() - t0) / 1000;
      const rate = (done - base) / Math.max(el, 1e-3);
      const eta = rate > 0 ? (total - done) / rate : NaN;
      log(`[${fmt}] ${fmtTime(done / fps)} / ${fmtTime(total / fps)}  frame ${done}/${total}  ${rate.toFixed(1)} fps` +
        `  ${rate > 0 ? (1000 / rate).toFixed(0) : '-'} ms/frame  ETA ${fmtTime(eta)}`);
    },
  };
}

function listFiles(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, acc); else if (e.isFile()) acc.push(p);
  }
  return acc;
}

/** Hash of every input that changes pixels, so resumed segments are only reused for the identical film and settings. */
function sourceFingerprint(root, settings) {
  const files = ['index.html', 'studio.json', 'audio/beats.json'].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f))
    .concat(...['film', 'lib', 'assets'].map((d) => listFiles(path.join(root, d))));
  const parts = [JSON.stringify(settings)];
  for (const f of files) parts.push(path.relative(root, f).replace(/\\/g, '/'), sha256(fs.readFileSync(f)));
  return sha256(parts.join('\n'));
}

async function renderFormat(ctx, fmt) {
  const { root, cfg, browser, server, opts } = ctx;
  const started = Date.now();
  const outFmt = path.join(opts.outBase, fmt);
  const n = Math.max(1, Math.min(opts.workers, opts.framesHint ?? opts.workers));
  const open = () => openFilm(browser, server.url, { format: fmt, scale: opts.scale });
  const first = await open();
  const pool = filmPool(first, Array.from({ length: n - 1 }, open));
  ctx.cleanup.push(() => pool.close());
  log(`[${fmt}] first page booted in ${((Date.now() - started) / 1000).toFixed(1)} s; ${n - 1} more joining`);
  const meta0 = first.meta;
  const capture = cfg.capture === 'auto' ? (meta0.capture === 'page' ? 'page' : 'canvas') : cfg.capture;
  const meta = { ...meta0, capture };
  const duration = Number.isFinite(meta.duration) ? meta.duration : cfg.duration;
  const fps = opts.fps;
  const { from, to, frames, partial } = frameRange(duration, fps, opts.from, opts.to);
  if (!(frames >= 1)) throw new UsageError(`empty range: --from ${opts.from ?? 0} --to ${opts.to ?? duration} gives ${frames} frames at ${fps} fps`);
  if (partial && opts.final) throw new UsageError('--final renders the whole film; drop --from/--to');
  const tag = partial ? `clip_${from.toFixed(2)}-${to.toFixed(2)}` : null;
  const names = partial
    ? { mp4: `${tag}.mp4`, json: `${tag}.json`, sha: `${tag}.sha256` }
    : { mp4: 'silent.mp4', json: 'render.json', sha: 'frames.sha256' };
  // A fresh staging directory: leftovers of a run whose publish failed (kept on purpose) must not leak into this one.
  const staging = path.join(outFmt, '.staging');
  fs.rmSync(staging, { recursive: true, force: true });
  ensureDir(staging);
  const staged = path.join(staging, names.mp4);
  const finalTargets = [names.mp4, names.json, names.sha, ...(partial ? [] : ['poster.png'])].map((name) => path.join(outFmt, name));
  for (const f of lockedFiles(finalTargets)) {
    log(`warning: ${path.relative(root, f)} is open in another program (a video player or image viewer?). Close it before this render ends: ` +
      `publishing waits ${Math.round(publishWaitMs() / 1000)} s for it, then keeps the finished render in ${path.relative(root, staging)}.`);
  }
  const enc = { fps, sub: opts.sub, capture, crf: opts.crf, preset: opts.preset, tune: opts.tune };
  const hashes = opts.hash || opts.chunk ? [] : null;
  const progress = progressReporter(fmt, frames, fps);
  log(`[${fmt}] ${meta.width}x${meta.height} @ ${fps} fps, sub ${opts.sub}, ${capture} capture, ${pool.size} worker page(s), ` +
    `${frames} frames (${fmtTime(from)}-${fmtTime(to)}), ${opts.preset}/crf ${opts.crf}${opts.draft ? ' draft' : ''}`);
  const common = { pool, meta, fps, sub: opts.sub, shutter: opts.shutter, from, onWritten: (d) => progress.tick(d), abort: ctx.abort };

  const captureStart = Date.now();
  let rendered = frames;
  if (!opts.chunk) {
    const sink = ffmpegSink(root, encodeArgs({ ...enc, out: staged }));
    ctx.sinks.add(sink);
    try { await runPipeline({ ...common, count: frames, sink, hashes }); } finally { ctx.sinks.delete(sink); }
  } else {
    const partsDir = ensureDir(path.join(outFmt, '.parts'));
    const settings = { fmt, fps, sub: opts.sub, shutter: opts.shutter, from, to, scale: opts.scale, capture, crf: opts.crf, preset: opts.preset,
      tune: opts.tune, width: meta.width, height: meta.height, browser: ctx.browserVersion };
    const fingerprint = sourceFingerprint(root, settings);
    const partsJson = path.join(partsDir, 'parts.json');
    if (readJSON(partsJson, null)?.fingerprint !== fingerprint) {
      const stale = fs.readdirSync(partsDir).filter((f) => f.startsWith('seg_'));
      if (stale.length) log(`[${fmt}] film sources or settings changed: discarding ${stale.length} old segment file(s)`);
      for (const f of stale) fs.rmSync(path.join(partsDir, f), { force: true });
      writeJSON(partsJson, { fingerprint, settings, createdBy: 'motion-studio' });
    }
    const segLen = Math.max(1, Math.round(opts.chunk * fps));
    const segs = [];
    for (let a = 0; a < frames; a += segLen) segs.push([a, Math.min(frames, a + segLen)]);
    for (const [a, b] of segs) {
      const base = `seg_${pad6(a)}_${pad6(b)}`;
      const mp4 = path.join(partsDir, `${base}.mp4`);
      const shaFile = path.join(partsDir, `${base}.sha256`);
      if (fs.existsSync(mp4) && fs.existsSync(shaFile)) {
        const segHashes = fs.readFileSync(shaFile, 'utf8').split('\n').filter(Boolean);
        if (segHashes.length === b - a) {
          hashes.push(...segHashes);
          progress.skip(b - a);
          rendered -= b - a;
          log(`[${fmt}] segment ${a}-${b} already rendered, reusing`);
          continue;
        }
      }
      const part = path.join(partsDir, `${base}.part.mp4`);
      const sink = ffmpegSink(root, encodeArgs({ ...enc, out: part }));
      ctx.sinks.add(sink);
      const segHashes = [];
      try { await runPipeline({ ...common, startFrame: a, count: b - a, sink, hashes: segHashes }); } finally { ctx.sinks.delete(sink); }
      writeFileAtomic(shaFile, segHashes.join('\n') + '\n');
      renameWithRetry(part, mp4);
      hashes.push(...segHashes);
    }
    const list = path.join(partsDir, 'concat.txt');
    fs.writeFileSync(list, segs.map(([a, b]) => `file 'seg_${pad6(a)}_${pad6(b)}.mp4'`).join('\n') + '\n');
    log(`[${fmt}] joining ${segs.length} segment(s)`);
    await ffmpeg(root, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', staged]);
  }

  const captureSeconds = (Date.now() - captureStart) / 1000;
  // Poster before publishing so a failure here leaves the previous outputs untouched. A crisp still (no blur).
  let poster = null;
  if (!partial && opts.poster) {
    const pt = Math.min(duration, Math.max(0, snapToFrame(cfg.poster ?? 0.35 * duration, fps)));
    poster = { t: pt, png: await captureFrame(first.page, meta, pt, { sub: 1, shutter: opts.shutter, fps }) };
  }
  const seconds = (Date.now() - started) / 1000;
  const file = path.join(outFmt, names.mp4);
  const shaPath = path.join(outFmt, names.sha);
  // Every output is written into staging first; publishing then replaces the previous set as one unit (see publishFiles).
  if (opts.hash) writeFileAtomic(path.join(staging, names.sha), hashes.map((h, i) => `${i} ${frameTime(from, i, fps).toFixed(6)} ${h}`).join('\n') + '\n');
  if (poster) fs.writeFileSync(path.join(staging, 'poster.png'), poster.png);
  const sidecar = {
    format: fmt, file: names.mp4, title: cfg.title, width: meta.width, height: meta.height,
    logicalWidth: meta.logicalWidth, logicalHeight: meta.logicalHeight, scale: opts.scale,
    fps, sub: opts.sub, shutter: opts.shutter, frames, from, to, duration: frames / fps, workers: pool.size,
    browser: ctx.browserVersion, via: ctx.via, capture,
    encode: { codec: 'libx264', crf: opts.crf, preset: opts.preset, tune: opts.tune || null, draft: !!opts.draft,
      pixFmt: 'yuv420p', colorspace: 'bt709', range: 'tv', ffmpeg: ctx.ffmpegVersion },
    chunk: opts.chunk ?? null, seconds: Number(seconds.toFixed(3)), captureSeconds: Number(captureSeconds.toFixed(3)),
    msPerFrame: rendered > 0 ? Number(((captureSeconds * 1000) / rendered).toFixed(1)) : null,
    final: !!opts.final, gate: ctx.gate ?? null, poster: poster ? 'poster.png' : null, posterTime: poster ? poster.t : null,
    hash: opts.hash ? names.sha : null, framesDigest: opts.hash ? sha256(hashes.join('\n')) : null,
    createdAt: new Date().toISOString(), createdBy: 'motion-studio',
  };
  writeJSON(path.join(staging, names.json), sidecar);
  // render.json is what mix/deliver trust, so it and the picture must always belong together. A full render also owns
  // poster.png and frames.sha256: without --no-poster / --hash the previous cut's file is removed, not left to ship.
  const plan = [
    { to: path.join(outFmt, names.json), from: path.join(staging, names.json) },
    { to: shaPath, from: opts.hash ? path.join(staging, names.sha) : null },
    ...(partial ? [] : [{ to: path.join(outFmt, 'poster.png'), from: poster ? path.join(staging, 'poster.png') : null }]),
    { to: file, from: staged }, // the picture last
  ];
  try {
    publishFiles(plan, {
      backupDir: path.join(staging, '.previous'),
      waitMs: publishWaitMs(),
      onWait: (f) => log(`[${fmt}] ${path.relative(root, f)} is open in another program; waiting up to ${Math.round(publishWaitMs() / 1000)} s for it (close the player or viewer)`),
    });
  } catch (err) {
    ctx.keep.add(staging); // the finished render survives the cleanup in render()
    throw new Error(`${err.message}\nThe finished render is kept in ${path.relative(root, staging)} (${path.basename(staged)}, ${path.basename(names.json)}${poster ? ', poster.png' : ''}); the previous outputs are unchanged. ` +
      'Close the program that has the file open and render again, or move the kept files over the old ones.');
  }
  fs.rmSync(staging, { recursive: true, force: true });
  log(`[${fmt}] wrote ${path.relative(root, file)} in ${fmtTime(seconds)} (capture+encode ${sidecar.msPerFrame ?? '-'} ms/frame over ${rendered} frames)`);
  await pool.close();
  return { format: fmt, file, frames, fps, seconds: sidecar.seconds, msPerFrame: sidecar.msPerFrame, partial,
    poster: poster ? path.join(outFmt, 'poster.png') : null, hashes: opts.hash ? shaPath : null,
    framesDigest: sidecar.framesDigest, renderJson: path.join(outFmt, names.json) };
}

function resolveOptions(flags, cfg) {
  const o = {
    fps: flags.fps ?? cfg.fps, sub: flags.sub ?? cfg.subframes, shutter: flags.shutter ?? cfg.shutter,
    from: flags.from ?? undefined, to: flags.to ?? undefined, scale: flags.scale ?? 1, workers: flags.workers ?? defaultWorkers(),
    draft: !!flags.draft, chunk: flags.chunk ?? null, final: !!flags.final, poster: flags.poster !== false, hash: !!flags.hash,
    tune: cfg.encode.tune || null,
  };
  o.crf = flags.crf ?? (o.draft ? 23 : cfg.encode.crf);
  o.preset = flags.preset ?? (o.draft ? cfg.encode.previewPreset : cfg.encode.preset);
  const bad = (m) => { throw new UsageError(m); };
  if (!(o.fps > 0 && o.fps <= 240)) bad(`--fps must be in (0, 240] (got ${o.fps})`);
  if (!(Number.isInteger(o.sub) && o.sub >= 1 && o.sub <= 64)) bad(`--sub must be an integer 1-64 (got ${o.sub})`);
  if (!(o.shutter >= 0 && o.shutter <= 1)) bad(`--shutter must be 0-1 (got ${o.shutter})`);
  if (!(o.scale >= 0.1 && o.scale <= 1)) bad(`--scale must be 0.1-1 (got ${o.scale})`);
  if (!(Number.isInteger(o.workers) && o.workers >= 1 && o.workers <= 32)) bad(`--workers must be an integer 1-32 (got ${o.workers})`);
  if (!(o.crf >= 0 && o.crf <= 51)) bad(`--crf must be 0-51 (got ${o.crf})`);
  if (!PRESETS.includes(o.preset)) bad(`--preset must be one of ${PRESETS.join(', ')} (got ${o.preset})`);
  if (o.chunk !== null && !(o.chunk > 0)) bad(`--chunk must be > 0 seconds (got ${o.chunk})`);
  if (o.from !== undefined && !(o.from >= 0)) bad(`--from must be >= 0 (got ${o.from})`);
  if (o.from !== undefined && o.to !== undefined && !(o.to > o.from)) bad(`--to must be greater than --from`);
  if (o.from !== undefined && o.from >= cfg.duration) bad(`--from ${o.from} is at or past the end of the film (${cfg.duration} s)`);
  if (o.final && o.draft) bad('--final and --draft cannot be combined');
  if (o.final && o.scale !== 1) bad('--final renders at scale 1; drop --scale');
  if (o.final && (o.from !== undefined || o.to !== undefined)) bad('--final renders the whole film; drop --from/--to');
  return o;
}

export async function render(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC, { title: TITLE });
  if (flags.help) { process.stdout.write(usage(TITLE, SPEC)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument ${positionals[0]}`, usage(TITLE, SPEC));
  const root = projectRoot();
  const cfg = loadConfig(root);
  const formats = resolveFormats(cfg, flags.format);
  const opts = resolveOptions(flags, cfg);
  opts.outBase = path.resolve(root, flags.out ?? 'out');
  opts.framesHint = Math.round(((opts.to ?? cfg.duration) - (opts.from ?? 0)) * opts.fps);

  const ctx = { root, cfg, opts, sinks: new Set(), cleanup: [], abort: {}, keep: new Set() };
  const onSigint = () => { for (const s of ctx.sinks) s.kill(); ctx.abort.fail?.(new Error('interrupted')); };
  process.once('SIGINT', onSigint);
  const results = [];
  try {
    ctx.ffmpegVersion = (/ffmpeg version (\S+)/.exec((await ffmpeg(root, ['-version'])).stdout) ?? [null, 'unknown'])[1];
    if (opts.final) {
      try {
        const { checkGate } = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate.mjs')).href);
        const g = checkGate(root, cfg);
        ctx.gate = { pass: !!g.pass, rounds: g.rounds ?? null };
        if (!g.pass) log(`warning: critique gate not passed (${(g.reasons ?? []).join('; ') || 'see node tools/gate.mjs'}); rendering anyway`);
      } catch (err) { if (!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(err?.code ?? err?.message))) log(`warning: gate check failed: ${err.message}`); }
    }
    const server = await startServer(root);
    ctx.server = server;
    ctx.cleanup.push(() => server.close());
    const { browser, via, version } = await launchBrowser(root, cfg);
    Object.assign(ctx, { browser, via, browserVersion: version });
    ctx.cleanup.push(() => browser.close().catch(() => {}));
    log(`browser: ${via} ${version}, ffmpeg ${ctx.ffmpegVersion}`);
    for (const fmt of formats) results.push(await renderFormat(ctx, fmt));
  } catch (err) {
    for (const s of ctx.sinks) s.kill();
    throw err; // main() prints the {"ok":false,"error":...} line with --json
  } finally {
    process.removeListener('SIGINT', onSigint);
    for (const fn of ctx.cleanup.reverse()) await fn();
    for (const fmt of formats) {
      const staging = path.join(opts.outBase, fmt, '.staging');
      // A staging directory holding a finished render that could not be published is the only copy of it: keep it.
      if (!ctx.keep.has(staging) && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  if (flags.json) process.stdout.write(JSON.stringify({ ok: true, formats: results }) + '\n');
  return 0;
}

if (isMainModule(import.meta.url)) main(() => render(process.argv.slice(2)));
