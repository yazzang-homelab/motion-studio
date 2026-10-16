#!/usr/bin/env node
// GIF export of a rendered cut: two-pass palette (palettegen stats_mode=diff → paletteuse, ordered dither), Lanczos scale,
// infinite loop, and a frame rate that GIF can actually store.
//
//   node tools/gif.mjs [--format f|all|a,b] [--fps n] [--width px] [--colors n] [--dither d] [--from s] [--to s]
//                      [--once] [--max-bytes n] [--json]
//
// GIF frame delays are whole centiseconds, so only 100/n fps plays at the speed it was made for: 50, 33.3, 25, 20, ...
// 24 fps would need 4.17 cs per frame (it plays as 25 fps, 4% fast, or the muxer alternates 4 and 5 cs and the motion
// stutters), and browsers slow delays under 2 cs to 10 cs, so 60 fps GIFs play at 10 fps. The requested rate is snapped to
// the nearest 100/n (n ≥ 2) and the frames are resampled to it, so every delay is identical and the total length is exact.
// The written file is parsed back (frame count, every delay, loop extension) and the result is checked against the cut.
import fs from 'node:fs';
import path from 'node:path';
import { UsageError, projectRoot, loadConfig, parseArgs, usage, main, resolveFormats, resolveFfmpeg, run, slug, log, isMainModule } from './studio.mjs';
import { probeMedia } from './refs.mjs';

const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const fmtBytes = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
export const DITHERS = Object.freeze(['bayer', 'sierra2_4a', 'floyd_steinberg', 'none']);

/**
 * The GIF-representable frame rate nearest to `fps`: 100 / cs with cs ≥ 2 whole centiseconds (≤ 50 fps).
 * @returns {{ fps:number, cs:number, exact:boolean }}
 */
export function gifRate(fps) {
  if (!(fps > 0) || !Number.isFinite(fps)) throw new UsageError(`--fps must be a number > 0 (got ${fps})`);
  const cs = Math.max(2, Math.round(100 / fps));
  return { fps: 100 / cs, cs, exact: Math.abs(100 / cs - fps) < 1e-9 };
}

/**
 * Timing of a GIF file from its bytes: { width, height, frames, delays (cs per frame), totalCs, loop } where loop is the
 * NETSCAPE2.0 repeat count (0 = forever) or null when the file plays once. Throws on a file that is not a GIF.
 */
export function gifTiming(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const sig = b.toString('latin1', 0, 6);
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error('not a GIF file');
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  const packed = b[10];
  let p = 13;
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1)); // global colour table
  const skipSubBlocks = () => { while (p < b.length) { const n = b[p++]; if (n === 0) return; p += n; } };
  const delays = [];
  let pending = null; // delay from the last graphic control extension
  let loop = null;
  while (p < b.length) {
    const tag = b[p++];
    if (tag === 0x3b) break; // trailer
    if (tag === 0x21) {
      const label = b[p++];
      if (label === 0xf9) { pending = b.readUInt16LE(p + 2); p += b[p] + 1; skipSubBlocks(); continue; }
      if (label === 0xff && b.toString('latin1', p + 1, p + 12) === 'NETSCAPE2.0') {
        p += b[p] + 1;
        if (b[p] >= 3 && b[p + 1] === 1) loop = b.readUInt16LE(p + 2);
        skipSubBlocks();
        continue;
      }
      skipSubBlocks(); // any other extension: its data is a plain sub-block chain
      continue;
    }
    if (tag === 0x2c) {
      const lp = b[p + 8];
      p += 9;
      if (lp & 0x80) p += 3 * (1 << ((lp & 7) + 1)); // local colour table
      p += 1; // LZW minimum code size
      skipSubBlocks();
      delays.push(pending ?? 0);
      pending = null;
      continue;
    }
    throw new Error(`corrupt GIF: unexpected block 0x${tag.toString(16)} at byte ${p - 1}`);
  }
  return { width, height, frames: delays.length, delays, totalCs: delays.reduce((a, x) => a + x, 0), loop };
}

