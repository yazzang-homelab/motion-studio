// Video mode of tools/critique.mjs: a rendered mp4 (--video). Decodes the frames with ffmpeg for the same pixel metrics, measures
// loudness and silent spans, and builds the paged sheets from the video; shot names and cues come from the live film when it loads.
import path from 'node:path';
import { startServer, launchBrowser, openFilm, readJSON, fmtTime, log, even } from './studio.mjs';
import { probeMedia, streamStats, mp4Durations, measureLoudness, readFrames, encodePNG, makeSheetPages, audioGaps, VIDEO_NOISE } from './refs.mjs';
import { CRIT_DEFAULTS, round, Analyzer, beatTimes, syncMetrics, loopVerdict, resolveRange } from './critique-metrics.mjs';
import { saveSheet, dropSheet } from './critique-sheets.mjs';

function readCues(root) {
  const raw = readJSON(path.join(root, 'audio', 'cues.json'), null);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.cues) ? raw.cues : [];
  return list.map((c) => ({ t: Number(c.t), type: c.type ?? c.sfx ?? 'cue' })).filter((c) => Number.isFinite(c.t));
}

/** Shots, cues and grid from the live film (best effort: a broken film must not block reviewing its render). */
async function filmTimeline(browser, root, fmt) {
  if (!browser) return null;
  let server = null;
  try {
    server = await startServer(root);
    const film = await openFilm(browser, server.url, { format: fmt, scale: 0.1 });
    try {
      return await film.page.evaluate(() => ({ cues: window.__studio.cues(), shots: window.__studio.shots(), grid: window.__studio.grid }));
    } finally { await film.context.close().catch(() => {}); }
  } catch (err) {
    log(`critique: live film unavailable for shot names (${String(err.message).split('\n')[0]}); using detected cuts`);
    return null;
  } finally { if (server) await server.close(); }
}

