// lib/runtime.js (browser) — THE RENDER CONTRACT (docs/ARCHITECTURE.md). boot(film) wires a film to a canvas:
//   window.seek(t)   synchronous paint of frame t (loop films wrap, others clamp to [0, duration]); seek(t, { frameT, sub,
//                    subs }) paints subframe `sub` of `subs` of the output frame at frameT (see renderFrame in timeline.js:
//                    scenes get c.t = the subframe time but c.frame / c.frameT / c.sub / c.subs of the OUTPUT frame)
//   window.__studio  { version, ready, error, meta, grid, cues(), shots(), frame(), hash(), pixels(), textUse(), coverage(),
//                    textTrack }
//   frame({ wrap: false }) / hash(t, { wrap: false }) paint the raw time clamped to [0, duration] even in a loop film,
//   so a loop check can compare hash(0) with hash(duration, { wrap: false }) (wrapped, they are the same frame).
//   textUse() / coverage(): the critique's font check. With window.__TEXT_TRACK__ === true set before the page loads (or
//   ?texttrack=1) draw.js records which characters text(), kinetic() and textWidth() handle with which font; textUse() resolves
//   [{ family, weight, style, chars }] (family = first name of the CSS list, chars = sorted unique non-whitespace characters),
//   textTrack says whether that recording is on ([] then means nothing was recorded, not that no text is drawn).
//   coverage(family, weight, style, chars) resolves { missing, checked }: the characters that face has no glyph for ('' = all
//   covered). Call both after `await window.__studio.ready`. textUse() lists what the frames painted so far drew (frame 0 is
//   painted at boot): seek() through the film before asking.
// Render mode (Playwright, ?render, window.__RENDER__) paints only on request. Preview mode adds a real-time player
// and a DOM overlay outside the canvas; every preview-only line is tagged so the determinism lint skips it.

import { buildFilm, renderFrame, filmContext } from './timeline.js';
import { FORMATS, DEFAULT_SAFE } from './layout.js';
import { loadFonts, hasFont, coverage } from './fonts.js';
import { setFontDefaults, setTextTracking, isTextTracking, getTextUse } from './draw.js';
import { clamp, loopT } from './motion.js';

const DEFAULTS = {
  title: 'Untitled Film',
  duration: 12,
  fps: 60,
  subframes: 4,
  shutter: 0.5,
  bpm: 120,
  beatsPerBar: 4,
  loop: false,
  formats: ['9x16', '1x1', '16x9'],
  primaryFormat: '9x16',
  capture: 'auto',
  safe: DEFAULT_SAFE,
  brand: { name: '', url: '', colors: { bg: '#141413', fg: '#F0EEE6', accent: '#D97757', muted: '#6C6B73' }, fonts: { display: 'Instrument Serif', ui: 'Inter' } },
  fonts: [],
  audio: {},
  critique: { cornerPct: 0.08 },
};

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}
const even = (n) => Math.max(2, 2 * Math.round(n / 2));