/** The cut to convert: out/<fmt>/final.mp4, else silent.mp4 (render without the mix). */
function sourceFor(root, fmt) {
  for (const name of ['final.mp4', 'silent.mp4']) {
    const f = path.join(root, 'out', fmt, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

async function exportGif(root, cfg, fmt, o) {
  const src = sourceFor(root, fmt);
  if (!src) throw new UsageError(`no cut for ${fmt}: render it first (npm run render -- --format ${fmt}); gif reads out/${fmt}/final.mp4 or silent.mp4`);
  const info = await probeMedia(root, src);
  const srcW = info.video?.width ?? 0;
  const width = Math.min(o.width ?? Math.min(srcW || 720, 720), srcW || Infinity);
  const from = o.from ?? 0;
  const to = o.to ?? info.duration;
  if (!(to > from)) throw new UsageError(`--to (${to}) must be greater than --from (${from})`);
  const length = to - from;
  const rate = gifRate(o.fps ?? Math.min(25, cfg.fps));
  const expected = Math.round(length * rate.fps);
  const out = path.join(root, 'out', fmt, `${slug(cfg.title) || 'film'}_${fmt}.gif`);
  const dither = o.dither === 'bayer' ? 'bayer:bayer_scale=5' : o.dither;
  // fps= resamples on the exact frame grid; trim first so --from/--to cut on source frames, setpts so the GIF starts at 0.
  const vf = [
    `trim=start=${from}:end=${to}`, 'setpts=PTS-STARTPTS', `fps=${rate.fps}`, `scale=${width}:-2:flags=lanczos`,
    `split[a][b];[a]palettegen=max_colors=${o.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`,
  ].join(',');
  const args = ['-hide_banner', '-y', '-i', src, '-an', '-vf', vf, '-frames:v', String(expected), '-loop', o.once ? '-1' : '0', '-f', 'gif', `${out}.tmp`];
  const r = await run(resolveFfmpeg(root), args, { timeoutMs: 15 * 60 * 1000 });
  if (r.code !== 0 || !fs.existsSync(`${out}.tmp`)) throw new Error(`ffmpeg could not write the GIF:\n${String(r.stderr).split(/\r?\n/).filter(Boolean).slice(-6).join('\n')}`);
  fs.renameSync(`${out}.tmp`, out);
  const t = gifTiming(fs.readFileSync(out));
  const bytes = fs.statSync(out).size;
  const delaysOk = t.delays.every((d) => d === rate.cs);
  const checks = [
    { id: 'frames', pass: t.frames === expected, value: t.frames, expected },
    { id: 'delay', pass: delaysOk, value: delaysOk ? `${rate.cs} cs` : `${[...new Set(t.delays)].join('/')} cs`, expected: `${rate.cs} cs on every frame` },
    { id: 'length', pass: Math.abs(t.totalCs / 100 - expected / rate.fps) < 1e-9, value: `${round(t.totalCs / 100)} s`, expected: `${round(expected / rate.fps)} s` },
    { id: 'loop', pass: o.once ? t.loop === null : t.loop === 0, value: t.loop === null ? 'plays once' : t.loop === 0 ? 'forever' : `${t.loop}×`, expected: o.once ? 'plays once' : 'forever' },
  ];
  if (o.maxBytes) checks.push({ id: 'size', pass: bytes <= o.maxBytes, value: fmtBytes(bytes), expected: `≤ ${fmtBytes(o.maxBytes)}`, note: 'lower --width, --fps or --colors, or shorten with --from/--to' });
  const warnings = [];
  if (!rate.exact && o.fps != null) warnings.push(`${o.fps} fps is not storable in GIF (delays are whole 1/100 s); used ${round(rate.fps, 2)} fps (${rate.cs} cs per frame) so the speed and length stay exact`);
  if (Math.abs(length * rate.fps - expected) > 1e-6) warnings.push(`${round(length, 3)} s is not a whole number of ${round(rate.fps, 2)} fps frames: the GIF is ${round(expected / rate.fps, 3)} s; for a seamless loop pick a rate whose frame count fits the loop exactly`);
  if (cfg.loop && from === 0 && Math.abs(to - cfg.duration) < 1e-6 && Math.abs(length * rate.fps - expected) > 1e-6) warnings.push('loop film: the last GIF frame does not land one frame before the seam, so the loop stutters');
  return { format: fmt, source: path.relative(root, src).split(path.sep).join('/'), file: path.relative(root, out).split(path.sep).join('/'), bytes, width: t.width, height: t.height, fps: round(rate.fps, 4), delayCs: rate.cs, frames: t.frames, checks, warnings, pass: checks.every((c) => c.pass) };
}

const SPEC = {
  format: { type: 'string', alias: 'f', arg: '<f|all|a,b>', desc: 'Formats to export (default: the primary format)' },
  fps: { type: 'number', arg: '<n>', desc: 'Frame rate, snapped to 100/n (50, 33.33, 25, 20, ...); default min(25, studio.json fps)' },
  width: { type: 'number', arg: '<px>', desc: 'Output width (height keeps the aspect); default min(720, source width)' },
  colors: { type: 'number', arg: '<n>', desc: 'Palette size 2–256 (default 256)' },
  dither: { type: 'string', arg: `<${DITHERS.join('|')}>`, desc: 'Dither for paletteuse (default bayer: ordered, compresses well, no crawling noise)' },
  from: { type: 'number', arg: '<sec>', desc: 'Start of the excerpt (default 0)' },
  to: { type: 'number', arg: '<sec>', desc: 'End of the excerpt (default the end of the cut)' },
  once: { type: 'boolean', desc: 'Play once instead of looping forever' },
  'max-bytes': { type: 'number', arg: '<n>', desc: 'Fail when the GIF is larger (platform limits)' },
  json: { type: 'boolean', desc: 'Print one JSON result line on stdout' },
};
const TITLE = `Usage: node tools/gif.mjs [--format f|all|a,b] [--fps n] [--width px] [--colors n] [--dither d] [--from s] [--to s] [--once] [--max-bytes n] [--json]

Converts out/<fmt>/final.mp4 (or silent.mp4) into out/<fmt>/<title>_<fmt>.gif with a two-pass palette, then parses the GIF
back and checks the frame count, that every delay is the same whole number of centiseconds, the exact length, the loop flag
and (with --max-bytes) the size. Exit 1 when a check fails.`;

async function cli(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC, { title: TITLE });
  if (flags.help) { process.stdout.write(usage(TITLE, SPEC)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument ${positionals[0]}`, usage(TITLE, SPEC));
  const root = projectRoot();
  const cfg = loadConfig(root);
  const formats = resolveFormats(cfg, flags.format ?? cfg.primaryFormat);
  const colors = flags.colors ?? 256;
  if (!(Number.isInteger(colors) && colors >= 2 && colors <= 256)) throw new UsageError(`--colors must be a whole number 2–256 (got ${colors})`);
  const dither = flags.dither ?? 'bayer';
  if (!DITHERS.includes(dither)) throw new UsageError(`--dither must be one of ${DITHERS.join(', ')} (got ${dither})`);
  if (flags.width != null && !(flags.width >= 16)) throw new UsageError(`--width must be at least 16 px (got ${flags.width})`);
  if (flags.fps != null) gifRate(flags.fps); // validate before any work
  const o = { fps: flags.fps, width: flags.width ? 2 * Math.round(flags.width / 2) : undefined, colors, dither, from: flags.from, to: flags.to, once: !!flags.once, maxBytes: flags['max-bytes'] };
  const results = [];
  for (const fmt of formats) {
    log(`gif: ${fmt}`);
    results.push(await exportGif(root, cfg, fmt, o));
  }
  const pass = results.every((r) => r.pass);
  if (flags.json) process.stdout.write(JSON.stringify({ ok: pass, results }) + '\n');
  else {
    const lines = [];
    for (const r of results) {
      lines.push(`${r.format}  ${r.file}  ${fmtBytes(r.bytes)}  ${r.width}x${r.height}  ${r.frames} frames @ ${round(r.fps, 2)} fps (${r.delayCs} cs)`);
      for (const c of r.checks) lines.push(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(7)} ${String(c.value).padEnd(16)} expected ${c.expected}${!c.pass && c.note ? `  (${c.note})` : ''}`);
      for (const w of r.warnings) lines.push(`  WARN  ${w}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
  }
  return pass ? 0 : 1;
}

if (isMainModule(import.meta.url)) main(() => cli(process.argv.slice(2)));
