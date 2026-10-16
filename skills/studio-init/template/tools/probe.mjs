#!/usr/bin/env node
// Numeric motion QA: the film's c.probe() series, its checks (lib/checks.js), a speed graph and an onion skin.
// Pixels say THAT something moved; probes say by how much, on which frame. A scene records numbers with
// c.probe(name, value) (a foot's height, a lid angle, a light's level); the film's `checks` assert them (a value at a
// frame, a range, the frame a threshold is crossed, no velocity kink). This tool paints every frame once in headless
// Chrome (at a small canvas: probes are logical values, independent of the render scale) and writes, into
// out/review/<fmt>/:
//   probes.json   every series, every check result, the loop-seam analysis (loop films, whole film only)
//   motion.png    the speed graph: one row per probe channel, value (light) and velocity (accent, own scale, dashed zero
//                 line), shot boundaries and beats, check markers (green pass, red fail), a frame axis
//   onion.png     with --onion A:B[:STEP]: frames A..B s every STEP frames composited oldest-faintest onto the background
//
//   node tools/probe.mjs [--format f] [--from S] [--to S] [--fps N] [--channels a,b] [--onion A:B[:STEP]] [--json]
//
// Exit code 1 when a check or the loop seam fails (like gate and deliver), 0 otherwise; a film without probes says so and
// exits 0. The critique runs the same checks on its own when the film defines any (metrics checks, P0 problems).
import fs from 'node:fs';
import path from 'node:path';
import { FORMATS, UsageError, projectRoot, loadConfig, parseArgs, usage, main, startServer, launchBrowser, openFilm, dataUrlToBuffer,
  writeJSON, writeFileAtomic, ensureDir, log, fmtTime, isMainModule } from './studio.mjs';
import { resolveRange } from './critique-metrics.mjs';
import { reviewDir, relDir } from './critique-report.mjs';
import { evaluateChecks, seamAnalysis, seriesStats } from '../lib/checks.js';

const MAX_ROWS = 12;
const MAX_ONION = 40;

const SPEC = {
  format: { type: 'string', alias: 'f', arg: '<fmt>', desc: 'Format to probe (default: primaryFormat)' },
  from: { type: 'number', arg: '<sec>', desc: 'Probe only from this time on (the loop seam is checked only for the whole film)' },
  to: { type: 'number', arg: '<sec>', desc: 'Probe only up to this time' },
  fps: { type: 'number', arg: '<n>', desc: 'Sampling rate (default: the film fps; check frames always refer to the film fps)' },
  channels: { type: 'list', arg: '<a,b>', desc: `Probe channels on motion.png (exact names, or a prefix such as "cursor" for cursor.x and cursor.y); default: the checked probes first, at most ${MAX_ROWS} rows` },
  onion: { type: 'string', arg: '<A:B[:STEP]>', desc: 'Also write onion.png: frames from A to B seconds, every STEP frames (default 2)' },
  json: { type: 'boolean', desc: 'Print one JSON result line on stdout' },
};
const TITLE = `Usage: node tools/probe.mjs [--format f] [--from S] [--to S] [--fps N] [--channels a,b] [--onion A:B[:STEP]] [--json]

Paints every frame once, collects the c.probe(name, value) series, evaluates the film's checks and writes
out/review/<fmt>/probes.json and motion.png (speed graph); --onion adds onion.png. Exit 1 when a check or the loop seam fails.`;

/** --onion "A:B[:STEP]" → { from, to, step }; seconds, step in frames. */
export function parseOnion(spec) {
  const parts = String(spec).split(':').map((x) => x.trim());
  if (parts.length < 2 || parts.length > 3) throw new UsageError(`--onion expects A:B or A:B:STEP (seconds, frames), got "${spec}"`);
  const [from, to] = parts.slice(0, 2).map(Number);
  const step = parts.length === 3 ? Number(parts[2]) : 2;
  if (!(from >= 0) || !(to > from)) throw new UsageError(`--onion: need 0 <= A < B seconds (got "${spec}")`);
  if (!(Number.isInteger(step) && step >= 1)) throw new UsageError(`--onion: STEP is a whole number of frames >= 1 (got "${parts[2]}")`);
  return { from, to, step };
}

