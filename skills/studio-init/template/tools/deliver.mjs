#!/usr/bin/env node
// Delivery checks + package (course step 12, and the spec checks from @robj3d3's "Proof" screenshot: fps, frame
// count, exact duration, stereo -14 LUFS, size vs the platform upload limit). Every format with a final.mp4 is
// measured; only a fully passing delivery is copied to out/deliver/. docs/production.json logs every attempt.
//
//   node tools/deliver.mjs [--format f|all|a,b] [--json]
//
// final.mp4 is judged against the CURRENT studio.json (frames = duration x fps, size from the format, fps) and against
// its own render.json, so a cut rendered before an edit of studio.json is a "stale render", never a pass. A film
// source (index.html, film/**, lib/**, assets/**, studio.json, audio inputs) newer than the render is a warning.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FORMATS, UsageError, projectRoot, loadConfig, parseArgs, usage, main, wantsJson, resolveFormats, resolveFfmpeg, run,
  readJSON, writeJSON, ensureDir, slug, sha256, log, isMainModule } from './studio.mjs';
import { probeMedia, streamStats, mp4Durations, measureLoudness, audioGaps, silenceLabel, readFrames, meanAbsDiff, VIDEO_NOISE } from './refs.mjs';
import { checkGate } from './gate.mjs';

const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const fmtBytes = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
const firstLine = (err) => String(err?.message ?? err).split(/\r?\n/).filter(Boolean)[0] ?? 'unknown error';
const evenPx = (x) => 2 * Math.round(x / 2);
const readOptionalJSON = (file) => { try { return { value: readJSON(file, null) }; } catch (err) { return { value: null, error: firstLine(err) }; } };

/** Newest mtime under the given project-relative files/folders (dot entries and node_modules skipped): { rel, mtimeMs } | null. */
function newestSource(root, rels) {
  let best = null;
  const visit = (abs) => {
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      let names;
      try { names = fs.readdirSync(abs); } catch { return; }
      for (const n of names) if (!n.startsWith('.') && n !== 'node_modules') visit(path.join(abs, n));
    } else if (!best || st.mtimeMs > best.mtimeMs) best = { rel: path.relative(root, abs).split(path.sep).join('/'), mtimeMs: st.mtimeMs };
  };
  for (const r of rels) visit(path.resolve(root, r));
  return best;
}

/** What the last render and mix were built from: pixels (page, film, engine, fonts, images, beat grid) and audio inputs. */
// Coarse file systems (FAT/exFAT keep 2 s) must not turn a same-second write into a warning.
const SOURCE_SLACK_MS = 2000;
const PIXEL_SOURCES = ['index.html', 'studio.json', 'film', 'lib', 'assets', 'audio/beats.json'];
const audioSources = (cfg) => ['music', 'sfx', 'voice'].map((k) => cfg.audio?.[k]).filter((p) => typeof p === 'string' && p && p !== 'none');

/** Seam continuity of a loop film from its encode: |last − first| vs |last-1 − last| on 64 px frames. */
async function loopSeam(root, file, info) {
  const w = 64;
  const h = Math.max(2, 2 * Math.round((w * info.video.height) / info.video.width / 2));
  let first = null; let prev = null; let last = null;
  await readFrames(root, file, { width: w, height: h, onFrame: (buf) => { if (!first) first = buf; prev = last; last = buf; } });
  if (!first || !prev) return null;
  const seam = meanAbsDiff(last, first, VIDEO_NOISE);
  const step = meanAbsDiff(prev, last, VIDEO_NOISE);
  return { seam: round(seam), step: round(step), ratio: step > 0 ? round(seam / step, 2) : null };
}