export async function critiqueVideo(root, cfg, fmt, flags, outDir, file, closers) {
  const crit = { ...CRIT_DEFAULTS, ...cfg.critique };
  const t0 = Date.now();
  const lap = (what) => log(`critique: ${what} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const [info, st] = await Promise.all([probeMedia(root, file), streamStats(root, file)]);
  if (!info.video?.width) throw new Error(`${file} has no video stream`);
  const fps = info.video.fps || cfg.fps;
  const N = st.video?.packets ?? Math.round((info.duration ?? cfg.duration) * fps);
  const dur = st.video?.duration ?? N / fps;
  const range = resolveRange(flags, { duration: dur, fps, frames: N });
  const inRange = (t) => t >= range.from - 1e-9 && t < range.to - 1e-9;
  const res = { mode: 'video', video: path.relative(root, file).split(path.sep).join('/'), film: { title: cfg.title, duration: round(dur, 4), fps, frames: N, width: info.video.width, height: info.video.height, loop: !!cfg.loop, pixFmt: info.video.pixFmt }, range };
  // Concurrent: browser + live timeline, loudness, silent spans, and the metrics decode (with scene detection).
  const browserTask = launchBrowser(root, cfg).then((b) => b.browser,
    (err) => { log(`critique: no browser for labelled sheets (${String(err.message).split('\n')[0]})`); return null; });
  closers.push(async () => { const b = await browserTask; if (b) await b.close(); }); // registered now: a later failure still closes it
  const timelineTask = browserTask.then((b) => filmTimeline(b, root, fmt));
  const loudTask = info.audio ? measureLoudness(root, file) : Promise.resolve(null);
  // The container's audio length (MP4 edit list), not decoded samples: AAC decodes whole 1024-sample frames.
  const aDur = info.audio ? (mp4Durations(file)?.audio?.duration ?? st.audio?.duration ?? null) : null;
  const silenceTask = info.audio ? audioGaps(root, file, cfg, { duration: aDur ?? dur }).catch((err) => ({ skipped: true, reason: `silence check failed: ${String(err.message).split('\n')[0]}` })) : Promise.resolve(null);
  const w = 160;
  const h = even((w * info.video.height) / info.video.width);
  const an = new Analyzer({ fps, frames: range.toFrame, crit, noise: VIDEO_NOISE, k0: range.fromFrame });
  const decTask = readFrames(root, file, { width: w, height: h, scene: 0.3, onFrame: (buf, k) => { if (k >= range.fromFrame && k < range.toFrame) an.push(buf, k, w, h); } }).then((d) => { lap(`metrics decode of ${range.frames} frames`); return d; });
  const [dec, live, L, silence] = await Promise.all([decTask, timelineTask, loudTask, silenceTask]);
  const browser = await browserTask;
  const liveShots = (live?.shots ?? []).filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.from < dur);
  const bounds = [0, ...dec.cuts.filter((t) => t > 0.05 && t < dur - 0.05), dur];
  const allShots = liveShots.length ? liveShots : bounds.slice(1).map((to, i) => ({ name: `cut ${i + 1}`, from: round(bounds[i]), to: round(to) }));
  const fileCues = readCues(root);
  const allCues = fileCues.length ? fileCues : (live?.cues ?? []).filter((c) => Number.isFinite(c.t));
  const beatsJson = readJSON(path.join(root, 'audio', 'beats.json'), null);
  const grid = live?.grid?.beats?.length ? live.grid : beatsJson?.beats?.length ? beatsJson : { bpm: cfg.bpm, offset: 0 };
  const beats = beatTimes(grid, dur, cfg);
  const downbeats = Array.isArray(grid.downbeats) && grid.downbeats.length ? grid.downbeats.filter((t) => t >= 0 && t < dur) : beats.filter((_, i) => i % (cfg.beatsPerBar || 4) === 0);
  // A range review sees the shots that overlap it, the cues and beats inside it.
  const shots = range.full ? allShots : allShots.filter((s) => s.to > range.from + 1e-9 && s.from < range.to - 1e-9);
  const cues = range.full ? allCues : allCues.filter((c) => inRange(c.t));
  const beatsR = range.full ? beats : beats.filter(inRange);
  Object.assign(res, { shots, shotsFrom: liveShots.length ? 'live film' : 'scene detection', cutsDetected: dec.cuts, cues: cues.length, cuesFrom: fileCues.length ? 'audio/cues.json' : live ? 'live film' : null, beats: beatsR.length });
  const px = an.finish({ shots, cues, beats });
  res.determinism = { skipped: true, reason: 'video mode (determinism needs the live film)' };
  res.fonts = { available: false, skipped: true, reason: 'video mode (glyph coverage needs the live film: run node tools/critique.mjs without --video)', entries: [], pass: true };
  res.loop = !cfg.loop ? { enabled: false }
    : range.full ? { ...loopVerdict(px.seam, null, crit), note: 'video: no hashes, continuity only' }
      : { enabled: false, reason: 'range', note: 'a --from/--to review does not include the end of the film: the loop seam is not checked' };

  // Tiles: decode only the frames the sheets need, at 360 px.
  const portrait = info.video.height > info.video.width;
  const kOf = (t) => Math.min(N - 1, Math.max(0, Math.round(t * fps)));
  const center = flags.stripAt != null ? kOf(flags.stripAt) : px.stripCenter;
  const explicit = flags.stripAt != null; // the automatic strip stays inside the reviewed range; --strip-at is honoured wherever it points
  const nStrip = Math.min(12, explicit ? N : range.frames);
  const [lo, hi] = explicit ? [0, N] : [range.fromFrame, range.toFrame];
  const k0 = Math.max(lo, Math.min(hi - nStrip, center - 5));
  const seconds = Array.from({ length: Math.max(1, Math.ceil(dur - 0.5)) }, (_, k) => k + 0.5).filter((t) => t < dur);
  const phoneTimes = seconds.filter(inRange);
  const midK = kOf((range.from + range.to) / 2);
  const want = {
    contact: beatsR.length ? beatsR.map(kOf) : [kOf(range.from)],
    shots: shots.length ? shots.map((s) => kOf((Math.max(s.from, range.from) + Math.min(s.to, range.to, dur)) / 2)) : [midK],
    phone: phoneTimes.length ? phoneTimes.map(kOf) : [midK],
    strip: Array.from({ length: nStrip }, (_, i) => k0 + i),
  };
  const all = [...new Set(Object.values(want).flat())].sort((a, b) => a - b);
  const tw = 360;
  const th = even((tw * info.video.height) / info.video.width);
  const pngs = new Map();
  await readFrames(root, file, { width: tw, height: th, frames: all, onFrame: (buf, i) => pngs.set(all[i], encodePNG(buf, tw, th)) });
  lap(`${pngs.size} tiles decoded`);
  const beatIdx = (t) => { let n = null; for (let i = 0; i < beats.length && beats[i] <= t + 1e-4; i++) n = i; return n; };
  const shotAt = (t) => allShots.find((s) => t >= s.from - 1e-9 && t < s.to - 1e-9)?.name ?? null;
  const lab = (k) => [fmtTime(k / fps), beatIdx(k / fps) == null ? null : `beat ${beatIdx(k / fps)}`, shotAt(k / fps) ? `shot ${shotAt(k / fps)}` : null].filter(Boolean).join(' · ');
  const rangeNote = range.full ? '' : ` · ${fmtTime(range.from)}–${fmtTime(range.to)}`;
  const thinned = (n, total) => (n < total ? `${n} of ${total}, thinned` : String(total));
  const images = {};
  const pages = {};
  const stripW = portrait ? 240 : 320;
  const specs = [
    ['contact', want.contact, { width: 270, cols: 6, title: (n) => `${cfg.title} · ${res.video} · one still per beat (${thinned(n, beatsR.length || 1)})${rangeNote}` }, lab],
    ['shots', want.shots, { width: 270, cols: 6, title: () => `${res.video} · shot midpoints (${res.shotsFrom})${rangeNote}` }, lab],
    ['phone', want.phone, { width: 360, cols: portrait ? 5 : 4, title: (n) => `${res.video} at 360 px wide · one still per second (${thinned(n, phoneTimes.length || 1)})${rangeNote}` }, lab],
    ['strip', want.strip, { width: stripW, cols: 6, title: () => `${nStrip} consecutive frames ${fmtTime(k0 / fps)}–${fmtTime((k0 + nStrip - 1) / fps)}${flags.stripAt != null ? '' : ' (most motion)'}` }, (k) => `f${k} ${fmtTime(k / fps)}${Number.isFinite(an.d[k]) ? ` Δ${an.d[k].toFixed(1)}` : ''}`],
  ];
  await Promise.all(specs.map(async ([base, ks, opt, label]) => {
    const items = [...new Set(ks)].filter((k) => pngs.has(k)).map((k) => ({ t: k / fps, png: pngs.get(k), label: label(k) }));
    if (!items.length) { dropSheet(outDir, base); return; }
    const made = await makeSheetPages({ root, cfg, browser, items, cols: Math.min(opt.cols, items.length), width: opt.width, title: opt.title(items.length), maxHeight: flags.pageHeight });
    saveSheet(outDir, base, made, items, images, pages);
  }));
  lap('sheets written');
  res.strip = { from: round(k0 / fps), frames: want.strip.length, auto: flags.stripAt == null };
  const A = cfg.audio;
  if (info.audio && L) {
    res.audio = { present: true, codec: info.audio.codec, sampleRate: info.audio.sampleRate, channels: info.audio.channels, I: L.I, TP: L.TP, LRA: L.LRA, target: A.lufs, tol: A.lufsTolerance, truePeak: A.truePeak,
      duration: round(aDur, 4), videoDuration: round(dur, 4),
      pass: Number.isFinite(L.I) && Math.abs(L.I - A.lufs) <= A.lufsTolerance && Number.isFinite(L.TP) && L.TP <= A.truePeak + 0.05 };
    if (silence && !silence.skipped) {
      // A range review reports the gaps that touch its range; loudness above is always the whole file.
      const touches = (g) => g.to > range.from + 1e-9 && g.from < range.to - 1e-9;
      res.audio.silence = { ...silence, gaps: range.full ? silence.gaps : silence.gaps.filter(touches) };
    } else res.audio.silence = silence ?? { skipped: true, reason: 'no audio stream' };
    if (!range.full) res.audio.scope = 'loudness and true peak are measured on the whole file; silent spans are those touching the range';
  } else res.audio = { present: false, pass: false };
  Object.assign(res, { images, pages, px, sync: syncMetrics(cues, beats, downbeats, range.full ? shots : shots.filter((s) => s.from >= range.from - 1e-9)) });
  return res;
}