async function fetchJSON(url, required) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    if (!required) return null;
    throw new Error(`could not fetch ${url} (${err.message}) — serve the project over http (npm run preview); file:// blocks fetch and ES modules`);
  }
  if (!res.ok) {
    if (!required && res.status === 404) return null;
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${url} is not valid JSON: ${err.message}`);
  }
}

// Canvas text falls back silently to a system face when a family is not bundled; fail loudly instead.
async function assertBrandFonts(brand) {
  const fonts = (brand && brand.fonts) || {};
  for (const role of ['display', 'ui']) {
    const fam = fonts[role];
    if (!fam) continue;
    if (!(await hasFont(fam))) throw new Error(`brand font "${fam}" (brand.fonts.${role}) is not bundled — add it: npm run fonts -- add "${fam}:400,700"`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// SHA-256 fallback for insecure contexts (preview opened via a LAN IP); crypto.subtle is used whenever it exists.

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const ror = (x, n) => (x >>> n) | (x << (32 - n));
export function sha256js(data) {
  const len = data.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000));
  dv.setUint32(total - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      w[i] = w[i - 16] + (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) + w[i - 7] + (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10));
    }
    let [A, B, C, D, E, F, G, H] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (H + (ror(E, 6) ^ ror(E, 11) ^ ror(E, 25)) + ((E & F) ^ (~E & G)) + K256[i] + w[i]) >>> 0;
      const t2 = ((ror(A, 2) ^ ror(A, 13) ^ ror(A, 22)) + ((A & B) ^ (A & C) ^ (B & C))) >>> 0;
      H = G;
      G = F;
      F = E;
      E = (D + t1) >>> 0;
      D = C;
      C = B;
      B = A;
      A = (t1 + t2) >>> 0;
    }
    h[0] += A;
    h[1] += B;
    h[2] += C;
    h[3] += D;
    h[4] += E;
    h[5] += F;
    h[6] += G;
    h[7] += H;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}
async function sha256hex(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return sha256js(bytes);
  const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------------------------------------------------------
// Pixel access: in-page subframe accumulation (4 subframes -> 1 PNG, no tmix), hashes and downscaled RGBA.

function pixelOps(canvas, g, paint, W, H, fps) {
  const w = canvas.width;
  const h = canvas.height;
  const n = w * h * 4;
  let acc = null;
  let outImg = null;
  let out = null;
  const small = new Map();

  // Centred shutter: subframe j of `sub` sits at t + ((j + 0.5)/sub − 0.5)·shutter/fps (each clamped/wrapped by paint).
  // Scene code sees that subframe time as c.t (so motion blurs) but the OUTPUT frame as c.frame / c.frameT / c.sub / c.subs
  // (lib/timeline.js renderFrame): frame-indexed effects such as grain and stepTime() must not change between subframes.
  function accumulate(t, sub, shutter, f, wrap) {
    if (!acc) acc = new Uint32Array(n);
    else acc.fill(0);
    for (let j = 0; j < sub; j++) {
      paint(t + (((j + 0.5) / sub - 0.5) * shutter) / f, wrap, { frameT: t, sub: j, subs: sub });
      const d = g.getImageData(0, 0, w, h).data;
      for (let i = 0; i < n; i++) acc[i] += d[i];
    }
    if (!outImg) outImg = new ImageData(w, h);
    const o = outImg.data;
    const half = sub >> 1;
    for (let i = 0; i < n; i++) o[i] = ((acc[i] + half) / sub) | 0; // round-half-up mean, matches ffmpeg tmix
    return outImg;
  }
  const opts = (x, t) => (typeof x === 'number' ? { t: x } : x && typeof x === 'object' ? x : { t });
  const subOf = (o) => Math.max(1, Math.floor(Number(o.sub ?? 1)) || 1);
  const shutterOf = (o) => (Number.isFinite(o.shutter) ? Math.max(0, o.shutter) : 0.5);
  const fpsOf = (o) => (Number(o.fps) > 0 ? Number(o.fps) : fps);
  const wrapOf = (o) => o.wrap !== false; // loop films wrap unless the caller asks for the raw (clamped) time

  function frame(arg = {}) {
    const o = opts(arg, 0);
    const t = Number(o.t ?? 0);
    const sub = subOf(o);
    const shutter = shutterOf(o);
    const type = o.type || 'image/png';
    const wrap = wrapOf(o);
    if (sub === 1 || shutter === 0) {
      paint(t, wrap);
      return Promise.resolve(canvas.toDataURL(type, o.quality));
    }
    const img = accumulate(t, sub, shutter, fpsOf(o), wrap);
    if (!out) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      out = { c, g: c.getContext('2d', { willReadFrequently: true, alpha: false }) };
    }
    out.g.putImageData(img, 0, 0);
    return Promise.resolve(out.c.toDataURL(type, o.quality));
  }

  // sha256 of the raw RGBA after paint(t) (or of the blended frame with { sub }; { wrap: false } as in frame()).
  // Bytes are copied synchronously by digest(), so overlapping calls cannot see each other's buffers.
  function hash(t, extra) {
    const o = typeof t === 'object' && t ? t : { ...(extra || {}), t };
    const sub = subOf(o);
    const wrap = wrapOf(o);
    let bytes;
    if (sub > 1) bytes = accumulate(Number(o.t ?? 0), sub, shutterOf(o), fpsOf(o), wrap).data;
    else {
      paint(Number(o.t ?? 0), wrap);
      bytes = g.getImageData(0, 0, w, h).data;
    }
    return sha256hex(bytes);
  }

  function pixels(t, width = 160) {
    paint(t);
    const tw = Math.max(2, Math.round(Number(width) || 160));
    const th = even(Math.round((tw * H) / W));
    const key = `${tw}x${th}`;
    let s = small.get(key);
    if (!s) {
      const c = document.createElement('canvas');
      c.width = tw;
      c.height = th;
      s = { c, g: c.getContext('2d', { willReadFrequently: true, alpha: false }) };
      small.set(key, s);
    }
    s.g.imageSmoothingEnabled = true;
    s.g.imageSmoothingQuality = 'high';
    s.g.drawImage(canvas, 0, 0, tw, th);
    return Promise.resolve(base64(s.g.getImageData(0, 0, tw, th).data));
  }
  return { frame, hash, pixels };
}

// ---------------------------------------------------------------------------------------------------------------

const notReady = () => Promise.reject(new Error('__studio is not ready yet — await window.__studio.ready first'));

export function boot(film, { canvasId = 'stage' } = {}) {
  const params = new URLSearchParams(location.search);
  const RENDER = window.__RENDER__ === true || params.has('render') || navigator.webdriver === true;
  // Text-use registry (lib/draw.js): opt-in, set before the first paint. Never switched off here: a caller that turned it on stays on.
  if (window.__TEXT_TRACK__ === true || ['1', 'true'].includes(params.get('texttrack'))) setTextTracking(true);
  // textTrack is a getter: it follows setTextTracking() even when a film switches the registry on or off after boot.
  const studio = { version: 1, ready: null, error: null, render: RENDER, get textTrack() { return isTextTracking(); }, meta: null, grid: null, cues: () => [], shots: () => [], frame: notReady, hash: notReady, pixels: notReady, textUse: notReady, coverage: notReady };
  window.__studio = studio;
  // HyperFrames bridge (experimental): a host page dispatches hf-seek with { detail: { time } }.
  window.addEventListener('hf-seek', (e) => {
    const d = e && e.detail;
    const t = d && typeof d === 'object' ? d.time : d;
    if (typeof window.seek === 'function') window.seek(Number(t));
  });
  const ready = start(film, canvasId, params, RENDER, studio);
  studio.ready = ready;
  ready.catch((err) => {
    studio.error = String((err && err.stack) || err);
    console.error(`[motion-studio] ${studio.error}`);
    if (!RENDER) showError(studio.error); // studio-allow preview
  });
  return ready;
}

async function start(film, canvasId, params, RENDER, studio) {
  const cfg = merge(DEFAULTS, (await fetchJSON('studio.json', true)) || {});
  const beats = await fetchJSON('audio/beats.json', false);
  const fmt = params.get('format') || cfg.primaryFormat;
  if (!FORMATS[fmt]) throw new Error(`unknown format "${fmt}" — use ?format=${Object.keys(FORMATS).join('|')}`);
  const qs = params.get('scale');
  const scale = qs == null ? 1 : clamp(Number(qs) || 1, 0.1, 1);
  const ctx = filmContext(cfg, fmt, beats);
  const { W, H } = ctx.L;

  let canvas = document.getElementById(canvasId);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = canvasId;
    document.body.appendChild(canvas);
  }
  canvas.width = even(Math.round(W * scale));
  canvas.height = even(Math.round(H * scale));
  const sx = canvas.width / W;
  const sy = canvas.height / H;
  // CPU raster: GPU and CPU canvases hash differently; willReadFrequently forces the deterministic software path.
  // alpha: true on purpose: an opaque (alpha: false) canvas lets Chrome draw LCD sub-pixel text, so small type gets
  // red/blue fringes that survive H.264 and change with the OS ClearType/fontconfig setting. Every frame fills the
  // opaque background first (renderFrame), so pixels stay opaque and text is grayscale-antialiased.
  const g = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
  if (!g) throw new Error('could not create a 2D canvas context');

  await loadFonts(cfg.fonts);
  await assertBrandFonts(cfg.brand);
  // text() / font() without a family draw the brand UI face, kinetic() the display face (never a machine-specific fallback).
  const brandFonts = (cfg.brand && cfg.brand.fonts) || {};
  setFontDefaults({ text: brandFonts.ui || brandFonts.display, kinetic: brandFonts.display || brandFonts.ui });
  const built = buildFilm(film, ctx);
  if (built.setup) await built.setup(ctx);

  const { dur, fps, loop } = ctx;
  // wrap = false keeps a loop film's raw time (clamped like a non-loop film) for seam checks: t = dur paints the end
  // state instead of frame 0.
  const norm = (t, wrap = true) => {
    const x = Number.isFinite(t) ? t : 0;
    return loop && wrap ? loopT(x, dur) : clamp(x, 0, dur);
  };
  const fctx = { W, H, u: ctx.L.u, fmt, L: ctx.L, grid: ctx.grid, brand: ctx.brand, fps, dur, film: ctx };
  // blur = { frameT, sub, subs } for one subframe of a blurred frame: t is that subframe's time, frameT the output frame's.
  const paint = (t, wrap = true, blur = null) => {
    g.setTransform(sx, 0, 0, sy, 0, 0); // scenes always draw in logical W×H
    const tt = norm(Number(t), wrap);
    const ft = blur && Number.isFinite(Number(blur.frameT)) ? norm(Number(blur.frameT), wrap) : null;
    renderFrame(built, g, tt, ft === null ? fctx : { ...fctx, frameT: ft, sub: blur.sub, subs: blur.subs });
  };
  paint(0);
  // seek(t) paints one time; the optional 2nd argument { frameT, sub, subs } says this is subframe `sub` of `subs` of the
  // output frame at frameT (the page-capture renderer passes it for every screenshot it averages).
  window.seek = (t, blur) => {
    paint(t, true, blur && typeof blur === 'object' ? blur : null);
    return true;
  };

  const capture = cfg.capture === 'canvas' || cfg.capture === 'page' ? cfg.capture : built.capture;
  const meta = { title: cfg.title, duration: dur, fps, format: fmt, width: canvas.width, height: canvas.height, logicalWidth: W, logicalHeight: H, scale, bpm: ctx.grid.bpm, loop, capture };
  const px = pixelOps(canvas, g, paint, W, H, fps);
  Object.assign(studio, {
    meta,
    grid: ctx.grid.toJSON(),
    cues: () => built.cues.map((c) => ({ ...c })),
    shots: () => built.shots.map((s) => ({ ...s })), // time order; overlays are never shots
    frame: px.frame,
    hash: px.hash,
    pixels: px.pixels,
    textUse: () => Promise.resolve(getTextUse()),
    coverage,
    seek: window.seek,
  });
  if (!RENDER) startPreview({ canvas, paint, ctx, built, cfg, fmt, params }); // studio-allow preview
}

// ---------------------------------------------------------------------------------------------------------------
// Preview player (never runs in render mode). Real-time clock, overlay outside the stage canvas.

const PREVIEW_CSS = [ // studio-allow preview
  '#ms-preview{position:fixed;inset:0;display:flex;flex-direction:column;font:13px/1.3 Inter,system-ui,sans-serif;color:#d8d6cf;user-select:none}', // studio-allow preview
  '#ms-preview .ms-stage{flex:1;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;min-height:0}', // studio-allow preview
  '#ms-preview .ms-stage canvas{display:block}', // studio-allow preview
  '#ms-preview .ms-guides{position:absolute;pointer-events:none}', // studio-allow preview
  '#ms-preview .ms-bar{padding:8px 14px 10px;background:rgba(255,255,255,0.04);border-top:1px solid rgba(255,255,255,0.08)}', // studio-allow preview
  '#ms-preview .ms-strip{display:block;width:100%;height:34px;cursor:pointer;touch-action:none}', // studio-allow preview
  '#ms-preview .ms-row{display:flex;align-items:center;gap:14px;margin-top:6px;white-space:nowrap;overflow:hidden}', // studio-allow preview
  '#ms-preview button{font:inherit;color:inherit;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:3px 9px;cursor:pointer}', // studio-allow preview
  '#ms-preview button.on{border-color:#D97757;color:#fff}', // studio-allow preview
  '#ms-preview .ms-time{font-variant-numeric:tabular-nums;color:#fff;min-width:150px}', // studio-allow preview
  '#ms-preview .ms-dim{color:#8a8993}', // studio-allow preview
  '#ms-preview .ms-grow{flex:1}', // studio-allow preview
].join('\n'); // studio-allow preview

const mmss = (t) => { // studio-allow preview
  const s = Math.max(0, t); // studio-allow preview
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`; // studio-allow preview
}; // studio-allow preview

