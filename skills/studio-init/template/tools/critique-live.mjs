// Live mode of tools/critique.mjs: the film in headless Chrome. A pixel pass (frame differences, dead spans, pops, corners,
// borders, frame 0), the determinism passes, the glyph preflight (critique-fonts.mjs), the loop seam and the paged evidence
// sheets. The metric maths is in critique-metrics.mjs; critique.mjs drives this and writes metrics.json / metrics.md.
import os from 'node:os';
import path from 'node:path';
import { FORMATS, startServer, launchBrowser, openFilm, captureFrame, writeFileAtomic, fmtTime, log, sha256 } from './studio.mjs';
import { captureStills, contactSheet, contactSheetPages } from './stills.mjs';
import { encodePNG, decodePNG, meanAbsDiff } from './refs.mjs';
import { CRIT_DEFAULTS, round, pixelScale, Analyzer, beatTimes, syncMetrics, loopClosure, loopVerdict, diffImage, resolveRange } from './critique-metrics.mjs';
import { trackedBrowser, readTextUse, fontPreflight } from './critique-fonts.mjs';
import { saveSheet, dropSheet } from './critique-sheets.mjs';
import { rngFor, shuffle } from '../lib/rng.js';

// In-page half of the pixel pass: __studio.pixels per frame, diffs computed next to the canvas so only the 10 fps
// sample frames cross the CDP pipe. State lives on window so a range can span several evaluate() calls.
async function pagePixelBatch({ ks, fps, keep, reset }) {
  const st = (reset || !window.__critique) ? (window.__critique = { p1: null, p2: null }) : window.__critique;
  const dec = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const diff = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return s / ((a.length / 4) * 3);
  };
  const keepSet = new Set(keep);
  const d = {}; const bridge = {}; const frames = {};
  for (const k of ks) {
    const b64 = await window.__studio.pixels(k / fps, 160);
    const cur = dec(b64);
    if (st.p1) d[k] = diff(st.p1.px, cur);
    if (st.p2) bridge[st.p1.k] = diff(st.p2.px, cur); // |f[a] − f[c]| belongs to the frame b between them (b = k − 1 when stride is 1)
    if (keepSet.has(k)) frames[k] = b64;
    st.p2 = st.p1;
    st.p1 = { k, px: cur };
  }
  return { d, bridge, frames };
}

/**
 * Pixel pass over analyzer frames j0..j1-1 (source frame j × stride) split across `workers` pages; feeds the Analyzer.
 * `sink.textUse` collects what each page's draw.js recorded once its frames are painted (glyph preflight).
 */
async function pixelSeries(browser, url, fmt, scale, an, { j0, j1, stride }, workers, onProgress, sink) {
  const all = [];
  for (let j = j0; j < j1; j++) all.push(j); // analyzer frame all[p] = source frame all[p] × stride
  const count = all.length;
  const sampleJs = an.sampleFrames(j1);
  const keep = new Set([...sampleJs, j1 - 1]);
  const W = Math.max(1, Math.min(workers, Math.floor(count / 60) || 1));
  const per = Math.ceil(count / W);
  const merged = { d: {}, bridge: {}, frames: {} };
  let done = 0;
  await Promise.all(Array.from({ length: W }, async (_, w) => {
    const a = w * per;
    const b = Math.min(count, a + per);
    if (a >= b) return;
    const film = await openFilm(browser, url, { format: fmt, scale });
    try {
      const range = [];
      for (let p = Math.max(0, a - 2); p < b; p++) range.push(all[p]); // 2 frames of overlap for d and bridge at the seam
      for (let i = 0; i < range.length; i += 60) {
        const part = range.slice(i, i + 60);
        const r = await film.page.evaluate(pagePixelBatch, { ks: part.map((j) => j * stride), fps: an.fps * stride, keep: part.filter((j) => keep.has(j)).map((j) => j * stride), reset: i === 0 });
        for (const [k, v] of Object.entries(r.d)) merged.d[Number(k) / stride] = v;
        for (const [k, v] of Object.entries(r.bridge)) merged.bridge[Number(k) / stride] = v;
        for (const [k, v] of Object.entries(r.frames)) merged.frames[Number(k) / stride] = v;
        done += part.filter((j) => j >= all[a]).length;
        onProgress?.(done, count);
      }
      if (film.errors.page.length) throw new Error(`page error during the pixel pass: ${film.errors.page[0]}`);
      sink?.textUse.push(await readTextUse(film.page));
    } finally { await film.context.close().catch(() => {}); }
  }));
  const bufs = new Map(Object.entries(merged.frames).map(([j, b64]) => [Number(j), Buffer.from(b64, 'base64')]));
  const w = 160;
  const h = bufs.get(j0).length / 4 / w;
  an.ingest({ d: merged.d, bridge: merged.bridge, samples: sampleJs.map((j) => ({ k: j, buf: bufs.get(j) })), last: bufs.get(j1 - 1), count: j1, w, h });
}

