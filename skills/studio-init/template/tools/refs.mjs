#!/usr/bin/env node
// Step 05 reference analysis: pull frames out of a reference video and measure its grammar (cuts, shot lengths,
// palette, brightness/contrast, motion energy, text density) so docs/style_guide.md starts from numbers.
// Also the home of the media helpers critique.mjs and deliver.mjs reuse (probe, loudness, raw frames, PNG).
//
//   node tools/refs.mjs extract <video> [--every 0.5] [--out refs/frames]
//   node tools/refs.mjs analyze <video|dir> [--json]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findProjectRoot, loadConfig, parseArgs, usage, main, UsageError, resolveFfmpeg, run, ffmpeg, ensureDir, launchBrowser,
  writeJSON, fmtTime, log, even } from './studio.mjs';
import { encodePNG, decodePNG, VIDEO_NOISE, meanAbsDiff, imageStats, palette } from './refs-pixels.mjs';
import { SILENCE, parseSilence, detectSilence, allowedSilence, judgeSilence, silenceLabel, audioGaps } from './refs-silence.mjs';

// The pixel helpers (PNG, differences, statistics, palette) live in refs-pixels.mjs and the silence check in refs-silence.mjs;
// both are re-exported here so every tool keeps importing them from refs.mjs.
export { encodePNG, decodePNG, VIDEO_NOISE, meanAbsDiff, imageStats, palette, SILENCE, parseSilence, detectSilence, allowedSilence, judgeSilence, silenceLabel, audioGaps };

// ---------------------------------------------------------------------------------------------------------------
// Media helpers (exported)

/** Parse `ffmpeg -i` stream info: duration, first video + audio stream. Throws when the file is not media. */
export async function probeMedia(root, file) {
  if (!fs.existsSync(file)) throw new Error(`not found: ${file}`);
  const r = await run(resolveFfmpeg(root), ['-hide_banner', '-i', file], { timeoutMs: 60000 });
  const err = r.stderr;
  if (!/Input #0/.test(err)) throw new Error(`ffmpeg cannot read ${file}:\n${err.split(/\r?\n/).filter(Boolean).slice(-5).join('\n')}`);
  const d = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const out = { file, duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null, video: null, audio: null };
  const vl = err.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*: Video:/.test(l) && !/attached pic/.test(l));
  if (vl) {
    const body = vl.slice(vl.indexOf('Video:') + 6);
    const size = body.match(/,\s*(\d{2,5})x(\d{2,5})/);
    const fps = body.match(/([\d.]+)\s*fps/) || body.match(/([\d.]+)\s*tbr/);
    const pix = body.match(/^\s*\w+[^,]*,\s*([a-z0-9_]+)(?:\(([^)]*)\))?/i);
    out.video = { codec: (body.match(/^\s*(\w+)/) || [])[1] || null, width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null,
      fps: fps ? Number(fps[1]) : null, pixFmt: pix ? pix[1] : null, colorInfo: pix && pix[2] ? pix[2] : null };
  }
  const al = err.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*: Audio:/.test(l));
  if (al) {
    const body = al.slice(al.indexOf('Audio:') + 6);
    const sr = body.match(/(\d+)\s*Hz/);
    const layout = body.match(/Hz,\s*([^,]+)/);
    const L = layout ? layout[1].trim() : null;
    const channels = L === 'mono' ? 1 : L === 'stereo' ? 2 : L && /(\d+)\s*channels/.test(L) ? Number(L.match(/(\d+)\s*channels/)[1]) : L && /^(\d)\.(\d)/.test(L) ? Number(L[0]) + Number(L[2]) : null;
    out.audio = { codec: (body.match(/^\s*(\w+)/) || [])[1] || null, sampleRate: sr ? Number(sr[1]) : null, layout: L, channels };
  }
  return out;
}

/**
 * Exact packet-level facts for the first video and audio stream via `-c copy -f framecrc` (one spawn, no decode):
 * { video: { packets, duration, start, end } | null, audio: {...} | null }. For H.264/AAC one packet = one frame.
 */