/** Channels for the graph: requested names (exact or prefix) or the checked probes first, then the rest; at most MAX_ROWS. */
export function pickChannels(names, checks, wanted) {
  if (wanted && wanted.length) {
    const out = [];
    for (const w of wanted) for (const n of names) if ((n === w || n.startsWith(`${w}.`)) && !out.includes(n)) out.push(n);
    return { rows: out.slice(0, MAX_ROWS), more: Math.max(0, out.length - MAX_ROWS), missing: wanted.filter((w) => !names.some((n) => n === w || n.startsWith(`${w}.`))) };
  }
  const checked = [...new Set(checks.map((c) => c.probe))].filter((p) => names.includes(p));
  const rest = names.filter((n) => !checked.includes(n));
  const all = [...checked, ...rest];
  return { rows: all.slice(0, MAX_ROWS), more: Math.max(0, all.length - MAX_ROWS), missing: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Collection (shared with the critique)

/**
 * Paint every frame of [from, to) once on a small page and return the probe series (NaN = not recorded) with the film's
 * checks, shots and grid. `opened` = an already open film (its page is used as is), else one is opened at a small scale.
 */
export async function collectProbes(browser, url, fmt, { from = 0, to = null, fps = null, opened = null } = {}) {
  const f = FORMATS[fmt];
  const film = opened ?? await openFilm(browser, url, { format: fmt, scale: Math.min(1, Math.max(0.1, 270 / f.w)) });
  try {
    const info = await film.page.evaluate(() => {
      const S = window.__studio;
      if (typeof S.probeRun !== 'function') return { unsupported: true };
      return { checks: S.checks(), shots: S.shots(), grid: S.grid, meta: S.meta };
    });
    if (info.unsupported) return { unsupported: true, reason: 'lib/runtime.js has no probeRun (an older runtime): update lib/ from the plugin template' };
    const dur = info.meta.duration;
    const filmFps = info.meta.fps;
    const run = await film.page.evaluate((o) => window.__studio.probeRun(o), { from, to: to ?? dur, fps: fps ?? filmFps });
    if (film.errors.page.length) throw new Error(`page error while probing: ${film.errors.page[0]}`);
    const series = Object.fromEntries(Object.entries(run.series).map(([k, v]) => [k, v.map((x) => (x == null ? NaN : x))]));
    return { fps: run.fps, filmFps, k0: run.k0, frames: run.frames, total: run.total, names: run.names, series, checks: info.checks, shots: info.shots, grid: info.grid, meta: info.meta, dur };
  } finally {
    if (!opened) await film.context.close().catch(() => {});
  }
}

/** Checks + loop seam of a collection. full = the collection covers the whole film. */
export function judgeProbes(col, { full, loop }) {
  const results = evaluateChecks(col.checks, col.series, { fps: col.fps, filmFps: col.filmFps, k0: col.k0, frames: col.frames, shots: col.shots });
  const seam = loop && full && col.names.length ? seamAnalysis(col.series, { fps: col.fps }) : [];
  const failed = results.filter((r) => r.pass === false).length + seam.filter((s) => !s.pass).length;
  return { results, seam, failed, passed: results.filter((r) => r.pass === true).length, skipped: results.filter((r) => r.pass === null).length };
}

/** The critique's `checks` object (metrics.json) from a judged collection. */
export function checksSummary(col, j) {
  return { total: col.checks.length, pass: j.failed === 0, passed: j.passed, failed: j.results.filter((r) => r.pass === false).length, skipped: j.skipped,
    fps: col.fps, frames: col.frames, probes: col.names, results: j.results, ...(j.seam.length ? { seam: j.seam } : {}) };
}

/** P0 findings of failing checks and seam probes, in the critique's finding shape. */
export function checkFindings(checks) {
  if (!checks) return [];
  const out = [];
  for (const r of checks.results.filter((x) => x.pass === false)) out.push({ severity: 'P0', t: Number.isFinite(r.t) ? r.t : null, text: `check failed: "${r.name}" (${r.kind} ${r.probe}): ${r.detail}. Fix the motion or the check; graph: node tools/probe.mjs (motion.png)`, metric: 'checks' });
  for (const s of (checks.seam ?? []).filter((x) => !x.pass)) out.push({ severity: 'P0', t: null, text: `loop seam of probe ${s.probe}: ${s.detail}`, metric: 'checks' });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// In-page drawing (runs in the film page: same fonts, no dependencies)

async function pageMotionGraph(o) {
  const { rows, k0, frames, fps, shots, beats, marks, title, sub } = o;
  const fmt = (x) => (Number.isFinite(x) ? (Math.abs(x) >= 1000 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(3)) : '—');
  const W = 1600;
  const HEAD = 104;
  const ROW = 126;
  const AXIS = 46;
  const LX = 248;
  const RX = W - 28;
  const H = HEAD + rows.length * ROW + AXIS;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const F = (px, w = 500) => `${w} ${px}px Inter, "Segoe UI", system-ui, sans-serif`;
  const BG = '#141413'; const FG = '#ECEAE3'; const DIM = '#8A8993'; const GRID = '#2A2A28'; const ACC = '#D97757'; const OK = '#5BD38A'; const BAD = '#FF5A5A';
  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  const X = (k) => LX + ((k - k0 + 0.5) / frames) * (RX - LX);
  g.fillStyle = FG; g.font = F(22, 600); g.textBaseline = 'alphabetic';
  g.fillText(title, 24, 34);
  g.font = F(15); g.fillStyle = DIM;
  g.fillText(sub, 24, 60);
  // legend
  const lg = (x, col, dash, label) => { g.strokeStyle = col; g.lineWidth = 3; g.setLineDash(dash); g.beginPath(); g.moveTo(x, 54); g.lineTo(x + 34, 54); g.stroke(); g.setLineDash([]); g.fillStyle = DIM; g.fillText(label, x + 42, 60); };
  lg(W - 560, FG, [], 'value'); lg(W - 440, ACC, [], 'velocity /s'); g.fillStyle = OK; g.beginPath(); g.arc(W - 280, 54, 6, 0, 7); g.fill(); g.fillStyle = DIM; g.fillText('check pass', W - 266, 60);
  g.fillStyle = BAD; g.beginPath(); g.arc(W - 160, 54, 6, 0, 7); g.fill(); g.fillStyle = DIM; g.fillText('check fail', W - 146, 60);
  g.fillStyle = DIM; g.font = F(13); g.fillText('shots ↓', 24, HEAD - 8);
  const top = HEAD;
  const bottom = HEAD + rows.length * ROW;
  // beats (faint) and shot boundaries (with names), across every row
  g.strokeStyle = GRID; g.lineWidth = 1;
  for (const b of beats) { const x = LX + ((b * fps - k0) / frames) * (RX - LX); if (x < LX || x > RX) continue; g.beginPath(); g.moveTo(x + 0.5, top); g.lineTo(x + 0.5, bottom); g.stroke(); }
  g.font = F(13);
  for (const s of shots) {
    const x = LX + ((s.from * fps - k0) / frames) * (RX - LX);
    if (x < LX - 1 || x > RX) continue;
    g.strokeStyle = '#55544F'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, top - 6); g.lineTo(x, bottom); g.stroke();
    g.fillStyle = DIM; g.fillText(s.name, x + 4, top - 8);
  }
  rows.forEach((r, i) => {
    const y0 = top + i * ROW;
    const pad = 14;
    const yA = y0 + pad;
    const yB = y0 + ROW - pad;
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)'; g.fillRect(LX, y0 + 2, RX - LX, ROW - 4);
    const vals = r.values.map((v) => (v == null ? NaN : v));
    const fin = vals.filter(Number.isFinite);
    let lo = Math.min(...fin); let hi = Math.max(...fin);
    if (!(hi > lo)) { lo -= 0.5; hi += 0.5; }
    const span = hi - lo;
    const Y = (v) => yB - ((v - lo) / span) * (yB - yA);
    const vel = vals.map((v, k) => (k > 0 ? (v - vals[k - 1]) * fps : NaN));
    const vfin = vel.filter(Number.isFinite).map(Math.abs);
    const vmax = vfin.length ? Math.max(...vfin) : 0;
    const yMid = (yA + yB) / 2;
    const YV = (v) => yMid - (vmax > 0 ? v / vmax : 0) * (yB - yA) * 0.48;
    // labels
    g.fillStyle = FG; g.font = F(17, 600); g.fillText(r.name.length > 22 ? `${r.name.slice(0, 21)}…` : r.name, 24, y0 + 34);
    g.font = F(14); g.fillStyle = DIM;
    g.fillText(`value ${fmt(lo)} … ${fmt(hi)}`, 24, y0 + 60);
    g.fillStyle = ACC; g.fillText(`|v| max ${fmt(vmax)}/s`, 24, y0 + 82);
    g.fillStyle = DIM; g.fillText(r.recorded === frames ? `${frames} frames` : `${r.recorded} of ${frames} frames`, 24, y0 + 104);
    // velocity zero line + curve
    g.strokeStyle = 'rgba(217,119,87,0.45)'; g.setLineDash([6, 6]); g.lineWidth = 1; g.beginPath(); g.moveTo(LX, yMid); g.lineTo(RX, yMid); g.stroke(); g.setLineDash([]);
    const curve = (arr, map, col, w) => {
      g.strokeStyle = col; g.lineWidth = w; g.lineJoin = 'round'; g.beginPath();
      let pen = false;
      arr.forEach((v, j) => { if (!Number.isFinite(v)) { pen = false; return; } const x = X(k0 + j); const y = map(v); if (pen) g.lineTo(x, y); else g.moveTo(x, y); pen = true; });
      g.stroke();
    };
    curve(vel, YV, ACC, 1.6);
    curve(vals, Y, FG, 2.4);
    // badges: every check on this row, right-aligned at the top of the row
    const mine = marks.filter((mm) => mm.probe === r.name);
    g.font = F(13, 600); g.textAlign = 'right';
    let bx = RX - 8;
    for (const m of [...mine].reverse()) {
      const label = `${m.pass === false ? '✗' : m.pass === true ? '✓' : '–'} ${m.kind}${m.pass === false && m.frames?.length ? ` f${m.frames[0]}` : ''}`;
      const tw = g.measureText(label).width + 14;
      g.fillStyle = m.pass === false ? 'rgba(255,90,90,0.18)' : m.pass === true ? 'rgba(91,211,138,0.14)' : 'rgba(138,137,147,0.18)';
      g.fillRect(bx - tw, y0 + 6, tw, 20);
      g.fillStyle = m.pass === false ? BAD : m.pass === true ? OK : DIM;
      g.fillText(label, bx - 7, y0 + 21);
      bx -= tw + 6;
    }
    g.textAlign = 'left';
    // check markers on this row
    for (const m of mine) {
      const col = m.pass === false ? BAD : m.pass === true ? OK : DIM;
      if (m.kind === 'range') {
        const xa = Math.max(LX, X(m.k0) - 0.5 * ((RX - LX) / frames)); const xb = Math.min(RX, X(m.k1 - 1) + 0.5 * ((RX - LX) / frames));
        g.strokeStyle = col; g.lineWidth = 2; g.setLineDash([8, 5]);
        for (const b of [m.min, m.max]) if (Number.isFinite(b) && b >= lo - span * 0.05 && b <= hi + span * 0.05) { g.beginPath(); g.moveTo(xa, Y(b)); g.lineTo(xb, Y(b)); g.stroke(); }
        g.setLineDash([]);
        g.fillStyle = m.pass === false ? 'rgba(255,90,90,0.14)' : 'rgba(91,211,138,0.10)'; g.fillRect(xa, yA, xb - xa, yB - yA);
      }
      if (Number.isFinite(m.expect)) { const x = X(m.expect); g.strokeStyle = col; g.lineWidth = 2; g.setLineDash([3, 4]); g.beginPath(); g.moveTo(x, yA); g.lineTo(x, yB); g.stroke(); g.setLineDash([]); }
      for (const k of m.frames ?? []) {
        const v = vals[k - k0];
        const x = X(k);
        const y = Number.isFinite(v) ? Y(v) : yMid;
        g.fillStyle = col; g.strokeStyle = BG; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); g.stroke();
      }
    }
  });
  // frame axis
  g.strokeStyle = '#55544F'; g.lineWidth = 1; g.beginPath(); g.moveTo(LX, bottom + 1); g.lineTo(RX, bottom + 1); g.stroke();
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 300, 600, 1200, 3000, 6000];
  const st = steps.find((s) => frames / s <= 14) ?? steps[steps.length - 1];
  g.font = F(14); g.fillStyle = DIM; g.textAlign = 'center';
  for (let k = Math.ceil(k0 / st) * st; k < k0 + frames; k += st) {
    const x = X(k);
    g.beginPath(); g.moveTo(x, bottom); g.lineTo(x, bottom + 8); g.stroke();
    g.fillText(`f${k} · ${(k / fps).toFixed(2)}s`, x, bottom + 28);
  }
  g.textAlign = 'left';
  return c.toDataURL('image/png');
}

