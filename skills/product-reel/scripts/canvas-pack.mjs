// The pack step of canvas-frames.mjs: keep only the frames the film plays, in order, in smaller sprite sheets.
// Input: <dir>/frames.json + <dir>/<clip>.png written by `canvas-frames.mjs capture`. Output: <dir>/pack/<clip>.png + pack.json.
// The film reads source frame `first + i` from the pack at slot i; pixels are copied, never resampled.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, repackSheet, sheetRows } from './png-sheet.mjs';
import { UsageError, insideRoot, relTo, writeFileAtomic } from './capture-cli.mjs';

/** Device names Windows routes to a console/port when a file of that base name is written (con.png, NUL.png, com1.png ...). */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * A clip name becomes a file name (`<name>.png`), so it is letters, digits, _ and -, never a Windows device name, never a path.
 * @throws {UsageError}
 */
export function assertClipName(name, where = 'clip name') {
  const n = String(name);
  if (!/^[A-Za-z0-9_-]+$/.test(n)) throw new UsageError(`${where} "${n}": a clip name is letters, digits, _ or - only (it becomes a file name)`);
  if (RESERVED.test(n)) throw new UsageError(`${where} "${n}" is a reserved Windows device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9): writing ${n}.png would not create a file there; pick another name`);
  return n;
}

/**
 * `name=first[:n]` -> { name, first, n } (n null = to the last frame). A clip name is letters, digits, _ and -.
 * @throws {UsageError}
 */
export function parseRange(text) {
  const m = /^([A-Za-z0-9_-]+)=(\d+)(?::(\d*))?$/.exec(String(text).trim());
  if (!m) throw new UsageError(`--range "${text}": expected <clip>=<first>[:<count>], e.g. db=4:200`);
  assertClipName(m[1], `--range "${text}": clip name`);
  const n = m[3] ? Number(m[3]) : null;
  if (n === 0) throw new UsageError(`--range "${text}": the count must be at least 1`);
  return { name: m[1], first: Number(m[2]), n };
}

/** Index of the first frame whose hash differs from frame 0 (the click's first visible effect), or 0 when nothing changes. */
export function firstChange(hashes) {
  const i = hashes.findIndex((h) => h !== hashes[0]);
  return i === -1 ? 0 : i;
}

/** Slot numbers `first .. first+n-1` clamped to the clip; throws when the range starts outside it. */
export function rangeIndices(total, first, n, name = 'clip') {
  if (first >= total) throw new UsageError(`${name}: --range starts at frame ${first} but the clip has ${total} frames (0..${total - 1})`);
  const count = Math.min(n ?? total - first, total - first);
  return Array.from({ length: count }, (_, i) => first + i);
}

/**
 * Packs every clip of <dir>/frames.json (or only those named in `ranges`, or all when `ranges` is empty).
 * @param {{ root: string, dir: string, ranges?: {name: string, first: number, n: number | null}[], outCols?: number, trimLead?: boolean }} o
 * @returns the pack.json object, already written to <dir>/pack/pack.json
 */
export function packClips({ root, dir, ranges = [], outCols = null, trimLead = false }) {
  const metaFile = path.join(dir, 'frames.json');
  if (!fs.existsSync(metaFile)) throw new UsageError(`${relTo(root, metaFile)} not found: run \`canvas-frames.mjs capture\` first (or pass --dir)`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/^﻿/, ''));
  const clips = meta.clips ?? {};
  for (const r of ranges) if (!clips[r.name]) throw new UsageError(`--range ${r.name}: no clip of that name in ${relTo(root, metaFile)} (have: ${Object.keys(clips).join(', ') || 'none'})`);
  const names = ranges.length ? ranges.map((r) => r.name) : Object.keys(clips);
  for (const name of names) assertClipName(name, `${relTo(root, metaFile)}: clip name`); // frames.json is data: its keys become file names
  const [fw, fh] = meta.frame;
  const dst = path.join(dir, 'pack');
  fs.mkdirSync(dst, { recursive: true });
  const pack = { version: 1, tool: 'motion-studio product-reel canvas-frames pack', source: relTo(root, metaFile), frame: [fw, fh], stepMs: meta.stepMs, clips: {} };
  for (const name of names) {
    const clip = clips[name];
    const range = ranges.find((r) => r.name === name);
    const sheetFile = insideRoot(root, String(clip.file ?? ''), `clip ${name}: sprite sheet`);
    const sheet = decodePng(fs.readFileSync(sheetFile));
    if (sheet.width !== meta.cols * fw) throw new Error(`${clip.file} is ${sheet.width} px wide, frames.json says ${meta.cols} columns of ${fw} px`);
    const first = range ? range.first : trimLead ? firstChange(clip.hashes ?? []) : 0;
    const indices = rangeIndices(clip.frames, first, range ? range.n : null, name);
    const cols = outCols ?? meta.cols;
    const out = repackSheet(sheet, { cols: meta.cols, frame: [fw, fh], indices, outCols: cols });
    const file = path.join(dst, `${name}.png`);
    if (path.relative(dst, file).split(path.sep).length !== 1) throw new UsageError(`clip ${name}: the output ${relTo(root, file)} is outside ${relTo(root, dst)}`);
    const png = encodePng(out);
    fs.writeFileSync(file, png);
    pack.clips[name] = {
      file: relTo(root, file), first, n: indices.length, cols, rows: sheetRows(indices.length, cols), frame: [fw, fh], bytes: png.length,
      times: indices.map((i) => clip.times[i]), hashes: indices.map((i) => clip.hashes?.[i]).filter(Boolean),
    };
  }
  writeFileAtomic(path.join(dst, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
  return pack;
}