export async function streamStats(root, file, { audio = true } = {}) {
  const maps = ['-map', '0:v:0?'];
  if (audio) maps.push('-map', '0:a:0?');
  const r = await run(resolveFfmpeg(root), ['-hide_banner', '-loglevel', 'error', '-i', file, ...maps, '-c', 'copy', '-f', 'framecrc', '-'], { timeoutMs: 300000 });
  const tb = {};
  const kind = {};
  const acc = {};
  for (const line of String(r.stdout).split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^#tb (\d+):\s*(\d+)\/(\d+)/))) { tb[m[1]] = Number(m[2]) / Number(m[3]); continue; }
    if ((m = line.match(/^#media_type (\d+):\s*(\w+)/))) { kind[m[1]] = m[2]; continue; }
    if (!line || line.startsWith('#')) continue;
    const c = line.split(',').map((s) => s.trim());
    if (c.length < 4) continue;
    const pts = Number(c[2]);
    const dur = Number(c[3]);
    if (!Number.isFinite(pts)) continue;
    const a = (acc[c[0]] ??= { packets: 0, minPts: Infinity, end: -Infinity });
    a.packets++;
    a.minPts = Math.min(a.minPts, pts);
    a.end = Math.max(a.end, pts + (Number.isFinite(dur) ? dur : 0));
  }
  const out = { video: null, audio: null };
  for (const [idx, a] of Object.entries(acc)) {
    const k = kind[idx];
    const t = tb[idx];
    if (!t || (k !== 'video' && k !== 'audio') || out[k]) continue;
    const start = Math.max(0, a.minPts); // AAC priming packets carry negative pts and are dropped on decode
    out[k] = { packets: a.packets, timebase: t, start: start * t, end: a.end * t, duration: (a.end - start) * t };
  }
  return out;
}

// MP4 / MOV boxes (ISO-BMFF): only the headers and the moov box are read, never the media.
const TOP_BOXES = new Set(['ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'uuid', 'pdin', 'sidx', 'moof', 'mfra', 'meta', 'junk']);
function* mp4Boxes(buf, start, end) {
  for (let off = start; off + 8 <= end;) {
    let len = buf.readUInt32BE(off);
    let hdr = 8;
    if (len === 1) { if (off + 16 > end) return; len = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; } else if (len === 0) len = end - off;
    if (len < hdr || off + len > end) return;
    yield { type: buf.toString('latin1', off + 4, off + 8), start: off + hdr, end: off + len };
    off += len;
  }
}
const mp4Child = (buf, box, type) => { if (!box) return null; for (const b of mp4Boxes(buf, box.start, box.end)) if (b.type === type) return b; return null; };

function parseMoov(buf) {
  const root = { start: 0, end: buf.length };
  const mvhd = mp4Child(buf, root, 'mvhd');
  if (!mvhd) return null;
  const movieScale = buf.readUInt32BE(mvhd.start + (buf[mvhd.start] === 1 ? 20 : 12));
  const tracks = [];
  for (const trak of mp4Boxes(buf, root.start, root.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = mp4Child(buf, trak, 'mdia');
    const mdhd = mp4Child(buf, mdia, 'mdhd');
    const hdlr = mp4Child(buf, mdia, 'hdlr');
    if (!mdhd || !hdlr) continue;
    const v1 = buf[mdhd.start] === 1;
    const scale = buf.readUInt32BE(mdhd.start + (v1 ? 20 : 12));
    const media = v1 ? Number(buf.readBigUInt64BE(mdhd.start + 24)) : buf.readUInt32BE(mdhd.start + 16);
    const handler = buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);
    const track = { type: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : handler, timescale: scale,
      mediaDuration: scale && media ? media / scale : null, duration: scale && media ? media / scale : null, start: 0, edits: 0 };
    const elst = mp4Child(buf, mp4Child(buf, trak, 'edts'), 'elst');
    if (elst && movieScale) {
      const e1 = buf[elst.start] === 1;
      const size = e1 ? 20 : 12;
      let shown = 0;
      let delay = 0;
      for (let i = 0, q = elst.start + 8; i < buf.readUInt32BE(elst.start + 4) && q + size <= elst.end; i++, q += size) {
        const seg = e1 ? Number(buf.readBigUInt64BE(q)) : buf.readUInt32BE(q);
        const mediaTime = e1 ? Number(buf.readBigInt64BE(q + 8)) : buf.readInt32BE(q + 4);
        if (mediaTime === -1) { if (!shown) delay += seg; } else shown += seg; // an empty edit first = a start delay
        track.edits++;
      }
      if (shown > 0) { track.duration = shown / movieScale; track.start = delay / movieScale; }
    }
    tracks.push(track);
  }
  return { timescale: movieScale, tracks };
}

/**
 * Stream durations as the MP4/MOV container declares them (mdhd + the edit list), which is what ffprobe and players
 * report. The edit list trims AAC priming and padding: a 12.000 s AAC track holds 564 frames of 1,024 samples, decodes
 * to 576,512 samples after priming, and presents exactly 576,000. Reads the box headers and the moov box only.
 * @returns {{ video:{duration,mediaDuration,start}|null, audio:{duration,mediaDuration,start}|null, tracks:object[] }|null}
 *   null for a file that is not ISO-BMFF or has no readable moov (callers fall back to streamStats).
 */
export function mp4Durations(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    for (let off = 0, i = 0; off + 8 <= size && i < 256; i++) {
      fs.readSync(fd, head, 0, 16, off);
      let len = head.readUInt32BE(0);
      let hdr = 8;
      const type = head.toString('latin1', 4, 8);
      if (i === 0 && !TOP_BOXES.has(type)) return null;
      if (len === 1) { if (off + 16 > size) return null; len = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - off;
      if (len < hdr || off + len > size) return null;
      if (type === 'moov') {
        if (len - hdr > 64 * 1024 * 1024) return null;
        const buf = Buffer.alloc(len - hdr);
        fs.readSync(fd, buf, 0, buf.length, off + hdr);
        const m = parseMoov(buf);
        if (!m) return null;
        const pick = (kind) => {
          const t = m.tracks.find((x) => x.type === kind);
          return t ? { duration: t.duration > 0 ? t.duration : null, mediaDuration: t.mediaDuration, start: t.start } : null;
        };
        return { video: pick('video'), audio: pick('audio'), tracks: m.tracks };
      }
      off += len;
    }
    return null;
  } catch { return null; } finally { fs.closeSync(fd); }
}

/** EBU R128 integrated loudness, LRA and true peak (ebur128=peak=true) of the first audio stream. */
export async function measureLoudness(root, file) {
  const { stderr } = await ffmpeg(root, ['-nostats', '-i', file, '-map', '0:a:0', '-filter:a', 'ebur128=peak=true', '-f', 'null', '-'], { timeoutMs: 600000 });
  const at = stderr.lastIndexOf('Summary:');
  if (at < 0) throw new Error(`ebur128 printed no summary for ${file}`);
  const s = stderr.slice(at);
  const val = (re) => { const m = s.match(re); if (!m) return null; return /inf/i.test(m[1]) ? -Infinity : Number(m[1]); };
  return { I: val(/I:\s*(-?inf|-?[\d.]+)\s*LUFS/i), LRA: val(/LRA:\s*(-?inf|-?[\d.]+)\s*LU/i), TP: val(/Peak:\s*(-?inf|-?[\d.]+)\s*dBFS/i) };
}

/**
 * Decode the first video stream to RGBA frames of width×height and call onFrame(buf, index) for each.
 * `fps` resamples; `frames` (sorted indices of source frames) keeps only those frames. `scene` (0–1) also runs
 * ffmpeg scene detection in the same process (ffmpeg starts slowly on some machines, so passes are merged) and
 * resolves `cuts` (seconds).
 */
export function readFrames(root, file, { width, height, fps = null, frames = null, scene = null, onFrame } = {}) {
  const w = even(width);
  const h = even(height);
  const size = w * h * 4;
  const filters = [];
  if (frames && frames.length) filters.push(`select='${frames.map((n) => `eq(n\\,${n})`).join('+')}'`);
  if (fps) filters.push(`fps=${fps}`);
  filters.push(`scale=${w}:${h}:flags=area`, 'format=rgba');
  const raw = ['-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];
  const args = scene == null
    ? ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-an', '-sn', '-vf', filters.join(','), ...raw]
    : ['-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin', '-i', file, '-filter_complex',
      `[0:v:0]split=2[a][b];[a]${filters.join(',')}[o];[b]scale=320:-2,select='gt(scene\\,${scene})',showinfo,nullsink`,
      '-map', '[o]', ...raw];
  return new Promise((resolve, reject) => {
    const ff = spawn(resolveFfmpeg(root), args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let buf = Buffer.allocUnsafe(size);
    let fill = 0;
    let index = 0;
    let stderr = '';
    let pending = '';
    const cuts = [];
    let failed = null;
    ff.stderr.setEncoding('utf8');
    ff.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-6000);
      if (scene == null) return;
      pending += d;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const l of lines) { const m = l.match(/Parsed_showinfo.*?pts_time:\s*(-?[\d.]+)/); if (m) cuts.push(Math.round(Number(m[1]) * 1000) / 1000); }
    });
    ff.stdout.on('data', (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(size - fill, chunk.length - off);
        chunk.copy(buf, fill, off, off + n);
        fill += n;
        off += n;
        if (fill === size) {
          try { onFrame?.(buf, index++, { width: w, height: h }); } catch (err) { failed = err; ff.kill('SIGKILL'); return; }
          buf = Buffer.allocUnsafe(size);
          fill = 0;
        }
      }
    });
    ff.on('error', (e) => reject(new Error(`cannot start ffmpeg: ${e.message}`)));
    ff.on('close', (code) => {
      if (failed) return reject(failed);
      if (code !== 0) return reject(new Error(`ffmpeg frame decode failed (${code}): ${stderr.trim().split(/\r?\n/).slice(-6).join('\n')}`));
      const m = pending.match(/Parsed_showinfo.*?pts_time:\s*(-?[\d.]+)/);
      if (m) cuts.push(Math.round(Number(m[1]) * 1000) / 1000);
      resolve({ count: index, width: w, height: h, cuts: scene == null ? null : [...new Set(cuts)].sort((a, b) => a - b) });
    });
  });
}

/** Hard-cut times via ffmpeg scene detection (`select='gt(scene,T)',showinfo`). */
export async function detectCuts(root, file, { threshold = 0.3 } = {}) {
  const { stderr } = await ffmpeg(root, ['-nostats', '-i', file, '-map', '0:v:0', '-an', '-vf', `scale=320:-2,select='gt(scene\\,${threshold})',showinfo`, '-f', 'null', '-'], { timeoutMs: 600000 });
  const cuts = [];
  for (const m of stderr.matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*(-?[\d.]+)/g)) cuts.push(Number(m[1]));
  return [...new Set(cuts.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------------------
// Contact sheets: labelled via stills.mjs#contactSheet in a browser; unlabelled ffmpeg tile when no browser works.

export async function makeSheet({ root, cfg, browser = null, items, cols = 6, width = 270, title = '' }) {
  if (!items.length) throw new Error('no frames for the contact sheet');
  let owned = null;
  try {
    const stills = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'stills.mjs')).href);
    let b = browser;
    if (!b) {
      owned = (await launchBrowser(root, cfg ?? {})).browser;
      b = owned;
    }
    return { png: await stills.contactSheet(b, items, { cols, width, title }), labelled: true };
  } catch (err) {
    log(`contact sheet: browser path unavailable (${String(err.message).split('\n')[0]}); using unlabelled ffmpeg tile`);
  } finally {
    if (owned) await owned.close().catch(() => {});
  }
  return { png: await ffmpegTile(root, items, cols, width), labelled: false };
}

/** Unlabelled sheet of the tiles: ffmpeg `tile` filter (no browser, no fonts). */
async function ffmpegTile(root, items, cols, width) {
  const rows = Math.ceil(items.length / cols);
  const { stdout } = await ffmpeg(root, ['-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'png', '-i', '-',
    '-vf', `scale=${even(width)}:-2:flags=area,tile=${cols}x${rows}:padding=6:margin=6:color=0x141413`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'],
  { input: Buffer.concat(items.map((i) => i.png)), timeoutMs: 120000 });
  return stdout;
}

/**
 * makeSheet split into pages of whole tile rows of at most `maxHeight` px (see stills.mjs#contactSheetPages; the image
 * viewer a critic looks through shrinks anything taller than about 2000 px). Returns [{ png, from, to, labelled }] (tile
 * index range, to exclusive). Same fallback as makeSheet: without a working browser the pages are unlabelled ffmpeg tiles,
 * cut at the same row count (tile height from the first tile, no caption).
 */
export async function makeSheetPages({ root, cfg, browser = null, items, cols = 6, width = 270, title = '', maxHeight }) {
  if (!items.length) throw new Error('no frames for the contact sheet');
  const stills = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'stills.mjs')).href);
  maxHeight ??= stills.PAGE_HEIGHT;
  let owned = null;
  try {
    let b = browser;
    if (!b) {
      owned = (await launchBrowser(root, cfg ?? {})).browser;
      b = owned;
    }
    const pages = await stills.contactSheetPages(b, items, { cols, width, title, maxHeight });
    return pages.map((p) => ({ ...p, labelled: true }));
  } catch (err) {
    log(`contact sheet: browser path unavailable (${String(err.message).split('\n')[0]}); using unlabelled ffmpeg tile`);
  } finally {
    if (owned) await owned.close().catch(() => {});
  }
  const c = stills.fitCols(Math.min(cols, items.length), width);
  const rows = stills.rowsPerSheet(items.map((it) => ({ png: it.png })), { width, maxHeight, gap: 6 });
  const per = Number.isFinite(rows) ? rows * c : items.length;
  const out = [];
  for (let a = 0; a < items.length; a += per) {
    const part = items.slice(a, a + per);
    out.push({ png: await ffmpegTile(root, part, Math.min(c, part.length), width), from: a, to: a + part.length, labelled: false });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// extract / analyze

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);
const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sizeFor = (w, h, W) => ({ width: even(W), height: even((W * h) / w) });