async function pageOnion({ ts, labels, title, caption }) {
  const stage = document.querySelector('canvas#stage') || document.querySelector('canvas');
  const w = stage.width; const h = stage.height;
  const g = stage.getContext('2d', { willReadFrequently: true });
  window.seek(ts[0]);
  const first = g.getImageData(0, 0, w, h).data;
  const bins = new Uint32Array(4096);
  for (let i = 0; i < first.length; i += 4) bins[((first[i] >> 4) << 8) | ((first[i + 1] >> 4) << 4) | (first[i + 2] >> 4)]++;
  let mode = 0;
  for (let b = 1; b < 4096; b++) if (bins[b] > bins[mode]) mode = b;
  let sr = 0; let sg = 0; let sb = 0; let n = 0;
  for (let i = 0; i < first.length; i += 4) { if ((((first[i] >> 4) << 8) | ((first[i + 1] >> 4) << 4) | (first[i + 2] >> 4)) !== mode) continue; sr += first[i]; sg += first[i + 1]; sb += first[i + 2]; n++; }
  const bg = [sr / n, sg / n, sb / n];
  const acc = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p++) { acc[p * 3] = bg[0]; acc[p * 3 + 1] = bg[1]; acc[p * 3 + 2] = bg[2]; }
  const TINT = [80, 165, 255];
  const M = ts.length;
  for (let j = 0; j < M; j++) {
    window.seek(ts[j]);
    const d = g.getImageData(0, 0, w, h).data;
    const age = M === 1 ? 0 : 1 - j / (M - 1); // 1 = oldest, 0 = newest
    const alpha = j === M - 1 ? 1 : 0.16 + 0.6 * (1 - age) ** 1.4;
    const tint = 0.6 * age;
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      if (Math.abs(d[i] - bg[0]) <= 24 && Math.abs(d[i + 1] - bg[1]) <= 24 && Math.abs(d[i + 2] - bg[2]) <= 24) continue;
      for (let ch = 0; ch < 3; ch++) {
        const col = d[i + ch] + (TINT[ch] - d[i + ch]) * tint;
        acc[p * 3 + ch] += (col - acc[p * 3 + ch]) * alpha;
      }
    }
  }
  const s = Math.max(1, w / 900);
  const fs = Math.round(15 * s);
  const legendH = Math.round(fs * (w < 700 ? 9.5 : 6.2));
  const c = document.createElement('canvas');
  c.width = w; c.height = h + legendH;
  const q = c.getContext('2d');
  const img = q.createImageData(w, h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) { img.data[i] = acc[p * 3]; img.data[i + 1] = acc[p * 3 + 1]; img.data[i + 2] = acc[p * 3 + 2]; img.data[i + 3] = 255; }
  q.putImageData(img, 0, 0);
  q.fillStyle = '#141413'; q.fillRect(0, h, w, legendH);
  // age ramp: oldest (faint, blue) → newest (full colour), frame numbers at both ends
  const rx = Math.round(fs * 0.9); const ry = h + Math.round(fs * 0.7); const rw = Math.min(w - 2 * rx, Math.round(fs * 16)); const rh = Math.round(fs * 0.7);
  for (let x = 0; x < rw; x++) {
    const a = 1 - x / Math.max(1, rw - 1);
    const al = 0.16 + 0.6 * (1 - a) ** 1.4;
    const col = [236 + (TINT[0] - 236) * 0.6 * a, 234 + (TINT[1] - 234) * 0.6 * a, 227 + (TINT[2] - 227) * 0.6 * a].map((v, k) => Math.round(bg[k] + (v - bg[k]) * (x === rw - 1 ? 1 : al)));
    q.fillStyle = `rgb(${col.join(',')})`; q.fillRect(rx + x, ry, 1, rh);
  }
  q.font = `500 ${fs}px Inter, system-ui, sans-serif`; q.textBaseline = 'middle'; q.fillStyle = '#8A8993';
  q.fillText(`${labels[0]}  →  ${labels[1]}`, rx + rw + fs, ry + rh / 2);
  // Word wrap, so a narrow 9:16 sheet keeps the whole caption.
  const wrap = (str, maxW) => {
    const lines = [];
    let cur = '';
    for (const word of str.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && q.measureText(next).width > maxW) { lines.push(cur); cur = word; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  let y = ry + rh + fs * 1.3;
  q.fillStyle = '#ECEAE3'; q.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  for (const line of wrap(title, w - 2 * rx)) { q.fillText(line, rx, y); y += fs * 1.3; }
  q.fillStyle = '#8A8993'; q.font = `500 ${Math.round(fs * 0.92)}px Inter, system-ui, sans-serif`;
  y += fs * 0.15;
  for (const line of wrap(caption, w - 2 * rx)) { q.fillText(line, rx, y); y += fs * 1.25; }
  return c.toDataURL('image/png');
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

async function cli(argv) {
  const { flags, positionals } = parseArgs(argv, SPEC, { title: TITLE });
  if (flags.help) { process.stdout.write(usage(TITLE, SPEC)); return 0; }
  if (positionals.length) throw new UsageError(`unexpected argument ${positionals[0]}`, usage(TITLE, SPEC));
  const root = projectRoot();
  const cfg = loadConfig(root);
  const fmt = flags.format ?? cfg.primaryFormat;
  if (!FORMATS[fmt]) throw new UsageError(`unknown format "${fmt}" (valid: ${Object.keys(FORMATS).join(', ')})`, usage(TITLE, SPEC));
  if (flags.fps != null && !(flags.fps > 0 && flags.fps <= 240)) throw new UsageError(`--fps must be in (0, 240] (got ${flags.fps})`);
  const onion = flags.onion != null ? parseOnion(flags.onion) : null;
  const outDir = ensureDir(reviewDir(root, fmt, false));
  const server = await startServer(root);
  let browser = null;
  try {
    ({ browser } = await launchBrowser(root, cfg));
    const t0 = Date.now();
    const dur = Number(cfg.duration) > 0 ? Number(cfg.duration) : 12;
    const filmFps = Number(cfg.fps) > 0 ? Number(cfg.fps) : 60;
    const range = resolveRange(flags, { duration: dur, fps: filmFps, frames: Math.max(1, Math.round(dur * filmFps)) });
    const col = await collectProbes(browser, server.url, fmt, { from: range.from, to: range.to, fps: flags.fps ?? null });
    if (col.unsupported) throw new Error(col.reason);
    const loop = !!col.meta.loop;
    const j = judgeProbes(col, { full: range.full, loop });
    log(`probe: ${col.frames} frames at ${col.fps} fps, ${col.names.length} probe channel(s), ${col.checks.length} check(s) (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    const images = {};
    const pick = pickChannels(col.names, col.checks, flags.channels);
    if (pick.missing.length) log(`probe: --channels ${pick.missing.join(', ')}: not recorded (recorded: ${col.names.join(', ') || 'none'})`);
    const graphPage = col.names.length || onion ? await openFilm(browser, server.url, { format: fmt, scale: onion ? Math.min(1, 900 / FORMATS[fmt].w) : 0.25 }) : null;
    try {
      if (pick.rows.length) {
        const marks = j.results.filter((r) => pick.rows.includes(r.probe)).map((r) => {
          const c = col.checks.find((x) => x.name === r.name) ?? {};
          const m = { probe: r.probe, kind: r.kind, pass: r.pass, frames: r.frames ?? (Number.isFinite(r.frame) ? [r.frame] : []) };
          if (r.kind === 'event') m.expect = Math.round(Number.isFinite(c.at) ? c.at * col.fps : (c.frame * col.fps) / col.filmFps);
          if (r.kind === 'range') Object.assign(m, { k0: Math.max(col.k0, Math.ceil(c.from * col.fps - 1e-6)), k1: Math.min(col.k0 + col.frames, Math.ceil(c.to * col.fps - 1e-6)), min: c.min, max: c.max });
          return m;
        });
        const rows = pick.rows.map((name) => {
          const st = seriesStats(col.series[name], col.fps);
          return { name, values: col.series[name].map((x) => (Number.isFinite(x) ? x : null)), recorded: st.recorded };
        });
        const beats = (col.grid?.beats ?? []).filter((b) => b >= range.from && b < range.to);
        const failN = j.results.filter((r) => r.pass === false).length;
        const data = await graphPage.page.evaluate(pageMotionGraph, { rows, k0: col.k0, frames: col.frames, fps: col.fps, shots: col.shots, beats, marks,
          title: `${cfg.title || 'film'} · ${fmt} · speed graph`,
          sub: `${fmtTime(range.from)}–${fmtTime(range.to)} · ${col.frames} frames at ${col.fps} fps · ${pick.rows.length}${pick.more ? ` of ${pick.rows.length + pick.more}` : ''} channel(s) · checks ${j.passed} pass, ${failN} fail${j.skipped ? `, ${j.skipped} skipped` : ''}` });
        writeFileAtomic(path.join(outDir, 'motion.png'), dataUrlToBuffer(data));
        images.motion = 'motion.png';
      }
      if (onion) {
        const fps = col.filmFps;
        const a = Math.round(onion.from * fps);
        const b = Math.min(Math.round(onion.to * fps), Math.max(1, Math.round(dur * fps)) - 1);
        let step = onion.step;
        while ((b - a) / step + 1 > MAX_ONION) step++;
        if (step !== onion.step) log(`probe: --onion: ${Math.floor((b - a) / onion.step) + 1} frames is too many; every ${step} frames instead (at most ${MAX_ONION})`);
        const ks = [];
        for (let k = a; k <= b; k += step) ks.push(k);
        const data = await graphPage.page.evaluate(pageOnion, {
          ts: ks.map((k) => k / fps), labels: [`f${ks[0]} ${fmtTime(ks[0] / fps)}`, `f${ks[ks.length - 1]} ${fmtTime(ks[ks.length - 1] / fps)}`],
          title: `onion skin · ${fmt} · ${ks.length} frames, every ${step} frame${step === 1 ? '' : 's'} · older = fainter and bluer, the last frame in full colour`,
          caption: 'Even spacing = constant speed · spacing that closes up at the ends = easing in / out · a sudden gap or a change of direction = a kink or a pop' });
        writeFileAtomic(path.join(outDir, 'onion.png'), dataUrlToBuffer(data));
        images.onion = 'onion.png';
      }
    } finally { if (graphPage) await graphPage.context.close().catch(() => {}); }
    const doc = { version: 1, createdBy: 'motion-studio', tool: 'probe', format: fmt, createdAt: new Date().toISOString(), range, fps: col.fps, filmFps: col.filmFps, k0: col.k0, frames: col.frames, loop,
      probes: col.names, checks: j.results, seam: j.seam, failed: j.failed, images,
      series: Object.fromEntries(Object.entries(col.series).map(([k, v]) => [k, v.map((x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null))])) };
    writeJSON(path.join(outDir, 'probes.json'), doc);
    const dir = relDir(root, outDir);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ok: j.failed === 0, format: fmt, dir, frames: col.frames, fps: col.fps, probes: col.names, checks: { total: col.checks.length, passed: j.passed, failed: j.results.filter((r) => r.pass === false).length, skipped: j.skipped }, results: j.results, seam: j.seam, images, file: `${dir}/probes.json` })}\n`);
    } else {
      const L = [];
      if (!col.names.length) L.push('probe: the film records no probes. Add c.probe(name, value) in a scene (lib/timeline.js) and checks to the film spec (lib/checks.js).');
      L.push(`probe · ${fmt} · ${col.frames} frames at ${col.fps} fps · ${col.names.length} channel(s) · checks: ${j.passed} pass, ${j.results.filter((r) => r.pass === false).length} fail${j.skipped ? `, ${j.skipped} skipped` : ''}${j.seam.length ? ` · loop seam: ${j.seam.filter((s) => !s.pass).length} of ${j.seam.length} probe(s) jump` : ''}`);
      for (const r of j.results) {
        const st = r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'skip';
        const where = Number.isFinite(r.frame) ? `f${r.frame}`.padEnd(6) : '      ';
        L.push(`  ${st}  ${where} ${r.name}: ${r.detail}`);
      }
      for (const s of j.seam.filter((x) => !x.pass)) L.push(`  FAIL  seam   ${s.probe}: ${s.detail}`);
      L.push(`wrote ${dir}/probes.json${images.motion ? `, ${dir}/motion.png` : ''}${images.onion ? `, ${dir}/onion.png` : ''}${pick.more ? ` (graph shows ${pick.rows.length} of ${pick.rows.length + pick.more} channels: --channels)` : ''}`);
      process.stdout.write(`${L.join('\n')}\n`);
    }
    return j.failed ? 1 : 0;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await Promise.resolve(server.close()).catch(() => {});
  }
}

if (isMainModule(import.meta.url)) main(() => cli(process.argv.slice(2)));