function el(tag, attrs = {}, parent) {
  const e = document.createElement(tag); // studio-allow preview
  for (const [k, v] of Object.entries(attrs)) if (k === 'text') e.textContent = v; else e.setAttribute(k, v); // studio-allow preview
  if (parent) parent.appendChild(e); // studio-allow preview
  return e; // studio-allow preview
}

function showError(msg) {
  const box = el('pre', { style: 'position:fixed;inset:16px;margin:0;padding:18px;overflow:auto;z-index:9;background:#1d1d1b;color:#ff8a70;font:13px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;border:1px solid #D97757;border-radius:8px' }, document.body); // studio-allow preview
  box.textContent = `motion-studio: the film failed to boot\n\n${msg}\n\nFix the error and reload. Run npm run lint and npm run doctor for hints.`; // studio-allow preview
}

function startPreview({ canvas, paint, ctx, built, cfg, fmt, params }) {
  const { dur, fps, grid, L } = ctx; // studio-allow preview
  const col = (ctx.brand && ctx.brand.colors) || {}; // studio-allow preview
  const accent = col.accent || '#D97757'; // studio-allow preview
  const shots = built.shots; // studio-allow preview
  const cues = built.cues; // studio-allow preview
  el('style', { text: PREVIEW_CSS }, document.head); // studio-allow preview
  const root = el('div', { id: 'ms-preview' }, document.body); // studio-allow preview
  const stage = el('div', { class: 'ms-stage' }, root); // studio-allow preview
  stage.appendChild(canvas); // studio-allow preview
  const guides = el('canvas', { class: 'ms-guides' }, stage); // studio-allow preview
  const bar = el('div', { class: 'ms-bar' }, root); // studio-allow preview
  const strip = el('canvas', { class: 'ms-strip' }, bar); // studio-allow preview
  const row = el('div', { class: 'ms-row' }, bar); // studio-allow preview
  const playBtn = el('button', { text: 'Pause', title: 'Space' }, row); // studio-allow preview
  const timeEl = el('span', { class: 'ms-time' }, row); // studio-allow preview
  const beatEl = el('span', { class: 'ms-dim' }, row); // studio-allow preview
  const shotEl = el('span', {}, row); // studio-allow preview
  el('span', { class: 'ms-grow' }, row); // studio-allow preview
  const formats = (Array.isArray(cfg.formats) && cfg.formats.length ? cfg.formats : Object.keys(FORMATS)).filter((f) => FORMATS[f]); // studio-allow preview
  for (const f of formats) el('button', { text: f, class: f === fmt ? 'on' : '', 'data-fmt': f, title: 'F cycles formats' }, row); // studio-allow preview
  const guideBtn = el('button', { text: 'Guides', title: 'G' }, row); // studio-allow preview
  const soundBtn = el('button', { text: 'Sound off', title: 'M' }, row); // studio-allow preview
  el('span', { class: 'ms-dim', text: 'space play · ←/→ frame · ⇧←/→ beat · [ ] shot' }, row); // studio-allow preview

  let t = clamp(Number(params.get('t')) || 0, 0, dur); // studio-allow preview
  let playing = !params.has('paused'); // studio-allow preview
  let showGuides = false; // studio-allow preview
  let last = performance.now(); // studio-allow preview
  let painted = -1; // studio-allow preview
  let audio = null; // studio-allow preview
  let soundOn = false; // studio-allow preview
  try { showGuides = localStorage.getItem('motion-studio:guides') === '1'; } catch {} // studio-allow preview

  const sources = ['out/score.wav', cfg.audio && cfg.audio.music].filter((s) => typeof s === 'string' && s && s !== 'none'); // studio-allow preview
  function ensureAudio() { // studio-allow preview
    if (audio || !sources.length) return audio; // studio-allow preview
    let i = 0; // studio-allow preview
    audio = new Audio(sources[0]); // studio-allow preview
    audio.preload = 'auto'; // studio-allow preview
    audio.addEventListener('error', () => { i += 1; if (i < sources.length) audio.src = sources[i]; else { soundOn = false; soundBtn.textContent = 'No audio'; } }); // studio-allow preview
    return audio; // studio-allow preview
  } // studio-allow preview
  function syncAudio() { // studio-allow preview
    if (!audio) return; // studio-allow preview
    if (soundOn && playing) { audio.currentTime = t; audio.play().catch(() => {}); } else audio.pause(); // studio-allow preview
  } // studio-allow preview

  function fit() { // studio-allow preview
    const r = stage.getBoundingClientRect(); // studio-allow preview
    const k = Math.min((r.width - 24) / L.W, (r.height - 24) / L.H); // studio-allow preview
    const cw = Math.max(1, Math.floor(L.W * k)); // studio-allow preview
    const ch = Math.max(1, Math.floor(L.H * k)); // studio-allow preview
    canvas.style.width = `${cw}px`; // studio-allow preview
    canvas.style.height = `${ch}px`; // studio-allow preview
    const dpr = window.devicePixelRatio || 1; // studio-allow preview
    guides.style.width = `${cw}px`; // studio-allow preview
    guides.style.height = `${ch}px`; // studio-allow preview
    guides.width = Math.round(cw * dpr); // studio-allow preview
    guides.height = Math.round(ch * dpr); // studio-allow preview
    strip.width = Math.round(strip.clientWidth * dpr); // studio-allow preview
    strip.height = Math.round(34 * dpr); // studio-allow preview
    drawGuides(); // studio-allow preview
    painted = -1; // studio-allow preview
  } // studio-allow preview

  function drawGuides() { // studio-allow preview
    const q = guides.getContext('2d'); // studio-allow preview
    q.setTransform(1, 0, 0, 1, 0, 0); // studio-allow preview
    q.clearRect(0, 0, guides.width, guides.height); // studio-allow preview
    guides.style.display = showGuides ? 'block' : 'none'; // studio-allow preview
    guideBtn.className = showGuides ? 'on' : ''; // studio-allow preview
    if (!showGuides) return; // studio-allow preview
    const k = guides.width / L.W; // studio-allow preview
    q.scale(k, k); // studio-allow preview
    const cp = (cfg.critique && cfg.critique.cornerPct) || 0.08; // studio-allow preview
    q.fillStyle = 'rgba(255,90,90,0.16)'; // studio-allow preview
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) q.fillRect(x * L.W * (1 - cp), y * L.H * (1 - cp), L.W * cp, L.H * cp); // studio-allow preview
    q.setLineDash([18, 12]); // studio-allow preview
    q.lineWidth = 3; // studio-allow preview
    q.strokeStyle = accent; // studio-allow preview
    q.strokeRect(L.S.x, L.S.y, L.S.w, L.S.h); // studio-allow preview
    q.setLineDash([]); // studio-allow preview
    q.strokeStyle = 'rgba(255,255,255,0.25)'; // studio-allow preview
    q.lineWidth = 2; // studio-allow preview
    q.beginPath(); q.moveTo(L.cx, 0); q.lineTo(L.cx, L.H); q.moveTo(0, L.cy); q.lineTo(L.W, L.cy); q.stroke(); // studio-allow preview
  } // studio-allow preview

  function drawStrip() { // studio-allow preview
    const q = strip.getContext('2d'); // studio-allow preview
    const w = strip.width; // studio-allow preview
    const h = strip.height; // studio-allow preview
    const x = (s) => (s / dur) * w; // studio-allow preview
    q.clearRect(0, 0, w, h); // studio-allow preview
    shots.forEach((s, i) => { q.fillStyle = i % 2 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.11)'; q.fillRect(x(s.from), h * 0.3, Math.max(1, x(s.to) - x(s.from) - 1), h * 0.7); }); // studio-allow preview
    q.font = `${Math.round(h * 0.3)}px Inter, sans-serif`; // studio-allow preview
    q.fillStyle = 'rgba(255,255,255,0.55)'; // studio-allow preview
    for (const s of shots) if (x(s.to) - x(s.from) > h * 2) q.fillText(s.name, x(s.from) + h * 0.2, h * 0.92, x(s.to) - x(s.from) - h * 0.4); // studio-allow preview
    q.fillStyle = 'rgba(255,255,255,0.35)'; // studio-allow preview
    for (const b of grid.beatsIn(0, dur)) q.fillRect(x(b), h * 0.3, 1, h * 0.16); // studio-allow preview
    q.fillStyle = 'rgba(255,255,255,0.8)'; // studio-allow preview
    for (const b of grid.barsIn(0, dur)) q.fillRect(x(b), h * 0.3, 2, h * 0.3); // studio-allow preview
    q.fillStyle = accent; // studio-allow preview
    for (const c of cues) { q.beginPath(); q.arc(x(c.t), h * 0.14, h * 0.08, 0, Math.PI * 2); q.fill(); } // studio-allow preview
    q.fillRect(x(t) - 1, 0, 3, h); // studio-allow preview
  } // studio-allow preview

  function readout() { // studio-allow preview
    const shot = shots.filter((s) => t >= s.from && t < s.to).map((s) => s.name).join(' + ') || '—'; // studio-allow preview
    timeEl.textContent = `${mmss(t)} / ${mmss(dur)}  f${Math.floor(t * fps + 1e-6)}`; // studio-allow preview
    beatEl.textContent = `beat ${grid.index(t)} · bar ${grid.barIndex(t) + 1}`; // studio-allow preview
    shotEl.textContent = shot; // studio-allow preview
    playBtn.textContent = playing ? 'Pause' : 'Play'; // studio-allow preview
  } // studio-allow preview

  function seekTo(x, keepPlaying = false) { // studio-allow preview
    t = clamp(x, 0, Math.max(0, dur - 1e-6)); // studio-allow preview
    if (!keepPlaying) playing = false; // studio-allow preview
    painted = -1; // studio-allow preview
    syncAudio(); // studio-allow preview
  } // studio-allow preview

  function tick(now) { // studio-allow preview
    if (playing) { // studio-allow preview
      t += (now - last) / 1000; // studio-allow preview
      if (audio && soundOn && !audio.paused && audio.readyState >= 2) t = audio.currentTime; // studio-allow preview
      if (t >= dur) { t = ctx.loop ? loopT(t, dur) : 0; syncAudio(); } // studio-allow preview
    } // studio-allow preview
    last = now; // studio-allow preview
    if (t !== painted) { paint(t); painted = t; drawStrip(); readout(); } // studio-allow preview
    requestAnimationFrame(tick); // studio-allow preview
  } // studio-allow preview

  function stripSeek(e) { // studio-allow preview
    const r = strip.getBoundingClientRect(); // studio-allow preview
    seekTo(((e.clientX - r.left) / r.width) * dur); // studio-allow preview
  } // studio-allow preview
  strip.addEventListener('pointerdown', (e) => { strip.setPointerCapture(e.pointerId); stripSeek(e); }); // studio-allow preview
  strip.addEventListener('pointermove', (e) => { if (e.buttons & 1) stripSeek(e); }); // studio-allow preview
  playBtn.addEventListener('click', () => { playing = !playing; syncAudio(); readout(); }); // studio-allow preview
  guideBtn.addEventListener('click', () => toggleGuides()); // studio-allow preview
  soundBtn.addEventListener('click', () => toggleSound()); // studio-allow preview
  row.addEventListener('click', (e) => { const f = e.target && e.target.getAttribute && e.target.getAttribute('data-fmt'); if (f) switchFormat(f); }); // studio-allow preview

  function toggleGuides() { // studio-allow preview
    showGuides = !showGuides; // studio-allow preview
    try { localStorage.setItem('motion-studio:guides', showGuides ? '1' : '0'); } catch {} // studio-allow preview
    drawGuides(); // studio-allow preview
  } // studio-allow preview
  function toggleSound() { // studio-allow preview
    if (!ensureAudio()) { soundBtn.textContent = 'No audio'; return; } // studio-allow preview
    soundOn = !soundOn; // studio-allow preview
    soundBtn.textContent = soundOn ? 'Sound on' : 'Sound off'; // studio-allow preview
    soundBtn.className = soundOn ? 'on' : ''; // studio-allow preview
    syncAudio(); // studio-allow preview
  } // studio-allow preview
  function switchFormat(f) { // studio-allow preview
    const q = new URLSearchParams(location.search); // studio-allow preview
    q.set('format', f); // studio-allow preview
    q.set('t', t.toFixed(3)); // studio-allow preview
    if (!playing) q.set('paused', ''); else q.delete('paused'); // studio-allow preview
    location.search = q.toString(); // studio-allow preview
  } // studio-allow preview
  const shotStarts = [...new Set(shots.map((s) => s.from))].sort((a, b) => a - b); // studio-allow preview

  window.addEventListener('keydown', (e) => { // studio-allow preview
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; // studio-allow preview
    const k = e.key; // studio-allow preview
    if (k === ' ' || k === 'k') { playing = !playing; syncAudio(); readout(); } // studio-allow preview
    else if (k === 'ArrowLeft' || k === 'ArrowRight') { // studio-allow preview
      const dir = k === 'ArrowRight' ? 1 : -1; // studio-allow preview
      if (e.shiftKey) { const p = grid.position(t); seekTo(grid.beat(dir > 0 ? Math.floor(p + 1e-6) + 1 : Math.ceil(p - 1e-6) - 1)); } // studio-allow preview
      else seekTo((Math.round(t * fps) + dir) / fps); // studio-allow preview
    } // studio-allow preview
    else if (k === '[') seekTo([...shotStarts].reverse().find((s) => s < t - 1e-6) ?? 0); // studio-allow preview
    else if (k === ']') seekTo(shotStarts.find((s) => s > t + 1e-6) ?? t); // studio-allow preview
    else if (k === 'Home') seekTo(0); // studio-allow preview
    else if (k === 'End') seekTo(dur - 1 / fps); // studio-allow preview
    else if (k === 'f' || k === 'F') switchFormat(formats[(formats.indexOf(fmt) + 1) % formats.length] || fmt); // studio-allow preview
    else if (k === 'g' || k === 'G') toggleGuides(); // studio-allow preview
    else if (k === 'm' || k === 'M') toggleSound(); // studio-allow preview
    else return; // studio-allow preview
    e.preventDefault(); // studio-allow preview
  }); // studio-allow preview
  window.addEventListener('resize', fit); // studio-allow preview
  fit(); // studio-allow preview
  requestAnimationFrame((now) => { last = now; tick(now); }); // studio-allow preview
}