export async function extractFrames(root, cfg, video, { every = 0.5, out } = {}) {
  if (!(every > 0)) throw new UsageError('--every must be > 0');
  const info = await probeMedia(root, video);
  if (!info.video) throw new Error(`${video} has no video stream`);
  ensureDir(out);
  for (const f of fs.readdirSync(out)) if (/^frame_\d+\.png$/.test(f)) fs.rmSync(path.join(out, f));
  await ffmpeg(root, ['-nostats', '-loglevel', 'error', '-i', video, '-map', '0:v:0', '-vf', `fps=1/${every}`, '-fps_mode', 'passthrough', '-start_number', '0', path.join(out, 'frame_%04d.png')], { timeoutMs: 600000 });
  const files = fs.readdirSync(out).filter((f) => /^frame_\d+\.png$/.test(f)).sort();
  if (!files.length) {
    // A clip shorter than the interval (or one with no decodable frame) samples nothing: say so instead of "extracted 0 frame(s)".
    const hint = round(Math.min(every, (info.duration || every) / 2), 3) || 0.1;
    throw new UsageError(`no frame was sampled from ${video}${info.duration != null ? ` (${round(info.duration, 3)} s long)` : ''} at --every ${every}: the clip is shorter than the interval, or it has no decodable frame. Try a smaller interval, for example --every ${hint}`);
  }
  const frames = files.map((f, i) => ({ file: f, t: round(i * every, 3) }));
  writeJSON(path.join(out, 'frames.json'), { source: video, every, count: frames.length, frames });
  // Contact sheet: up to 60 evenly spaced tiles, labelled with their time.
  const pickN = Math.min(60, frames.length);
  const picks = Array.from({ length: pickN }, (_, i) => frames[Math.round((i * (frames.length - 1)) / Math.max(1, pickN - 1))]);
  const landscape = info.video.width >= info.video.height;
  const items = picks.map((f) => ({ t: f.t, png: fs.readFileSync(path.join(out, f.file)), label: `${fmtTime(f.t)} · ${f.file}` }));
  // Paged like every other sheet (page 1 = contact.png, then contact-2.png ...: the critic's viewer shrinks anything past ~2000 px).
  const contact = path.join(path.dirname(out), 'contact.png');
  let sheets = [];
  let labelled = false;
  if (items.length) {
    const stills = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'stills.mjs')).href);
    const pages = await makeSheetPages({ root, cfg, items, cols: landscape ? 5 : 6, width: landscape ? 320 : 240, title: `reference · ${path.basename(video)} · every ${every}s` });
    sheets = stills.writeSheetPages(contact, pages.map((p) => p.png));
    labelled = pages.every((p) => p.labelled);
  }
  return { video, every, out, count: frames.length, contact: sheets[0] ?? null, contacts: sheets, labelled, duration: info.duration };
}