async function checkFormat(root, cfg, fmt) {
  const dir = path.join(root, 'out', fmt);
  const file = path.join(dir, 'final.mp4');
  const checks = [];
  const add = (id, pass, value, expected, note = '') => checks.push({ id, pass, value, expected, note });
  const out = { format: fmt, file: `out/${fmt}/final.mp4`, checks };
  if (!fs.existsSync(file)) {
    add('final.mp4', false, 'missing', 'present', `run npm run render:final && npm run mix`);
    return out;
  }
  const stat = fs.statSync(file);
  const bytes = stat.size;
  const { value: render, error: renderError } = readOptionalJSON(path.join(dir, 'render.json'));
  // An unreadable final.mp4 is a failing check, not a crash: the caller must still withdraw the previous delivery and
  // record the failed attempt (manifest.json, docs/production.json).
  let info; let st; let L;
  try {
    [info, st] = await Promise.all([probeMedia(root, file), streamStats(root, file)]);
    L = info.audio ? await measureLoudness(root, file) : null;
  } catch (err) {
    add('final.mp4 readable', false, 'unreadable', 'a valid H.264/AAC mp4', `${firstLine(err)}; re-run npm run mix`);
    Object.assign(out, { bytes });
    return out;
  }
  const v = info.video;
  const F = FORMATS[fmt];
  // The expectation is the CURRENT studio.json, never the sidecar the render wrote about itself: an edit of duration,
  // fps or the format list after the render must fail here (a cut of the old film would otherwise pass its own render.json).
  const fps = cfg.fps;
  const expectFrames = Math.round(cfg.duration * cfg.fps);
  const expectDur = expectFrames / fps;
  const expectW = F.w;
  const expectH = F.h;
  const scale = render?.scale ?? 1;
  add('video codec', v?.codec === 'h264', v?.codec ?? 'none', 'h264');
  add('pixel format', v?.pixFmt === 'yuv420p', v?.pixFmt ?? 'none', 'yuv420p', 'players and upload pipelines expect 4:2:0');
  add('dimensions', v?.width === expectW && v?.height === expectH, `${v?.width}x${v?.height}`, `${expectW}x${expectH}`, scale !== 1 ? `render scale ${scale} (not a full-size master)` : '');
  add('fps', Number.isFinite(v?.fps) && Math.abs(v.fps - fps) < 0.01, v?.fps, fps);
  const frames = st.video?.packets ?? null;
  add('frames', frames === expectFrames, frames, expectFrames);
  const vDur = st.video?.duration ?? null;
  add('duration', Number.isFinite(vDur) && Math.abs(vDur - expectDur) <= 0.5 / fps + 1e-6, round(vDur, 4), round(expectDur, 4), 'video stream, from packet timestamps');
  const has = `final.mp4 has ${round(vDur, 3)} s @ ${v?.fps} fps (${frames} frames, ${v?.width}x${v?.height})`;
  const says = `studio.json says ${cfg.duration} s @ ${cfg.fps} fps (${expectFrames} frames, ${expectW}x${expectH})`;
  const inSync = checks.filter((c) => ['dimensions', 'fps', 'frames', 'duration'].includes(c.id)).every((c) => c.pass);
  add('matches studio.json', inSync, inSync ? 'yes' : 'stale render', 'yes', inSync ? '' : `stale render: ${says}, ${has}; re-render (npm run render:final && npm run mix)`);
  if (render) {
    // The sidecar must describe the file next to it and the current config (a render.json left behind by an older run
    // or an mp4 swapped in by hand shows up here).
    const drift = [];
    if (render.format && render.format !== fmt) drift.push(`format ${render.format}`);
    if (Number.isFinite(render.fps) && render.fps !== cfg.fps) drift.push(`${render.fps} fps`);
    if (Number.isFinite(render.frames) && render.frames !== expectFrames) drift.push(`${render.frames} frames`);
    if (Number.isFinite(render.width) && (render.width !== evenPx(F.w * scale) || render.height !== evenPx(F.h * scale))) drift.push(`${render.width}x${render.height} at scale ${scale}`);
    if (Number.isFinite(render.fps) && Number.isFinite(render.frames) && frames !== null && (!(Math.abs(render.fps - v?.fps) < 0.01) || render.frames !== frames)) drift.push(`does not describe final.mp4 (${render.frames} frames @ ${render.fps} fps vs ${frames} @ ${v?.fps})`);
    add('render.json', drift.length === 0, drift.length ? 'differs' : 'consistent', 'matches studio.json and final.mp4',
      drift.length ? `render.json says ${drift.join(', ')}; ${says}; re-render (npm run render:final && npm run mix)` : '');
  } else {
    add('render.json', true, renderError ? 'unreadable' : 'missing', 'present', `warning: ${renderError ?? 'out/' + fmt + '/render.json not found'}; cannot confirm the cut came from render --final`);
  }
  const A = cfg.audio;
  if (!info.audio) add('audio stream', false, 'none', 'AAC stereo 48 kHz', 'run npm run mix');
  else {
    add('audio stream', info.audio.channels === 2 && info.audio.sampleRate === 48000, `${info.audio.codec} ${info.audio.layout} ${info.audio.sampleRate} Hz`, 'stereo 48000 Hz');
    // The length the container declares (MP4 edit list, as ffprobe and players show it), never decoded samples: AAC
    // decodes whole 1024-sample frames (576512 samples for a 12.000 s stream). Packet timestamps are the fallback.
    const box = mp4Durations(file)?.audio?.duration;
    const aDur = box ?? st.audio?.duration ?? null;
    out.audioLength = { seconds: round(aDur, 4), from: box != null ? 'container' : aDur != null ? 'packets' : null };
    add('audio length', Number.isFinite(aDur) && Math.abs(aDur - vDur) <= 1 / fps + 1e-6, round(aDur, 4), round(vDur, 4),
      `audio must run the whole video (never -shortest); ${out.audioLength.from ?? 'no'} duration`);
    add('loudness', Number.isFinite(L?.I) && Math.abs(L.I - A.lufs) <= A.lufsTolerance, `${L?.I} LUFS`, `${A.lufs} ±${A.lufsTolerance} LUFS`, 'ebur128 integrated, after AAC');
    add('true peak', Number.isFinite(L?.TP) && L.TP <= A.truePeak + 0.05, `${L?.TP} dBTP`, `≤ ${A.truePeak} dBTP`);
    // A soundtrack that drops out for seconds (a stem shorter than the film, padded with zeros) still measures the right
    // loudness, so it needs its own check. Not a gap: a silent intro (starts < 0.3 s), a fade-out that starts in the
    // last second, and what studio.json critique.allowSilence ([[from, to], ...]) lists.
    try {
      const sil = await audioGaps(root, file, cfg, { duration: aDur ?? vDur });
      out.silence = { noiseDb: sil.noiseDb, minSec: sil.minSec, gaps: sil.gaps, ignored: sil.ignored.length };
      add('silence', sil.gaps.length === 0, sil.gaps.length ? sil.gaps.map((g) => `silence ${silenceLabel(g)}`).join('; ') : 'none', `no span of ≥ ${sil.minSec} s below ${sil.noiseDb} dB`,
        sil.gaps.length ? 'the soundtrack drops out: fix the stem (npm run score / sfx / voice) and re-run npm run mix, or list an intended silence in studio.json critique.allowSilence ([[from, to]])' : '');
    } catch (err) {
      add('silence', false, 'not measured', `no span of ≥ 1 s below -50 dB`, `silencedetect failed: ${firstLine(err)}`);
    }
  }
  for (const [platform, max] of Object.entries(cfg.deliver?.maxBytes ?? {})) add(`size (${platform})`, bytes <= max, fmtBytes(bytes), `≤ ${fmtBytes(max)}`);
  const poster = path.join(dir, 'poster.png');
  add('poster', fs.existsSync(poster), fs.existsSync(poster) ? `out/${fmt}/poster.png` : 'missing', 'present', fs.existsSync(poster) ? '' : 'render without --no-poster');
  if (cfg.loop) {
    const s = await loopSeam(root, file, info);
    add('loop seam', !!s && (s.ratio === null ? s.seam < 0.35 : s.ratio <= 1.5 || s.seam < 0.35), s ? `ratio ${s.ratio} (seam ${s.seam}, last step ${s.step})` : 'n/a', 'ratio ≤ 1.5');
  }
  // A draft encode (previewPreset, CRF 23) is never a master. A full-size cut rendered without --final is deliverable,
  // with a warning: the gate was not checked at render time.
  if (render?.encode?.draft === true) add('final render', false, 'draft encode', '--final (full quality)', 'rendered with --draft (CRF 23, preview preset); run npm run render:final && npm run mix');
  else if (render && render.final !== true) add('final render', true, 'not --final', '--final', 'warning: not rendered with --final');
  // Sources edited after the render/mix: the film on screen is no longer the film in the file.
  const renderStat = (() => { try { return fs.statSync(path.join(dir, 'render.json')); } catch { return null; } })();
  const newestPixels = newestSource(root, PIXEL_SOURCES);
  const newestAudio = newestSource(root, audioSources(cfg));
  const stale = [];
  // Pixels are compared with the render (a film edit between render and mix is stale even though the mix is newer).
  if (newestPixels && newestPixels.mtimeMs > Math.min(stat.mtimeMs, renderStat?.mtimeMs ?? Infinity) + SOURCE_SLACK_MS) stale.push(newestPixels);
  if (newestAudio && newestAudio.mtimeMs > stat.mtimeMs + SOURCE_SLACK_MS) stale.push(newestAudio);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  if (stale.length) {
    const newest = stale.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    add('sources', true, `${newest.rel} ${iso(newest.mtimeMs)}`, `not newer than the render (${iso(Math.min(stat.mtimeMs, renderStat?.mtimeMs ?? Infinity))})`,
      `warning: ${stale.map((s) => s.rel).join(', ')} changed after out/${fmt} was rendered or mixed; re-render (npm run render:final && npm run mix) unless the edit does not touch the picture or sound`);
  }
  Object.assign(out, { bytes, fps: v?.fps, frames, duration: round(vDur, 4), width: v?.width, height: v?.height,
    loudness: L ? { I: L.I, TP: L.TP, LRA: L.LRA } : null, render: render ? { final: render.final ?? null, scale, sub: render.sub, crf: render.encode?.crf, preset: render.encode?.preset, browser: render.browser, via: render.via } : null });
  return out;
}