/** DOM films (capture 'page'): screenshots decoded in Node; slower, so 10 fps only. Analyzer frame j = source frame j × step. */
async function pixelSeriesPage(browser, url, fmt, scale, an, { j0, j1, stride: step }, fps, onProgress, sink) {
  const film = await openFilm(browser, url, { format: fmt, scale });
  try {
    for (let j = j0; j < j1; j++) {
      const img = decodePNG(await captureFrame(film.page, { ...film.meta, capture: 'page' }, (j * step) / fps));
      an.push(img.data, j, img.width, img.height);
      onProgress?.(j - j0 + 1, j1 - j0);
    }
    sink?.textUse.push(await readTextUse(film.page));
  } finally { await film.context.close().catch(() => {}); }
}

async function hashes(page, meta, times) {
  if (meta.capture === 'page') {
    const out = [];
    for (const t of times) out.push(sha256(decodePNG(await captureFrame(page, meta, t)).data));
    return out;
  }
  const out = [];
  for (let i = 0; i < times.length; i += 40) {
    out.push(...await page.evaluate(async (ts) => { const r = []; for (const t of ts) r.push(await window.__studio.hash(t)); return r; }, times.slice(i, i + 40)));
  }
  return out;
}

/**
 * Hash times straddling every shot boundary and cue (±1 frame): A in order, B shuffled (same page), C fresh page. A range
 * review (k0, k1) samples only frames k0 <= k < k1, boundaries and cues inside it included.
 */
async function determinism(browser, url, fmt, meta, first, { shots, cues, N, fps, k0 = 0, k1 = N }) {
  const M = k1 - k0;
  const ks = new Set([k0, k0 + Math.floor(M / 5), k0 + Math.floor(M / 3), k0 + Math.floor(M / 2), k1 - 1]);
  for (let i = 1; i < 24; i++) ks.add(k0 + Math.floor((i * (M - 1)) / 24)); // even coverage between boundaries
  for (const b of [...shots.flatMap((s) => [s.from, s.to]), ...cues.map((c) => c.t)]) {
    const c = Math.round(b * fps);
    for (const k of [c - 1, c, c + 1]) if (k >= k0 && k < k1) ks.add(k);
  }
  let list = [...ks].sort((a, b) => a - b);
  if (list.length > 240) list = Array.from({ length: 240 }, (_, i) => list[Math.round((i * (list.length - 1)) / 239)]);
  const times = list.map((k) => k / fps);
  const order = shuffle(rngFor('critique-determinism', fmt), times.map((_, i) => i));
  const onFirst = (async () => {
    const A = await hashes(first.page, meta, times);
    const Bv = await hashes(first.page, meta, order.map((i) => times[i]));
    const B = new Array(times.length);
    order.forEach((i, j) => { B[i] = Bv[j]; });
    return [A, B];
  })();
  const onFresh = (async () => {
    const fresh = await openFilm(browser, url, { format: fmt, scale: 1 });
    try { return (await hashes(fresh.page, meta, [...times].reverse())).reverse(); } finally { await fresh.context.close().catch(() => {}); }
  })();
  const [[A, B], C] = await Promise.all([onFirst, onFresh]);
  const mismatches = [];
  times.forEach((t, i) => { if (A[i] !== B[i] || A[i] !== C[i]) mismatches.push({ t: round(t, 4), frame: list[i], inOrder: A[i].slice(0, 12), shuffled: B[i].slice(0, 12), freshPage: C[i].slice(0, 12) }); });
  return { skipped: false, samples: times.length, passes: ['in order', 'shuffled (seeded)', 'fresh page, reverse order'], mismatches, pass: mismatches.length === 0 };
}