function textHint(edgeShare) {
  if (edgeShare >= 0.06) return 'text/UI-heavy (dense fine edges)';
  if (edgeShare >= 0.025) return 'mixed type and shapes';
  return 'shape/image-led (little fine detail)';
}

export async function analyzeVideo(root, video, { cutThreshold = 0.3 } = {}) {
  const info = await probeMedia(root, video);
  if (!info.video || !info.video.width) throw new Error(`${video} has no video stream`);
  // A container without a Duration line (a streamed or recorder-written webm/mkv) reports null: read the length from the
  // packet timestamps instead of treating the clip as 0 s long (that dropped every cut and every shot).
  let duration = Number.isFinite(info.duration) && info.duration > 0 ? info.duration : 0;
  let durationFrom = duration ? 'container' : null;
  if (!duration) {
    const st = await streamStats(root, video, { audio: false }).catch(() => null);
    if (st?.video?.duration > 0) { duration = st.video.duration; durationFrom = 'packets'; }
  }
  // One decode at 10 fps / 320 px: motion energy per second from consecutive frames, brightness/contrast/edges at
  // 2 fps, palette from ≤ 60 evenly spaced frames, and scene cuts from the same ffmpeg process.
  const size = sizeFor(info.video.width, info.video.height, 320);
  const perSec = [];
  const stats = [];
  let palBufs = [];
  let palEvery = Math.max(10, Math.ceil((duration * 10) / 60));
  let prev = null;
  let k = 0;
  const { cuts: rawCuts } = await readFrames(root, video, { ...size, fps: 10, scene: cutThreshold, onFrame: (buf, i, { width, height }) => {
    if (prev) { const s = Math.floor((k - 0.5) / 10); (perSec[s] ??= []).push(meanAbsDiff(prev, buf, VIDEO_NOISE)); }
    if (i % 5 === 0) stats.push(imageStats(buf, width, height));
    if (i % palEvery === 0) {
      palBufs.push(buf);
      if (palBufs.length > 60) { palBufs = palBufs.filter((_, j) => j % 2 === 0); palEvery *= 2; } // length unknown: stay bounded
    }
    prev = buf; k++;
  } });
  if (k < 2) {
    throw new UsageError(`${video}: ${k} frame(s) decoded at 10 fps, too few to measure cuts, motion or shot length. It is a single image or a clip shorter than 0.2 s${info.duration != null ? ` (${round(info.duration, 3)} s)` : ''}: pass a real video, or a folder of images (or one image file) for a still-image look.`);
  }
  if (!duration) { duration = Math.max(k / 10, ...(rawCuts ?? [])); durationFrom = 'decoded frames'; }
  const motion = Array.from({ length: Math.max(perSec.length, Math.ceil(duration)) }, (_, s) => round(perSec[s]?.length ? perSec[s].reduce((a, b) => a + b, 0) / perSec[s].length : 0, 2));
  const cuts = rawCuts ?? [];
  const bounds = [0, ...cuts.filter((t) => t > 0.05 && t < duration - 0.05), duration];
  const lengths = bounds.slice(1).map((t, i) => round(t - bounds[i], 3)).filter((x) => x > 0);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const edge = mean(stats.map((s) => s.edgeShare)) ?? 0;
  const peak = motion.reduce((best, v, i) => (v > motion[best] ? i : best), 0);
  return {
    version: 1, createdBy: 'motion-studio', tool: 'refs', kind: 'video', source: video,
    duration: round(duration, 3), durationFrom, fps: info.video.fps, width: info.video.width, height: info.video.height, audio: !!info.audio,
    cuts, cutThreshold,
    shots: { count: lengths.length, mean: round(mean(lengths), 3), median: round(median(lengths), 3), min: round(Math.min(...lengths), 3), max: round(Math.max(...lengths), 3), lengths },
    palette: palette(palBufs),
    brightness: { mean: round(mean(stats.map((s) => s.brightness))), min: round(Math.min(...stats.map((s) => s.brightness))), max: round(Math.max(...stats.map((s) => s.brightness))) },
    contrast: { mean: round(mean(stats.map((s) => s.contrast))) },
    motion: { unit: 'mean abs RGB diff between frames 0.1 s apart at 320 px (0-255)', perSecond: motion, mean: round(mean(motion), 2), peakSecond: motion.length ? peak : null },
    text: { edgeShare: round(edge, 4), hint: textHint(edge), heuristic: true },
    samples: { motionFrames: k, statFrames: stats.length },
  };
}