/** contact-2.png, contact-3.png ... of out/review/<fmt>/ in page order (page 1 is contact.png). */
function contactPages(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map((n) => ({ n, page: Number(/^contact-(\d+)\.png$/.exec(n)?.[1]) })).filter((x) => x.page >= 2).sort((a, b) => a.page - b.page).map((x) => x.n);
}

async function toolVersions(root) {
  const v = { node: process.versions.node, platform: `${process.platform}-${process.arch}` };
  try {
    const r = await run(resolveFfmpeg(root), ['-hide_banner', '-version'], { timeoutMs: 30000 });
    v.ffmpeg = (r.stdout.split(/\r?\n/)[0] || '').replace(/^ffmpeg version\s*/, '').split(' ')[0] || null;
  } catch { v.ffmpeg = null; }
  try { v.playwright = createRequire(path.join(root, 'package.json'))('playwright/package.json').version; } catch { v.playwright = null; }
  return v;
}

const SPEC = {
  format: { type: 'string', alias: 'f', arg: '<f|all|a,b>', desc: 'Formats to deliver (default: every format in studio.json); the other formats keep their delivered files' },
  json: { type: 'boolean', desc: 'Print one JSON result line on stdout' },
};
const TITLE = `Usage: node tools/deliver.mjs [--format f|all|a,b] [--json]

Checks out/<fmt>/final.mp4 against the CURRENT studio.json (frames = duration x fps, size of the format, fps) and its
render.json (a cut rendered before an edit of studio.json fails as a stale render), plus codec, yuv420p, stereo
48 kHz, loudness, true peak, silent spans (a span of 1 s or more below -50 dB that is not the very start or the last
second; studio.json critique.allowSilence: [[from, to], ...] lists intended ones), file size vs deliver.maxBytes, poster,
loop seam and the critique gate. Passing
deliveries are copied to out/deliver/; out/deliver/manifest.json and docs/production.json record every attempt.
Exit 1 when any check fails; with --json the failure line is {ok:false, error, failed:[...], ...}. A warning does not fail the delivery: the cut was not rendered with --final, or a film
source (index.html, film/**, lib/**, assets/**, studio.json, audio inputs) is newer than the render.

--format re-checks and re-delivers only the named formats. The other formats keep their delivered files and their
manifest entries; a failing critique gate is project-wide and withdraws every delivered file.`;