// In-page half of the loop check (canvas films): the three hashes loopClosure() needs, plus panes of the last frame,
// frame 0 and the unwrapped end state, all downscaled the same way (frame() PNG → <img> → drawImage).
async function pageLoopProbe({ dur, fps, N, w }) {
  const S = window.__studio;
  const h0 = await S.hash(0);
  const hEnd = await S.hash(dur, { wrap: false });
  const hBeyond = await S.hash(dur * 1.5, { wrap: false });
  const c = document.createElement('canvas');
  const grab = async (t, wrap) => {
    const img = new Image();
    img.src = await S.frame({ t, wrap });
    await img.decode();
    c.width = w;
    c.height = Math.max(2, 2 * Math.round((w * img.naturalHeight) / img.naturalWidth / 2));
    const g = c.getContext('2d', { willReadFrequently: true, alpha: false });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let str = '';
    for (let i = 0; i < d.length; i += 0x8000) str += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
    return { b64: btoa(str), h: c.height };
  };
  return { h0, hEnd, hBeyond, last: await grab((N - 1) / fps, true), start: await grab(0, true), end: await grab(dur, false) };
}

/** Loop probe + loop.png: last frame | t=dur unwrapped | seek(0) | |last − first| ×4 | |end − first| ×4. */
async function loopEvidence(page, sheetBrowser, { dur, fps, N }) {
  const W = 270;
  const p = await page.evaluate(pageLoopProbe, { dur, fps, N, w: W });
  const [last, start, end] = [p.last, p.start, p.end].map((x) => Buffer.from(x.b64, 'base64'));
  const h = p.start.h;
  const closure = loopClosure(p);
  const probe = closure.unwrapped ? { ...closure, endDiff: meanAbsDiff(end, start) }
    : { ...closure, note: 'the runtime ignores hash(t, { wrap: false }), so seek(dur) wraps to frame 0' };
  const tile = (buf, label) => ({ png: encodePNG(buf, W, h), label });
  const items = [tile(last, `last frame f${N - 1} ${fmtTime((N - 1) / fps)}`)];
  if (probe.unwrapped) items.push(tile(end, `t=dur unwrapped ${fmtTime(dur)}`));
  items.push(tile(start, 'seek(0) 00:00.00'), tile(diffImage(last, start), '|last − first| ×4'));
  if (probe.unwrapped) items.push(tile(diffImage(end, start), `|end − first| ×4 ${probe.hashEqual ? '(same hash)' : `Δ${probe.endDiff.toFixed(2)}`}`));
  const title = probe.unwrapped ? 'loop seam: |last − first| should look like one normal step; |end − first| should be black (t=dur is frame 0)'
    : 'loop seam: the last frame must flow into the first (no unwrapped hash: continuity only)';
  return { probe, png: await contactSheet(sheetBrowser, items, { cols: items.length, width: W, title }) };
}