export async function analyzeImages(root, input) {
  // A folder of images, or one image file: a still has no cuts, motion or shot length, so it is judged as a one-image set.
  const single = !fs.statSync(input).isDirectory();
  const dir = single ? path.dirname(input) : input;
  const files = single ? [path.basename(input)] : fs.readdirSync(dir).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())).sort();
  if (!files.length) throw new Error(`no images (${[...IMAGE_EXT].join(' ')}) in ${dir}`);
  const per = [];
  const palBufs = [];
  for (const f of files) {
    const p = path.join(dir, f);
    const info = await probeMedia(root, p);
    if (!info.video?.width) continue;
    const sz = sizeFor(info.video.width, info.video.height, 320);
    await readFrames(root, p, { ...sz, onFrame: (buf, i, { width, height }) => {
      if (i) return;
      const s = imageStats(buf, width, height);
      per.push({ file: f, width: info.video.width, height: info.video.height, brightness: round(s.brightness), contrast: round(s.contrast), edgeShare: round(s.edgeShare, 4), palette: palette([buf], { k: 4 }) });
      palBufs.push(buf);
    } });
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const edge = mean(per.map((p) => p.edgeShare)) ?? 0;
  return {
    version: 1, createdBy: 'motion-studio', tool: 'refs', kind: 'images', source: input, count: per.length,
    palette: palette(palBufs),
    brightness: { mean: round(mean(per.map((p) => p.brightness))) }, contrast: { mean: round(mean(per.map((p) => p.contrast))) },
    text: { edgeShare: round(edge, 4), hint: textHint(edge), heuristic: true },
    images: per,
  };
}