async function cli(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC, { title: TITLE });
  if (flags.help) { process.stdout.write(usage(TITLE, SPEC)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument ${positionals[0]}`, usage(TITLE, SPEC));
  const root = projectRoot();
  const cfg = loadConfig(root);
  const formats = resolveFormats(cfg, flags.format ?? 'all');
  const name = slug(cfg.title);
  log(`deliver: checking ${formats.join(', ')}`);
  const results = [];
  for (const fmt of formats) results.push(await checkFormat(root, cfg, fmt)); // sequential: each check spawns ffmpeg
  const gate = checkGate(root, cfg);
  const pass = gate.pass && results.every((r) => r.checks.every((c) => c.pass));
  const deliverDir = ensureDir(path.join(root, 'out', 'deliver'));
  // Withdraw what the previous delivery copied for the formats of this run, so a failed run never leaves stale files
  // that look current. Formats this run did not ask for keep their files and entries while they are still on disk,
  // still part of the film and delivered under the same title, and the gate (project-wide) still passes.
  const previous = readOptionalJSON(path.join(deliverDir, 'manifest.json')).value;
  const requested = new Set(formats);
  const kept = [];
  for (const entry of Array.isArray(previous?.formats) ? previous.formats : []) {
    const files = Array.isArray(entry?.files) ? entry.files : [];
    const onDisk = (f) => fs.existsSync(path.join(deliverDir, path.basename(f.path)));
    const untouched = gate.pass && previous.slug === name && !requested.has(entry.format) && cfg.formats.includes(entry.format);
    if (untouched && files.length && files.every(onDisk)) { kept.push({ ...entry, carriedOver: true }); continue; }
    for (const f of files) fs.rmSync(path.join(deliverDir, path.basename(f.path)), { force: true });
  }
  if (pass) {
    for (const r of results) {
      r.files = [];
      const copy = (src, dest) => {
        if (!fs.existsSync(src)) return;
        const target = path.join(deliverDir, dest);
        fs.copyFileSync(src, target);
        r.files.push({ path: `out/deliver/${dest}`, bytes: fs.statSync(target).size, sha256: sha256(fs.readFileSync(target)) });
      };
      copy(path.join(root, 'out', r.format, 'final.mp4'), `${name}_${r.format}.mp4`);
      copy(path.join(root, 'out', r.format, 'poster.png'), `${name}_${r.format}_poster.png`);
      // contact.png is page 1; a long film's sheet has contact-2.png ... (critique.mjs / stills.mjs rule): every page is delivered.
      const reviewDir = path.join(root, 'out', 'review', r.format);
      copy(path.join(reviewDir, 'contact.png'), `${name}_${r.format}_contact.png`);
      for (const page of contactPages(reviewDir)) copy(path.join(reviewDir, page), `${name}_${r.format}_${page}`);
    }
  }
  const createdAt = new Date().toISOString();
  const tools = await toolVersions(root);
  const gateOut = { pass: gate.pass, enabled: gate.enabled, rounds: gate.rounds, minRounds: gate.minRounds, minScore: gate.minScore, reasons: gate.reasons };
  const entries = [...results, ...kept].sort((a, b) => cfg.formats.indexOf(a.format) - cfg.formats.indexOf(b.format));
  const missing = cfg.formats.filter((f) => !entries.some((e) => e.format === f && (e.files ?? []).length));
  const manifest = { version: 1, createdBy: 'motion-studio', tool: 'deliver', createdAt, title: cfg.title, slug: name, pass, complete: pass && !missing.length, missing, gate: gateOut, formats: entries };
  writeJSON(path.join(deliverDir, 'manifest.json'), manifest);
  const last = gate.last;
  const production = {
    version: 1, createdBy: 'motion-studio', updatedAt: createdAt, title: cfg.title, delivered: pass, complete: manifest.complete, missing,
    formats: entries.map((r) => ({ format: r.format, pass: r.checks.every((c) => c.pass), duration: r.duration ?? null, frames: r.frames ?? null, fps: r.fps ?? null,
      size: r.width ? `${r.width}x${r.height}` : null, bytes: r.bytes ?? null, loudness: r.loudness ?? null, ...(r.carriedOver ? { carriedOver: true } : {}) })),
    audioTargets: { lufs: cfg.audio.lufs, tolerance: cfg.audio.lufsTolerance, truePeak: cfg.audio.truePeak },
    critique: { rounds: gate.rounds, minRounds: gate.minRounds, gateEnabled: gate.enabled, gatePass: gate.pass, lastRound: last ? { n: last.n, title: last.title, scores: last.scores, problems: last.problems.length, p0: last.problems.filter((p) => p.severity === 'P0').length } : null },
    effort: process.env.CLAUDE_EFFORT || null,
    tools: { ...tools, browser: results.find((r) => r.render?.browser)?.render.browser ?? null },
  };
  writeJSON(path.join(root, 'docs', 'production.json'), production);
  const failed = results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `${r.format}: ${c.id} = ${c.value} (expected ${c.expected})${c.note ? ` — ${c.note}` : ''}`));
  if (!gate.pass) failed.push(`gate: ${gate.reasons.join('; ')}`);
  const isWarning = (c) => c.pass && String(c.note).startsWith('warning');
  const warnings = results.flatMap((r) => r.checks.filter(isWarning).map((c) => `${r.format}: ${c.id}: ${c.note.replace(/^warning:\s*/, '')}`));
  if (flags.json) {
    for (const f of failed) log(`deliver: FAIL ${f}`);
    for (const w of warnings) log(`deliver: WARN ${w}`);
    // One line, {ok:false, error, failed}: `error` is the summary a caller can show, `failed` lists every failing check.
    const error = pass ? undefined : `delivery failed: ${failed.length} failing check(s), first: ${failed[0]}`.replace(/\s*[\r\n]+\s*/g, ' ');
    process.stdout.write(JSON.stringify({ ok: pass, ...(pass ? {} : { error }), failed, warnings, manifest: 'out/deliver/manifest.json', production: 'docs/production.json', formats: results.map((r) => ({ format: r.format, pass: r.checks.every((c) => c.pass), files: r.files ?? [] })),
      kept: kept.map((e) => e.format), missing, gate: gateOut }) + '\n');
  } else {
    const lines = [];
    for (const r of results) {
      lines.push(`${r.format}  ${r.file}${r.bytes ? `  ${fmtBytes(r.bytes)}` : ''}`);
      for (const c of r.checks) lines.push(`  ${c.pass ? (isWarning(c) ? 'WARN' : 'PASS') : 'FAIL'}  ${c.id.padEnd(19)} ${String(c.value).padEnd(26)} expected ${c.expected}${c.note && (!c.pass || isWarning(c)) ? `  (${c.note})` : ''}`);
    }
    lines.push(`gate  ${gate.pass ? 'PASS' : 'FAIL'}  ${gate.rounds}/${gate.minRounds} rounds${gate.reasons.length ? `  ${gate.reasons.join('; ')}` : ''}`);
    lines.push(pass ? `delivered: ${results.flatMap((r) => r.files.map((f) => f.path)).join(', ')}` : `NOT delivered (${failed.length} failing check(s)); fix them and re-run npm run deliver`);
    if (kept.length) lines.push(`kept from an earlier delivery: ${kept.map((e) => e.format).join(', ')}`);
    if (pass && missing.length) lines.push(`not delivered yet: ${missing.join(', ')} (run npm run deliver without --format)`);
    lines.push('wrote out/deliver/manifest.json and docs/production.json');
    process.stdout.write(lines.join('\n') + '\n');
  }
  return pass ? 0 : 1;
}

/**
 * --json promises ONE line {ok, error?, failed?, ...} also when the run cannot even start (a studio.json that does not
 * validate, an unknown format, a bad flag): `failed` then holds the cause, like a failing check does. main() would print
 * {ok:false,error} without it.
 */
async function cliJson(argv) {
  try { return await cli(argv); } catch (err) {
    if (!wantsJson(argv)) throw err;
    const isUsage = err instanceof UsageError || err?.name === 'UsageError';
    const error = String(err?.message ?? err).replace(/\s*[\r\n]+\s*/g, ' ');
    process.stdout.write(`${JSON.stringify({ ok: false, error, failed: [error] })}\n`);
    process.stderr.write(`error: ${err?.message ?? err}\n`);
    if (isUsage && err.usage) process.stderr.write(`\n${err.usage}`);
    if (process.env.DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
    return isUsage ? 2 : 1;
  }
}

if (isMainModule(import.meta.url)) main(() => cliJson(process.argv.slice(2)));