// `closers`: the CLI closes the browser after writing the results (Chrome's profile cleanup can take many seconds).
export async function critiqueLive(root, cfg, fmt, flags, outDir, closers) {
  const crit = { ...CRIT_DEFAULTS, ...cfg.critique };
  const server = await startServer(root);
  closers.push(() => server.close());
  const { browser, via, version } = await launchBrowser(root, cfg);
  closers.push(() => browser.close());
  const tracked = trackedBrowser(browser); // the pixel-pass pages record what they draw (glyph preflight)
  const images = {};
  const pages = {};
  const res = { mode: 'live', browser: { via, version } };
  const t0 = Date.now();
  const lap = (what) => log(`critique: ${what} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const first = await openFilm(tracked, server.url, { format: fmt, scale: 1 });
  const meta = first.meta;
  const dur = Number.isFinite(meta.duration) ? meta.duration : cfg.duration;
  const fps = Number(meta.fps) > 0 ? meta.fps : cfg.fps;
  const N = Math.max(1, Math.round(dur * fps));
  const range = resolveRange(flags, { duration: dur, fps, frames: N });
  const inRange = (t) => t >= range.from - 1e-9 && t < range.to - 1e-9;
  const info = await first.page.evaluate(() => ({ cues: window.__studio.cues(), shots: window.__studio.shots(), grid: window.__studio.grid }));
  const shots = (info.shots || []).filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to));
  const cues = (info.cues || []).filter((c) => Number.isFinite(c.t));
  const beats = beatTimes(info.grid, dur, cfg);
  const downbeats = Array.isArray(info.grid?.downbeats) ? info.grid.downbeats.filter((t) => t >= 0 && t < dur) : [];
  // A range review sees the shots that overlap it, the cues and beats inside it.
  const shotsR = range.full ? shots : shots.filter((s) => s.to > range.from + 1e-9 && s.from < range.to - 1e-9);
  const cuesR = range.full ? cues : cues.filter((c) => inRange(c.t));
  const beatsR = range.full ? beats : beats.filter(inRange);
  const capture = meta.capture === 'page' ? 'page' : 'canvas';
  Object.assign(res, { film: { title: meta.title ?? cfg.title, duration: dur, fps, frames: N, width: meta.width, height: meta.height, loop: !!(meta.loop ?? cfg.loop), capture, bpm: info.grid?.bpm ?? cfg.bpm, gridSource: info.grid?.source ?? null }, range, shots: shotsR, cues: cuesR.length, beats: beatsR.length });
  const workers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 3), Math.ceil(range.frames / 400)));
  const portrait = FORMATS[fmt].h > FORMATS[fmt].w;
  const common = { format: fmt, browser, serverUrl: server.url };
  const rangeNote = range.full ? '' : ` · ${fmtTime(range.from)}–${fmtTime(range.to)}`;
  const mid = (range.from + range.to) / 2;
  const sheet = async (base, times, { width, cols, title, relabel, max = 120 }) => {
    let items = await captureStills(root, cfg, { ...common, times, width, max });
    if (!items.length) { dropSheet(outDir, base); return; }
    if (relabel) items = items.map(relabel);
    const head = typeof title === 'function' ? title(items.length) : title;
    const made = await contactSheetPages(browser, items, { cols: Math.min(cols, items.length), width, title: head, maxHeight: flags.pageHeight });
    saveSheet(outDir, base, made, items, images, pages);
    lap(`${base} (${items.length} stills, ${made.length} page${made.length === 1 ? '' : 's'})`);
  };
  const thinned = (n, total) => (n < total ? `${n} of ${total}, thinned` : String(total));

  // Phase 1 (concurrent): pixel metrics on small pages, determinism on full-size pages, the three paged sheets.
  const stride = capture === 'page' ? Math.max(1, Math.round(fps / 10)) : Math.max(1, Math.ceil(range.frames / 7200));
  const span = { j0: Math.floor(range.fromFrame / stride), j1: Math.ceil(range.toFrame / stride), stride };
  const an = new Analyzer({ fps: fps / stride, frames: span.j1, crit, k0: span.j0 });
  // Canvas films: half size or more, so glyph snapping on a small CPU canvas cannot fake pops (critique-metrics.mjs).
  const scale = capture === 'page' ? Math.min(1, Math.max(0.1, 320 / FORMATS[fmt].w)) : pixelScale(FORMATS[fmt].w);
  let lastPct = -1;
  const progress = (k, n) => { const p = Math.floor((k / n) * 4); if (p !== lastPct && p < 4) { lastPct = p; log(`critique: pixel pass ${Math.round((k / n) * 100)}%`); } };
  const sink = { textUse: [] };
  const pixelTask = (capture === 'page' ? pixelSeriesPage(tracked, server.url, fmt, scale, an, span, fps, progress, sink) : pixelSeries(tracked, server.url, fmt, scale, an, span, workers, progress, sink))
    .then(() => lap(`pixel metrics over ${an.count - span.j0} frames${range.full ? '' : ` (${fmtTime(range.from)}–${fmtTime(range.to)})`}`));
  const detTask = flags.determinism === false ? Promise.resolve({ skipped: true, reason: '--no-determinism' })
    : determinism(browser, server.url, fmt, meta, first, { shots: shotsR, cues: cuesR, N, fps, k0: range.fromFrame, k1: range.toFrame }).then((r) => { lap(`determinism ${r.samples} times × 3 passes, ${r.mismatches.length} mismatch(es)`); return r; });
  const seconds = Array.from({ length: Math.max(1, Math.ceil(dur - 0.5)) }, (_, k) => k + 0.5).filter((t) => t < dur);
  const phoneTimes = seconds.filter(inRange);
  const sheetTask = Promise.all([
    sheet('contact', beatsR.length ? beatsR : [range.from], { width: 270, cols: 6, title: (n) => `${res.film.title} · ${fmt} · one still per beat (${thinned(n, beatsR.length)})${rangeNote}` }),
    sheet('shots', shotsR.length ? shotsR.map((s) => (Math.max(s.from, range.from) + Math.min(s.to, range.to)) / 2) : [mid], { width: 270, cols: 6, title: (n) => `${res.film.title} · ${fmt} · shot midpoints (${thinned(n, shotsR.length || 1)})${rangeNote}` }),
    sheet('phone', phoneTimes.length ? phoneTimes : [mid], { width: 360, cols: portrait ? 5 : 4, title: (n) => `${fmt} at 360 px wide · one still per second (${thinned(n, phoneTimes.length || 1)})${rangeNote}` }),
  ]);
  const [, det] = await Promise.all([pixelTask, detTask, sheetTask]);
  res.determinism = det;
  // Every frame of the range is painted now (the pixel pass on its own pages, determinism on `first`): ask each page what it drew.
  sink.extra = [await readTextUse(first.page)];
  res.fonts = await fontPreflight(first.page, sink);
  lap(res.fonts.skipped ? res.fonts.reason : `glyph coverage of ${res.fonts.faces} font spec(s): ${res.fonts.entries.filter((e) => !e.pass).length} with missing glyphs`);
  const px = an.finish({ shots: shotsR, cues: cuesR, beats });
  if (stride > 1) px.pops.note = capture === 'page' ? 'DOM film: sampled at 10 fps from screenshots' : `sampled every ${stride} frames (long film)`;

  // Phase 2: loop seam and the strip (needs the motion peak from phase 1).
  if (res.film.loop && range.full) {
    let probe = { unwrapped: false, hashEqual: null, note: 'DOM film: screenshots wrap like seek()' };
    if (capture !== 'page') { // the probe and the panel read canvas pixels; DOM films get the continuity metric only
      const ev = await loopEvidence(first.page, browser, { dur, fps, N });
      probe = ev.probe;
      writeFileAtomic(path.join(outDir, 'loop.png'), ev.png);
      images.loop = 'loop.png';
    }
    res.loop = { ...loopVerdict(px.seam, probe, crit), note: probe.note ?? null };
  } else if (res.film.loop) res.loop = { enabled: false, reason: 'range', note: 'a --from/--to review does not include the end of the film: the loop seam is not checked' };
  else res.loop = { enabled: false };
  if (!images.loop) dropSheet(outDir, 'loop'); // a loop.png of an earlier run (whole film) must not sit next to this run's metrics
  await first.context.close().catch(() => {});
  const center = flags.stripAt != null ? Math.round(flags.stripAt * fps) : px.stripCenter * stride;
  // The automatic strip stays inside the reviewed range; an explicit --strip-at is honoured wherever it points.
  const explicit = flags.stripAt != null;
  const nStrip = Math.min(12, explicit ? N : range.frames);
  const [lo, hi] = explicit ? [0, N] : [range.fromFrame, range.toFrame];
  const k0 = Math.max(lo, Math.min(hi - nStrip, center - 5));
  const stripKs = Array.from({ length: nStrip }, (_, i) => k0 + i);
  const stripW = portrait ? 240 : 320;
  await sheet('strip', stripKs.map((k) => k / fps), { width: stripW, cols: 6, title: `${nStrip} consecutive frames ${fmtTime(k0 / fps)}–${fmtTime((k0 + nStrip - 1) / fps)}${flags.stripAt != null ? '' : ' (most motion)'}`,
    relabel: (it) => { const k = Math.round(it.t * fps); const d = stride === 1 ? an.d[k] : NaN; return { ...it, label: `f${k} ${fmtTime(it.t)}${Number.isFinite(d) ? ` Δ${d.toFixed(1)}` : ''}` }; } });
  res.strip = { from: round(k0 / fps), frames: stripKs.length, auto: flags.stripAt == null };
  const shotsSync = range.full ? shots : shotsR.filter((s) => s.from >= range.from - 1e-9);
  Object.assign(res, { images, pages, px, sync: syncMetrics(cuesR, beats, downbeats, shotsSync), audio: { skipped: true, reason: `live mode: run with --video after npm run mix (writes out/review/${fmt}/video/)` } });
  return res;
}