export function summaryMarkdown(a) {
  const lines = [`## Reference analysis (tools/refs.mjs) · ${path.basename(a.source)}`];
  if (a.kind === 'video') {
    lines.push(`- Length ${a.duration} s${a.durationFrom && a.durationFrom !== 'container' ? ` (the container has no Duration; measured from ${a.durationFrom})` : ''} · ${a.width}x${a.height} · ${a.fps ?? '?'} fps · audio ${a.audio ? 'yes' : 'no'}`);
    lines.push(`- Cuts: ${a.cuts.length} (scene > ${a.cutThreshold})${a.cuts.length ? ` at ${a.cuts.slice(0, 12).map((t) => t.toFixed(2)).join(', ')}${a.cuts.length > 12 ? ', …' : ''} s` : ''}`);
    lines.push(`- Shot length: mean ${a.shots.mean} s · median ${a.shots.median} s · range ${a.shots.min}–${a.shots.max} s over ${a.shots.count} shot(s)`);
    const bars = ' .:-=+*#%@';
    const mx = Math.max(1e-9, ...a.motion.perSecond);
    lines.push(`- Motion energy per second (0–255 levels): mean ${a.motion.mean}, peak at ${a.motion.peakSecond} s  [${a.motion.perSecond.map((v) => bars[Math.min(9, Math.round((v / mx) * 9))]).join('')}]`);
  } else lines.push(`- ${a.count} image(s) in ${a.source}`);
  lines.push(`- Palette (share): ${a.palette.map((p) => `${p.hex} ${Math.round(p.share * 100)}%`).join(' · ')}`);
  lines.push(`- Brightness ${a.brightness.mean} (0 black – 1 white) · RMS contrast ${a.contrast.mean} → ${a.brightness.mean < 0.35 ? 'dark' : a.brightness.mean > 0.65 ? 'light' : 'mid-tone'} look`);
  lines.push(`- Text density: ${a.text.hint} (edge share ${a.text.edgeShare}; heuristic)`);
  lines.push('- Take the grammar (pacing, type, transitions), never the content, logos or characters.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const SPEC = {
  every: { type: 'number', default: 0.5, desc: 'extract: seconds between frames' },
  out: { type: 'string', desc: 'extract: frames folder (default refs/frames); analyze: JSON path (default refs/analysis.json)' },
  threshold: { type: 'number', default: 0.3, desc: 'analyze: scene-cut threshold (0–1)' },
  json: { type: 'boolean', desc: 'print one JSON result line on stdout' },
};
const TITLE = 'Usage: node tools/refs.mjs extract <video> [--every 0.5] [--out refs/frames]\n       node tools/refs.mjs analyze <video|folder|image> [--json]';
const EXTRA = 'extract writes refs/frames/frame_NNNN.png + frames.json and refs/contact.png (a tall sheet is paged: contact-2.png, contact-3.png ...; open every page).\nanalyze writes refs/analysis.json (cuts, shot lengths, palette, brightness/contrast, motion, text hint)\nand prints a summary to paste into docs/style_guide.md.\nA container without a Duration (a streamed webm/mkv) is measured from its packets. An image file or a folder of images gets\npalette, brightness, contrast and text density only. A single-frame clip, or extract on a clip shorter than --every, exits 2 with the reason.';

async function cli() {
  const { flags, positionals } = parseArgs(process.argv.slice(2), SPEC, { title: TITLE });
  if (flags.help) { process.stdout.write(usage(TITLE, SPEC, EXTRA)); return 0; }
  const [cmd, target, ...rest] = positionals;
  if (!cmd || !['extract', 'analyze'].includes(cmd)) throw new UsageError(cmd ? `unknown command "${cmd}" (extract | analyze)` : 'missing command (extract | analyze)', usage(TITLE, SPEC, EXTRA));
  if (!target) throw new UsageError(`${cmd} needs a ${cmd === 'extract' ? 'video' : 'video or folder'} path`, usage(TITLE, SPEC, EXTRA));
  if (rest.length) throw new UsageError(`unexpected argument "${rest[0]}"`, usage(TITLE, SPEC, EXTRA));
  const root = findProjectRoot() ?? process.cwd();
  let cfg = {};
  try { cfg = loadConfig(root); } catch { cfg = {}; }
  const input = path.resolve(target);
  if (!fs.existsSync(input)) throw new Error(`not found: ${target}`);
  if (cmd === 'extract') {
    const out = path.resolve(flags.out ?? path.join(root, 'refs', 'frames'));
    const r = await extractFrames(root, cfg, input, { every: flags.every, out });
    if (flags.json) process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
    else {
      log(`extracted ${r.count} frame(s) every ${r.every}s → ${path.relative(root, r.out) || r.out}`);
      if (r.contact) log(`contact sheet → ${path.relative(root, r.contact)}${r.contacts.length > 1 ? ` … ${path.basename(r.contacts.at(-1))} (${r.contacts.length} pages)` : ''}${r.labelled ? '' : ' (unlabelled)'}`);
      log('next: open the contact sheet, then node tools/refs.mjs analyze <video> and write docs/style_guide.md');
    }
    return 0;
  }
  const stills = fs.statSync(input).isDirectory() || IMAGE_EXT.has(path.extname(input).toLowerCase());
  const a = stills ? await analyzeImages(root, input) : await analyzeVideo(root, input, { cutThreshold: flags.threshold });
  const outFile = path.resolve(flags.out ?? path.join(root, 'refs', 'analysis.json'));
  writeJSON(outFile, a);
  if (flags.json) process.stdout.write(JSON.stringify({ ok: true, out: outFile, ...a }) + '\n');
  else {
    process.stdout.write(summaryMarkdown(a) + '\n');
    log(`\nwrote ${path.relative(root, outFile) || outFile}`);
  }
  return 0;
}

function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  const norm = (p) => { let r = path.resolve(p); try { r = fs.realpathSync.native(r); } catch { /* keep */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
  try { return norm(process.argv[1]) === norm(fileURLToPath(metaUrl)); } catch { return false; }
}
if (isMainModule(import.meta.url)) main(cli);
